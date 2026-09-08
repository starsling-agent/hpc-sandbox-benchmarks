#!/usr/bin/env bun
// `driver-check` — drive one provider end to end through the ADR-0007 driver path, locally.
//
// This is the lane that answers "does the port actually work?". Until now every driver module was
// compile-checked and unit-tested but had never created a sandbox: `syncCapMs`, `durable`, the
// readiness claim and the filesystem capability were all assertions no execution had tested. This
// bin runs the real composition flow (load → parse → resolve → construct), boots a real sandbox,
// and drives a real workload through the harness's own `StepRunner` on both transports.
//
// It deliberately writes NO Run document. This command is a contract/TCK check rather than a
// benchmark measurement; the port-native bench-suite lane owns raw result collection and Run v6
// artifact evidence. Keeping the two lanes separate prevents conformance probes from being published
// as benchmark samples.
//
// Usage:
//   bun apps/cli/src/bin/driver-check.ts --provider e2b
//   bun apps/cli/src/bin/driver-check.ts --provider tama --phase candidate --workload-seconds 10
//   bun apps/cli/src/bin/driver-check.ts --provider modal-vm --artifact-ref ghcr.io/…:v8-candidate
//
// Credentials come from the environment (bun auto-loads `.env`). A provider whose credentials are
// absent SKIPS with exit 0 — the same skip-vs-fail contract the rest of the fleet uses.

import { writeFileSync } from "node:fs";
import type { SandboxSession } from "@sandbox-benchmarks/driver";
import { isDriverError, readTextFile, succeeded, writeTextFile } from "@sandbox-benchmarks/driver";
import { verifyDriverReadiness } from "@sandbox-benchmarks/driver/conformance";
import type { DriverProviderId } from "@sandbox-benchmarks/drivers";
import { DRIVERS } from "@sandbox-benchmarks/drivers";
import {
	exitAfterSandboxCleanup,
	SessionStepRunner,
	StepRunner,
} from "@sandbox-benchmarks/harness";
import type { ArtifactPhase } from "@sandbox-benchmarks/schema";
import type { OwnedDriverSession } from "../lib/driver-run.ts";
import {
	benchmarkCreateRequest,
	createOwnedDriverSession,
	openDriver,
	sessionHandle,
} from "../lib/driver-run.ts";

type CheckStatus = "pass" | "fail" | "skip";

interface Check {
	readonly name: string;
	readonly status: CheckStatus;
	readonly detail: string;
	readonly durationMs: number;
}

const DRIVER_IDS = Object.keys(DRIVERS) as DriverProviderId[];
/** Long enough that the create budget is honest, short enough to abandon a wedged control plane. */
const CREATE_DEADLINE_MS = 10 * 60_000;
const PROBE_PATH = "/tmp/driver-check-probe.txt";

interface Options {
	readonly provider: DriverProviderId;
	readonly phase: ArtifactPhase;
	readonly artifactRef?: string;
	readonly workloadSeconds: number;
	readonly keep: boolean;
	readonly requirePass: boolean;
	readonly reportFile?: string;
}

/** The `--help`-shaped banner, naming the providers this lane can actually drive today. */
function usage(): string {
	return [
		"usage: driver-check --provider <id> [--phase candidate|version] [--artifact-ref <ref>]",
		"                    [--workload-seconds <n>] [--keep] [--require-pass] [--report-file <path>]",
		"",
		`migrated providers: ${DRIVER_IDS.join(", ")}`,
		"",
		"Providers still on packages/providers carry a migration waiver and are not drivable here;",
		"see packages/drivers/migration-waivers.json.",
	].join("\n");
}

/**
 * Parse argv into options, rejecting anything ambiguous rather than guessing.
 *
 * An unmigrated provider is rejected here rather than at load time: driving one would exercise the
 * legacy `packages/providers` adapter and report the result as driver-path evidence.
 */
function parseArgs(argv: readonly string[]): Options {
	const values = new Map<string, string>();
	let keep = false;
	let requirePass = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (arg === "--require-pass") {
			requirePass = true;
			continue;
		}
		if (arg === "--keep") {
			keep = true;
			continue;
		}
		if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
		if (
			!["--provider", "--phase", "--artifact-ref", "--workload-seconds", "--report-file"].includes(
				arg,
			)
		)
			throw new Error(`unknown option ${arg}`);
		if (values.has(arg.slice(2))) throw new Error(`duplicate option ${arg}`);
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
		values.set(arg.slice(2), next);
		index++;
	}

	if (keep && requirePass) throw new Error("--keep cannot be combined with --require-pass");
	const provider = values.get("provider");
	if (provider === undefined) throw new Error("--provider is required");
	if (!DRIVER_IDS.includes(provider as DriverProviderId)) {
		throw new Error(`${provider} has no driver module (migrated: ${DRIVER_IDS.join(", ")})`);
	}

	const phase = values.get("phase") ?? "version";
	if (phase !== "candidate" && phase !== "version") {
		throw new Error("--phase must be candidate or version");
	}

	const rawWorkload = values.get("workload-seconds") ?? "3";
	const workloadSeconds = Number(rawWorkload);
	if (!Number.isSafeInteger(workloadSeconds) || workloadSeconds <= 0) {
		throw new Error("--workload-seconds must be a positive integer");
	}

	const artifactRef = values.get("artifact-ref");
	const reportFile = values.get("report-file");
	return {
		provider: provider as DriverProviderId,
		phase,
		workloadSeconds,
		keep,
		requirePass,
		...(artifactRef === undefined ? {} : { artifactRef }),
		...(reportFile === undefined ? {} : { reportFile }),
	};
}

/** Render an error for the report, keeping a DriverError's typed code visible. */
function reason(error: unknown): string {
	if (isDriverError(error)) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

/** Run one check, timing it and turning any throw into a `fail` rather than aborting the lane. */
async function check(
	checks: Check[],
	name: string,
	body: () => Promise<string>,
	log: (message: string) => void,
): Promise<boolean> {
	const started = performance.now();
	try {
		const detail = await body();
		const durationMs = performance.now() - started;
		checks.push({ name, status: "pass", detail, durationMs });
		log(`  ✓ ${name} (${durationMs.toFixed(0)}ms) ${detail}`);
		return true;
	} catch (error) {
		const durationMs = performance.now() - started;
		checks.push({ name, status: "fail", detail: reason(error), durationMs });
		log(`  ✗ ${name} (${durationMs.toFixed(0)}ms) ${reason(error)}`);
		return false;
	}
}

function skip(checks: Check[], name: string, detail: string, log: (message: string) => void): void {
	checks.push({ name, status: "skip", detail, durationMs: 0 });
	log(`  – ${name} ${detail}`);
}

/** The most useful failure text a CommandResult carries; stderr is optional on that shape. */

/**
 * The deadline for the durable step: at least the declared cap, and always longer than the workload.
 *
 * Two different things ride on this one number. `selectTransport` routes to the detached path when
 * `timeoutMs >= syncCapMs`, so the cap is the floor — below it the check would silently measure the
 * synchronous path instead. But `runDetached` also treats it as a hard deadline and kills the step
 * when it expires, so a workload at or beyond the cap would time out and report a healthy durable
 * route as broken. Taking the max of the two, plus headroom for create/poll overhead, keeps the
 * routing decision and the completion budget from fighting each other.
 */
export function durableStepTimeoutMs(syncCapMs: number, workloadSeconds: number): number {
	const DURABLE_OVERHEAD_MS = 30_000;
	return Math.max(syncCapMs, workloadSeconds * 1_000 + DURABLE_OVERHEAD_MS);
}

/** A workload with real duration, so the durable transport genuinely polls for completion. */
function workloadScript(seconds: number): string {
	return `set -eu; start=$(date +%s); sleep ${seconds}; echo "workload ok after $(( $(date +%s) - start ))s"`;
}

/**
 * Run every in-sandbox check against a live session.
 *
 * Ordered cheapest-first so a broken exec surfaces before a multi-minute durable step, and written
 * so one failing check never aborts the rest — the report is more useful complete than early.
 */
async function driveSession(
	session: SandboxSession,
	options: Options,
	transportSyncCapMs: number | null,
	runner: StepRunner | SessionStepRunner,
	checks: Check[],
	log: (message: string) => void,
): Promise<void> {
	await check(
		checks,
		"exec-success",
		async () => {
			const result = await session.exec("sh -c 'exit 0'");
			if (!succeeded(result.exit)) throw new Error(`expected exit 0, got ${result.exit.kind}`);
			return "exit 0 reported as exited/0";
		},
		log,
	);

	// ADR-0008: the guest's real status crosses the port, never a fabricated 1.
	await check(
		checks,
		"exec-exit-code",
		async () => {
			const result = await session.exec("sh -c 'exit 7'");
			if (result.exit.kind !== "exited" || result.exit.code !== 7) {
				throw new Error(`expected exited/7, got ${JSON.stringify(result.exit)}`);
			}
			return "exit 7 preserved";
		},
		log,
	);

	await check(
		checks,
		"exec-streams",
		async () => {
			const result = await session.exec("sh -c 'echo out; echo err 1>&2'");
			if (!result.stdout.includes("out")) throw new Error("stdout missing its own output");
			if (!result.stderr.includes("err")) throw new Error("stderr missing its own output");
			if (result.stdout.includes("err")) throw new Error("stderr leaked into stdout");
			return "stdout and stderr stayed separate";
		},
		log,
	);

	// Capability-by-presence: whichever path this session has must round-trip. `files` absent is not
	// a skip — it selects the kit's exec-based fallback, which the harness relies on just as hard.
	const capability = session.files === undefined ? "kit exec fallback" : "native files";
	await check(
		checks,
		"files-roundtrip",
		async () => {
			const payload = `driver-check ${Date.now().toString(36)}`;
			await writeTextFile(session, PROBE_PATH, payload);
			const read = await readTextFile(session, PROBE_PATH);
			// null is "could not read", which for a path just written is a failure, not an empty file.
			if (read === null) throw new Error(`${PROBE_PATH} was unreadable after writing it`);
			if (read.trim() !== payload) throw new Error(`read back ${JSON.stringify(read)}`);
			return `${capability} round-tripped`;
		},
		log,
	);

	// The real harness router, on the real declared policy. A short timeout stays synchronous.
	await check(
		checks,
		"step-sync",
		async () => {
			const result = await runner.step("driver-check-sync", workloadScript(1), 30_000);

			return (result.stdout ?? "").trim();
		},
		log,
	);

	// A timeout at or beyond the declared cap must route to the durable path and still complete.
	if (transportSyncCapMs === null) {
		skip(checks, "step-durable", "module declares no sync cap; no durable boundary to cross", log);
	} else {
		const durableTimeoutMs = durableStepTimeoutMs(transportSyncCapMs, options.workloadSeconds);
		await check(
			checks,
			"step-durable",
			async () => {
				const script = workloadScript(options.workloadSeconds);
				const result = await runner.step("driver-check-durable", script, durableTimeoutMs);

				return `${(result.stdout ?? "").trim()} (durable path, cap ${transportSyncCapMs}ms)`;
			},
			log,
		);
	}
}

/**
 * Drive one provider end to end, guaranteeing teardown even when a check throws.
 *
 * Absent credentials skip rather than fail: this lane is meant to be runnable in a checkout with no
 * `.env`, the same skip-vs-fail contract the rest of the fleet uses.
 */
async function run(options: Options, log: (message: string) => void): Promise<Check[]> {
	const checks: Check[] = [];
	log(`>>> ${options.provider}: driver end-to-end check`);

	let opened: Awaited<ReturnType<typeof openDriver>>;
	try {
		opened = await openDriver(options.provider, {
			artifact: {
				phase: options.phase,
				...(options.artifactRef ? { ref: options.artifactRef } : {}),
			},
		});
	} catch (error) {
		if (isDriverError(error) && error.code === "missing-credentials") {
			skip(checks, "resolve", reason(error), log);
			return checks;
		}
		checks.push({ name: "resolve", status: "fail", detail: reason(error), durationMs: 0 });
		log(`  ✗ resolve ${reason(error)}`);
		return checks;
	}

	const { driver, artifact, transport, module } = opened;
	checks.push({
		name: "resolve",
		status: "pass",
		detail: `artifact ${artifact.kind}${"ref" in artifact ? ` ${artifact.ref}` : ""}, sdk ${module.provenance.packageName}@${module.provenance.version}`,
		durationMs: 0,
	});
	log(`  ✓ resolve ${checks[checks.length - 1]?.detail}`);
	log(
		`  · policy: syncCapMs=${module.execution.syncCapMs} durable=${module.execution.durable} readiness=${module.readiness.startup}`,
	);

	let session: OwnedDriverSession | undefined;
	const created = await check(
		checks,
		"create",
		async () => {
			session = await createOwnedDriverSession(
				driver,
				benchmarkCreateRequest(artifact, CREATE_DEADLINE_MS),
			);
			const effective = session.artifact;
			return `${session.sandboxRef.provider}/${session.sandboxRef.id}, booted ${effective.kind}${"ref" in effective ? ` ${effective.ref}` : ""}`;
		},
		log,
	);

	if (!created || session === undefined) return checks;
	const live = session;

	try {
		const ready = await check(
			checks,
			"readiness",
			async () => {
				const outcome = await verifyDriverReadiness(module, live);
				if (outcome.status !== "pass") throw new Error(outcome.detail);
				return outcome.detail;
			},
			log,
		);
		if (!ready) return checks;
		const runner =
			module.id === "e2b"
				? new SessionStepRunner(live, module.execution, undefined, { mode: "fixed", times: 1 })
				: new StepRunner(sessionHandle(live), transport, undefined, {
						mode: "fixed",
						times: 1,
					});
		await driveSession(live, options, transport.syncCapMs, runner, checks, log);
	} finally {
		if (options.keep) {
			const handedOff = await check(
				checks,
				"ownership-handoff",
				async () => {
					if (!live.releaseOwnership()) throw new Error("session is no longer process-owned");
					return `operator now owns ${live.sandboxRef.id}`;
				},
				log,
			);
			if (handedOff) {
				skip(checks, "destroy", `--keep: left ${live.sandboxRef.id} running`, log);
			} else {
				await live.destroy();
			}
		} else {
			await check(
				checks,
				"destroy",
				async () => {
					await live.destroy();
					return "destroyed";
				},
				log,
			);
			// ADR-0008: destroy MUST be idempotent.
			await check(
				checks,
				"destroy-idempotent",
				async () => {
					await live.destroy();
					return "second destroy succeeded";
				},
				log,
			);
			// ADR-0008: destroy MUST be convergent. Absent probes are `unverified`, not a pass.
			const probes = driver.probes;
			if (probes === undefined) {
				skip(checks, "destroy-converged", "module exposes no probes; convergence unverified", log);
			} else {
				await check(
					checks,
					"destroy-converged",
					async () => {
						const observation = await probes.observe(live.sandboxRef);
						if (observation.state === "running") {
							throw new Error("control plane still reports the sandbox running after destroy");
						}
						return `observed ${observation.state}`;
					},
					log,
				);
			}
		}
	}

	return checks;
}

if (import.meta.main) {
	const log = (message: string) => console.error(message);
	let options: Options;
	try {
		options = parseArgs(Bun.argv.slice(2));
	} catch (error) {
		console.error(`${reason(error)}\n\n${usage()}`);
		process.exit(2);
	}

	const startedAt = new Date().toISOString();
	const checks = await run(options, log);
	const failed = checks.filter((entry) => entry.status === "fail").length;
	const passed = checks.filter((entry) => entry.status === "pass").length;
	const skipped = checks.filter((entry) => entry.status === "skip").length;
	log(`<<< ${options.provider}: ${passed} passed, ${failed} failed, ${skipped} skipped`);
	const report = JSON.stringify(
		{
			provider: options.provider,
			phase: options.phase,
			startedAt,
			completedAt: new Date().toISOString(),
			workloadSeconds: options.workloadSeconds,
			checks,
		},
		null,
		2,
	);
	// Emitting the report must never be the reason a still-owned sandbox is abandoned. When `destroy`
	// failed above, the sandbox stays registered with the process owner and `exitAfterSandboxCleanup`
	// is the only thing that retries it — so a write failure (bad `--report-file` path, full disk,
	// closed stdout) is caught, reported, and folded into the exit code rather than allowed to escape.
	let exitCode = failed > 0 || (options.requirePass && skipped > 0) ? 1 : 0;
	try {
		if (options.reportFile !== undefined) writeFileSync(options.reportFile, `${report}\n`);
		else console.log(report);
	} catch (error) {
		log(`error: could not emit the report — ${reason(error)}`);
		exitCode = 1;
	}

	await exitAfterSandboxCleanup(exitCode);
}

export { parseArgs, workloadScript };
