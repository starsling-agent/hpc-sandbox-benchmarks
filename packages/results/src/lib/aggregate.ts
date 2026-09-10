/**
 * Aggregate the per-shard {@link Run}s of one benchmark run into a single published Run. The CI matrix
 * fans out one job per `(provider, suite, replicate)` cell, each emitting a Run document where only that
 * cell's provider/suite carries data (and, on a v3 shard, its {@link Run.replicateIndex}). This merges
 * them back into the one Run the dataset publishes: each provider's measured Metrics unioned across
 * suites, coverage/gaps/uncatalogued/observed-specs combined, and — critically — economics RE-DERIVED
 * from the merged measured set so `usd_per_lifecycle` reflects every suite's timings, not whichever shard
 * happened to carry them.
 *
 * Replicate sandboxes report the SAME metric id (they ran the same suite), so the merge folds them by id:
 * ≥2 replicate slices of one metric become a {@link MetricResult.replicates} breakdown with a pooled
 * `samples`/`aggregates` recomputed across all of them, while a metric seen in a single replicate is kept
 * verbatim (the R = 1 path — byte-identical to the pre-replicate merge). A repeated id WITHIN one
 * replicate is still a duplicate (result-name contamination), so first-wins survives at that level.
 *
 * SDK-free — schema + the Run model only. Validates the result at the boundary (parseRun), so an
 * inconsistent merge fails here rather than reaching a consumer.
 */
import type {
	GapCause,
	MetricReplicate,
	MetricResult,
	ObservedSpecs,
	ProviderArtifactEvidence,
	ProviderCostEvidence,
	ProviderRun,
	ResultGap,
	Run,
	TargetSpec,
	UncataloguedResult,
} from "@sandbox-benchmarks/schema";
import {
	aggregate,
	canonicalJsonString,
	deriveEconomics,
	getProvider,
	isDerivedMetric,
	PROVIDER_EVIDENCE_JSON_LIMITS,
	parseRun,
	providerCostCellKey,
	providerReportedNothing,
} from "@sandbox-benchmarks/schema";
import type { HostMetadataRecordInput, ObservedMixtureIds } from "./observed-mixtures.ts";
import {
	buildObservedMixtures,
	foldHostMetadata,
	observedMixtureIds,
	representativeSpecs,
} from "./observed-mixtures.ts";

/**
 * Field separator for the composite dedupe keys below. A NUL can't occur in a suite name, a reason, or
 * an error message, so it can't be forged into a collision by real data — and it is written as an escape
 * rather than a literal control character in a template string (which makes git read the file as binary).
 */
const NUL = "\u0000";

/** One provider's slice from one shard, tagged with the replicate sandbox the shard was measured under. */
interface ReplicateSlice {
	slice: ProviderRun;
	replicateIndex: number;
}

/**
 * Fold one metric id's per-replicate slices into a single {@link MetricResult}. A single replicate is
 * returned verbatim (the R = 1 path stays byte-identical to the old first-wins union). Two or more become
 * a {@link MetricResult.replicates} breakdown — replicates ordered by index, `samples` the pooled union
 * in that order, `aggregates` recomputed over the pool — so the cluster structure survives for the
 * hierarchical-bootstrap inference while the pooled median stays the ranking value. Provenance
 * (`sourceFile`/`appVersion`/`arguments`) is carried from the lowest-index replicate.
 */
function mergeMetricReplicates(byReplicate: Map<number, ReplicateContribution>): MetricResult {
	const indices = [...byReplicate.keys()].sort((a, b) => a - b);
	const only = byReplicate.get(indices[0] as number) as ReplicateContribution;
	const first = only.metric;
	// R = 1: no replicate structure to hold the attribution (the schema keeps `replicates` for ≥2
	// clusters), so the ids go on the Metric itself — one sandbox produced every Sample, so naming one
	// machine is exactly true. Without this the join went missing precisely where the breakdown is
	// absent, and a provider whose suites each landed a single sandbox published its mixtures with
	// nothing pointing at any of them. Spread into a NEW object: `first` belongs to the caller's shard.
	if (indices.length === 1) return { ...first, ...only.ids };

	const replicates: MetricReplicate[] = indices.map((index) => {
		const contribution = byReplicate.get(index) as ReplicateContribution;
		return {
			index,
			samples: [...contribution.metric.samples],
			// The join to observedMixtures: which machine and network produced THIS cluster. Spread so a
			// category the sandbox disclosed nothing for stays absent rather than becoming a dangling key.
			...contribution.ids,
		};
	});
	const pooled = replicates.flatMap((r) => r.samples);
	// Spread `first` so every provenance field (sourceFile/appVersion/arguments — and any future optional
	// MetricResult field) is carried from the lowest-index replicate without re-listing the schema here,
	// then override the pooled fields. A shard's `first` never carries `replicates`, so this is byte-
	// identical to the old field-by-field build today and stays correct if MetricResult gains a field.
	return {
		...first,
		samples: pooled,
		aggregates: aggregate(pooled),
		replicates,
	};
}

/**
 * A cause's comparison key, with its keys in a FIXED order rather than the order the producing site
 * happened to write them in. Every `GapCause` arm is a flat record of scalars, so listing the sorted
 * top-level keys canonicalizes it completely — the same discipline `observed-mixtures` applies before
 * hashing, for the same reason: a key order that drifts at a construction site would otherwise put shard
 * arrival order back into the published document through the tie-break below.
 */
function causeKey(cause: GapCause): string {
	return JSON.stringify(cause, Object.keys(cause).sort());
}

/**
 * Whether `next` should replace `current` as a gap's cause: any classification beats none, and between
 * two classifications the canonically smaller wins so the choice never depends on shard arrival order.
 */
function preferCause(current: GapCause | undefined, next: GapCause): boolean {
	if (current === undefined) return true;
	return causeKey(next) < causeKey(current);
}

/** One replicate's contribution to a metric, with the mixture ids of the sandbox that produced it. */
interface ReplicateContribution {
	metric: MetricResult;
	ids: ObservedMixtureIds;
}

/**
 * Fold across shards by the rule the whole merge uses for a verdict: a single `false` is sticky, a
 * `true` stands only while nothing contradicts it, and all-undefined stays undefined ("refuse to judge
 * on partial evidence", see computeSpecMatched).
 *
 * Order-independent by construction, which matters because shard arrival order is not deterministic —
 * an earlier first-shard-wins version made ranking eligibility depend on it.
 */
function foldVerdict(current: boolean | undefined, next: boolean | undefined): boolean | undefined {
	if (next === false || current === false) return false;
	return next === true ? true : current;
}

/** Merge one provider's slices across every replicate shard that carried it. */
function mergeProvider(
	providerId: string,
	entries: readonly ReplicateSlice[],
	targetSpec: TargetSpec,
	emitArtifactEvidence: boolean,
): ProviderRun {
	// Group measured metrics by id, then by the replicate that produced them, carrying that sandbox's
	// mixture ids in the SAME record. A metric id recurring across replicate shards is R distinct
	// sandboxes (folded into the replicate structure below); a metric id recurring WITHIN one replicate is
	// a duplicate (one <Result> owns a metric's samples — result-name contamination), so first-wins
	// survives at the per-replicate level. Keeping the ids alongside the metric rather than in a parallel
	// map makes "the attribution describes the sandbox the samples came from" structural.
	//
	// Keyed per METRIC, not per provider: a replicate index is scoped to its cell, so (system, r0) and
	// (disk, r0) are two different sandboxes that may well have landed on different machines. A
	// provider-wide index→machine map would silently attribute one suite's samples to another suite's host.
	const byMetric = new Map<string, Map<number, ReplicateContribution>>();
	const gapByKey = new Map<string, ResultGap>();
	// Coverage unions across shards: the matrix fans out one job per (provider, suite) and that job writes
	// one shard per replicate sandbox, so each shard sees only its own cell+replicate. A suite is covered
	// for this provider iff SOME shard produced a Metric for it.
	const suitesCovered = new Set<string>();
	const uncatalogued: UncataloguedResult[] = [];
	const seenStraggler = new Set<string>();
	let specMatched: boolean | undefined;
	// One reading per SANDBOX, for the mixture tally. Only slices carrying participation evidence count:
	// the normalizer emits a zero-evidence placeholder ProviderRun for every registered provider in
	// EVERY shard, so counting slices naively would set the denominator to "every shard in the run" and
	// report a 3-sandbox provider as having 60-odd blind sandboxes. A slice with a gap but no metric IS a
	// real report (a skipped or failed-to-create sandbox is a sandbox the provider was asked for), so the
	// predicate is participation evidence, not measurement.
	const sandboxSpecReadings: ObservedSpecs[] = [];
	// One entry per (record, sandbox), folded below. Collected raw rather than deduped here because the
	// fold needs the machine each record was read on, which only the slice knows.
	const hostMetadataInputs: HostMetadataRecordInput[] = [];
	const evidenceByCell = new Map<string, ProviderCostEvidence>();
	const sandboxCells = new Map<string, string>();
	const artifactByCell = new Map<string, ProviderArtifactEvidence>();
	const artifactSandboxCells = new Map<string, string>();

	// ONE pass over the slices. The mixture ids are two sha256 hashes per slice, and a real run merges
	// ~470 slices per provider (the normalizer's placeholder rows included), so deriving them once here
	// rather than once per consumer loop is the difference between ~940 hashes and ~2,800.
	for (const { slice, replicateIndex } of entries) {
		const ids = observedMixtureIds(slice.observedSpecs);
		if (!providerReportedNothing(slice)) sandboxSpecReadings.push(slice.observedSpecs);
		// Preserve the complete provider probe record here: foldHostMetadata removes only volatile
		// timestamps, so exact isolation fields (runtime, VMM, confidence, scores, and evidence)
		// remain available to figure generation after shards are merged.
		for (const record of slice.hostMetadata ?? []) hostMetadataInputs.push({ record, ids });
		for (const record of slice.costEvidence ?? []) {
			const key = providerCostCellKey(record);
			const existing = evidenceByCell.get(key);
			// Canonicalization is needed only for duplicate candidates; one-record cells stay on the
			// allocation-free common path.
			if (existing !== undefined) {
				if (
					canonicalJsonString(existing, PROVIDER_EVIDENCE_JSON_LIMITS) !==
					canonicalJsonString(record, PROVIDER_EVIDENCE_JSON_LIMITS)
				) {
					throw new Error(`aggregateRuns: conflicting provider cost evidence for cell ${key}`);
				}
			} else {
				evidenceByCell.set(key, record);
			}
			const sandboxId = record.subject.sandboxId;
			if (sandboxId !== undefined) {
				const priorCell = sandboxCells.get(sandboxId);
				if (priorCell !== undefined && priorCell !== key) {
					throw new Error(
						`aggregateRuns: provider cost sandbox ${sandboxId} is reused across cells`,
					);
				}
				sandboxCells.set(sandboxId, key);
			}
		}
		for (const record of slice.artifactEvidence ?? []) {
			const key = providerCostCellKey(record);
			const existing = artifactByCell.get(key);
			if (existing !== undefined) {
				if (
					canonicalJsonString(existing, PROVIDER_EVIDENCE_JSON_LIMITS) !==
					canonicalJsonString(record, PROVIDER_EVIDENCE_JSON_LIMITS)
				) {
					throw new Error(`aggregateRuns: conflicting provider artifact evidence for cell ${key}`);
				}
			} else {
				artifactByCell.set(key, record);
			}
			const priorCell = artifactSandboxCells.get(record.sandboxId);
			if (priorCell !== undefined && priorCell !== key) {
				throw new Error(
					`aggregateRuns: provider artifact sandbox ${record.sandboxId} is reused across cells`,
				);
			}
			artifactSandboxCells.set(record.sandboxId, key);
		}
		for (const suite of slice.suitesCovered) suitesCovered.add(suite);

		for (const metric of slice.metrics) {
			if (isDerivedMetric(metric)) continue;
			let byReplicate = byMetric.get(metric.metricId);
			if (!byReplicate) {
				byReplicate = new Map<number, ReplicateContribution>();
				byMetric.set(metric.metricId, byReplicate);
			}
			if (!byReplicate.has(replicateIndex)) byReplicate.set(replicateIndex, { metric, ids });
		}

		// Gaps keyed by (scope, id, outcome, reason); `outcome` belongs in the key because one shard
		// skipping a suite on a disk precondition while another attempted it and crashed are two distinct
		// facts, and folding them would silently drop whichever arrived second. Merged into a NEW object:
		// the gaps belong to the caller's shard Runs and must not be mutated.
		//
		// `cause` is not in the key, and the merge below is ORDER-INDEPENDENT for the two ways two shards
		// can disagree about it. A classified cause beats an unclassified one (shards can straddle a
		// producer upgrade). Two DIFFERENT classified causes under one key are reachable even though
		// reason and cause are built from one input, because a reason can be lossier than its cause: the
		// disk-shortfall sentence rounds with `toFixed(1)`, so 20.04 and 20.049 GiB free render one
		// sentence carrying two `freeGb` values. Keeping whichever arrived first would make the published
		// number depend on shard order, so the canonically smaller cause wins — arbitrary, but stable
		// across re-aggregation, which is the property the committed dataset needs.
		for (const gap of slice.gaps) {
			const key = [gap.scope, gap.id, gap.outcome, gap.reason].join(NUL);
			const existing = gapByKey.get(key);
			if (existing === undefined) {
				gapByKey.set(key, gap);
			} else if (gap.cause !== undefined && preferCause(existing.cause, gap.cause)) {
				gapByKey.set(key, { ...existing, cause: gap.cause });
			}
		}

		for (const straggler of slice.uncatalogued) {
			if (seenStraggler.has(straggler.id)) continue;
			seenStraggler.add(straggler.id);
			uncatalogued.push(straggler);
		}

		specMatched = foldVerdict(specMatched, slice.specMatched);
	}

	const measured = new Map<string, MetricResult>();
	for (const [metricId, byReplicate] of byMetric) {
		measured.set(metricId, mergeMetricReplicates(byReplicate));
	}
	const gaps = [...gapByKey.values()];

	// The counted disclosure: how many distinct host-hardware and host-network combinations the
	// provider's sandboxes actually reported, and how many landed on each. Undefined for a provider with
	// no sandbox report at all (the registry placeholder row), which has no mixture to disclose.
	const observedMixtures = buildObservedMixtures(sandboxSpecReadings);

	// The representative single-value summary: the dominant machine and network, derived from the mixtures
	// alone so it cannot depend on shard arrival order. Empty without mixtures, and provably so —
	// `observedMixtures` is undefined only when NO slice carried participation evidence, and
	// `providerReportedNothing` includes "no observed-spec reading", so every excluded slice had empty
	// specs and there was never anything to summarize.
	const observedSpecs: ObservedSpecs = observedMixtures
		? representativeSpecs(observedMixtures)
		: {};

	// Fold the PER-MACHINE verdicts in too. The two inputs are the same observations at different grains,
	// so they cannot legitimately disagree — and this closes the case where a shard reported specs but no
	// verdict of its own, which used to leave the provider undefined while its machines plainly answered
	// the question. The schema refuses a provider verdict kinder than its parts, so this is load-bearing.
	for (const mixture of Object.values(observedMixtures?.hostHardware ?? {})) {
		specMatched = foldVerdict(specMatched, mixture.specMatched);
	}

	// Fold host records by (source, file, non-volatile fields, machine) with a sandbox count.
	const hostMetadata = foldHostMetadata(hostMetadataInputs);
	const costEvidence = [...evidenceByCell.values()].sort((a, b) => {
		const suite = a.cell.suite.localeCompare(b.cell.suite, "en");
		if (suite !== 0) return suite;
		const replicate = (a.cell.replicateIndex ?? -1) - (b.cell.replicateIndex ?? -1);
		if (replicate !== 0) return replicate;
		return (a.subject.sandboxId ?? "").localeCompare(b.subject.sandboxId ?? "", "en");
	});
	const artifactEvidence = [...artifactByCell.values()].sort((a, b) => {
		const suite = a.cell.suite.localeCompare(b.cell.suite, "en");
		if (suite !== 0) return suite;
		const replicate = (a.cell.replicateIndex ?? -1) - (b.cell.replicateIndex ?? -1);
		if (replicate !== 0) return replicate;
		return a.sandboxId.localeCompare(b.sandboxId, "en");
	});

	const metrics = [...measured.values()];
	// Re-derive economics from the FULL merged measured set so $/lifecycle sums every suite's timings,
	// not just the shard that carried them. Gated on ≥1 measured metric (as in normalize), so economics
	// enriches a validated provider and never promotes a pending one.
	const meta = getProvider(providerId);
	if (meta && metrics.length > 0) {
		metrics.push(
			...deriveEconomics(
				meta,
				metrics.map((m) => ({ metricId: m.metricId, mean: m.aggregates.mean })),
				undefined,
				targetSpec,
			),
		);
	}
	metrics.sort((a, b) => a.metricId.localeCompare(b.metricId));

	return {
		providerId,
		costEvidence,
		...(emitArtifactEvidence ? { artifactEvidence } : {}),
		validationStatus: metrics.length > 0 ? "validated" : "pending",
		...(specMatched !== undefined ? { specMatched } : {}),
		observedSpecs,
		...(observedMixtures !== undefined ? { observedMixtures } : {}),
		...(hostMetadata.length > 0 ? { hostMetadata } : {}),
		metrics,
		suitesCovered: [...suitesCovered].sort((a, b) => a.localeCompare(b)),
		gaps,
		uncatalogued,
	};
}

/**
 * Merge the per-shard Runs of one benchmark run into a single validated Run. All shards must share
 * `runId`, `sha`, and `targetSpec` (they are slices of one run); `generatedAt` resolves to the latest
 * shard's. Throws on an empty input or a shard-identity/target mismatch, and validates the merged Run
 * at the boundary.
 */
export function aggregateRuns(runs: readonly Run[]): Run {
	if (runs.some((run) => run.experiment !== undefined)) {
		throw new Error(
			"aggregateRuns cannot merge completed experiments; use original planned attempts to preserve eligibility and provenance",
		);
	}
	if (runs.length === 0) {
		throw new Error("aggregateRuns requires at least one shard Run");
	}
	const first = runs[0];
	if (!first) throw new Error("aggregateRuns requires at least one shard Run");
	const emitArtifactEvidence = runs.every((run) => Number(run.schemaVersion) >= 6);
	if (!emitArtifactEvidence && runs.some((run) => Number(run.schemaVersion) >= 6)) {
		throw new Error("aggregateRuns: cannot mix v6 artifact-attributed shards with older shards");
	}
	for (const run of runs) {
		if (run.runId !== first.runId || run.sha !== first.sha) {
			throw new Error(
				`aggregateRuns: shard identity mismatch — expected runId=${first.runId} sha=${first.sha}, got runId=${run.runId} sha=${run.sha}`,
			);
		}
		if (
			run.targetSpec.vcpus !== first.targetSpec.vcpus ||
			run.targetSpec.memoryGb !== first.targetSpec.memoryGb ||
			run.targetSpec.diskGb !== first.targetSpec.diskGb
		) {
			throw new Error(
				`aggregateRuns: shard target spec mismatch — expected ${JSON.stringify(first.targetSpec)}, got ${JSON.stringify(run.targetSpec)}`,
			);
		}
	}

	// Every provider present in any shard, sorted for deterministic output.
	const providerIds = [
		...new Set(runs.flatMap((run) => run.providers.map((p) => p.providerId))),
	].sort((a, b) => a.localeCompare(b));

	const providers = providerIds.map((id) =>
		mergeProvider(
			id,
			// Carry each shard's replicate index alongside its slice so the merge can key the replicate
			// breakdown by it. A shard without one (a legacy v2 shard) is replicate 0 — so a run of such
			// shards folds every metric into a single replicate and stays byte-identical to the old merge.
			runs.flatMap((run) =>
				run.providers
					.filter((p) => p.providerId === id)
					.map((slice) => ({ slice, replicateIndex: run.replicateIndex ?? 0 })),
			),
			first.targetSpec,
			emitArtifactEvidence,
		),
	);

	// Latest shard timestamp (ISO-8601 sorts lexicographically) — the run is "as of" its last shard.
	const generatedAt = runs.map((run) => run.generatedAt).sort((a, b) => a.localeCompare(b))[
		runs.length - 1
	];
	const sourceRunUrl = runs.find((run) => run.sourceRunUrl !== undefined)?.sourceRunUrl;

	// The merged Run spans every replicate, so it carries no single `replicateIndex` — that lived on the
	// shards. Emit v6 only when every shard carries artifact attribution; historical all-pre-v6
	// inputs continue to aggregate as v5 without fabricating evidence.
	// one that can emit `observedMixtures`, join each replicate to the mixture its sandbox reported, and
	// fold the host records. v2/v3 shards read in above validate unchanged, and the v4 document still
	// carries the v3 replicate fold (version floors compare numerically in runSchema).
	return parseRun({
		schemaVersion: emitArtifactEvidence ? "6" : "5",
		runId: first.runId,
		sha: first.sha,
		generatedAt,
		...(sourceRunUrl !== undefined ? { sourceRunUrl } : {}),
		targetSpec: first.targetSpec,
		providers,
	});
}
