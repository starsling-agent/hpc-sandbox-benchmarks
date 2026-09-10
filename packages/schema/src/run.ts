/**
 * The canonical result model for the sandbox comparison dataset. These arktype
 * schemas are the producer/consumer contract: the harness validates every Run it emits, and every
 * consumer validates a dataset at its fetch boundary. The measurement model nests Sample → Metric →
 * Run: `MetricResult.samples` holds the retained Samples, `aggregates` their distribution.
 *
 * Schemas compose by embedding one another (arktype accepts a `Type` as a property value), so the
 * TypeScript types stay inferred from the single runtime source — no hand-written interface to drift.
 */
import { type } from "arktype";
import { aggregatesSchema } from "./analysis.ts";
import { effectiveArtifact, providerArtifactEvidenceSchema } from "./artifact-evidence.ts";
import { providerCostCellKey, providerCostEvidenceSchema } from "./cost-evidence.ts";
import { runIdSchema } from "./identifiers.ts";
import { directionSchema } from "./metrics.ts";
import type { TargetSpec } from "./target-spec.ts";
import { targetSpecSchema } from "./target-spec-schema.ts";

export type { TargetSpec } from "./target-spec.ts";
export { targetSpecSchema } from "./target-spec-schema.ts";

/** Whether a ProviderRun carries at least one catalogued Metric (validated) or none yet (pending). */
export const validationStatusSchema = type("'validated' | 'pending'");
export type ValidationStatus = typeof validationStatusSchema.infer;

/**
 * One replicate sandbox's contribution to a Metric: the raw per-pass Samples that one (provider, suite)
 * replicate produced, tagged with its {@link index}. Present only on a Metric merged from ≥2 replicate
 * shards ({@link MetricResult.replicates}); the pooled `samples`/`aggregates` above stay the ranking
 * value, this is the between-sandbox breakdown the hierarchical-bootstrap inference reads.
 */
export const metricReplicateSchema = type({
	// The replicate sandbox this slice came from (the `--replicate` index the shard was run under).
	index: "number.integer >= 0",
	// This replicate's retained per-pass Samples (>= 1, all finite — enforced by the parent narrow).
	samples: "number[] >= 1",
	/**
	 * WHICH machine and network these Samples were measured on: keys into the provider's
	 * {@link ObservedMixtures}. Absent when that sandbox's probes disclosed nothing for the category.
	 *
	 * Without this the between-machine axis is undecodable. A replicate breakdown says a provider's
	 * numbers varied across R sandboxes, and `observedMixtures` says the fleet held N distinct machine
	 * shapes — but nothing joined them, so "is the Intel leg slower than the EPYC leg?" was
	 * unanswerable from a published Run even though both halves of the answer were in it. The dataset
	 * already pays R× the provider cost to sample between machines; discarding which machine each
	 * cluster came from threw away most of what that spend bought.
	 *
	 * {@link providerRunSchema} narrows these to real keys of the provider's own mixtures, so an id can
	 * never dangle.
	 */
	"hostHardwareId?": "string >= 1",
	"hostNetworkId?": "string >= 1",
});
export type MetricReplicate = typeof metricReplicateSchema.infer;

/** One catalogued Metric's result: the retained Samples and their distribution, with provenance. */
export const metricResultSchema = type({
	metricId: "string",
	// At least one retained Sample — a MetricResult with `samples: []` but `aggregates.n > 0` would be
	// internally inconsistent, so reject it at the boundary.
	samples: "number[] >= 1",
	aggregates: aggregatesSchema,
	// Which raw file the Samples came from — provenance for debugging a Run.
	"sourceFile?": "string",
	// Test-profile provenance carried from the PTS `<Result>`: the profile's AppVersion and the exact
	// option Arguments that produced these Samples. Pins each Metric to the version + argument matrix it
	// was measured under, so a profile/option bump can't silently shift numbers across Runs.
	"appVersion?": "string",
	"arguments?": "string",
	// The per-replicate breakdown, set only when the aggregate merged ≥2 replicate sandboxes for this
	// Metric. `samples` above is the pooled union (the ranking median is unchanged); `replicates` keeps
	// the clusters distinct so render-time inference can resample the between-sandbox level. Absent at
	// R = 1, so a single-replicate Run is byte-identical to the pre-replicate schema.
	"replicates?": metricReplicateSchema.array(),
	/**
	 * WHICH machine and network produced these Samples, when a single sandbox produced all of them
	 * (v4+): keys into the provider's {@link ObservedMixtures}, exactly as on {@link MetricReplicate}.
	 *
	 * Set only when this Metric came from ONE sandbox — a shard, or an aggregate that merged a single
	 * replicate for this id. With ≥2 clusters the attribution lives per-replicate, where it is honest;
	 * one id here would have to name a single machine for samples that may span several.
	 *
	 * Without this the join had a hole exactly where the replicate structure is absent. `replicates`
	 * only exists at ≥2 clusters, so a provider whose suites each landed one sandbox published its
	 * mixtures with nothing pointing at any of them — the fleet was counted and the numbers were
	 * unattributable. A metric measured on one machine can always say which.
	 */
	"hostHardwareId?": "string >= 1",
	"hostNetworkId?": "string >= 1",
	/**
	 * Marks a COMPUTED Metric (v4+): the economics rows, which are derived from other Metrics plus the
	 * provider's published price rather than measured in any sandbox.
	 *
	 * Without it the document could not tell the two apart — `usd_per_hour` sat in `metrics` looking
	 * exactly like a measurement, and only a Metric Catalog lookup (`getMetric(id)?.derived`) separated
	 * them. That made a dataset non-self-describing: a consumer validating the JSON on its own would
	 * rank a price alongside measured throughput, and a Run outlives the catalog version that produced
	 * it. The narrow below keeps document and catalog in agreement rather than merely hoping.
	 *
	 * A literal `true`, not a boolean: the flag is a marker, so `derived: false` on a derived Metric is
	 * unrepresentable rather than merely wrong. Absent means measured.
	 */
	"derived?": "true",
}).narrow((metric, ctx) => {
	// `aggregate()` already guarantees these at the producer; enforce them at the dataset boundary too,
	// so a hand-edited/corrupt persisted Run can't carry NaN/Infinity samples or a sample count that
	// disagrees with `aggregates.n`.
	if (!metric.samples.every((s) => Number.isFinite(s))) {
		return ctx.mustBe("a MetricResult whose samples are all finite");
	}
	if (metric.aggregates.n !== metric.samples.length) {
		return ctx.mustBe("a MetricResult whose aggregates.n equals samples.length");
	}
	// A derived Metric is computed from the merged measured set as a single value, so it has no
	// per-sandbox clusters to break out — a replicate breakdown on one would claim a between-machine
	// spread that was never measured.
	if (metric.derived === true && metric.replicates !== undefined) {
		return ctx.mustBe("a derived MetricResult without a replicate breakdown");
	}
	// The two attribution levels are mutually exclusive by construction: a Metric-level id claims ONE
	// machine for every Sample, which is only true when one sandbox produced them all. Carrying both
	// would let the levels disagree, and a consumer would have to pick which to believe.
	if (
		metric.replicates !== undefined &&
		(metric.hostHardwareId !== undefined || metric.hostNetworkId !== undefined)
	) {
		return ctx.mustBe(
			"a MetricResult whose host attribution is per-replicate when it has a replicate breakdown",
		);
	}
	if (metric.replicates !== undefined) {
		// The replicate structure only exists to hold ≥2 clusters; a lone replicate is just `samples`.
		if (metric.replicates.length < 2) {
			return ctx.mustBe(
				"a MetricResult whose replicates hold at least two sandboxes (or omit them)",
			);
		}
		const indices = new Set<number>();
		const pooled: number[] = [];
		for (const replicate of metric.replicates) {
			if (indices.has(replicate.index)) {
				return ctx.mustBe("a MetricResult whose replicate indices are distinct");
			}
			indices.add(replicate.index);
			if (!replicate.samples.every((s) => Number.isFinite(s))) {
				return ctx.mustBe("a MetricResult whose replicate samples are all finite");
			}
			pooled.push(...replicate.samples);
		}
		// The pooled `samples` must be exactly the union of the replicate slices (as a multiset), so the
		// ranking distribution and the between-sandbox breakdown can never silently disagree.
		if (pooled.length !== metric.samples.length) {
			return ctx.mustBe(
				"a MetricResult whose pooled samples count equals the sum of its replicates",
			);
		}
		const sortedPooled = [...pooled].sort((a, b) => a - b);
		const sortedSamples = [...metric.samples].sort((a, b) => a - b);
		if (!sortedPooled.every((value, i) => value === sortedSamples[i])) {
			return ctx.mustBe(
				"a MetricResult whose pooled samples are the union of its replicate samples",
			);
		}
	}
	return true;
});
export type MetricResult = typeof metricResultSchema.infer;

/**
 * A parsed result whose id is not in the Metric Catalog — reported for visibility but inert: it
 * never feeds rankings until someone adds a matching Catalog entry.
 */
export const uncataloguedResultSchema = type({
	id: "string",
	value: "number",
	"unit?": "string",
	"direction?": directionSchema,
	sourceFile: "string",
});
export type UncataloguedResult = typeof uncataloguedResultSchema.infer;

/** One flattened field from a host-metadata source. String values preserve the source value while
 * the path retains its original nested shape (`hardware.Processor`, `data.cpu-smt`, ...). */
export const hostMetadataFieldSchema = type({
	path: "string >= 1",
	value: "string",
});
export type HostMetadataField = typeof hostMetadataFieldSchema.infer;

/**
 * One rich host record retained from an in-sandbox producer. `mise/system-provider` is the repo's
 * ASN/geo/DMI probe; `phoronix/result-file-to-json` is PTS's native structured System export. The
 * generic flattened field list deliberately preserves new upstream keys without a Run schema bump.
 *
 * On an AGGREGATED Run (v4+) a record is the FOLD of every sandbox that reported these same
 * non-volatile fields: `sandboxes` counts them, and `hostHardwareId`/`hostNetworkId` name the machine
 * and network they were on. Before that a record was an anonymous member of a flat bag — so the ten
 * distinct CPUs modal-vm ran on were present in the file yet attributable to nothing, which is the
 * same defect {@link ObservedMixtures} fixed one level up.
 */
export const hostMetadataRecordSchema = type({
	source: "'mise/system-provider' | 'phoronix/result-file-to-json'",
	sourceFile: "string >= 1",
	fields: hostMetadataFieldSchema.array(),
	/** How many sandboxes reported this record (v4+); absent on a per-shard Run, where it is always 1. */
	"sandboxes?": "number.integer >= 1",
	/** The machine and network this record was read on — keys into the provider's mixtures (v4+). */
	"hostHardwareId?": "string >= 1",
	"hostNetworkId?": "string >= 1",
});
export type HostMetadataRecord = typeof hostMetadataRecordSchema.infer;

/**
 * HOST HARDWARE fields — the machine a sandbox landed on, as the sandbox could see it. This is one of
 * the two {@link ObservedMixtures} hash categories: a provider that scheduled its sandboxes across
 * more than one machine shape produces more than one hostHardware mixture, and the count on each says
 * how many sandboxes landed there.
 *
 * `vcpus`/`memoryGb`/`diskGb` are the EFFECTIVE sandbox size (the cgroup quota where enforced) while
 * `hostVcpus`/`hostMemoryGb` disclose the underlying machine when probes see through the container
 * boundary (e.g. Daytona: a 4-vCPU quota on a 48-thread host) — the host-vs-effective split of
 * ADR 0005, which the field docs keep explicit. They share ONE hash category on purpose: a provider
 * handing out 4 vCPU on some sandboxes and 2 on others is exactly the heterogeneity this disclosure
 * exists to make impossible to miss, so the effective size is part of "which machine did I get".
 * `cpuMicroarch` is a HOST-side generation label derived from `cpuModel` (e.g. "Zen 5 (Turin)").
 */
const hostHardwareSpecFields = {
	"vcpus?": "number",
	"memoryGb?": "number",
	"diskGb?": "number",
	"hostVcpus?": "number",
	"hostMemoryGb?": "number",
	"cpuModel?": "string",
	// Host-side generation/microarch label derived from cpuModel; never reflects the effective spec.
	"cpuMicroarch?": "string",
	"cpuMhz?": "number",
	"kernel?": "string",
	"os?": "string",
	"virtualization?": "string",
	// A coarse, best-effort classification of the isolation boundary the in-sandbox probe could
	// actually see — "gvisor" (kernel marker), "container" (a cgroup-limited quota under a much larger
	// disclosed host), "vm" (a self-sized machine), or "unknown". Deliberately NOT authoritative:
	// systemd-detect-virt cannot separate a container from a microVM (both read "kvm") or gVisor from a
	// microVM (both read "unknown"), so the declared per-provider isolation stays the source of truth
	// and this is only a cross-check the leaderboard flags when the two disagree.
	"detectedIsolation?": "string",
	// DMI, from benchmark:system:provider — describes the machine/hypervisor the sandbox ran on.
	"manufacturer?": "string",
	"productName?": "string",
	"biosVendor?": "string",
} as const;

/**
 * HOST NETWORK fields — which network a sandbox egressed through, and from where. The second
 * {@link ObservedMixtures} hash category, from benchmark:system:provider's ASN/geo lookup.
 *
 * `publicIp` and `reverseDns` are deliberately NOT here: they identify the individual sandbox rather
 * than its network, so hashing them would mint one "mixture" per sandbox and report every count as 1 —
 * destroying the very signal the categories exist to carry. They live in
 * {@link sandboxIdentitySpecFields} instead, and `networkPrefix` (the announced prefix) is what
 * carries the address-space dimension into the hash.
 */
const hostNetworkSpecFields = {
	"egressOrg?": "string",
	"egressAsn?": "string",
	"egressOrgName?": "string",
	"networkPrefix?": "string",
	"city?": "string",
	"region?": "string",
	"country?": "string",
	"location?": "string",
	"timezone?": "string",
	// Which lookup answered — a mixture whose geo came from a different source is a different
	// observation, not a silently comparable one.
	"asnSource?": "string",
	"geoSource?": "string",
} as const;

/**
 * Per-sandbox IDENTITY fields — true observations, but unique (or near-unique) to a single sandbox,
 * so they are excluded from both mixture hashes. Full source records live in
 * {@link ProviderRun.hostMetadata} when the individual value is what a reader wants.
 */
const sandboxIdentitySpecFields = {
	"publicIp?": "string",
	"reverseDns?": "string",
	"user?": "string",
} as const;

/**
 * The hostHardware mixture category as its own Type — the `specs` of a hardware mixture, so a mixture
 * carrying a network or identity field is rejected at the boundary rather than merely discouraged.
 *
 * `onUndeclaredKey("reject")` is what makes that true: arktype IGNORES undeclared keys by default, so
 * without it a serialized `hostNetwork` mixture carrying `cpuModel` — or either category carrying the
 * `publicIp` whose inclusion the design says destroys the signal — validated cleanly and the partition
 * was only a producer convention. Scoped to the category schemas alone, NOT to
 * {@link observedSpecsSchema}: that one must keep ignoring undeclared keys so already-published Runs
 * carrying since-deleted fields (`hostCpuModels`) still parse.
 */
export const hostHardwareSpecsSchema = type(hostHardwareSpecFields).onUndeclaredKey("reject");
export type HostHardwareSpecs = typeof hostHardwareSpecsSchema.infer;

/** The hostNetwork mixture category as its own Type; see {@link hostHardwareSpecsSchema}. */
export const hostNetworkSpecsSchema = type(hostNetworkSpecFields).onUndeclaredKey("reject");
export type HostNetworkSpecs = typeof hostNetworkSpecsSchema.infer;

/**
 * Observed actuals recorded per Run — what in-sandbox probes actually saw, versus the requested
 * {@link TargetSpec}. All optional: providers differ in what in-sandbox probes can see.
 *
 * COMPOSED from the three field groups above rather than written out flat, and that composition is
 * load-bearing: the two mixture categories are literally groups this type is built from, so a field
 * added to ObservedSpecs must be added to one of them and therefore cannot end up unclassified. A flat
 * list plus a separate key list would let the two drift — a new field silently absent from every
 * mixture hash, which is exactly the "looks complete, quietly isn't" failure the categories exist to
 * remove. See {@link ObservedMixtures}.
 *
 * On an AGGREGATED Run this carries one representative reading — the DOMINANT mixture per category, i.e.
 * the one the most sandboxes reported — which is a summary, NOT a claim that every sandbox saw it.
 * `observedMixtures` is the complete, countable disclosure; prefer it whenever the question is "how many
 * distinct X did this provider actually put us on".
 */
export const observedSpecsSchema = type({
	...hostHardwareSpecFields,
	...hostNetworkSpecFields,
	...sandboxIdentitySpecFields,
});
export type ObservedSpecs = typeof observedSpecsSchema.infer;

/**
 * A mixture must DESCRIBE something. All category fields are optional, so `specs: {}` is structurally
 * legal — and it would be a counted, referenceable "machine shape" built from a probe that disclosed
 * nothing, which inverts the contract: a category the sandbox saw nothing for is represented by no
 * mixture and no id at all, so the counts visibly fall short of `sandboxes`. An empty mixture would
 * launder that shortfall into a phantom machine every reader can join to.
 */
function nonEmptySpecs(
	mixture: { specs: object },
	ctx: { mustBe: (expected: string) => false },
): boolean {
	return (
		Object.keys(mixture.specs).length > 0 ||
		ctx.mustBe("a mixture whose specs disclose at least one field")
	);
}

/**
 * One observed HOST-NETWORK mixture: a distinct combination of the egress/geo fields, plus how many of
 * the provider's sandboxes reported exactly that combination. `count` is a sandbox count, so the counts
 * within a category sum to the number of sandboxes that disclosed at least one of its fields — which
 * is ≤ {@link ObservedMixtures.sandboxes} whenever some sandbox's probe saw nothing.
 *
 * Named for its category rather than left generic: the two mixture types are deliberately NOT the same
 * shape (see {@link observedHardwareMixtureSchema}), so a category-neutral name would read as the shared
 * base of both and invite the verdict field to be added here too.
 */
export const observedNetworkMixtureSchema = type({
	count: "number.integer >= 1",
	specs: hostNetworkSpecsSchema,
}).narrow(nonEmptySpecs);
export type ObservedNetworkMixture = typeof observedNetworkMixtureSchema.infer;

/**
 * A host-hardware mixture, which additionally carries its OWN spec verdict (v4+).
 *
 * `ProviderRun.specMatched` is one boolean folded across every shard, and on a mixed fleet that is too
 * coarse to act on: run 30510718771 put modal-vm's sandboxes on ten different machines under a single
 * `specMatched: true`, so a provider honoring the target on nine shapes and missing it on the tenth
 * reads identically to one that honored it everywhere. Per machine, the verdict is answerable —
 * `vcpus`/`memoryGb` are hostHardware-category fields, so each mixture carries what the check needs.
 *
 * Deliberately absent from the NETWORK mixture type rather than optional-and-always-undefined there:
 * the target spec says nothing about egress, so a network mixture has no verdict to give and should
 * not be able to claim one.
 */
export const observedHardwareMixtureSchema = type({
	count: "number.integer >= 1",
	specs: hostHardwareSpecsSchema,
	/** Whether THIS machine honored the pinned target; absent when its probes saw too little to judge. */
	"specMatched?": "boolean",
}).narrow(nonEmptySpecs);
export type ObservedHardwareMixture = typeof observedHardwareMixtureSchema.infer;

/**
 * The precise, countable answer to "how heterogeneous was this provider in this run" — keyed by a
 * stable content hash of the combination, so the same machine shape or egress network carries the same
 * id in every run and can be tracked across the dataset series.
 *
 * This exists because a single {@link ObservedSpecs} on an aggregated ProviderRun reads like a
 * property of the provider while actually being one sandbox's reading: a provider spread across three
 * CPU generations and two regions rendered identically to one that never moved. A reader could not
 * tell, and nothing in the document disclosed the mixture. Here, `Object.keys(hostHardware).length` IS
 * the number of distinct machine shapes observed, and each `count` says how many sandboxes landed on
 * it — no inference required.
 *
 * `sandboxes` is the denominator: how many sandboxes (one per merged shard, i.e. per
 * `(suite, replicate)` cell) the provider contributed. Without it a category's counts are
 * uninterpretable — "one hardware mixture, count 10" cannot be told apart from a homogeneous fleet
 * (10 of 10) or a mostly-blind one (10 of 30).
 */
export const observedMixturesSchema = type({
	sandboxes: "number.integer >= 1",
	hostHardware: type({ "[string]": observedHardwareMixtureSchema }),
	hostNetwork: type({ "[string]": observedNetworkMixtureSchema }),
}).narrow((mixtures, ctx) => {
	// A category's counts are sandbox counts drawn from ONE reading per sandbox, so their sum cannot
	// exceed the denominator. It may fall short — that is the visible partial disclosure a category
	// records when some sandbox's probe saw nothing — but a sum ABOVE `sandboxes` describes a fleet
	// that never existed, and every proportion a reader computes from it ("6 of 4 sandboxes were on
	// Zen 5") is then arithmetic on a lie. The denominator is the whole reason the counts mean
	// anything, so it is enforced rather than documented.
	for (const [category, entries] of [
		["hostHardware", mixtures.hostHardware],
		["hostNetwork", mixtures.hostNetwork],
	] as const) {
		let total = 0;
		for (const mixture of Object.values(entries)) total += mixture.count;
		if (total > mixtures.sandboxes) {
			return ctx.mustBe(
				`ObservedMixtures whose ${category} counts sum to at most sandboxes (got ${total} of ${mixtures.sandboxes})`,
			);
		}
	}
	return true;
});
export type ObservedMixtures = typeof observedMixturesSchema.infer;

/**
 * Where a Run document of this identity is written, relative to the ROOT of the tree that holds it —
 * the CANONICAL name. It and {@link runDocumentPaths} are the one derivation both the RunIndex
 * invariant below and the index writer read, so the two cannot drift into the disagreement that made
 * a whole lane unwritable (a writer computing the path from the filesystem while the schema demanded
 * a derivation).
 *
 * "Relative to the root", not to the index file: an index sits at the root of a tree whose Runs are
 * under `runs/` (`data/index.json` + `data/runs/…`, `data/dataset/index.json` +
 * `data/dataset/runs/…`), which is what makes one rule describe every index this repo writes.
 *
 * A per-replicate SHARD is named by the same identity its Run carries — shards of one cell share a
 * runId and are told apart by `replicateIndex`, so the index can list all R of them instead of
 * letting the last one to normalize overwrite its peers' entry.
 */
export function runDocumentPath(runId: string, replicateIndex?: number): string {
	return `runs/${runId}${replicateIndex === undefined ? "" : `-r${replicateIndex}`}.json`;
}

/**
 * Every name a Run document of this identity may legally carry, canonical first.
 *
 * A replicate-stamped Run has TWO legal names, because the harness has two lanes and they disagree
 * on the filename by design:
 *
 *  - `runs/<runId>-r<idx>.json` — the fan-out lane (`bench-suite --replicates`), where R shards share
 *    one runId inside one cell and only the suffix tells the sandboxes apart.
 *  - `runs/<runId>.json` — the single-sandbox lane (`bench-suite --replicate <idx>`), which stamps
 *    the index onto the Run but deliberately keeps the UN-suffixed name. That name is a downstream
 *    contract, not an oversight: commit-dataset.yml reads it as the legacy shard shape when
 *    re-aggregating a run whose artifacts predate the fan-out.
 *
 * So the filename is not a function of the identity alone, and a derivation that pretends otherwise
 * rejects one of the two lanes outright — which is exactly how the single lane started failing after
 * its benchmark had already succeeded. Membership in this set is the check; the ENTRY still records
 * the name the file actually has, so an index never points at a document that isn't there.
 *
 * An entry with no `replicateIndex` (every promoted dataset entry) keeps exactly one legal name, so
 * the dataset invariant — and the path guard update-leaderboard.yml re-applies to it — is unchanged.
 */
export function runDocumentPaths(runId: string, replicateIndex?: number): readonly string[] {
	const canonical = runDocumentPath(runId, replicateIndex);
	return replicateIndex === undefined ? [canonical] : [canonical, runDocumentPath(runId)];
}

/** A RunIndex entry whose path is one of the names its Run's identity allows (its id, plus the
 *  replicate index when the entry describes one shard of a fan-out) — never a free-form path. */
export const runIndexEntrySchema = type({
	runId: runIdSchema,
	generatedAt: "string.date.iso",
	path: "string >= 1",
	// Present only for a per-replicate shard entry, mirroring `Run.replicateIndex`. A promoted dataset
	// Run spans every replicate and carries none, so dataset index entries are unchanged by this field.
	"replicateIndex?": "number.integer >= 0",
}).narrow((entry, ctx) => {
	// Derived, never free-form: `runIdSchema` already rejects path syntax in an id and the replicate
	// index is a non-negative integer, so no accepted name can escape `runs/` or traverse upward.
	const allowed = runDocumentPaths(entry.runId, entry.replicateIndex);
	if (allowed.includes(entry.path)) return true;
	return ctx.mustBe(`a RunIndex entry whose path is ${allowed.map((p) => `"${p}"`).join(" or ")}`);
});
export type RunIndexEntry = typeof runIndexEntrySchema.infer;

/**
 * What a benchmark that produced no result was: a whole suite, or one harness lifecycle operation.
 * The two are not interchangeable — a missing suite is a workload the provider never ran, a missing
 * operation is a control-plane call that never returned — so the gap names which it is rather than
 * overloading one identifier slot with both.
 */
export const gapScopeSchema = type("'suite' | 'operation'");
export type GapScope = typeof gapScopeSchema.infer;

/**
 * Why a benchmark produced no result. The distinction is the whole point of recording gaps at all:
 *
 *  - `skipped` — DELIBERATELY not run. A precondition said no before anything was attempted (the
 *    sandbox has less free disk than the suite needs; the provider's SDK has no snapshot call). It
 *    says something structural about the provider: it cannot host this workload as configured.
 *  - `failed`  — ATTEMPTED and errored. The suite/operation ran and threw, timed out, or died with
 *    the sandbox. It says something about reliability, and it is a different fact from a skip.
 *
 * Collapsing the two (recording a crash as a "skip") reports an outage as a design decision, so the
 * producer picks the arm at the point it knows which happened, and never widens one into the other.
 */
export const gapOutcomeSchema = type("'skipped' | 'failed'");
export type GapOutcome = typeof gapOutcomeSchema.infer;

/**
 * WHY a benchmark produced no result, as data rather than prose.
 *
 * `reason` beside this is a human sentence, and for a long time it was also the machine interface:
 * the leaderboard decided whether a skip was a disk shortfall with `/^insufficient disk/i` against a
 * string authored in another package, a coupling its own comment had to warn about. Every question
 * past that regex — how many GiB short, which step timed out and after how long, which declared
 * metrics never recorded — was answerable only by re-parsing English that no test pinned.
 *
 * The taxonomy is closed and there is deliberately NO catch-all arm. A producer that cannot classify
 * a gap omits `cause` entirely, which reads as "unclassified" and cannot be mistaken for a diagnosis;
 * an `other` kind would let genuinely different failures accumulate behind one label that consumers
 * would then have to re-parse `reason` to tell apart, reintroducing exactly what this replaces.
 */
export const gapCauseSchema = type({
	// A precondition refused the suite: the sandbox had less free disk than `Suite.minDiskGb`.
	kind: "'disk-shortfall'",
	freeGb: "number >= 0",
	requiredGb: "number > 0",
})
	// The provider's credentials were not present in the environment, so nothing was attempted.
	.or({ kind: "'missing-credentials'", variables: "string[] >= 1" })
	// `sandbox.create` never returned a usable sandbox (quota, region, provider-side error).
	.or({ kind: "'sandbox-create-failed'", "detail?": "string" })
	// The sandbox stopped answering mid-step — distinct from a step that ran and failed.
	.or({
		kind: "'sandbox-lost'",
		step: "string >= 1",
		"consecutivePollFailures?": "number.integer >= 1",
	})
	// A step exceeded its own budget. `timeoutSeconds` is the budget, not the elapsed time.
	.or({ kind: "'step-timeout'", step: "string >= 1", timeoutSeconds: "number > 0" })
	// A step ran to completion and exited non-zero.
	.or({ kind: "'step-failed'", step: "string >= 1", "exitCode?": "number.integer" })
	// The suite ran, but these declared metrics never recorded a value on any trial.
	.or({ kind: "'metrics-unrecorded'", metricIds: "string[] >= 1", declared: "number.integer >= 1" })
	// PTS's duplicate-value dedup dropped a result whose value collided with its twin's.
	.or({ kind: "'duplicate-value-dedup'", metricIds: "string[] >= 1" })
	// A lifecycle operation the provider's SDK does not expose (`scope: "operation"` skips).
	.or({ kind: "'unsupported-operation'", "detail?": "string" })
	// The run was configured not to measure this — a choice we made, never a provider limitation. Kept
	// distinct from `unsupported-operation` precisely because collapsing them would let a config toggle
	// read as a capability the provider lacks.
	.or({ kind: "'measurement-disabled'", "detail?": "string" })
	.narrow((cause, ctx) => {
		// The arms carry numbers whose MEANING constrains them beyond their type, and a structured
		// diagnosis that contradicts itself is worse than an absent one: a consumer trusts this field
		// precisely because it stopped re-reading prose. Every invariant here already holds at each
		// producer (the disk precondition only fires below the threshold, a step is only "failed" on a
		// non-zero exit, and the unrecorded metrics are a subset of the declared ones), so this pins
		// them at the boundary for hand-edited and future producers.
		if (cause.kind === "disk-shortfall" && cause.freeGb >= cause.requiredGb) {
			return ctx.mustBe("a disk shortfall whose freeGb is below requiredGb");
		}
		if (cause.kind === "step-failed" && cause.exitCode === 0) {
			return ctx.mustBe("a failed step whose exitCode is non-zero");
		}
		if (cause.kind === "metrics-unrecorded" && cause.metricIds.length > cause.declared) {
			return ctx.mustBe("unrecorded metrics that are a subset of the declared ones");
		}
		return true;
	});
export type GapCause = typeof gapCauseSchema.infer;

/**
 * The causes that describe a PRECONDITION refusing a benchmark, as opposed to one that was attempted and
 * broke — the {@link GapOutcome} partition of {@link gapCauseSchema}, stated next to the taxonomy it
 * partitions rather than buried in the narrow that enforces it (and allocated once, not per parsed gap).
 */
const SKIP_CAUSE_KINDS: ReadonlySet<GapCause["kind"]> = new Set<GapCause["kind"]>([
	"disk-shortfall",
	"missing-credentials",
	"unsupported-operation",
	"measurement-disabled",
]);

/**
 * Which {@link GapOutcome} a cause belongs to — the partition above, exposed so a producer can CHECK the
 * pairing before building a gap instead of discovering it as a parse failure. `resultGapSchema` is the
 * enforcement; this is how a caller stays on the right side of it (see `parseGapMarker`).
 */
export function gapOutcomeOfCause(cause: GapCause): GapOutcome {
	return SKIP_CAUSE_KINDS.has(cause.kind) ? "skipped" : "failed";
}

/**
 * One benchmark that produced no result for a provider, and why — the recorded half of a coverage
 * gap. The DERIVED half (a suite that ran elsewhere in the Run but never reported here at all, with
 * no marker of any kind) cannot live on a ProviderRun: it is a cross-provider fact, so the
 * leaderboard derives it from {@link ProviderRun.suitesCovered}. See `CoverageGap` in the results
 * package, which unions the two into the surface a reader sees.
 */
export const resultGapSchema = type({
	scope: gapScopeSchema,
	/** The suite name (`scope: "suite"`) or the harness Metric id (`scope: "operation"`). */
	id: "string",
	outcome: gapOutcomeSchema,
	/**
	 * The producer's human explanation. Still authored, still the thing a reader reads — but no longer
	 * the machine interface: consumers branch on {@link ResultGap.cause}, and this is free to be prose.
	 */
	reason: "string",
	/**
	 * The same failure as structured data (v4+). Absent means the producer did not classify it — an
	 * older Run, or a failure mode the taxonomy has no arm for. Never infer a cause by parsing `reason`
	 * when this is absent: guessing produces a confident label for an unclassified event.
	 */
	"cause?": gapCauseSchema,
}).narrow((gap, ctx) => {
	// A skip and a failure are different facts (see gapOutcomeSchema), and so are their causes. Pinning
	// the pairing here stops a producer from recording a crash as a skip — or a precondition as a
	// failure — via the cause while the outcome says otherwise, which would make the two disagree
	// inside one gap and leave a consumer to pick a side.
	if (gap.cause === undefined) return true;
	const causeOutcome = gapOutcomeOfCause(gap.cause);
	if (causeOutcome !== gap.outcome) {
		return ctx.mustBe(
			`a ${gap.outcome} gap whose cause describes one (got "${gap.cause.kind}", a ${causeOutcome} cause)`,
		);
	}
	// `unsupported-operation` names a call the provider's SDK does not expose, which is a statement
	// about ONE lifecycle operation — the scope its own doc gives it. On a suite it would read as
	// "this provider cannot run this benchmark at all", a much larger claim than the producer made.
	// Only this arm is pinned: `measurement-disabled` is a choice we make and could legitimately turn
	// off a whole suite one day, so coupling it to a scope would be inventing a rule, not recording one.
	if (gap.cause.kind === "unsupported-operation" && gap.scope !== "operation") {
		return ctx.mustBe('an operation-scoped gap when its cause is "unsupported-operation"');
	}
	return true;
});
export type ResultGap = typeof resultGapSchema.infer;

/**
 * One provider's slice of a Run: its catalogued Metrics, observed specs, coverage gaps and stragglers.
 * The `.narrow`s enforce two cross-field invariants: a `validated` ProviderRun must carry at least
 * one Metric (see {@link validationStatusSchema}), so `{ validationStatus: "validated", metrics: [] }`
 * is rejected at the boundary rather than reaching a consumer that branches on it; and a defined
 * `specMatched` requires a non-empty `observedSpecs` — the verdict is computed FROM observations, so
 * a row carrying one without any is a hand-authored contradiction that would otherwise render both as
 * "not present in this run" ({@link providerReportedNothing}) and under a comparability warning about
 * measured ranks it doesn't have.
 */
export const providerRunSchema = type({
	providerId: "string",
	/** Sandbox-scoped provider cost evidence (required by the Run v5 gate below). */
	"costEvidence?": providerCostEvidenceSchema.array(),
	/**
	 * Sandbox-scoped artifact attribution — which toolchain each sandbox actually booted, and what
	 * established that (required by the Run v6 gate below).
	 *
	 * An array, like `costEvidence`, because a ProviderRun can span replicate sandboxes and each
	 * boots its own artifact. Empty means the provider never booted anything (a skip), which is a
	 * different fact from a provider that booted something nobody observed — that one records a
	 * `request-fallback` entry.
	 */
	"artifactEvidence?": providerArtifactEvidenceSchema.array(),
	validationStatus: validationStatusSchema,
	// Whether observed specs honored the pinned target spec; absent when probes saw too little to judge.
	"specMatched?": "boolean",
	observedSpecs: observedSpecsSchema,
	/**
	 * The countable heterogeneity disclosure — distinct host-hardware and host-network combinations with
	 * a sandbox count each. Set by the AGGREGATE path only (a single shard is one sandbox, so its
	 * mixtures would be a tautology) and therefore v4-only, gated in {@link runSchema}'s narrow. Absent
	 * on shards and on every Run published before v4; `observedSpecs` remains the representative
	 * single-value summary beside it.
	 */
	"observedMixtures?": observedMixturesSchema,
	/** Rich, source-attributed host records; optional for historical Runs predating capture. */
	"hostMetadata?": hostMetadataRecordSchema.array(),
	metrics: metricResultSchema.array(),
	/**
	 * Every suite that produced at least one catalogued Metric here — the POSITIVE record of coverage,
	 * without which a hole is indistinguishable from a suite this Run never ran at all. `metrics` alone
	 * cannot supply it: a Metric knows its Dimension, and two suites can declare one Dimension, so
	 * suite→metric is not invertible. Recorded by the producer, which is the only layer that saw the
	 * raw tree. Sorted, so a re-normalized Run is byte-stable.
	 */
	suitesCovered: "string[]",
	/** Benchmarks that reported no result here, each tagged with WHY (see {@link resultGapSchema}). */
	gaps: resultGapSchema.array(),
	uncatalogued: uncataloguedResultSchema.array(),
})
	.narrow(
		(run, ctx) =>
			run.validationStatus !== "validated" ||
			run.metrics.length > 0 ||
			ctx.mustBe('a ProviderRun with at least one metric when validationStatus is "validated"'),
	)
	.narrow(
		(run, ctx) =>
			run.specMatched === undefined ||
			Object.keys(run.observedSpecs).length > 0 ||
			ctx.mustBe("a ProviderRun with observedSpecs when specMatched carries a verdict"),
	)
	.narrow((run, ctx) => {
		// Referential integrity for the replicate→machine join. A dangling id is worse than an absent
		// one: absent reads as "this sandbox disclosed nothing", while dangling reads as a real machine
		// that simply cannot be looked up — and the natural consumer (`mixtures[replicate.hostHardwareId]`)
		// yields undefined for both, so the two failure modes are indistinguishable at the point of use.
		// Rejecting here keeps "an id resolves" a guarantee rather than a hope.
		// `Object.hasOwn` against the maps directly rather than materialising two key Sets: a provider has
		// at most a handful of mixtures, and the common case by far — a shard, or any pre-v4 Run — has none
		// at all, where building Sets from `{}` would allocate on every provider row of every parse.
		const hardware = run.observedMixtures?.hostHardware;
		const network = run.observedMixtures?.hostNetwork;
		const resolves = (map: object | undefined, id: string): boolean =>
			map !== undefined && Object.hasOwn(map, id);
		for (const metric of run.metrics) {
			if (metric.hostHardwareId !== undefined && !resolves(hardware, metric.hostHardwareId)) {
				return ctx.mustBe(
					`a ProviderRun whose metric hostHardwareId resolves in observedMixtures (${metric.metricId} → ${metric.hostHardwareId})`,
				);
			}
			if (metric.hostNetworkId !== undefined && !resolves(network, metric.hostNetworkId)) {
				return ctx.mustBe(
					`a ProviderRun whose metric hostNetworkId resolves in observedMixtures (${metric.metricId} → ${metric.hostNetworkId})`,
				);
			}
			for (const replicate of metric.replicates ?? []) {
				if (
					replicate.hostHardwareId !== undefined &&
					!resolves(hardware, replicate.hostHardwareId)
				) {
					return ctx.mustBe(
						`a ProviderRun whose replicate hostHardwareId resolves in observedMixtures (${metric.metricId} r${replicate.index} → ${replicate.hostHardwareId})`,
					);
				}
				if (replicate.hostNetworkId !== undefined && !resolves(network, replicate.hostNetworkId)) {
					return ctx.mustBe(
						`a ProviderRun whose replicate hostNetworkId resolves in observedMixtures (${metric.metricId} r${replicate.index} → ${replicate.hostNetworkId})`,
					);
				}
			}
		}
		// Host records join the same way and get the same guarantee — one rule for every reference into
		// observedMixtures, so "an id resolves" holds document-wide rather than per-field.
		for (const record of run.hostMetadata ?? []) {
			if (record.hostHardwareId !== undefined && !resolves(hardware, record.hostHardwareId)) {
				return ctx.mustBe(
					`a ProviderRun whose hostMetadata hostHardwareId resolves in observedMixtures (${record.sourceFile} → ${record.hostHardwareId})`,
				);
			}
			if (record.hostNetworkId !== undefined && !resolves(network, record.hostNetworkId)) {
				return ctx.mustBe(
					`a ProviderRun whose hostMetadata hostNetworkId resolves in observedMixtures (${record.sourceFile} → ${record.hostNetworkId})`,
				);
			}
		}
		return true;
	})
	.narrow((run, ctx) => {
		// The provider verdict is the fold of the per-machine ones, so it cannot be kinder than its
		// parts: one machine off-spec contaminates the shared aggregate and disqualifies the provider.
		// Checking it here makes the fold rule a property of the document rather than a convention of
		// whichever code last wrote it.
		const mixtures = Object.values(run.observedMixtures?.hostHardware ?? {});
		if (mixtures.some((mixture) => mixture.specMatched === false) && run.specMatched !== false) {
			return ctx.mustBe(
				"a ProviderRun with specMatched false when any host-hardware mixture failed the target spec",
			);
		}
		return true;
	});
export type ProviderRun = typeof providerRunSchema.infer;

/**
 * True when a ProviderRun carries NO evidence of participation at all: no metric, no coverage, no
 * gap, no uncatalogued straggler, no observed-spec reading, no host-metadata record. This is exactly
 * the shape the normalizer emits for an absent raw directory — a registered provider the run never
 * dispatched (or whose every cell was lost before reporting anything). It is deliberately stricter
 * than "no metrics": a straggler, a spec probe, a host record, or an artifact attribution IS
 * participation evidence, and a
 * provider that reported any of them belongs in the coverage derivation, not in the absent list.
 * Consumers (the leaderboard's coverage derivation, the CLI status logs) use it to keep the pending
 * dataset row first-class while not accusing a never-dispatched provider of per-suite holes.
 * `specMatched` needs no clause of its own: the schema narrow rejects a verdict without
 * observations, and observations already count via `observedSpecs`.
 */
export function providerReportedNothing(p: ProviderRun): boolean {
	return (
		p.metrics.length === 0 &&
		p.suitesCovered.length === 0 &&
		p.gaps.length === 0 &&
		p.uncatalogued.length === 0 &&
		Object.keys(p.observedSpecs).length === 0 &&
		(p.hostMetadata?.length ?? 0) === 0 &&
		(p.costEvidence?.length ?? 0) === 0 &&
		// A booted sandbox leaves an attribution even when it produced nothing else; counting it here
		// keeps a provider that booted and then failed out of the never-dispatched list.
		(p.artifactEvidence?.length ?? 0) === 0
	);
}

/**
 * Display status for a ProviderRun row: the validation status, tagged "(no shard data)" when the
 * row is a zero-evidence registry placeholder — so a never-dispatched provider stops printing
 * indistinguishably from a freshly-attempted shard that also reads `pending metrics=0`. Shared by
 * every human-facing status line (CI job summaries, `summarizeRun`) so the two views can't drift.
 */
export function providerStatusText(p: ProviderRun): string {
	return providerReportedNothing(p) ? `${p.validationStatus} (no shard data)` : p.validationStatus;
}

/**
 * A full benchmark Run: every provider measured against one pinned target spec at one SHA.
 *
 * `schemaVersion` accepts `"2"` through `"7"`. Version 7 adds experiment plan/attempt linkage;
 * older documents do not establish experiment completeness. v1's `skips: { suite, reason }[]` could not say
 * whether a benchmark was deliberately not run or had crashed, and carried no positive record of what
 * DID run — so a suite that vanished (job died, artifact never uploaded) left no trace anywhere in the
 * document. v2 replaced it with {@link resultGapSchema} + {@link ProviderRun.suitesCovered}. v3 adds
 * the replicate model: a shard Run carries its {@link replicateIndex}, and the aggregate folds ≥2
 * replicate sandboxes of one (provider, suite) into {@link MetricResult.replicates}.
 *
 * v4 makes the document SELF-DESCRIBING — every fact a reader needs is expressible from the file,
 * rather than recoverable only by knowing something the file does not say:
 *
 *  - {@link ProviderRun.observedMixtures} counts the distinct host-hardware and host-network
 *    combinations a provider's sandboxes reported, which one representative `observedSpecs` reading
 *    could only imply.
 *  - {@link MetricReplicate} names the mixture its sandbox reported, joining a sample cluster to the
 *    machine that produced it instead of to an anonymous index; a single-sandbox
 *    {@link MetricResult} names its own, so the join has no hole below two clusters.
 *  - {@link ResultGap.cause} classifies a failure as data rather than prose.
 *  - {@link MetricResult.derived} separates a computed row from a measured one without a catalog lookup.
 *  - Host records are folded and attributed to their machine.
 *  - Each host-hardware mixture carries its own spec verdict.
 *
 * v5 adds the sandbox-scoped provider cost-evidence transport. Every provider row carries an array;
 * historical versions cannot carry one, so absence in an older Run remains absence rather than a
 * fabricated zero or backfill.
 *
 * v6 adds the sandbox-scoped ARTIFACT attribution beside it. The benchmark's headline claim names a
 * toolchain, but until v6 the document retained no cell-bound artifact evidence at all. Each entry
 * records the exact request and how the effective artifact was established
 * ({@link ProviderArtifactEvidence}), so a reader can tell a control-plane confirmation or an in-guest
 * fingerprint from an unobserved request fallback. Historical Runs cannot carry it, so their silence
 * stays silence rather than being backfilled into a claim nobody made.
 *
 * Every version validates here — already-published Runs are read unchanged, and the parser never
 * migrates them in place.
 */
export const runSchema = type({
	schemaVersion: "'2' | '3' | '4' | '5' | '6' | '7'",
	runId: runIdSchema,
	sha: "string",
	// ISO-8601 timestamp the Run was generated at — validated so the RunIndex sort key can't be a
	// free-form string ("tomorrow") that silently breaks newest-first ordering.
	generatedAt: "string.date.iso",
	"sourceRunUrl?": "string",
	// The replicate sandbox index a SHARD Run was measured under (the `--replicate` argument). Present on
	// a per-replicate shard; the aggregate reads it to key {@link MetricResult.replicates} and drops it
	// from the merged Run (which spans every replicate). Absent on legacy shards and aggregated Runs.
	"replicateIndex?": "number.integer >= 0",
	"experiment?": {
		planDigest: /^sha256:[a-f0-9]{64}$/,
		"cohortDigest?": /^sha256:[a-f0-9]{64}$/,
		attemptIds: "string[] >= 1",
	},
	targetSpec: targetSpecSchema,
	providers: providerRunSchema.array(),
}).narrow((run, ctx) => {
	// Version floors are compared NUMERICALLY, not by equality: a field introduced at v3 stays legal at
	// v4 and beyond, so "=== '3'" would have made every version bump retroactively reject the previous
	// version's own fields (the v4 aggregate below carries folded `replicates`).
	const version = Number(run.schemaVersion);
	if (version >= 7 !== (run.experiment !== undefined)) {
		return ctx.mustBe("experiment linkage exactly on Run v7 or newer");
	}
	// The replicate fields (`replicateIndex`, `MetricResult.replicates`) are v3-or-later, so "v2 == the
	// pre-replicate schema" stays a real guarantee: a producer that writes a replicate field but forgets
	// to bump schemaVersion is rejected here rather than silently read by a v3-gated consumer that then
	// ignores the between-sandbox breakdown (reporting the anti-conservative pooled interval instead).
	if (version < 3) {
		if (run.replicateIndex !== undefined) {
			return ctx.mustBe("a v3-or-later Run when it carries a replicateIndex");
		}
		if (
			run.providers.some((provider) => provider.metrics.some((m) => m.replicates !== undefined))
		) {
			return ctx.mustBe("a v3-or-later Run when a MetricResult carries replicates");
		}
	}
	// The v4 self-description fields, gated together because they arrived together. A pre-v4 consumer
	// handed any of them would fall back to the pre-v4 reading of the same fact — a heterogeneous fleet
	// read as homogeneous, an anonymous replicate cluster, re-parsed `reason` prose, a price treated as a
	// measurement, a folded host record read as one sandbox's — each a quietly wrong answer, never a loud
	// one. Reported by FIELD rather than as one blanket message, so the error names what to fix.
	if (version < 4) {
		for (const provider of run.providers) {
			if (provider.observedMixtures !== undefined) {
				return ctx.mustBe("a v4-or-later Run when a ProviderRun carries observedMixtures");
			}
			// No separate check for a replicate's mixture ids, or for a mixture's own `specMatched`: both
			// are unreachable pre-v4 by construction rather than by a second rule. A replicate id must
			// RESOLVE (the ProviderRun narrow, which runs before this one), and `specMatched` lives inside
			// a mixture — so each requires `observedMixtures`, which the check above has already refused.
			// Restating them here would read as defence-in-depth while actually being dead branches that
			// no test can reach and that a later reader would have to re-derive as unreachable.
			if (provider.gaps.some((gap) => gap.cause !== undefined)) {
				return ctx.mustBe("a v4-or-later Run when a ResultGap carries a structured cause");
			}
			if (provider.metrics.some((metric) => metric.derived !== undefined)) {
				return ctx.mustBe("a v4-or-later Run when a MetricResult carries the derived marker");
			}
			if (
				provider.hostMetadata?.some(
					(record) =>
						record.sandboxes !== undefined ||
						record.hostHardwareId !== undefined ||
						record.hostNetworkId !== undefined,
				)
			) {
				return ctx.mustBe("a v4-or-later Run when a HostMetadataRecord is folded or attributed");
			}
		}
	}
	for (const provider of run.providers) {
		if (version < 5 && provider.costEvidence !== undefined) {
			return ctx.mustBe("a v5 Run when a ProviderRun carries costEvidence");
		}
		if (version >= 5 && provider.costEvidence === undefined) {
			return ctx.mustBe("a v5 ProviderRun with a costEvidence array");
		}
		// v6 gates artifactEvidence exactly as v5 gates costEvidence: forbidden below its floor so a
		// producer that writes the field without bumping the version is rejected here rather than read
		// by a v6-gated consumer, and required at the floor so a v6 Run cannot omit the attribution
		// that is the whole point of the version.
		if (version < 6 && provider.artifactEvidence !== undefined) {
			return ctx.mustBe("a v6 Run when a ProviderRun carries artifactEvidence");
		}
		if (version >= 6 && provider.artifactEvidence === undefined) {
			return ctx.mustBe("a v6 ProviderRun with an artifactEvidence array");
		}
		// Presence alone was not enough: the array's own doc says empty means "never booted", and
		// nothing held a producer to it. A Metric is a measurement taken inside a sandbox, so a v6 row
		// carrying metrics and no attribution is exactly the unattributed measurement this version
		// exists to make impossible — the empty array stays legal only for a row that measured nothing.
		if (
			version >= 6 &&
			provider.metrics.length > 0 &&
			(provider.artifactEvidence?.length ?? 0) === 0
		) {
			return ctx.mustBe(
				"a v6 ProviderRun whose metrics carry artifact attribution (an empty artifactEvidence array claims the provider never booted)",
			);
		}
		for (const evidence of provider.costEvidence ?? []) {
			if (evidence.cell.runId !== run.runId || evidence.cell.providerId !== provider.providerId) {
				return ctx.mustBe("cost evidence whose runId and providerId match its parent Run");
			}
			if (run.replicateIndex !== undefined && evidence.cell.replicateIndex !== run.replicateIndex) {
				return ctx.mustBe("shard cost evidence whose replicateIndex matches the Run");
			}
		}
		const artifactCells = new Set<string>();
		const artifactSandboxes = new Set<string>();
		let effectiveArtifactKey: string | undefined;
		for (const evidence of provider.artifactEvidence ?? []) {
			if (evidence.cell.runId !== run.runId || evidence.cell.providerId !== provider.providerId) {
				return ctx.mustBe("artifact evidence whose runId and providerId match its parent Run");
			}
			if (run.replicateIndex !== undefined && evidence.cell.replicateIndex !== run.replicateIndex) {
				return ctx.mustBe("shard artifact evidence whose replicateIndex matches the Run");
			}
			const cellKey = providerCostCellKey(evidence);
			if (artifactCells.has(cellKey)) {
				return ctx.mustBe("at most one artifact attribution for each benchmark cell");
			}
			artifactCells.add(cellKey);
			if (artifactSandboxes.has(evidence.sandboxId)) {
				return ctx.mustBe("an artifact sandbox id used by exactly one benchmark cell");
			}
			artifactSandboxes.add(evidence.sandboxId);
			const artifact = effectiveArtifact(evidence.provenance);
			// A tuple fixes comparison order even when an input JSON object listed `ref` before `kind`.
			const currentArtifactKey = JSON.stringify([
				artifact.kind,
				"ref" in artifact ? artifact.ref : null,
			]);
			if (effectiveArtifactKey !== undefined && currentArtifactKey !== effectiveArtifactKey) {
				return ctx.mustBe("one effective artifact across every sandbox of a provider Run");
			}
			effectiveArtifactKey = currentArtifactKey;
		}
	}
	// `replicateIndex` marks a per-replicate SHARD (one sandbox, not yet folded); `MetricResult.replicates`
	// marks the AGGREGATE (the fold across shards, which drops `replicateIndex`). A Run carrying both is
	// neither — reject it here rather than leave a consumer to guess which level it is looking at.
	if (
		run.replicateIndex !== undefined &&
		run.providers.some((provider) => provider.metrics.some((m) => m.replicates !== undefined))
	) {
		return ctx.mustBe(
			"either a replicate shard (replicateIndex, no folded replicates) or an aggregate (folded replicates, no replicateIndex), never both",
		);
	}
	return true;
});
export type Run = typeof runSchema.infer;

/**
 * Index of committed Runs, newest first — the time series the trends view reads. The `.narrow`
 * enforces the newest-first ordering the doc promises (ISO-8601 sorts lexicographically), so a
 * consumer can trust `runs[0]` is the latest without re-sorting.
 */
export const runIndexSchema = type({
	schemaVersion: "'1'",
	runs: runIndexEntrySchema.array(),
}).narrow((index, ctx) => {
	for (let i = 1; i < index.runs.length; i++) {
		const prev = index.runs[i - 1];
		const curr = index.runs[i];
		if (prev && curr && prev.generatedAt < curr.generatedAt) {
			return ctx.mustBe("a RunIndex whose runs are ordered newest-first by generatedAt");
		}
	}
	return true;
});
export type RunIndex = typeof runIndexSchema.infer;

/** Validate an unknown value as a {@link Run}. */
export function parseRun(value: unknown): Run {
	const out = runSchema(value);
	if (out instanceof type.errors) {
		throw new Error(`invalid Run: ${out.summary}`);
	}
	return out;
}

/** Validate an unknown value as a {@link RunIndex}. */
export function parseRunIndex(value: unknown): RunIndex {
	const out = runIndexSchema(value);
	if (out instanceof type.errors) {
		throw new Error(`invalid RunIndex: ${out.summary}`);
	}
	return out;
}
