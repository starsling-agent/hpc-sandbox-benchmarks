import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, SandboxSession } from "@sandbox-benchmarks/driver";
import { loadDriverModule } from "@sandbox-benchmarks/drivers";
import { evaluateExperiment } from "@sandbox-benchmarks/results";
import { TOOLCHAIN_VERSION } from "@sandbox-benchmarks/schema/toolchain";
import type { AccountRecord } from "./account-journal.ts";
import { recoverAccount } from "./account-journal.ts";
import { recoverAllocatedIntent } from "./allocated-intent-recovery.ts";
import type { OpenedDriver } from "./driver-run.ts";
import { resolveDriverArtifact } from "./driver-run.ts";
import { batchIsComplete, executeExperimentBatch } from "./execute-experiment.ts";
import { readExperimentAttempt } from "./experiment-artifacts.ts";
import { workflowExperiment } from "./workflow-experiment.ts";

const root = mkdtempSync(join(tmpdir(), "experiment-integration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const plan = workflowExperiment(
	{
		GITHUB_RUN_ID: "123",
		GITHUB_SHA: "a".repeat(40),
		BENCH_PROVIDERS: "tama",
		BENCH_SUITES: "cpu-node",
		BENCH_REPLICAS: "2",
		BENCH_PTS_PASSES: "2",
		BENCH_ACCOUNT_CAPACITY: '{"tama":{"sandboxes":2}}',
	},
	"2026-09-10",
);
const ok = (stdout = "", code = 0): ExecResult => ({
	stdout,
	stderr: "",
	exit: { kind: "exited", code },
	durationMs: 1,
	truncated: false,
});
async function fixture(name: string, failCleanup = false) {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	const payloadRoot = join(directory, "payload");
	mkdirSync(join(payloadRoot, "benchmark-results"), { recursive: true });
	writeFileSync(
		join(payloadRoot, "benchmark-results", "pts_node-web-tooling.xml"),
		readFileSync(
			new URL(
				"../../../../packages/results/src/lib/__fixtures__/daytona-vm/pts_node-web-tooling.xml",
				import.meta.url,
			),
		),
	);
	const tar = Bun.spawnSync(["tar", "-czf", "-", "benchmark-results"], { cwd: payloadRoot });
	if (tar.exitCode !== 0) throw new Error("fixture archive failed");
	const payload = `__BENCH_RESULTS_TGZ_BEGIN__\n${tar.stdout.toString("base64")}\n__BENCH_RESULTS_TGZ_END__\n`;
	const records: AccountRecord[] = [];
	const events: string[] = [];
	const present = new Set<string>();
	let sequence = 0;
	let peak = 0;
	const artifact = resolveDriverArtifact("tama");
	const module = await loadDriverModule("tama");
	const opened: OpenedDriver = {
		artifact,
		module: {
			id: module.id,
			provenance: module.provenance,
			driver: () => {
				throw new Error("fixture is already opened");
			},
			readiness: { startup: "create-returns-ready" },
			execution: { syncCapMs: null, durable: "none" },
		},
		transport: { syncCapMs: null, detachedPoll: false, streaming: false },
		driver: {
			inventory: {
				list: async () => ({
					owned: [...present].map((id) => ({ provider: "tama" as const, id })),
					foreignCount: 0,
				}),
			},
			probes: { observe: async (ref) => ({ state: present.has(ref.id) ? "running" : "absent" }) },
			destroyById: async (ref) => {
				present.delete(ref.id);
			},
			create: async () => {
				const id = `sandbox-${++sequence}`;
				expect(records.filter((record) => record.kind === "intent").length).toBeGreaterThanOrEqual(
					sequence,
				);
				present.add(id);
				peak = Math.max(peak, present.size);
				events.push("create");
				const session: SandboxSession = {
					sandboxRef: { provider: "tama", id },
					artifact,
					native: undefined,
					exec: async (command) => {
						if (command.includes("/toolchain-manifest.json"))
							return ok(
								JSON.stringify({
									image_name: "sandbox-benchmarks-toolchain",
									image_version: TOOLCHAIN_VERSION,
								}),
							);
						if (command.includes("base64")) return ok(payload);
						if (command.includes("benchmark:cpu"))
							expect(
								records.some((record) => record.kind === "allocated" && record.ref.id === id),
							).toBe(true);
						return ok();
					},
					destroy: async () => {
						events.push("destroy");
						if (failCleanup) throw new Error("cleanup unavailable");
						present.delete(id);
					},
				};
				return session;
			},
		},
	};
	const options = {
		plan,
		batchId: "batch-0",
		root: join(directory, "attempts"),
		workflowAttempt: 1,
		job: "bench",
		open: async () => opened,
		journal: {
			read: async () => records,
			append: async (record: AccountRecord) => {
				records.push(record);
				events.push(record.kind);
			},
		},
		store: {
			upload: async (_name: string, path: string) => {
				readExperimentAttempt(path);
				events.push("upload");
			},
		},
	};
	return { options, records, events, present, peak: () => peak };
}

test("planned batch crosses the real harness, raw collector, normalizer and publication evaluator", async () => {
	const f = await fixture("complete");
	const attempts = await executeExperimentBatch(f.options);
	expect(attempts).toHaveLength(2);
	expect(f.peak()).toBeLessThanOrEqual(2);
	expect(f.present.size).toBe(0);
	expect(f.records.filter((record) => record.kind === "released")).toHaveLength(2);
	expect(batchIsComplete(plan, f.options.root, attempts)).toBe(true);
	expect(
		evaluateExperiment(
			plan,
			attempts.map((attempt) => readExperimentAttempt(join(f.options.root, attempt.id))),
		).complete,
	).toBe(true);
});

test("cleanup failure retains account ownership and blocks publication", async () => {
	const f = await fixture("cleanup", true);
	const attempts = await executeExperimentBatch(f.options);
	expect(
		attempts.every((attempt) => attempt.cleanup === "unresolved" && attempt.outcome === "failed"),
	).toBe(true);
	expect(f.records.filter((record) => record.kind === "released")).toHaveLength(0);
	expect(batchIsComplete(plan, f.options.root, attempts)).toBe(false);
});

test("missing inventory fails each planned replicate without creating", async () => {
	const f = await fixture("admission");
	const opened = await f.options.open();
	const attempts = await executeExperimentBatch({
		...f.options,
		open: async () => ({ ...opened, driver: { create: opened.driver.create } }),
	});
	expect(
		attempts.every(
			(attempt) => attempt.outcome === "failed" && attempt.cleanup === "not-allocated",
		),
	).toBe(true);
	expect(f.events).not.toContain("create");
});

test("workflow reruns cannot silently measure a planned sample again", async () => {
	const f = await fixture("rerun");
	await executeExperimentBatch(f.options);
	const creates = f.events.filter((event) => event === "create").length;
	const rerun = await executeExperimentBatch({ ...f.options, workflowAttempt: 2 });
	expect(f.events.filter((event) => event === "create")).toHaveLength(creates);
	expect(
		rerun.every((attempt) => attempt.outcome === "failed" && !attempt.measurementStarted),
	).toBe(true);
});

test("a failed terminal upload does not discard its local immutable evidence or repeat allocation", async () => {
	const f = await fixture("upload-failure");
	await expect(
		executeExperimentBatch({
			...f.options,
			store: {
				upload: async () => {
					throw new Error("upload unavailable");
				},
			},
		}),
	).rejects.toThrow("upload unavailable");
	expect(f.present.size).toBe(0);
	expect(f.records.filter((record) => record.kind === "released")).toHaveLength(2);
	const retry = await executeExperimentBatch({ ...f.options, workflowAttempt: 2 });
	expect(retry.every((attempt) => !attempt.measurementStarted)).toBe(true);
});

test("a create-failed releases its intent while a failed-create cleanup keeps ownership", async () => {
	const { DriverError, FailedCreateCleanupError } = await import("@sandbox-benchmarks/driver");
	for (const clean of [true, false]) {
		const f = await fixture(`create-refusal-${clean}`);
		const open = f.options.open;
		const primary = new DriverError("create-failed", "boot interrupted", { provider: "tama" });
		const failure = clean
			? primary
			: new FailedCreateCleanupError(new Error("destroy unavailable"), primary, {
					provider: "tama",
					locator: { kind: "name", value: "bench-orphan" },
					cleanup: async () => {
						throw new Error("destroy unavailable");
					},
				});
		f.options.open = async () => {
			const opened = await open();
			return {
				...opened,
				driver: {
					...opened.driver,
					create: async () => {
						throw failure;
					},
				},
			};
		};
		const attempts = await executeExperimentBatch(f.options);
		expect(
			attempts.every((attempt) => attempt.cleanup === (clean ? "not-allocated" : "unresolved")),
		).toBe(true);
		expect(f.records.filter((record) => record.kind === "released")).toHaveLength(clean ? 2 : 0);
		expect(
			attempts.every((attempt) => attempt.outcome === "failed" && !attempt.measurementStarted),
		).toBe(true);
	}
});

test("different suites enter measurement together and retain independent attempt identities", async () => {
	const f = await fixture("mixed-suites");
	const mixed = workflowExperiment(
		{
			GITHUB_RUN_ID: "mixed",
			GITHUB_SHA: plan.sha,
			BENCH_PROVIDERS: "tama",
			BENCH_SUITES: "cpu-node,memory",
			BENCH_REPLICAS: "1",
			BENCH_ACCOUNT_CAPACITY: '{"tama":{"sandboxes":2}}',
		},
		"2026-09-10",
	);
	const opened = await f.options.open();
	const started = new Set<string>();
	const gate = Promise.withResolvers<void>();
	const timeout = setTimeout(() => gate.reject(new Error("suites did not overlap")), 2000);
	try {
		const attempts = await executeExperimentBatch({
			...f.options,
			plan: mixed,
			open: async () => ({
				...opened,
				driver: {
					...opened.driver,
					create: async (...args) => {
						const session = await opened.driver.create(...args);
						return {
							...session,
							exec: async (command, options) => {
								if (command.includes("benchmark:cpu") || command.includes("benchmark:memory")) {
									started.add(session.sandboxRef.id);
									if (started.size === 2) gate.resolve();
									await gate.promise;
								}
								return session.exec(command, options);
							},
						};
					},
				},
			}),
		});
		expect(started.size).toBe(2);
		expect(f.peak()).toBe(2);
		expect(attempts.map((attempt) => attempt.cellId)).toEqual(mixed.cells.map((cell) => cell.id));
		expect(
			attempts.every((attempt) => attempt.measurementStarted && attempt.cleanup === "confirmed"),
		).toBe(true);
		// The CPU-only fixture cannot fabricate the missing memory metrics.
		expect(batchIsComplete(mixed, f.options.root, attempts)).toBe(false);
		expect(f.present.size).toBe(0);
	} finally {
		clearTimeout(timeout);
	}
});

test("a rejected allocation journal append retains recovery identity without admitting measurement", async () => {
	const f = await fixture("allocation-journal-failure");
	const attempts = await executeExperimentBatch({
		...f.options,
		journal: {
			...f.options.journal,
			append: async (record) => {
				if (record.kind === "allocated") throw new Error("journal allocation rejected");
				await f.options.journal.append(record);
			},
		},
	});
	expect(attempts).toHaveLength(2);
	expect(
		attempts.every(
			(attempt) =>
				!attempt.measurementStarted &&
				attempt.cleanup === "unresolved" &&
				attempt.outcome === "failed",
		),
	).toBe(true);
	expect(f.records.every((record) => record.kind === "intent")).toBe(true);
	expect(f.present.size).toBe(0);
	for (const attempt of attempts) {
		const allocation = JSON.parse(
			readFileSync(join(f.options.root, attempt.id, "raw", "allocation.json"), "utf8"),
		);
		expect(allocation).toMatchObject({
			kind: "allocated",
			attempt: attempt.id,
			cellId: attempt.cellId,
			planDigest: plan.digest,
			account: "tama",
			ref: { provider: "tama" },
		});
		expect(allocation.ref.id).toMatch(/^sandbox-[12]$/);
		expect(readExperimentAttempt(join(f.options.root, attempt.id)).evidence.rawDigest).toBe(
			attempt.rawDigest,
		);
	}
});

test("operator recovery reclaims the leaked sandbox and readmits the account", async () => {
	const f = await fixture("allocation-journal-recovery", true);
	const attempts = await executeExperimentBatch({
		...f.options,
		journal: {
			...f.options.journal,
			append: async (record) => {
				if (record.kind === "allocated") throw new Error("journal allocation rejected");
				await f.options.journal.append(record);
			},
		},
	});
	// The account is wedged: unresolved intents, and the sandboxes really did leak.
	expect(f.records.every((record) => record.kind === "intent")).toBe(true);
	expect(f.present.size).toBe(2);
	await expect(
		recoverAccount(
			"tama",
			new Map([["tama", (await f.options.open()).driver]]),
			f.options.journal,
			AbortSignal.timeout(1000),
		),
	).rejects.toThrow("no durable sandbox identity");

	for (const attempt of attempts) {
		expect(
			await recoverAllocatedIntent({
				directory: join(f.options.root, attempt.id),
				openDriver: async () => (await f.options.open()).driver,
				journal: f.options.journal,
				assertQuiescent: async () => {},
				signal: AbortSignal.timeout(10_000),
			}),
		).toMatchObject({ provider: "tama" });
	}
	// Every leaked sandbox is gone, the journal is consistent, and admission passes again.
	expect(f.present.size).toBe(0);
	expect(f.records.filter((record) => record.kind === "allocated")).toHaveLength(2);
	expect(f.records.filter((record) => record.kind === "released")).toHaveLength(2);
	await recoverAccount(
		"tama",
		new Map([["tama", (await f.options.open()).driver]]),
		f.options.journal,
		AbortSignal.timeout(1000),
	);
	// The original attempts stay failed; recovery never makes them publishable.
	expect(attempts.every((attempt) => attempt.outcome === "failed")).toBe(true);
});
