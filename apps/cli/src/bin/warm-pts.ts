#!/usr/bin/env bun
// `warm-pts` — pre-install the Phoronix Test Suite profiles a selection of suites runs, so a later
// `mise run benchmark:…` on this host spends its wall time on measurement rather than on downloading
// and compiling (git ~450 MB, plus the fio / STREAM / pgbench / realworld source builds). Profiles
// that leaves deliberately re-stage, currently iperf, get their downloads seeded but build at run time.
//
// This is the HOST lane. Provider sandboxes get the same profiles baked into the toolchain image
// (packages/templates/images/base/scripts/25-pts-profiles.sh); a dev VM has no such image, so a
// snapshot of one is only as useful as what has been warmed into it.
//
// What to install is PLANNED, never listed here: ../lib/pts-warm.ts derives targets, staging and
// download-cache seeds from the suite registry and the leaves themselves, so a leaf that pins a new
// profile is warmed with no edit to this bin. Staging then calls the same `lib/bench.sh` helpers the
// leaves call. Idempotent; the first-time PTS apt install needs `SUDO=sudo`.
//
// Usage:
//   bun apps/cli/src/bin/warm-pts.ts --list-suites
//   SUDO=sudo bun apps/cli/src/bin/warm-pts.ts --suite synthetic   # default when none given
//   SUDO=sudo bun apps/cli/src/bin/warm-pts.ts --suite all         # synthetic + realworld
//   SUDO=sudo bun apps/cli/src/bin/warm-pts.ts -s disk -s memory
//   bun apps/cli/src/bin/warm-pts.ts --dry-plan --suite network    # print the plan, install nothing
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SUITES } from "@sandbox-benchmarks/schema";
import { logInfo } from "../lib/actions-log.ts";
import type { WarmTarget } from "../lib/pts-warm.ts";
import { formatWarmSuiteCatalog, planPtsWarm } from "../lib/pts-warm.ts";
import {
	batchInstall,
	discardInstallTree,
	ensurePts,
	hostIsGvisor,
	installLocalPtsProfile,
	installPayloadProblem,
	listInstalledTests,
	seedPtsDownloadCache,
} from "../lib/pts-warm-bench.ts";

// apps/cli/src/bin → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../..");

/** `ensure_pts` apt-installs these alongside PTS; a leaf that lacks one skips instead of measuring. */
const REQUIRED_BINS = ["stress-ng", "nc", "jq", "php"] as const;

interface Options {
	/** Preset and/or suite-name tokens; empty defers to the planner's `synthetic` default. */
	readonly suites: string[];
	readonly dryPlan: boolean;
	readonly listSuites: boolean;
}

function usage(): string {
	return [
		"usage: warm-pts [--suite <preset|name>]... [--dry-plan] [--list-suites]",
		"",
		"  --suite, -s <token>   preset (all|synthetic|realworld) or suite name; repeatable",
		"                        (also accepted as a positional argument; default: synthetic)",
		"  --dry-plan            print the planned warm as JSON and exit",
		"  --list-suites         print presets + registered suites and exit",
		"",
		"  SUDO=sudo             required for the first-time PTS apt install",
	].join("\n");
}

/** Parse argv, rejecting anything ambiguous rather than guessing. Suite tokens themselves are
 *  parsed against the registry by {@link planPtsWarm}, which owns the preset vocabulary. */
export function parseArgs(argv: readonly string[]): Options {
	const suites: string[] = [];
	let dryPlan = false;
	let listSuites = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (arg === "--dry-plan") {
			dryPlan = true;
			continue;
		}
		if (arg === "--list-suites") {
			listSuites = true;
			continue;
		}
		if (arg === "--suite" || arg === "-s") {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
			suites.push(next);
			index++;
			continue;
		}
		if (arg.startsWith("--suite=")) {
			const value = arg.slice("--suite=".length);
			if (!value) throw new Error("--suite= needs a value");
			suites.push(value);
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`unexpected argument ${arg}`);
		suites.push(arg);
	}
	return { suites, dryPlan, listSuites };
}

/**
 * Where the completion stamp for this selection lives.
 *
 * Keyed on the RESOLVED suites, not the tokens typed: `-s disk -s memory`, `-s memory -s disk` and a
 * future preset covering both are the same warm, and three stamps for one state would each report a
 * warm that the other two already did.
 */
export function stampPath(suites: readonly string[]): string {
	const key = suites.join("+").replaceAll(/[^a-z0-9._+-]+/gi, "_") || "synthetic";
	return join(homedir(), ".cache/sandbox-benchmarks", `pts-warm-${key}.stamp`);
}

async function main(options: Options): Promise<void> {
	if (options.listSuites) {
		console.log(formatWarmSuiteCatalog());
		return;
	}

	const plan = await planPtsWarm(REPO_ROOT, { suites: options.suites });

	if (options.dryPlan) {
		// The one stdout contract this bin has: `--dry-plan` prints the plan and nothing else, so it
		// can be diffed or piped. Progress logging goes to stderr via logInfo.
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	if (plan.targets.length === 0) {
		throw new Error(
			`warm plan for ${plan.suites.join(",")} has no PTS targets — check suite leaves`,
		);
	}
	logInfo(
		`warm suites=${plan.suites.join(",")} targets=${plan.targets.length} ` +
			`local=${plan.localInstalls.length} seeds=${plan.seeds.length} ` +
			`restaged-by-leaf=${plan.restagedByLeaf.length}`,
	);

	await ensurePts(REPO_ROOT);
	const missing = REQUIRED_BINS.filter((bin) => Bun.which(bin) === null);
	if (missing.length > 0) {
		throw new Error(
			`missing tools ensure_pts installs: ${missing.join(" ")} — re-run with SUDO=sudo`,
		);
	}

	for (const seed of plan.seeds) {
		logInfo(`seed download-cache: ${seed.filename}`);
		await seedPtsDownloadCache(REPO_ROOT, seed.filename, seed.sha256, seed.urls);
	}
	for (const name of plan.restagedByLeaf) {
		logInfo(`seed only, install left to the leaf's re-stage: pts/${name}`);
	}

	for (const install of plan.localInstalls) {
		logInfo(`stage local profile: ${install.name}`);
		await installLocalPtsProfile(REPO_ROOT, install.name, install.overlays);
	}

	const installed = await listInstalledTests(REPO_ROOT);
	const pending: WarmTarget[] = [];
	for (const target of plan.targets) {
		if (installed.has(target.id)) {
			logInfo(`already installed: ${target.id}`);
			continue;
		}
		await discardInstallTree(REPO_ROOT, target.id);
		pending.push(target);
	}

	if (pending.length === 0) {
		logInfo("all planned profiles already installed");
	} else {
		// One batch per distinct compile env. CFLAGS_OVERRIDE reaches every install.sh in a batch, so
		// profiles that pin nothing must not inherit a neighbour's flags (see WarmTarget.cflagsOverride).
		const gvisor = hostIsGvisor();
		const batches = new Map<string, string[]>();
		for (const target of pending) {
			const cflags = target.cflagsOverride
				? gvisor
					? target.cflagsOverride.gvisor
					: target.cflagsOverride.native
				: "";
			const batch = batches.get(cflags);
			if (batch) batch.push(target.id);
			else batches.set(cflags, [target.id]);
		}
		for (const [cflags, ids] of batches) {
			if (cflags) logInfo(`CFLAGS_OVERRIDE=${cflags} for ${ids.join(" ")}`);
			await batchInstall(REPO_ROOT, ids, cflags ? { CFLAGS_OVERRIDE: cflags } : {});
		}
	}

	// PTS's batch-install exits 0 for a profile that failed to build, and marks a profile installed
	// on nothing more than the launcher its install.sh wrote — so registration is checked AND the
	// tree is probed for the failure log and the payload (see installPayloadProblem).
	const afterInstall = await listInstalledTests(REPO_ROOT);
	const failed: string[] = [];
	for (const target of plan.targets) {
		if (!afterInstall.has(target.id)) {
			failed.push(`${target.id} (not installed)`);
			continue;
		}
		const problem = await installPayloadProblem(REPO_ROOT, target.id);
		if (problem) failed.push(`${target.id} (${problem})`);
	}
	if (failed.length > 0) throw new Error(`warm incomplete — ${failed.join(", ")}`);

	const stamp = stampPath(plan.suites);
	mkdirSync(dirname(stamp), { recursive: true });
	writeFileSync(
		stamp,
		`${new Date().toISOString()}\nsuites=${plan.suites.join(",")}\n` +
			`targets=${plan.targets.map((target) => target.id).join(" ")}\n`,
	);
	logInfo(`warm complete: ${plan.targets.map((target) => target.id).join(" ")}`);
	logInfo(`stamp: ${stamp}`);
	for (const suite of plan.suites) {
		for (const command of SUITES[suite].commands) logInfo(`  ${command}`);
	}
}

if (import.meta.main) {
	let options: Options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error(usage());
		process.exit(1);
	}
	try {
		await main(options);
	} catch (err) {
		// A warm failure is a host problem (no sudo, a dead mirror, a build that will not compile),
		// not a usage one — printing the flag list over it buries the message that matters.
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
