// Plan which PTS profiles a host warm must stage and install, derived from the suite registry plus
// leaf mining rather than a hard-coded profile list — the same sources ./suite-tasks.ts already uses
// to describe a suite, so a leaf that starts pinning a new profile is warmed without editing a list
// here. Callers select suites by preset (`all` / `synthetic` / `realworld`) or by concrete name.
//
// Planning only: nothing here touches PTS or the filesystem beyond reading in-repo files, so the
// whole plan is inspectable with `warm-pts --dry-plan` before a minute of compile time is spent.
// Staging and installing live in ./pts-warm-bench.ts.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SuiteName } from "@sandbox-benchmarks/schema";
import { SUITE_NAMES, SUITES, suiteNameSchema } from "@sandbox-benchmarks/schema";
import { type } from "arktype";
import type { DownloadSeed } from "./suite-tasks.ts";
import {
	describeSuiteTasks,
	downloadSeedSchema,
	realworldOverlaysFromBenchSh,
	warmHintsFromScript,
} from "./suite-tasks.ts";

/** Presets expand to one or more registered PTS-backed suites. */
export const warmSuitePresetSchema = type("'all' | 'synthetic' | 'realworld'");
export type WarmSuitePreset = typeof warmSuitePresetSchema.infer;

/** One selection token: a preset or a concrete suite name. Parsed at the argv boundary. */
export const warmSuiteTokenSchema = warmSuitePresetSchema.or(suiteNameSchema);
export type WarmSuiteToken = typeof warmSuiteTokenSchema.infer;

/** Which preset a PTS-backed suite belongs to. Non-PTS suites warm nothing and return null. */
export type SuiteWarmKind = "synthetic" | "realworld";

export function suiteWarmKind(name: string): SuiteWarmKind | null {
	if (!(name in SUITES)) return null;
	const suite = SUITES[name as SuiteName];
	if (!suite.setupPts) return null;
	return name.startsWith("realworld") ? "realworld" : "synthetic";
}

/**
 * Expand selection tokens into a stable, de-duplicated suite list in registry order.
 * Empty input defaults to `synthetic`. Unknown tokens fail at the arktype parse.
 */
export function resolveWarmSuites(tokens: readonly string[] = []): SuiteName[] {
	const effective = tokens.length > 0 ? tokens : (["synthetic"] satisfies WarmSuiteToken[]);
	const selected = new Set<SuiteName>();

	for (const raw of effective) {
		const token = warmSuiteTokenSchema(raw);
		if (token instanceof type.errors) {
			throw new Error(`invalid warm suite token: ${token.summary} (see --list-suites)`);
		}
		if (token === "all" || token === "synthetic" || token === "realworld") {
			for (const name of SUITE_NAMES) {
				const kind = suiteWarmKind(name);
				if (kind && (token === "all" || kind === token)) selected.add(name);
			}
			continue;
		}
		// A concrete suite name — rejected here rather than planned to an empty target set, which
		// would read as "already warm" when it means "this suite runs no PTS profile".
		if (!suiteWarmKind(token)) {
			throw new Error(`suite ${JSON.stringify(token)} is not PTS-backed (setupPts)`);
		}
		selected.add(token);
	}

	const suites = SUITE_NAMES.filter((name) => selected.has(name));
	if (suites.length === 0) throw new Error("warm suite selection resolved to an empty set");
	return suites;
}

/** A repo-local profile to stage before install, with the overlay files it needs alongside it. */
export interface LocalProfileInstall {
	name: string;
	/** Repo-relative overlay files copied into the staged profile (realworld runner/install). */
	overlays: string[];
}

/** One profile to install, carrying the compile env its own leaf pins — never a neighbour's. */
export interface WarmTarget {
	/** `pts/<name>` or `local/<name>`, as PTS names it. */
	id: string;
	/**
	 * `CFLAGS_OVERRIDE` the leaf that pins this profile exports, per ISA branch.
	 *
	 * Per target, not per plan: `CFLAGS_OVERRIDE` is read by every profile's `install.sh`, and the
	 * vendored iperf install.sh explicitly lets a caller's value win over its deliberately generic
	 * `-O3`. One batch-install carrying STREAM's `-march=native` would therefore rebuild iperf as a
	 * native binary — the exact thing that profile's repair exists to prevent, and a SIGILL waiting
	 * for the first host with a narrower ISA than the one that warmed the snapshot.
	 */
	cflagsOverride?: { native: string; gvisor: string };
}

/** Everything a warm run needs, planned before it touches PTS. */
export interface PtsWarmPlan {
	/** Resolved suites, in registry order. */
	suites: SuiteName[];
	/** Profiles this warm installs and then verifies. */
	targets: WarmTarget[];
	localInstalls: LocalProfileInstall[];
	/**
	 * `pts/<name>` profiles a leaf re-stages with `install_vendored_pts_profile` at run time.
	 *
	 * Installing these here is wasted work: that helper unconditionally `rm -rf`s the installed tree
	 * so `run_pts_benchmark` rebuilds the vendored override, which is the whole point of the
	 * override. Their source tarball still gets seeded, and the download cache does survive the
	 * discard — so the warm buys the download for them, never the build.
	 */
	restagedByLeaf: string[];
	seeds: DownloadSeed[];
}

/**
 * Load and parse a `host-seed.json` sitting beside a vendored profile.
 *
 * These exist for profiles whose leaf plants no seed of its own but whose upstream download host is
 * unreliable (fio's `brick.kernel.dk`), so a warm on a host with no baked download cache has a
 * mirror to fall back to.
 */
export function loadHostSeedJson(path: string): DownloadSeed {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(
			`invalid host-seed.json at ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const parsed = downloadSeedSchema(raw);
	if (parsed instanceof type.errors) {
		throw new Error(`invalid host-seed.json at ${path}: ${parsed.summary}`);
	}
	return parsed;
}

function profileDirForTarget(root: string, target: string): string | undefined {
	if (target.startsWith("local/")) {
		return resolve(root, "packages/schema/src/pts-profiles/local", target.slice("local/".length));
	}
	if (target.startsWith("pts/")) {
		return resolve(root, "packages/schema/src/pts-profiles", target.slice("pts/".length));
	}
	return undefined;
}

function readTaskScript(root: string, relFile: string): string | undefined {
	if (!relFile) return undefined;
	try {
		return readFileSync(resolve(root, relFile), "utf8");
	} catch {
		return undefined;
	}
}

export interface PlanPtsWarmOptions {
	/** Preset and/or suite-name tokens; empty → `synthetic`. */
	suites?: readonly string[];
}

/**
 * Build a warm plan for the selected suites from {@link SUITES} plus leaf mining.
 * Seeds prefer a leaf's own `seed_pts_download_cache` call; `host-seed.json` fills the gaps.
 */
export async function planPtsWarm(
	root: string = process.cwd(),
	options: PlanPtsWarmOptions = {},
): Promise<PtsWarmPlan> {
	const suites = resolveWarmSuites(options.suites ?? []);

	const targets = new Map<string, WarmTarget>();
	const localNames = new Set<string>();
	const restagedByLeaf = new Set<string>();
	const seedsByFile = new Map<string, DownloadSeed>();

	let realworldOverlays: string[] = [];
	try {
		const benchSh = readFileSync(resolve(root, "lib/bench.sh"), "utf8");
		realworldOverlays = realworldOverlaysFromBenchSh(benchSh);
	} catch {
		// Overlays are optional enrichment; a realworld warm without them fails batch-install loudly.
	}

	for (const suite of suites) {
		const plan = await describeSuiteTasks(suite, root);
		for (const task of plan.tasks) {
			const ids = task.ptsProfile
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const script = readTaskScript(root, task.file);
			const hints = script ? warmHintsFromScript(script) : undefined;
			for (const id of ids) {
				// The flags belong to the leaf that pins this profile, so they reach this profile's
				// install.sh and no other. A second leaf pinning the same profile with different flags
				// would be a genuine ambiguity, so refuse rather than let install order decide.
				const existing = targets.get(id);
				const cflagsOverride = hints?.cflagsOverride;
				if (existing?.cflagsOverride && cflagsOverride) {
					if (existing.cflagsOverride.native !== cflagsOverride.native) {
						throw new Error(
							`leaves pin conflicting CFLAGS_OVERRIDE for ${id}: ` +
								`${existing.cflagsOverride.native} vs ${cflagsOverride.native}`,
						);
					}
					continue;
				}
				targets.set(id, { id, ...(cflagsOverride ? { cflagsOverride } : {}) });
			}
			if (!hints) continue;
			for (const name of hints.localProfiles) localNames.add(name);
			for (const name of hints.vendoredProfiles) restagedByLeaf.add(name);
			for (const seed of hints.seeds) {
				// First leaf wins; later duplicates (iperf localhost + wan) are identical.
				if (!seedsByFile.has(seed.filename)) seedsByFile.set(seed.filename, seed);
			}
		}
	}

	// A profile the leaf re-stages is seeded but never installed here (see PtsWarmPlan.restagedByLeaf).
	for (const name of restagedByLeaf) targets.delete(`pts/${name}`);

	for (const id of targets.keys()) {
		if (id.startsWith("local/")) localNames.add(id.slice("local/".length));
	}
	// Seeds attach to every profile the plan knows of, restaged ones included: the download cache is
	// the one thing a leaf's re-stage does not discard, so seeding it is the warm those profiles get.
	for (const id of [...targets.keys(), ...[...restagedByLeaf].map((name) => `pts/${name}`)]) {
		const dir = profileDirForTarget(root, id);
		if (!dir) continue;
		const hostSeedPath = join(dir, "host-seed.json");
		if (!existsSync(hostSeedPath)) continue;
		const seed = loadHostSeedJson(hostSeedPath);
		if (!seedsByFile.has(seed.filename)) seedsByFile.set(seed.filename, seed);
	}

	const localInstalls: LocalProfileInstall[] = [...localNames].sort().map((name) => ({
		name,
		overlays: name.startsWith("realworld-") ? [...realworldOverlays] : [],
	}));

	return {
		suites,
		targets: [...targets.values()].sort((a, b) => a.id.localeCompare(b.id)),
		localInstalls,
		restagedByLeaf: [...restagedByLeaf].sort(),
		seeds: [...seedsByFile.values()].sort((a, b) => a.filename.localeCompare(b.filename)),
	};
}

/** Human-readable catalog for `--list-suites`. */
export function formatWarmSuiteCatalog(): string {
	const lines = [
		"Presets:",
		"  all         every PTS-backed suite (synthetic + realworld)",
		"  synthetic   non-realworld PTS suites (includes pgbench)",
		"  realworld   realworld-* PTS suites",
		"",
		"Suites:",
	];
	for (const name of SUITE_NAMES) {
		const mark = suiteWarmKind(name) ?? "skip (no setupPts)";
		lines.push(`  ${name.padEnd(24)} ${mark.padEnd(10)} ${SUITES[name].commands.join("; ")}`);
	}
	return lines.join("\n");
}
