/**
 * Normalization pipeline: a raw `data/raw/<runId>/` tree → one validated {@link Run}. The tree has
 * one subdirectory per provider id; every file inside is routed through ./extract.ts. The output is
 * validated against the shared schema before it leaves this module — validation happens at the
 * producer boundary, so no malformed Run can reach a consumer. SDK-free — filesystem + schema only.
 */
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type {
	GapCause,
	HostMetadataRecord,
	MetricResult,
	ObservedSpecs,
	OffDimensionEmission,
	ProviderArtifactEvidence,
	ProviderCostEvidence,
	ProviderRun,
	ResultGap,
	Run,
	UncataloguedResult,
} from "@sandbox-benchmarks/schema";
import {
	aggregate,
	canonicalJsonEqual,
	deriveEconomics,
	describeOffDimensionEmission,
	FIO_SCENARIO_METRICS,
	getProvider,
	MAX_PROVIDER_ARTIFACT_EVIDENCE_FILE_BYTES,
	MAX_PROVIDER_COST_EVIDENCE_FILE_BYTES,
	METRIC_CATALOG,
	offDimensionEmissions,
	PROVIDERS,
	parseProviderArtifactEvidence,
	parseProviderCostEvidence,
	parseRun,
	providerArtifactEvidenceFile,
	providerCostCellKey,
	providerCostEvidenceFile,
	SUITE_NAMES,
	SUITES,
	TARGET_SPEC,
} from "@sandbox-benchmarks/schema";
import type { AttemptedEmptyResult, SampleContribution } from "./extract.ts";
import { extractProviderDir } from "./extract.ts";
import { readHostMetadata } from "./host-metadata.ts";
import { computeSpecMatched, readObservedSpecs } from "./specs.ts";

/** Read max+1 bytes from one descriptor, avoiding both unbounded allocation and stat/read races. */
function readEvidenceFile(path: string, maximumBytes: number): string {
	const descriptor = openSync(
		path,
		constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		if (!fstatSync(descriptor).isFile()) {
			throw new Error("evidence path is not a regular file");
		}
		const buffer = new Uint8Array(maximumBytes + 1);
		let length = 0;
		while (length < buffer.byteLength) {
			const count = readSync(descriptor, buffer, length, buffer.byteLength - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > maximumBytes) {
			throw new Error(`evidence file exceeds ${maximumBytes / 1024} KiB`);
		}
		return new TextDecoder().decode(buffer.subarray(0, length));
	} finally {
		closeSync(descriptor);
	}
}

export interface NormalizeInput {
	rawRoot: string;
	runId: string;
	sha: string;
	generatedAt: string;
	sourceRunUrl?: string;
	/** The replicate sandbox index this shard was run under (the `--replicate` argument), stamped onto
	 *  the shard Run so the aggregate can key its replicate breakdown. Absent for a non-replicate run. */
	replicateIndex?: number;
}

/** Normalize a whole raw tree into one validated Run — every known provider appears in every Run. */
export function normalizeResultsTree(input: NormalizeInput): Run {
	// Providers without results stay `pending`, which is itself a first-class fact the tool surfaces.
	const providers = [...PROVIDERS]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((meta) => normalizeProviderDir(input.rawRoot, meta.id));

	const candidate = {
		// Run v6 carries cost and artifact evidence on every provider row. This function also stamps
		// structured suite-gap causes (`shortfallCause`/`twinDropCause`), which `runSchema` gates at
		// v4-or-later — lowering this while
		// still emitting causes fails `parseRun`. A shard may also carry a replicateIndex (v3+) the
		// aggregate folds into MetricResult.replicates.
		schemaVersion: "6" as const,
		runId: input.runId,
		sha: input.sha,
		generatedAt: input.generatedAt,
		...(input.sourceRunUrl !== undefined ? { sourceRunUrl: input.sourceRunUrl } : {}),
		...(input.replicateIndex !== undefined ? { replicateIndex: input.replicateIndex } : {}),
		targetSpec: { ...TARGET_SPEC },
		providers,
	};

	try {
		return parseRun(candidate);
	} catch (err) {
		throw new Error(
			`Normalized Run for ${input.runId} failed schema validation: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** Element-wise sample equality — used to tell a benign duplicate from divergent contamination. */
function sameSamples(a: readonly number[], b: readonly number[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The result-prefix base implied by a catalogued metric's PTS test (`pts/git` → `pts_git`). */
function metricLeafBase(metricId: string): string | undefined {
	const test = METRIC_CATALOG.find((metric) => metric.id === metricId)?.pts?.test;
	const profile = test?.split("/").at(-1);
	return profile ? `pts_${profile}` : undefined;
}

/** Whether a bash marker names the PTS test that owns a metric. Scenario suffixes (fio/pgbench)
 *  still match their shared test base; the more exact ownership check below handles the suffix. */
function leafMatchesMetricTest(leaf: string, metricId: string): boolean {
	const base = metricLeafBase(metricId);
	return base !== undefined && (leaf === base || leaf.startsWith(`${base}-`));
}

/** Whether a failed leaf marker already accounts for this exact metric. Use catalog identity first,
 *  never the composite filename: PTS result-name contamination can put a PyBench Result in
 *  `pts_git.xml`, and the filename must not let a Git marker silence PyBench's independent loss. */
function leafOwnsMetric(leaf: string, metricId: string): boolean {
	const base = metricLeafBase(metricId);
	if (!base || !leafMatchesMetricTest(leaf, metricId)) return false;
	if (leaf === base) return true;

	// Multi-scenario leaves share one PTS profile. Match the leaf's scenario tokens against the stable
	// metric id so one fio/pgbench marker suppresses only its own scenario, not every result of the test.
	const aliases: Record<string, string> = { rand: "random", seq: "sequential" };
	const scenario = leaf
		.slice(base.length + 1)
		.split("-")
		.map((token) => aliases[token] ?? token);
	return scenario.every((token) => metricId.includes(`_${token}`));
}

/** Recover a legacy flat leaf marker's suite from the catalog contract. A mapping must be unique;
 *  unknown/ambiguous markers remain untouched rather than being guessed into the wrong suite. */
function suiteForLeaf(leaf: string): string | undefined {
	const matches = SUITE_NAMES.filter((suite) =>
		SUITES[suite].metrics.some((metricId) => leafMatchesMetricTest(leaf, metricId)),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The single owner of the suite-shortfall gap wording: declared metrics that were attempted (PTS ran
 * them) and produced no value in any trial. Byte-deterministic — sorted ids, stable filenames, no
 * timestamps — so the aggregate's (scope, id, outcome, reason) dedupe key folds identical shortfalls
 * across replicate shards instead of stacking one gap per replicate.
 */
export function shortfallReason(suite: string, missing: readonly AttemptedEmptyResult[]): string {
	const list = missing.map((e) => `${e.metricId} (${e.sourceFile})`).join(", ");
	return `PTS ran but every trial failed for ${missing.length} of ${declaredMetricCount(suite, missing.length)} declared metrics: ${list} — attempted, no value recorded`;
}

/**
 * How many metrics the suite declares — the denominator in the shortfall wording and cause. suiteDirs
 * only ever contains registered names, so the lookup can't miss in production; the fallback keeps the
 * pure helpers total for tests and future callers.
 */
function declaredMetricCount(suite: string, fallback: number): number {
	return (
		(SUITES as Partial<Record<string, { metrics: readonly string[] }>>)[suite]?.metrics.length ??
		fallback
	);
}

/**
 * The same shortfall as data. Emitted alongside {@link shortfallReason} so the two can never describe
 * different facts: one call site builds both from one input.
 */
export function shortfallCause(suite: string, missing: readonly AttemptedEmptyResult[]): GapCause {
	return {
		kind: "metrics-unrecorded",
		metricIds: missing.map((e) => e.metricId),
		declared: declaredMetricCount(suite, missing.length),
	};
}

/** A catalogued fio twin whose <Result> PTS omitted entirely; sourceFile carries the SURVIVING twin. */
export interface DroppedTwinResult {
	metricId: string;
	sourceFile: string;
}

/**
 * The single owner of the dropped-twin gap wording: a fio MB/s↔IOPS twin whose <Result> PTS's
 * result-parser silently dropped because its numeric values duplicated the surviving twin's
 * (MB/s == IOPS at this block size). Byte-deterministic — sorted ids, stable filenames — for the
 * same aggregate (scope, id, outcome, reason) dedupe reason as shortfallReason above.
 */
export function twinDropReason(dropped: readonly DroppedTwinResult[]): string {
	const list = dropped.map((d) => `${d.metricId} (twin survived in ${d.sourceFile})`).join(", ");
	return `PTS duplicate-value dedup dropped ${dropped.length} fio twin result${dropped.length === 1 ? "" : "s"} (MB/s == IOPS at this block size, so the duplicate-valued <Result> was never written): ${list}`;
}

/** The dropped-twin gap as data, built from the same input as {@link twinDropReason}. */
export function twinDropCause(dropped: readonly DroppedTwinResult[]): GapCause {
	return { kind: "duplicate-value-dedup", metricIds: dropped.map((d) => d.metricId) };
}

const TWIN_SUFFIXES = ["_mb_per_s", "_iops"] as const;
/**
 * PTS's duplicate-value drop requires the twins to be numerically EQUAL, which is structural only at
 * a 1MB block size (1 op == 1 MB, so MB/s == IOPS). At 4KB the two scales differ by 256x and can
 * never collide, so an absent 4KB sibling is some other pathology — inferring "duplicate-value
 * dedup" there would publish a false explanation.
 */
const TWIN_EQUALITY_MARKER = "_block_size_1mb_";

/**
 * fio twin pairs among a suite's declared metrics: two ids identical up to the _mb_per_s/_iops
 * suffix (one scenario+direct-mode measured on two scales), restricted to the 1MB block size where
 * the two scales are numerically equal and PTS's duplicate-value drop can actually fire. Derived
 * from the declaration — never a hardcoded pair list — so catalog changes (new scenarios, retired
 * probes) keep the check in sync. Sorted for a byte-stable gap reason.
 */
function twinPairs(declared: ReadonlySet<string>): Array<readonly [string, string]> {
	const [mbSuffix, iopsSuffix] = TWIN_SUFFIXES;
	const pairs: Array<readonly [string, string]> = [];
	for (const id of [...declared].sort((a, b) => a.localeCompare(b, "en"))) {
		if (!id.endsWith(mbSuffix) || !id.includes(TWIN_EQUALITY_MARKER)) continue;
		const iops = `${id.slice(0, -mbSuffix.length)}${iopsSuffix}`;
		if (declared.has(iops)) pairs.push([id, iops]);
	}
	return pairs;
}

/** Parse a JSON file, returning undefined (never throwing) when it's absent or malformed. */
function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Normalize one provider's raw directory into a ProviderRun (pending when the directory is absent). */
export function normalizeProviderDir(rawRoot: string, providerId: string): ProviderRun {
	const dir = join(rawRoot, providerId);
	// Single stat (not existsSync + statSync) so a directory removed between the two calls degrades to
	// `pending` instead of throwing ENOENT mid-normalization.
	let dirStat: ReturnType<typeof statSync> | undefined;
	try {
		dirStat = statSync(dir);
	} catch {
		dirStat = undefined;
	}
	if (!dirStat?.isDirectory()) {
		// No raw directory at all: the provider reported NOTHING — no result, not even a marker saying
		// why. That is a real hole, but not one this layer can describe: only the whole Run knows which
		// suites the other providers ran, and therefore which ones are missing here. Left as an empty
		// slice; `buildLeaderboard` derives the missing-suite gaps across providers.
		return {
			providerId,
			costEvidence: [],
			artifactEvidence: [],
			validationStatus: "pending",
			observedSpecs: {},
			metrics: [],
			suitesCovered: [],
			gaps: [],
			uncatalogued: [],
		};
	}

	// The raw tree tags results by suite (`<provider>/<suite>/`). Read each registered-suite
	// subdirectory on its own, so every produced metric can be attributed to — and contract-checked
	// against — the suite that wrote it. Also read any files directly under the provider dir: the older
	// un-nested layout, kept working for back-compat. extractProviderDir only reads files (it skips
	// subdirectories), so the flat read never double-counts a suite subdir's contents.
	const registered = new Set<string>(SUITE_NAMES);
	const suiteDirs: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (!entry.isDirectory()) continue;
		if (registered.has(entry.name)) {
			suiteDirs.push(entry.name);
			continue;
		}
		// An unexpected subdirectory can't be attributed to a suite, so it can't be contract-checked;
		// skip it loudly rather than silently fold its results into the provider untagged.
		console.warn(
			`[normalize] ${providerId}: ignoring subdirectory "${entry.name}" — not a registered suite`,
		);
	}

	const contributions: SampleContribution[] = [];
	const rawUncatalogued: UncataloguedResult[] = [];
	const gaps: ResultGap[] = [];
	// The positive record of coverage: a suite lands here iff it produced at least one catalogued Metric
	// for this provider. A suite directory that exists but yielded nothing (the run died mid-suite, or
	// every <Result> was empty) is NOT coverage — it is a hole with no marker, and recording the
	// directory instead of the metrics would hide exactly that case.
	const suitesCovered = new Set<string>();
	const offDimension: OffDimensionEmission[] = [];
	const hostMetadata: HostMetadataRecord[] = [];
	const costEvidence: ProviderCostEvidence[] = [];
	const artifactEvidence: ProviderArtifactEvidence[] = [];
	// Host fingerprint from a composite's <System>, first non-empty across the read order (all suites of
	// one provider ran on the same machine). Merged UNDER the spec probe below so the probe always wins.
	let systemHost: ObservedSpecs | undefined;
	// Per-suite shortfall candidates: declared metrics that were attempted (an all-passes-failed
	// <Result> is the evidence) and that no file in the suite produced a value for. Collected here,
	// emitted as at most ONE suite gap AFTER the flat read below, once every marker is in `gaps`.
	const suiteShortfalls = new Map<string, AttemptedEmptyResult[]>();
	// Which failed markers each suite carries, split by kind (recorded while folding below): a HARNESS
	// whole-suite marker mutes the suite's shortfall entirely, a folded LEAF marker mutes only its own
	// leaf's entries — one leaf's recorded failure must not hide a DIFFERENT leaf's silent loss.
	const foldedFailedLeaves = new Map<string, Set<string>>();
	const harnessFailedSuites = new Set<string>();
	// Per-suite dropped-twin candidates: declared fio twins whose <Result> is ABSENT (not empty)
	// while the other member of the pair produced a value — PTS's duplicate-value dedup signature.
	// Collected here, emitted as at most ONE suite gap after the loop, same as the shortfalls.
	const suiteTwinDrops = new Map<string, DroppedTwinResult[]>();

	for (const suite of suiteDirs) {
		const artifactPath = join(dir, suite, providerArtifactEvidenceFile());
		try {
			const evidence = parseProviderArtifactEvidence(
				readEvidenceFile(artifactPath, MAX_PROVIDER_ARTIFACT_EVIDENCE_FILE_BYTES),
			);
			if (evidence.cell.providerId !== providerId || evidence.cell.suite !== suite) {
				throw new Error(
					`artifact evidence identity mismatch: expected ${providerId}/${suite}, got ${evidence.cell.providerId}/${evidence.cell.suite}`,
				);
			}
			const duplicate = artifactEvidence.find(
				(record) => providerCostCellKey(record) === providerCostCellKey(evidence),
			);
			if (duplicate !== undefined) {
				if (!canonicalJsonEqual(duplicate, evidence)) {
					throw new Error(`conflicting artifact evidence for ${providerId}/${suite}`);
				}
			} else {
				artifactEvidence.push(evidence);
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(
					`invalid ${providerId}/${suite}/${providerArtifactEvidenceFile()}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const evidencePath = join(dir, suite, providerCostEvidenceFile());
		try {
			const evidence = parseProviderCostEvidence(
				readEvidenceFile(evidencePath, MAX_PROVIDER_COST_EVIDENCE_FILE_BYTES),
			);
			if (evidence.cell.providerId !== providerId || evidence.cell.suite !== suite) {
				throw new Error(
					`cost evidence identity mismatch: expected ${providerId}/${suite}, got ${evidence.cell.providerId}/${evidence.cell.suite}`,
				);
			}
			costEvidence.push(evidence);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(
					`invalid ${providerId}/${suite}/${providerCostEvidenceFile()}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const ext = extractProviderDir(join(dir, suite), providerId);
		for (const record of readHostMetadata(join(dir, suite))) {
			hostMetadata.push({ ...record, sourceFile: `${suite}/${record.sourceFile}` });
		}
		if (!systemHost && ext.observedHost) systemHost = ext.observedHost;
		// Runtime half of the contract: collect any catalogued metric this suite emitted on a Dimension it
		// does not declare. (Uncatalogued emissions are NOT breaches — they stay inert stragglers below.)
		offDimension.push(
			...offDimensionEmissions(
				suite,
				ext.contributions.map((c) => c.metricId),
			),
		);
		// Carry the suite in each result's provenance so a metric/straggler stays traceable to its source.
		for (const c of ext.contributions)
			contributions.push({ ...c, sourceFile: `${suite}/${c.sourceFile}` });
		for (const u of ext.uncatalogued)
			rawUncatalogued.push({ ...u, sourceFile: `${suite}/${u.sourceFile}` });
		if (ext.contributions.length > 0) suitesCovered.add(suite);
		// Bash leaf markers carry the LEAF name (pts_fio-rand-read) in `benchmark`; the Run vocabulary
		// (resultGapSchema) says a suite-scoped gap's id is the SUITE. Fold the leaf into the reason so
		// the leaderboard's missing-suite derivation (which treats suite-gap ids as suite names) can
		// neither fabricate a bogus 'suite' nor accuse healthy providers of missing it. Harness-written
		// markers already carry the suite name, so the fold is the identity for them. Which KIND of
		// failed marker each suite carries is remembered for the shortfall emission below: a folded
		// leaf failure must only mute that leaf's own shortfall entries, while a harness whole-suite
		// failure mutes the suite's shortfall entirely.
		for (const g of ext.gaps) {
			if (g.scope === "suite" && g.id !== suite) {
				if (g.outcome === "failed") {
					const leaves = foldedFailedLeaves.get(suite) ?? new Set<string>();
					leaves.add(g.id);
					foldedFailedLeaves.set(suite, leaves);
				}
				gaps.push({ ...g, id: suite, reason: `${g.id}: ${g.reason}` });
			} else {
				if (g.scope === "suite" && g.outcome === "failed") harnessFailedSuites.add(suite);
				gaps.push(g);
			}
		}
		// Shortfall evidence: declared metrics attempted-and-empty here, minus the ones some file in
		// this suite DID produce (a metric can fail in one composite and succeed in another). Unique by
		// metricId (first file wins — extraction order is filename-sorted, so deterministic), sorted so
		// the gap reason is byte-stable.
		const produced = new Set(ext.contributions.map((c) => c.metricId));
		const declared = new Set<string>(
			suite === "disk"
				? [...SUITES.disk.metrics, ...FIO_SCENARIO_METRICS]
				: ((SUITES as Partial<Record<string, { metrics: readonly string[] }>>)[suite]?.metrics ??
						[]),
		);
		const missingById = new Map<string, AttemptedEmptyResult>();
		for (const e of ext.attemptedEmpty) {
			if (!declared.has(e.metricId) || produced.has(e.metricId)) continue;
			if (!missingById.has(e.metricId)) {
				missingById.set(e.metricId, {
					metricId: e.metricId,
					sourceFile: `${suite}/${e.sourceFile}`,
				});
			}
		}
		if (missingById.size > 0) {
			suiteShortfalls.set(
				suite,
				[...missingById.values()].sort((a, b) => a.metricId.localeCompare(b.metricId, "en")),
			);
		}
		// Dropped-twin evidence: PTS's result-parser drops a <Result> whose numeric values duplicate an
		// earlier result's, and with 1MB blocks a fio scenario's MB/s equals its IOPS — so one twin
		// vanishes ENTIRELY (absent, not empty) and the attempted-and-empty evidence above never sees
		// it. The surviving twin IS the proof the scenario ran: exactly one member with a value, the
		// other with neither a value nor an empty Result, means dropped — not un-probed. BOTH twins
		// absent stays gap-free: that scenario was legitimately never run (the probe-subset rule).
		const attempted = new Set(ext.attemptedEmpty.map((e) => e.metricId));
		const dropped: DroppedTwinResult[] = [];
		for (const pair of twinPairs(declared)) {
			for (const [survivor, missing] of [pair, [pair[1], pair[0]]] as const) {
				if (!produced.has(survivor) || produced.has(missing) || attempted.has(missing)) continue;
				const source = ext.contributions.find((c) => c.metricId === survivor);
				// `produced` implies a contribution exists; the guard keeps this pass total (never throw).
				if (!source) continue;
				// A Result that failed catalog mapping is PRESENT, not a PTS duplicate-value omission. Be
				// conservative at the composite boundary: any unmapped Result beside the survivor makes the
				// exact cause ambiguous, so do not publish the stronger dedup explanation.
				if (ext.unmappedPts.some((result) => result.sourceFile === source.sourceFile)) continue;
				dropped.push({ metricId: missing, sourceFile: `${suite}/${source.sourceFile}` });
			}
		}
		if (dropped.length > 0) {
			suiteTwinDrops.set(
				suite,
				dropped.sort((a, b) => a.metricId.localeCompare(b.metricId, "en")),
			);
		}
	}
	// Reject at the boundary before any further work: a suite emitting a catalogued metric off its
	// declared Dimensions is a producer/registry drift that would land a number under the wrong
	// leaderboard axis. Fail the run with every such emission listed at once, rather than silently
	// ranking it — and before the flat read below, so the error path does no extra I/O.
	if (offDimension.length > 0) {
		const lines = offDimension.map((e) => `  - ${describeOffDimensionEmission(e)}`);
		throw new Error(
			`provider "${providerId}" emitted off-contract metrics (suite ↔ dimension ↔ metric contract):\n${lines.join("\n")}`,
		);
	}

	// Legacy flat files (no suite subdir): no suite to attribute to, so they can't be contract-checked —
	// and, for the same reason, they can't be credited to `suitesCovered`. A Run whose tree is entirely
	// flat therefore claims no suite coverage, which correctly makes the derived missing-suite gaps
	// empty (nothing is known to have run anywhere) rather than accusing every provider of a hole.
	const flat = extractProviderDir(dir, providerId);
	hostMetadata.push(...readHostMetadata(dir));
	contributions.push(...flat.contributions);
	rawUncatalogued.push(...flat.uncatalogued);
	for (const g of flat.gaps) {
		if (g.scope !== "suite") {
			gaps.push(g);
			continue;
		}
		// A flat HARNESS marker still names a registered suite and must suppress the suite directory's
		// duplicate shortfall. A flat bash LEAF marker has no directory context, so recover its suite
		// from the catalog's metric→PTS-test→suite contract and fold it exactly like a nested marker.
		const suite = registered.has(g.id) ? g.id : suiteForLeaf(g.id);
		if (!suite) {
			gaps.push(g);
			continue;
		}
		if (g.id === suite) {
			if (g.outcome === "failed") harnessFailedSuites.add(suite);
			gaps.push(g);
			continue;
		}
		if (g.outcome === "failed") {
			const leaves = foldedFailedLeaves.get(suite) ?? new Set<string>();
			leaves.add(g.id);
			foldedFailedLeaves.set(suite, leaves);
		}
		gaps.push({ ...g, id: suite, reason: `${g.id}: ${g.reason}` });
	}
	if (!systemHost && flat.observedHost) systemHost = flat.observedHost;
	// (flat.attemptedEmpty is deliberately unused: a legacy flat file has no suite to diff against,
	// exactly as it earns no suitesCovered credit above.)

	// Suite-shortfall gaps: an all-trials-failed PTS test exits 0 and writes a value-less composite,
	// which used to leave a green job with no metric AND no gap — an invisible hole (pgbench vanished
	// from three consecutive published runs this way). Emit at most ONE failed gap per suite, from the
	// EVIDENCE collected above (attempted-and-empty catalogued Results), never from expectations — so
	// disk's legitimately-unrun O_DIRECT/buffered twins and PTS's dropped-duplicate Results produce no
	// false gaps. Emitted after every marker is in `gaps`, with marker-kind-aware dedupe: a HARNESS
	// whole-suite failed marker mutes the suite's shortfall (the loss is already recorded wholesale); a
	// folded LEAF failed marker mutes only its OWN leaf's entries (its loss is recorded, but a
	// different leaf's silent loss in the same suite must still surface); a SKIP marker never
	// suppresses, because a deliberate non-run of one leaf must not hide that a different leaf was
	// attempted and lost. Entries whose metric a LEGACY FLAT file produced are dropped too — the
	// metric has a published value, so claiming it "produced no value" would contradict the dataset.
	// This check only pushes gaps and must NEVER throw: a normalize-time throw loses the whole shard
	// (how disk/modal-gvisor's valid hardlink metric was lost in run 29799034615).
	const producedAnywhere = new Set(contributions.map((c) => c.metricId));
	for (const suite of suiteDirs) {
		const collected = suiteShortfalls.get(suite);
		if (!collected) continue;
		if (harnessFailedSuites.has(suite)) continue;
		const mutedLeaves = foldedFailedLeaves.get(suite);
		const missing = collected.filter((e) => {
			if (producedAnywhere.has(e.metricId)) return false;
			if (!mutedLeaves) return true;
			return ![...mutedLeaves].some((leaf) => leafOwnsMetric(leaf, e.metricId));
		});
		if (missing.length === 0) continue;
		gaps.push({
			scope: "suite",
			id: suite,
			outcome: "failed",
			reason: shortfallReason(suite, missing),
			cause: shortfallCause(suite, missing),
		});
	}

	// Dropped-twin gaps: same shape as the shortfall above, but the lost <Result> is ABSENT rather
	// than empty, so it needs its own evidence (the surviving twin, collected per suite above). Same
	// suppression rules mirror shortfalls: a harness whole-suite failure mutes the suite, while a
	// folded leaf failure mutes only candidates from that same leaf. A different leaf's marker or
	// shortfall remains independent. Legacy flat-layout measurements also rescue a candidate because
	// the supposedly missing metric is present in the published output. This pass only pushes gaps.
	for (const suite of suiteDirs) {
		const collected = suiteTwinDrops.get(suite);
		if (!collected || harnessFailedSuites.has(suite)) continue;
		const mutedLeaves = foldedFailedLeaves.get(suite);
		const dropped = collected.filter((candidate) => {
			if (producedAnywhere.has(candidate.metricId)) return false;
			if (!mutedLeaves) return true;
			// Use the missing twin's catalogued test/scenario identity, not the survivor composite's
			// filename: result-name contamination can put a sequential Result in a random-read file, and
			// that misleading filename must not let the random-read marker hide a sequential twin loss.
			return ![...mutedLeaves].some((leaf) => leafOwnsMetric(leaf, candidate.metricId));
		});
		if (dropped.length === 0) continue;
		gaps.push({
			scope: "suite",
			id: suite,
			outcome: "failed",
			reason: twinDropReason(dropped),
			cause: twinDropCause(dropped),
		});
	}

	// De-dupe catalogued metrics by metricId across source files — keep the FIRST (deterministic file
	// order). In our model one <Result> owns a metric's per-pass samples, so the same metricId in two
	// files is a duplicate, not extra passes: real PTS producers that reuse TEST_RESULTS_NAME write the
	// same result into more than one composite (observed in runner-benchmarking's pts_git result, which
	// landed in both pts_git.xml and pts_compress_zstd.xml). Pooling the samples would inflate n and
	// distort the stddev, so drop the later copy and warn — louder when the samples diverge, which
	// signals genuine result-name contamination rather than a benign rewrite.
	const merged = new Map<
		string,
		{ samples: number[]; sourceFile: string; appVersion?: string; arguments?: string }
	>();
	for (const contribution of contributions) {
		const existing = merged.get(contribution.metricId);
		if (existing) {
			const diverged = !sameSamples(existing.samples, contribution.samples);
			console.warn(
				`[normalize] ${providerId}: metric "${contribution.metricId}" appears in both ` +
					`${existing.sourceFile} and ${contribution.sourceFile}` +
					(diverged
						? " with DIFFERENT samples — keeping the first (check for result-name contamination)"
						: " — keeping the first"),
			);
			continue;
		}
		merged.set(contribution.metricId, {
			samples: [...contribution.samples],
			sourceFile: contribution.sourceFile,
			appVersion: contribution.appVersion,
			arguments: contribution.arguments,
		});
	}
	const metrics: MetricResult[] = [...merged.entries()]
		// A metric must carry >=1 sample to aggregate (and to satisfy the schema). The extractor no
		// longer emits empty-sample contributions, but guard here too so a zero-sample metric is
		// dropped rather than throwing out of aggregate() before parseRun's try/catch can frame it.
		.filter(([, { samples }]) => samples.length > 0)
		.map(([metricId, { samples, sourceFile, appVersion, arguments: args }]) => ({
			metricId,
			samples,
			aggregates: aggregate(samples),
			sourceFile,
			...(appVersion !== undefined ? { appVersion } : {}),
			...(args !== undefined ? { arguments: args } : {}),
		}))
		.sort((a, b) => a.metricId.localeCompare(b.metricId));

	// Enrich a measured provider with derived economics ($/run): pricing × the runtime already on the
	// Run. Done here, AFTER the off-dimension contract check above, because economics is derived and
	// declared by no suite — running it through that check would flag it as off-contract. Gated on ≥1
	// measured Metric so economics enriches a `validated` provider and never promotes a `pending` one
	// (a provider with no real measurements has no economics either). An unknown/unpriced provider
	// yields no economics, so a null rate can never read as free.
	const meta = getProvider(providerId);
	if (meta && metrics.length > 0) {
		metrics.push(
			...deriveEconomics(
				meta,
				metrics.map((m) => ({ metricId: m.metricId, mean: m.aggregates.mean })),
			),
		);
		metrics.sort((a, b) => a.metricId.localeCompare(b.metricId));
	}

	// De-dupe uncatalogued stragglers by id for the same reason (a contaminating result leaks into every
	// composite it lands in); keep the first occurrence and preserve extraction order.
	const seenUncatalogued = new Set<string>();
	const uncatalogued: UncataloguedResult[] = [];
	for (const straggler of rawUncatalogued) {
		if (seenUncatalogued.has(straggler.id)) continue;
		seenUncatalogued.add(straggler.id);
		uncatalogued.push(straggler);
	}

	// Observed specs are per-sandbox; each suite ran in its own sandbox of the same provider, so the
	// readings describe the same machine. Prefer a suite subdirectory's file (the suite-scoped, current
	// layout) over a provider-dir file (legacy flat), so a stray legacy file can't shadow the tagged one.
	// `suiteDirs` is sorted, so when several suites carry one the alphabetically-first wins — an arbitrary
	// but deterministic tie-break, fine while suites share a provider's spec; revisit if tiers diverge.
	const specSources = [...suiteDirs, ""];
	const probeSpecs = readObservedSpecs((name) => {
		for (const sub of specSources) {
			const parsed = readJsonFile(join(dir, sub, name));
			if (parsed !== undefined) return parsed;
		}
		return undefined;
	});
	// Merge the <System> host fingerprint UNDER the in-sandbox spec probe: the probe owns the effective
	// fields (vcpus/memoryGb), and <System> only ever fills host-side fields, so the probe always wins on
	// overlap and a host disclosure can never masquerade as the sandbox's effective size.
	const observedSpecs: ObservedSpecs = { ...(systemHost ?? {}), ...probeSpecs };
	const specMatched = computeSpecMatched(observedSpecs);

	return {
		providerId,
		costEvidence,
		artifactEvidence,
		// A provider is validated exactly when it produced ≥1 catalogued Metric.
		validationStatus: metrics.length > 0 ? "validated" : "pending",
		...(specMatched !== undefined ? { specMatched } : {}),
		observedSpecs,
		...(hostMetadata.length > 0 ? { hostMetadata } : {}),
		metrics,
		suitesCovered: [...suitesCovered].sort((a, b) => a.localeCompare(b)),
		gaps,
		uncatalogued,
	};
}
