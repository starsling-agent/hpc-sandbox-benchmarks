/**
 * Render a validated {@link Run} into the public comparison surface: one ranked table per emitted,
 * catalogued Metric, grouped by Dimension. This is the payoff the dataset exists for — a complete,
 * human-readable provider ranking. SDK-free: the Run model + the Catalog only.
 *
 * Each Dimension shows every Metric that at least one provider produced, with its headline Metric
 * first (catalog.ts guarantees at most one), and every provider that produced each Metric ranked by
 * its Direction (HIB → highest first, LIB → lowest first). A Metric with no provider value is omitted.
 * The representative value is the Samples' p50 (median) — robust to a single slow pass.
 *
 * The document leads with `realworld` and collapses the synthetic microbenchmarks, because that is the
 * claim this benchmark makes: a synthetic score says what the hardware CAN do, and the real-world
 * workflows say what a developer or a CI job actually waits on. See {@link LEADERBOARD_DIMENSION_ORDER}
 * and {@link SYNTHETIC_DIMENSIONS}. Which sections exist stays driven by the data — a Dimension no
 * provider emitted is absent, collapsed or not.
 *
 * Ranking is INFERENTIAL, not a bare sort, and the unit it reasons about is the SANDBOX. A provider is
 * measured on R independent sandboxes, each running k trials; trials capture within-machine noise while
 * sandboxes capture the machine-to-machine variation a user meets on every fresh environment. Ordering
 * on a median alone would let a lucky draw buy a position: a live run had modal's STREAM Copy span
 * 9.7k–65k MB/s against daytona's 66.5k ±0.14%. So each row carries a cluster-bootstrapped interval
 * around the median of its per-sandbox medians, and two rows share a rank unless their per-sandbox
 * medians separate under Mann-Whitney U (with Kolmogorov-Smirnov reported alongside, since a bimodal
 * provider can match another's median while behaving nothing like it).
 */
import type {
	Dimension,
	GapCause,
	GapOutcome,
	GapScope,
	MedianInterval,
	MetricDef,
	ObservedSpecs,
	Run,
	TargetSpec,
} from "@sandbox-benchmarks/schema";
import {
	bootstrapMedianInterval,
	canSeparate,
	clusterMedianInterval,
	clusterSeparation,
	DEFAULT_ALPHA,
	DIMENSIONS,
	getProvider,
	kolmogorovSmirnov,
	METRIC_CATALOG,
	mannWhitneyU,
	providerReportedNothing,
	SUITE_NAMES,
	sandboxMedianOf,
} from "@sandbox-benchmarks/schema";

/**
 * The repository the published leaderboard lives in — the base for every provenance link in the header.
 * A constant rather than `GITHUB_REPOSITORY`: this renderer is pure, and its output is gated
 * byte-identical against a fresh render (tooling/repo-checks/leaderboard-artifact-sync.test.ts), so a
 * link that varied with the environment would make a local regeneration differ from CI's for no reason
 * a reader could see. The artifact is published here; the links point here.
 */
export const REPO_URL = "https://github.com/starslingdev/hpc-sandbox-benchmarks";

/** The committed dataset tree — one Run document per run id, written by `promote`. */
export const DATASET_RUNS_DIR = "data/dataset/runs";

/**
 * The SYNTHETIC Dimensions: microbenchmarks that load one hardware axis in isolation (PTS profiles for
 * `cpu`/`disk`/`memory`/`network`/`system`). They answer "what can this machine do", which is a real
 * question but not the one this benchmark is FOR — so their sections render collapsed and the
 * real-world workflows lead. See {@link LEADERBOARD_DIMENSION_ORDER}.
 *
 * Deliberately not "everything except realworld". `lifecycle` and `control-plane` are harness-measured
 * timings of the provider's own API — a spawn a user waits on, not a synthetic load — and `economics`
 * is the provider's published price. Neither is a microbenchmark, so neither is hidden behind a
 * disclosure triangle.
 */
export const SYNTHETIC_DIMENSIONS: ReadonlySet<Dimension> = new Set<Dimension>([
	"cpu",
	"disk",
	"memory",
	"network",
	"system",
]);

/**
 * Dimension render order: `realworld` first, then the Catalog's own order for the rest. Only the hoist
 * is editorial — everything else keeps {@link DIMENSIONS}' ordering so a new Dimension lands where the
 * schema says it belongs, without a second ordering to keep in sync.
 *
 * This is presentation priority, never a filter: {@link buildLeaderboard} still emits a Dimension only
 * when some provider produced a catalogued Metric in it.
 */
export const LEADERBOARD_DIMENSION_ORDER: readonly Dimension[] = [
	"realworld",
	...DIMENSIONS.filter((dimension) => dimension !== "realworld"),
];

/**
 * The Dimension whose section leads with FIGURES instead of tables. See
 * {@link renderLeaderboardMarkdown} on why the tables then collapse rather than disappear.
 *
 * A constant rather than a literal in two places: the renderer branches on it and
 * `tooling/repo-checks/src/leaderboard-artifact-sync.test.ts` asserts the resulting layout, and a
 * gate holding its own copy of "which dimension is special" stops checking the renderer the moment
 * the renderer changes its mind.
 */
export const FIGURE_DIMENSION: Dimension = "realworld";

/**
 * One rendered suite chart the Markdown embeds — what the renderer needs in order to link a figure
 * it did not produce.
 *
 * The renderer takes these as an ARGUMENT rather than deriving them, and the argument is required
 * rather than defaulted. Which suites are chartable is a decision the figure pipeline makes from
 * the run (it needs two environments that completed every exercised task), so re-deriving it here
 * would be a second copy of that rule, free to disagree — and the way it would disagree is by
 * linking an image nobody wrote, which renders as a broken image on the published page and as a
 * passing test in CI. Handing over the list that was actually rendered makes that impossible: the
 * writer and the linker read the same array.
 */
export interface LeaderboardFigure {
	/** The suite's registry id, e.g. `realworld-better-auth`. */
	readonly suiteId: string;
	/** Display name for the alt text, e.g. `Better-Auth`. */
	readonly suiteName: string;
	/** Path the Markdown links, relative to the directory holding it. */
	readonly file: string;
	/** Display width in CSS px. The committed WebP is rasterised at 2× this, so the `<img>`
	 *  tag must say the logical width or GitHub shows the chart at double size. */
	readonly width: number;
	/** Environments charted, and those the chart discloses as not having completed the suite. */
	readonly charted: number;
	readonly incomplete: number;
	readonly tasks: number;
}

/** One provider's standing on one Metric. */
export interface LeaderboardRow {
	providerId: string;
	displayName: string;
	/**
	 * Representative value of the Metric for this provider: with replicate sandboxes, the median of the
	 * PER-SANDBOX medians (one machine one vote — NOT `aggregates.p50`, which weights each machine by its
	 * trial count); without them, the p50 of that single sandbox's Samples.
	 */
	value: number;
	/**
	 * 1-based rank by the Metric's Direction. Providers that are NOT distinguishable share a rank: a
	 * faster median earned inside the noise is not a faster provider. The deciding test is the
	 * SANDBOX-LEVEL one wherever replicate sandboxes exist — Mann-Whitney U (two-sided,
	 * α = {@link DEFAULT_ALPHA}) on each side's per-sandbox medians, whole machines as the exchangeable
	 * unit; only where both sides ran in a single sandbox does it fall back to Mann-Whitney on the pooled
	 * trials. See {@link pVsPrevious} for which one decided a given row.
	 */
	rank: number;
	/**
	 * Descriptive bootstrap interval around {@link value}, over the same estimand. NOT a calibrated
	 * interval at small R: simulated coverage of a nominal 95% is ≈77% at R=3, ≈92% at R=6, ≈95% at R=20.
	 * That is a property of the sandbox count, not of the method — renderers must disclose it.
	 */
	interval: MedianInterval;
	/**
	 * Retained TRIAL count pooled across sandboxes, and their spread. `n` is not the unit of replication
	 * and must never be rendered as if it were: {@link sandboxes} is. Under convergence a large `n` is
	 * evidence the machines were UNSTABLE (PTS kept re-running), not that the estimate is precise.
	 */
	n: number;
	/** Replicate sandboxes behind {@link value} — the actual unit of replication. `null` at R=1. */
	sandboxes: number | null;
	/**
	 * Sample standard deviation of the POOLED trials, so it conflates between-machine and within-machine
	 * variance (measured median ICC 0.53 — roughly half of it is within-machine). Not rendered anywhere
	 * for exactly that reason; do not surface it without decomposing it first.
	 */
	stdev: number;
	/**
	 * Two-sided p-values against the row immediately above (`null` for rank 1, which has no predecessor).
	 * `mannWhitney` tests a shift in central tendency and drives the tie grouping; `ks` compares the full
	 * empirical CDFs, catching a provider whose median matches but whose distribution is bimodal — the
	 * signature of environmental noise rather than a real difference.
	 *
	 * Both are rendered: `mannWhitney` as `p vs. above`, `ks` as `p (KS)`. Only `mannWhitney` decides the
	 * rank; `ks` is shown so a reader can see the two disagree.
	 */
	pVsPrevious: {
		mannWhitney: number;
		ks: number;
		floor: number;
		/**
		 * The test that ACTUALLY decided {@link verdict}, when the sandbox-level path decided it. Carried
		 * separately because the two floors differ by orders of magnitude and quoting the wrong one made
		 * the published footnote self-refuting: it asserted "the best attainable p already exceeds α" while
		 * printing the POOLED floor of <0.001. `null` when the pooled Mann-Whitney above decided (R=1 both
		 * sides), in which case `mannWhitney`/`floor` are the deciding numbers.
		 */
		cluster: { p: number; floor: number; sandboxesA: number; sandboxesB: number } | null;
	} | null;
	/**
	 * What the test said about this row and the one above it (`null` for rank 1, which has nothing above):
	 *
	 *  - `separated`    — the distributions differ (p < α). This row ranks strictly below the one above.
	 *  - `tied`         — the test ran, could have separated them, and did not. A real statistical tie.
	 *  - `underpowered` — the test COULD NOT have separated them at any effect size: its best attainable
	 *    p already exceeds α. That is a fact about the trial count, not about the providers, and it is
	 *    not a tie. See {@link tiedWithAbove} for what the rank then means.
	 *  - `untested`     — fewer than 2 Samples on a side: no distribution to test at all.
	 */
	verdict: ComparisonVerdict | null;
	/**
	 * Why this row shares the rank above it — and `null` exactly when it does NOT share it. Every shared
	 * rank states its reason, because "same rank" means two different things and conflating them is how a
	 * table comes to claim a tie it never established:
	 *
	 *  - `statistical`    — the test ran and could not tell them apart. THIS is the statistical tie.
	 *  - `identical-value` — their values are exactly equal, so the ranking has nothing to order them by.
	 *    It says nothing about the distributions; it is what stops the providerId sort tie-break from
	 *    silently deciding which of two identical published prices "wins". An `underpowered` row can share
	 *    a rank on this basis, and when it does, the shared rank is NOT a claim that they are alike.
	 */
	tiedWithAbove: TieBasis | null;
}

/** What the pairwise Mann-Whitney test said about a row and the one above it. */
export type ComparisonVerdict = "separated" | "tied" | "underpowered" | "untested";

/** Why a row shares the rank above it. See {@link LeaderboardRow.tiedWithAbove}. */
export type TieBasis = "statistical" | "identical-value";

/** One emitted Metric's ranked provider comparison. */
export interface LeaderboardMetric {
	metric: MetricDef;
	rows: LeaderboardRow[];
}

/** Every emitted Metric in one Dimension, with the headline first. */
export interface LeaderboardDimension {
	dimension: Dimension;
	metrics: LeaderboardMetric[];
	/** First rendered Metric (the headline when one was emitted), retained for API compatibility. */
	metric: MetricDef;
	/** Rows for {@link metric}, retained for API compatibility. */
	rows: LeaderboardRow[];
}

/** A provider whose observed allocation did not match the Run's requested target. */
export interface ComparabilityCaveat {
	providerId: string;
	displayName: string;
	observedSpecs: ObservedSpecs;
}

/**
 * One provider's isolation-technology standing in a Run: what it DECLARES it runs (the authoritative
 * per-provider fact from the schema registry) alongside what the in-sandbox probe could actually
 * DETECT ({@link ObservedSpecs.detectedIsolation}). The two are surfaced together so the comparison
 * discloses which isolation each measured provider used — and `mismatch` flags the rare case where a
 * detectable signal contradicts the declaration (a bake pointed at the wrong class, say), without ever
 * letting the unreliable probe override the declared label.
 */
export interface ProviderRosterEntry {
	providerId: string;
	displayName: string;
	/** The schema-declared isolation technology (authoritative), or `undefined` for an unknown id. */
	declaredIsolation: string | undefined;
	/** The probe's coarse best-effort class ("gvisor"/"container"/"vm"/"unknown"), or `undefined`. */
	detectedIsolation: string | undefined;
	/** True only when the probe returned a known class that contradicts the declared technology. */
	mismatch: boolean;
}

/**
 * How a benchmark came to produce no result for a provider — the leaderboard's outcome vocabulary.
 * The first two are RECORDED by the producer ({@link GapOutcome}); `missing` is DERIVED here, and is
 * the one a Run cannot state about itself:
 *
 *  - `skipped` — a precondition said no before anything ran (not enough disk for the suite).
 *  - `failed`  — it ran and broke (the suite threw, the operation errored, the sandbox died).
 *  - `missing` — nothing was ever reported: no result, and no marker either. The suite ran somewhere
 *    else in this Run, so it was part of the comparison, but this provider is simply absent from it.
 *    A dropped CI job, an artifact that never uploaded, a sandbox that died before it could write a
 *    marker. Left underived, it is the ONE hole that shows up nowhere: not in the table (no value to
 *    rank), and not in the gaps (no marker to read).
 */
export type CoverageOutcome = GapOutcome | "missing";

/** One benchmark that produced no result for a provider — a hole in the comparison, surfaced not hidden. */
export interface CoverageGap {
	providerId: string;
	displayName: string;
	/** What did not run: a whole suite, or one harness lifecycle operation. */
	scope: GapScope;
	/** The suite name, or the harness Metric id — whichever {@link scope} names. */
	id: string;
	outcome: CoverageOutcome;
	/** The producer's verbatim reason (a disk shortfall's numbers, an error message), or ours for `missing`. */
	reason: string;
	/**
	 * True when the suite was skipped because the provider could not supply the disk it needs — the
	 * case the leaderboard calls out loudly, since it means a provider is structurally unable to run a
	 * whole class of workload, not that it ran and lost.
	 */
	disk: boolean;
}

/** A registered provider whose Run row carries no evidence at all — never dispatched, or lost whole. */
export interface AbsentProvider {
	providerId: string;
	displayName: string;
}

/** The full comparison surface derived from one Run. */
export interface Leaderboard {
	runId: string;
	comparisonCohort?: string;
	sha: string;
	generatedAt: string;
	/** The requested comparison target recorded on this Run — never substituted from global config. */
	targetSpec: TargetSpec;
	dimensions: LeaderboardDimension[];
	/** Every provider measured in this Run with its declared vs detected isolation, in run order. */
	roster: ProviderRosterEntry[];
	/** Providers explicitly recorded as failing to match {@link targetSpec}. */
	comparabilityCaveats: ComparabilityCaveat[];
	/** Every benchmark that produced no result somewhere, disk gaps first. Empty when coverage is complete. */
	coverageGaps: CoverageGap[];
	/**
	 * Registered providers whose Run row is a zero-evidence pending placeholder (the dataset keeps one
	 * row per registry provider). Surfaced as one "not present in this run" note rather than per-suite
	 * `missing` rows: a provider the run never dispatched has not "failed to cover" anything, and its
	 * phantom rows would bury the real holes (16 of 24 committed coverage rows once accused two
	 * never-dispatched providers).
	 */
	absentProviders: AbsentProvider[];
}

/**
 * Whether the Run's producer was able to classify gaps at all — true once ANY gap carries a structured
 * cause. This is what decides whether an ABSENT cause is meaningful.
 *
 * Deliberately not `schemaVersion >= 4`. The version says which fields the document MAY carry, not
 * whether its producer populated them, and the two come apart precisely where it matters: re-aggregating
 * a historical run emits a v4 document whose gaps have no causes, because the shard markers it merges
 * were written by a harness that predated the taxonomy. Gating on the version would strip the disk
 * classification off every backfilled run in the committed series; gating on the evidence does not.
 */
function producerClassifiesGaps(run: Run): boolean {
	return run.providers.some((provider) => provider.gaps.some((gap) => gap.cause !== undefined));
}

/**
 * Whether a gap is a disk-capacity skip — the sandbox had less free disk than the suite's `minDiskGb`.
 *
 * Reads the structured {@link ResultGap.cause} whenever the Run's producer classified anything. In that
 * case an absent cause means "this gap is unclassified", and prose-matching it anyway would manufacture
 * a confident diagnosis for an event the producer declined to diagnose — exactly what the taxonomy's
 * no-catch-all rule forbids.
 *
 * The prose match survives only for Runs whose producer emitted no causes at all, where the English
 * sentence is the sole record of the fact. A compatibility shim over a closed input set — not a parser
 * to extend. A NEW fact belongs in the cause taxonomy.
 */
function isDiskGap(gap: { reason: string; cause?: GapCause }, classified: boolean): boolean {
	if (gap.cause !== undefined) return gap.cause.kind === "disk-shortfall";
	return !classified && /^insufficient disk/i.test(gap.reason.trim());
}

/** Rendering/sort precedence: the structural absences first, the merely-unreported last. */
const OUTCOME_ORDER: Record<CoverageOutcome, number> = { skipped: 0, failed: 1, missing: 2 };

/** The registry's suite names — the only ids a suite-scope gap may fold into the derivation below. */
const REGISTERED_SUITES = new Set<string>(SUITE_NAMES);

/**
 * The suites this Run actually exercised — every suite that produced a Metric for SOME provider, or
 * that some provider left a marker for. This is the denominator the missing-suite gaps are derived
 * against, and it is deliberately the Run's OWN evidence rather than the registry's `SUITE_NAMES`: a
 * Run that only ever ran the disk suite has not "failed to cover" the other five, and accusing every
 * provider of five holes would bury the one real gap in noise the reader must then learn to ignore.
 *
 * Only REGISTERED suite names fold in, from either source. Gap ids: a legacy bash leaf marker's
 * pseudo-suite id (e.g. "pts_fast-cli" — the marker body's `benchmark` becomes the gap id) is a
 * real recorded gap, but it is not a suite, and admitting it here would accuse every OTHER provider
 * of missing a nonexistent one. (The normalizer now folds leaf ids into their suite; this filter
 * keeps already-published Runs that predate the fold from corrupting the denominator.)
 * `suitesCovered`: today's producer only records catalogued suites, but an already-published Run
 * outlives the registry that validated it — a suite deregistered later would otherwise re-enter the
 * denominator and accuse every current provider of missing a suite nobody can run anymore.
 */
function suitesExercised(run: Run): string[] {
	const suites = new Set<string>();
	for (const provider of run.providers) {
		for (const suite of provider.suitesCovered) {
			if (REGISTERED_SUITES.has(suite)) suites.add(suite);
		}
		for (const gap of provider.gaps) {
			if (gap.scope === "suite" && REGISTERED_SUITES.has(gap.id)) suites.add(gap.id);
		}
	}
	return [...suites].sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Every hole in one Run's coverage: the gaps the providers RECORDED (skipped / failed), plus the ones
 * only the whole Run can see — a suite that ran elsewhere but never reported here at all, with no
 * result and no marker to explain itself.
 *
 * Deriving that last class is the difference between a coverage section that is honest and one that
 * merely looks it: an unrecorded absence is exactly what a dropped CI job, a lost artifact, or a
 * sandbox that died before writing its marker leaves behind, and it is invisible in every other view —
 * the ranked tables can only show providers that produced a value.
 */
function coverageGapsOf(run: Run): CoverageGap[] {
	const exercised = suitesExercised(run);
	// Computed once per Run, not per gap: whether an absent cause means "unclassified" or "this producer
	// had no causes to give".
	const classified = producerClassifiesGaps(run);

	const gaps = run.providers.flatMap((provider): CoverageGap[] => {
		// A zero-evidence registry row (never dispatched, or every cell lost before reporting) gets the
		// single "not present in this run" note instead of one derived `missing` row per exercised
		// suite. Any participation evidence — a gap, a straggler, a spec probe — keeps the provider in
		// the derivation: it WAS part of the run, so its holes are real.
		if (providerReportedNothing(provider)) return [];
		const displayName = getProvider(provider.providerId)?.displayName ?? provider.providerId;
		const accountedFor = new Set([
			...provider.suitesCovered,
			...provider.gaps.filter((g) => g.scope === "suite").map((g) => g.id),
		]);
		return [
			...provider.gaps.map((gap) => ({
				providerId: provider.providerId,
				displayName,
				scope: gap.scope,
				id: gap.id,
				outcome: gap.outcome satisfies GapOutcome as CoverageOutcome,
				reason: gap.reason,
				// Only a SKIP can be a disk gap: the reason is the harness's precondition message, written
				// before the suite was attempted. A failure's reason is an error message, and one that merely
				// happens to start with "insufficient disk" is the workload running out of space mid-flight —
				// a different fact, and not the structural "cannot host this at all" the ❌ claims.
				disk: gap.outcome === "skipped" && isDiskGap(gap, classified),
			})),
			...exercised
				.filter((suite) => !accountedFor.has(suite))
				.map((suite) => ({
					providerId: provider.providerId,
					displayName,
					scope: "suite" as GapScope,
					id: suite,
					outcome: "missing" as CoverageOutcome,
					reason: "No result and no marker — the suite never reported for this provider.",
					disk: false,
				})),
		];
	});

	// Deterministically ordered so a committed leaderboard is byte-stable: disk gaps first (the headline
	// — a provider that cannot fit the workload at all), then by outcome, then by provider and benchmark.
	// Locale pinned to "en": bare localeCompare collates by whatever locale the runtime was built with.
	return gaps.sort(
		(a, b) =>
			Number(b.disk) - Number(a.disk) ||
			OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome] ||
			a.displayName.localeCompare(b.displayName, "en") ||
			a.id.localeCompare(b.id, "en"),
	);
}

/** Rank all providers that emitted one Metric; empty when the Run has no result for it. */
function rankMetric(run: Run, metric: MetricDef): LeaderboardRow[] {
	// Carry each provider's raw Samples alongside its row: the ranking needs the full distributions,
	// not just their medians, to tell a real difference from environmental noise.
	const candidates = run.providers.flatMap((provider) => {
		const result = provider.metrics.find((m) => m.metricId === metric.id);
		if (!result) return [];
		// The per-replicate sample slices, present only once the aggregate merged ≥2 replicate sandboxes.
		const replicates = result.replicates?.map((r) => r.samples);
		const seed = `${run.runId}:${metric.id}:${provider.providerId}`;
		const row: LeaderboardRow = {
			providerId: provider.providerId,
			displayName: getProvider(provider.providerId)?.displayName ?? provider.providerId,
			// ONE MACHINE, ONE VOTE. With replicate sandboxes the ranking value is the median of the
			// per-sandbox medians, not `aggregates.p50` (the median of the POOLED trials). Pooling weights
			// each sandbox by its trial count, and PTS convergence sets that count by watching the variance,
			// so the noisiest machine earned the most votes: on the committed data ρ(trials, within-sandbox
			// CV) = 0.76, and one headline row published 20.99 from sandbox medians {18.87, 21.06, 18.95}
			// because the 15-pass machine held 71% of the weight. The pooled Samples stay in the dataset as
			// the raw evidence; they are no longer the ranking statistic.
			value: replicates ? sandboxMedianOf(replicates) : result.aggregates.p50,
			rank: 0, // assigned after sort
			// Seed from stable identity so a committed leaderboard is byte-identical on every regeneration —
			// a Math.random() bootstrap would churn the diff on every run. The interval is the CLUSTER
			// bootstrap of that same statistic (resample sandboxes intact), so estimate and interval share
			// an estimand; at R=1 there is no between-machine information and it stays the ordinary
			// percentile bootstrap over the single sandbox's trials.
			interval: replicates
				? clusterMedianInterval(replicates, { seed })
				: bootstrapMedianInterval(result.samples, { seed }),
			n: result.aggregates.n,
			sandboxes: replicates?.length ?? null,
			stdev: result.aggregates.stdev,
			pVsPrevious: null,
			verdict: null,
			tiedWithAbove: null,
		};
		return [{ samples: result.samples, replicates, row }];
	});
	if (candidates.length === 0) return [];

	// Order by Direction; tie-break on providerId so the output is deterministic. Locale pinned to
	// "en" so the byte-identical artifact gate can't flake on a runner built with a different locale.
	candidates.sort((a, b) =>
		a.row.value !== b.row.value
			? metric.direction === "HIB"
				? b.row.value - a.row.value
				: a.row.value - b.row.value
			: a.row.providerId.localeCompare(b.row.providerId, "en"),
	);

	// Competition ranking with STATISTICAL ties. Walk the ordered rows and test each against the one
	// above: when Mann-Whitney can't separate them, they share a rank rather than letting a median
	// won inside the noise buy a position. `separated` carries the verdict; `ks` is reported beside
	// it because two providers can share a median while differing in distribution shape.
	//
	// Only ADJACENT rows are tested, which is deliberate: a leaderboard is a linear order, and the
	// pairwise "which providers are mutually indistinguishable" relation is not transitive (A~B and
	// B~C does not give A~C). Testing the chain keeps the table honest about the one comparison it
	// actually renders — each row against the row above it — instead of implying a grouping the
	// tests don't support. It also keeps this to k−1 tests. The rendered methodology explicitly labels
	// their p-values unadjusted and exploratory; it does not claim family-wise error control.
	candidates.forEach((candidate, i) => {
		const previous = candidates[i - 1];
		if (!previous) {
			candidate.row.rank = 1;
			return;
		}
		// A row shares the rank above it EXACTLY when it has a reason to, and the reason is recorded.
		// That invariant is the whole defence against the table claiming a tie it never established: a
		// shared rank always answers "on what basis?", and the renderer prints the answer.
		const settle = (basis: TieBasis | null): void => {
			candidate.row.tiedWithAbove = basis;
			candidate.row.rank = basis === null ? i + 1 : previous.row.rank;
		};
		// Exactly equal values cannot be ordered by a ranking that ranks on the value. Whenever no
		// verdict is available to override that, they must share a rank — otherwise the providerId sort
		// tie-break alone would split two providers with an identical published price.
		const identical = candidate.row.value === previous.row.value;

		// A single Sample is not a distribution: there is nothing to test, and the value is typically
		// exact rather than measured (a Metric like `usd_per_hour` is a published price, not a trial).
		// Rank such rows on the value and mark them untested, rather than declaring every provider
		// "indistinguishable" because a one-trial comparison can never reach significance.
		if (previous.samples.length < 2 || candidate.samples.length < 2) {
			candidate.row.verdict = "untested";
			settle(identical ? "identical-value" : null);
			return;
		}

		const mw = mannWhitneyU(previous.samples, candidate.samples);
		const ks = kolmogorovSmirnov(previous.samples, candidate.samples);
		candidate.row.pVsPrevious = {
			mannWhitney: mw.pValue,
			ks: ks.pValue,
			floor: mw.minAttainablePValue,
			// Filled in below when the sandbox-level test decides; stays null on the R=1 path.
			cluster: null,
		};

		// Replicate-aware separation: when EITHER row carries ≥2 replicate sandboxes, the decider is the
		// EXACT cluster-level rank permutation `clusterSeparation` — Mann-Whitney U on the per-sandbox
		// medians, whole sandboxes the exchangeable unit. That is cluster-honest where MW on samples pooled
		// across replicates is anti-conservative, and it carries the real 2/C(2R,R) floor, so small R reads
		// as UNDERPOWERED rather than a false tie or a false separation. A row with no replicate breakdown
		// enters as a single cluster of its pooled Samples, so a mixed-R pair is judged the same honest way.
		// MW/KS above stay as descriptive columns only. At R=1 on BOTH sides this is skipped and
		// Mann-Whitney on the pooled Samples decides the rank, as before.
		//
		// The verdict only, not the whole `bootstrapMedianDifferenceInterval`: the table renders no
		// difference interval, and the seeded 10 000-resample hierarchical bootstrap behind `lo`/`hi` was
		// the single largest cost of building this board — computed once per adjacent pair and discarded.
		// `clusterSeparation` is the identical (RNG-free) verdict that function returns.
		if (previous.replicates || candidate.replicates) {
			const clustersA = previous.replicates ?? [previous.samples];
			const clustersB = candidate.replicates ?? [candidate.samples];
			const cluster = clusterSeparation(clustersA, clustersB);
			// Record the DECIDING test beside the descriptive one, so the renderer never has to guess which
			// floor produced the verdict it is explaining.
			if (candidate.row.pVsPrevious) {
				candidate.row.pVsPrevious.cluster = {
					p: cluster.pValue,
					floor: cluster.minAttainablePValue,
					sandboxesA: clustersA.length,
					sandboxesB: clustersB.length,
				};
			}
			// The same "a test that can never reach α is not evidence of sameness" rule as the R=1 path:
			// when the between-sandbox floor already meets α (2/C(6,3)=0.1 at R=3), no data could separate
			// the pair, so it is underpowered — never a "tied" verdict, which would claim the test had the
			// power to find a difference and didn't. Rank on the value; the renderer discloses it.
			if (cluster.minAttainablePValue >= DEFAULT_ALPHA) {
				candidate.row.verdict = "underpowered";
				settle(identical ? "identical-value" : null);
				return;
			}
			candidate.row.verdict = cluster.separated ? "separated" : "tied";
			settle(cluster.separated ? null : "statistical");
			return;
		}

		// The same "a test that can never reach α is not evidence of sameness" rule as the n<2 case
		// above, applied where it actually bites: Mann-Whitney's p has a FLOOR, and at 3 v 3 that floor
		// (0.1) is already above α. Grouping those rows would print "statistically tied" for a provider
		// running at half the speed of the one above it — a fact about the trial count masquerading as a
		// fact about the providers. Claim no verdict, rank on the observed value, and let the rendering
		// disclose that the comparison was untestable.
		//
		// The floor comes from the test itself (it depends on the tie pattern, not just the sample
		// sizes), so the guard and the p-value it guards are answers about the same enumerated null and
		// cannot disagree.
		if (!canSeparate(mw)) {
			candidate.row.verdict = "underpowered";
			// An underpowered row can still share a rank — but only ever because the two values are
			// identical, never because the test "found no difference". The basis says which, so the
			// renderer and the footer can keep the two apart.
			settle(identical ? "identical-value" : null);
			return;
		}

		if (mw.pValue < DEFAULT_ALPHA) {
			candidate.row.verdict = "separated";
			settle(null);
			return;
		}
		// The test could have separated them and did not: a real statistical tie.
		candidate.row.verdict = "tied";
		settle("statistical");
	});

	return candidates.map((candidate) => candidate.row);
}

/**
 * Collapse a declared isolation technology to the coarse class the probe can speak in: "gvisor",
 * "container", or "vm" (or `undefined` when it doesn't map). Order matters — Modal's "gVisor
 * container" contains both "gvisor" and "container", so gVisor is checked first; "microVM" contains
 * "vm", so VM is checked before the bare container fallback.
 */
function isolationClass(declared: string | undefined): "gvisor" | "container" | "vm" | undefined {
	if (!declared) return undefined;
	const lower = declared.toLowerCase();
	if (lower.includes("gvisor")) return "gvisor";
	if (lower.includes("vm")) return "vm";
	if (lower.includes("container")) return "container";
	return undefined;
}

/**
 * Build the per-provider isolation roster: declared technology (authoritative) beside the probe's
 * best-effort detected class. A `mismatch` is flagged only when the probe returned one of the three
 * recognized classes ("gvisor"/"container"/"vm") that disagrees with the declared one — a detected
 * "unknown" (the common case) or any unrecognized raw value never counts, so the declaration wins.
 */
function buildRoster(run: Run): ProviderRosterEntry[] {
	// "Every provider measured in this Run": a zero-evidence registry placeholder was not measured —
	// it lands in the absent-providers note instead of a roster row claiming an isolation nobody probed.
	const measured = run.providers.filter((p) => !providerReportedNothing(p));
	return measured.map((provider): ProviderRosterEntry => {
		const meta = getProvider(provider.providerId);
		const declaredIsolation = meta?.isolation.technology;
		const detectedIsolation = provider.observedSpecs.detectedIsolation;
		const declaredClass = isolationClass(declaredIsolation);
		// Flag a mismatch ONLY for the one contradiction the probe can tell apart reliably: gVisor
		// (announced in /proc/version) vs a real VM hypervisor (systemd-detect-virt --vm). The probe's
		// "container" signal is a cgroup-quota heuristic that a microVM (Daytona's LINUX_VM exposes a
		// bounded vCPU quota) and gVisor both trip — and gVisor *is* a container runtime — so "container"
		// cannot contradict a declared vm/gvisor without putting a false ⚠ on a correctly-baked provider
		// (this PR's own run.ts note says a container and a microVM can't be separated). Any other value
		// ("unknown", or a raw systemd-detect-virt string) never counts either.
		const mismatch =
			(declaredClass === "gvisor" && detectedIsolation === "vm") ||
			(declaredClass === "vm" && detectedIsolation === "gvisor");
		return {
			providerId: provider.providerId,
			displayName: meta?.displayName ?? provider.providerId,
			declaredIsolation,
			detectedIsolation,
			mismatch,
		};
	});
}

/** Build the structured leaderboard from a validated Run. Pure — Run in, ranking out. */
export function buildLeaderboard(run: Run): Leaderboard {
	const dimensions: LeaderboardDimension[] = [];

	for (const dimension of LEADERBOARD_DIMENSION_ORDER) {
		// Catalog order is the stable display order, except the dimension's editorial headline leads.
		// Crucially, every emitted Metric gets a table: headline is presentation priority, not a filter.
		const catalogued = METRIC_CATALOG.filter((metric) => metric.dimension === dimension).sort(
			(a, b) => Number(b.headline) - Number(a.headline),
		);
		const metrics = catalogued.flatMap((metric): LeaderboardMetric[] => {
			const rows = rankMetric(run, metric);
			return rows.length === 0 ? [] : [{ metric, rows }];
		});
		const primary = metrics[0];
		if (primary) {
			dimensions.push({ dimension, metrics, metric: primary.metric, rows: primary.rows });
		}
	}

	return {
		runId: run.runId,
		...(run.experiment?.cohortDigest ? { comparisonCohort: run.experiment.cohortDigest } : {}),
		sha: run.sha,
		generatedAt: run.generatedAt,
		targetSpec: run.targetSpec,
		dimensions,
		roster: buildRoster(run),
		absentProviders: run.providers.filter(providerReportedNothing).map((provider) => ({
			providerId: provider.providerId,
			displayName: getProvider(provider.providerId)?.displayName ?? provider.providerId,
		})),
		comparabilityCaveats: run.providers.flatMap((provider): ComparabilityCaveat[] =>
			provider.specMatched === false
				? [
						{
							providerId: provider.providerId,
							displayName: getProvider(provider.providerId)?.displayName ?? provider.providerId,
							observedSpecs: provider.observedSpecs,
						},
					]
				: [],
		),
		coverageGaps: coverageGapsOf(run),
	};
}

/**
 * Describe every underpowered comparison the board actually contains, as
 * `"3 v 3 sandboxes floors at p ≈ 0.1"` — quoting the floor THE TEST REPORTED for that row, never one
 * recomputed from the counts here. The floor depends on the TIE PATTERN as well as the counts, so a
 * footer that re-derived it, or that deduplicated on the counts alone, could print a number the row's
 * own test never produced: the committed run contains 3-v-3 comparisons floored at 0.1, 0.2, 0.4 AND
 * 1.0, the last three from ties among the per-sandbox medians. Deduplication therefore keys on the
 * (counts, floor) pair, so every distinct floor the board contains is listed. An underpowered row is
 * always compared against the row above it, which is what supplies the other count. Ordered so the
 * committed markdown stays byte-stable.
 */
function underpoweredFloors(board: Leaderboard): string[] {
	const seen = new Map<string, string>();
	for (const { metrics } of board.dimensions) {
		for (const { rows } of metrics) {
			rows.forEach((row, i) => {
				const previous = rows[i - 1];
				if (row.verdict !== "underpowered" || !previous || !row.pVsPrevious) return;
				// Quote the test that DECIDED, in ITS unit. When the sandbox-level test decided, the binding
				// constraint is the number of machines and the floor is 2/C(Ra+Rb, Ra) — keying this on the
				// pooled trial counts and printing the pooled floor is what made the published footnote assert
				// "the floor exceeds α" beside a printed <0.001. Only the R=1-both-sides path falls through to
				// the pooled Mann-Whitney, where trial counts genuinely are the unit.
				//
				// Key on the unit counts AND the floor, never the counts alone: the attainable floor depends on
				// the TIE PATTERN among the per-sandbox medians as well as their number (see
				// `minAttainablePValue`), so one shape yields several floors. The committed run has 3-v-3
				// comparisons floored at 0.1, 0.2, 0.4 and 1.0 — a count-only key silently kept whichever
				// landed last and printed it as if it were the floor for all of them.
				const { cluster, floor } = row.pVsPrevious;
				const unit = cluster
					? `${cluster.sandboxesA} v ${cluster.sandboxesB} sandboxes`
					: `${previous.n} v ${row.n} trials`;
				const attainable = cluster ? cluster.floor : floor;
				seen.set(`${unit}\0${attainable}`, `${unit} floors at p ≈ ${formatPValue(attainable)}`);
			});
		}
	}
	return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([, text]) => text);
}

/**
 * Neutralize the HTML-significant characters. GitHub renders raw HTML inside Markdown, so any text
 * that reaches markup passes through here first — a gap reason carrying an upstream error page
 * (`<HTML>`, `<PRE>`, `<HR>` from a CloudFront/proxy diagnostic) would otherwise inject live markup
 * instead of showing as a plain diagnostic. `&` goes first so the entities emitted for `<`/`>` aren't
 * themselves re-encoded.
 */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Make free-form text safe inside a Markdown table cell. Skip reasons are the harness's verbatim
 * strings — a `|` would end the cell and a newline would end the row, silently corrupting the table —
 * on top of the raw-HTML hazard {@link escapeHtml} handles.
 *
 * Order matters: escape each escape-introducing character before the character it guards. The
 * backslash is doubled before we backslash-escape `|` — otherwise a reason containing `\|` would leave
 * a lone `\` in front of our escape, unescaping the pipe and breaking the cell anyway. HTML escaping
 * runs first for the same reason it does inside {@link escapeHtml}: the `&` of an emitted entity must
 * not be re-encoded, and the entities it emits contain no `\` or `|` for the later passes to mangle.
 *
 * The final pass folds any whitespace run that spans a newline down to a single space (a newline
 * would otherwise end the table row). It scans each maximal `\s+` run once rather than matching
 * `\s*\n\s*`, whose optional runs on both sides of a required `\n` backtrack quadratically on a long
 * newline-free whitespace stretch in an attacker-influenced reason.
 */
function escapeCell(text: string): string {
	return escapeHtml(text)
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\s+/g, (ws) => (ws.includes("\n") ? " " : ws));
}

/**
 * The GitHub Actions run(s) behind a Run id, as GFM links straight to the workflow run — the primary
 * source for the matrix legs, the job logs, and the uploaded artifacts every number below is derived
 * from. A Run id IS a bench-matrix run id, so it resolves to `/actions/runs/<id>` with nothing to look up.
 *
 * A COMPOSITE id (`<runA>+<runB>` — a Run spliced from two CI runs, see data/dataset/index.json) names
 * no single workflow run, so each component is linked separately rather than emitting one dead link to
 * an id GitHub has never issued.
 *
 * A component that is not a run id at all — a locally-produced Run named `local-1`, say — renders as
 * bare code. A provenance link that 404s is worse than no link: it asserts a primary source exists.
 */
function runSourceLinks(runId: string): string {
	return runId
		.split("+")
		.map((id) => (/^\d+$/.test(id) ? `[\`${id}\`](${REPO_URL}/actions/runs/${id})` : `\`${id}\``))
		.join(" + ");
}

/** The Run's commit, linked to the tree the measurement was taken against. Bare code for a non-sha
 *  (a fixture, a placeholder) — see {@link runSourceLinks} on why a dead link is worse than none. */
function commitSourceLink(sha: string): string {
	return /^[0-9a-f]{7,40}$/.test(sha) ? `[\`${sha}\`](${REPO_URL}/commit/${sha})` : `\`${sha}\``;
}

/**
 * The committed Run document this board was rendered from, as a repo-relative GFM link: the reader can
 * go from any table straight to the raw Samples behind it. Relative so it resolves on whatever ref the
 * file is being viewed at, rather than pinning every reader to `main`.
 *
 * `+` is percent-encoded for a composite id: it is legal in a URL path segment, but it is the one
 * character a renderer may still decode as a space, and the link would then point at no file at all.
 */
function datasetSourceLink(runId: string): string {
	const path = `${DATASET_RUNS_DIR}/${runId}.json`;
	return `[\`${path}\`](${path.replace(/\+/g, "%2B")})`;
}

/**
 * The `<summary>` line of a collapsed synthetic Dimension — how many Metrics are inside and which one
 * headlines them, so a shut section still says what it holds instead of reading as an empty triangle.
 * Escaped: catalogued labels are trusted, but this is the one place a label is emitted into markup
 * rather than into a table cell, and the two escapes are not the same.
 */
function syntheticSummary(metrics: readonly LeaderboardMetric[]): string {
	const count = `<strong>${metrics.length} synthetic metric${metrics.length === 1 ? "" : "s"}</strong>`;
	const headline = metrics.find(({ metric }) => metric.headline);
	return headline ? `${count} · headline: ${escapeHtml(headline.metric.label)}` : count;
}

/**
 * The `<summary>` line over the figure dimension's collapsed tables. It says the tables are the
 * per-task receipts for the charts above — a triangle labelled only "details" would read as
 * something optional, and these are the only auditable numbers in the section.
 */
function figureTableSummary(metrics: readonly LeaderboardMetric[]): string {
	const noun = metrics.length === 1 ? "task" : "tasks";
	return `<strong>Per-task rankings</strong> · ${metrics.length} ${noun}, with medians, intervals and trial counts`;
}

/**
 * The charts, one per suite, above the collapsed tables.
 *
 * Written as `<img src width alt>` rather than bare `![…](…)`: the charts are rasterised at 2×
 * for hi-DPI displays, and the `width` attribute — which GitHub's Markdown renderer preserves —
 * is what shows them at logical size. The alt text is not decoration — it is what a reader with
 * the image unavailable gets INSTEAD of the section, so it names the suite, the size of the
 * comparison and the disclosure count.
 */
function figureSection(figures: readonly LeaderboardFigure[]): string[] {
	if (figures.length === 0) return [];
	// How many charts there are is a property of the RUN (the ingest drops uncharted suites, and
	// a new suite lands upstream without touching this file), so the prose must never hand-count
	// them — "the three charts" was wrong the day a suite dropped to one completing environment.
	const scaleClaim =
		figures.length === 1
			? "" //  one chart still uses the shared scale, but there is no cross-chart claim to state.
			: " The charts share one time scale, so a second is the same length in all of them.";
	const lines: string[] = [
		"What a developer or a CI job actually waits on: each bar is one environment's whole pipeline",
		`for that repo, segmented by task in execution order.${scaleClaim}`,
		"",
	];
	for (const figure of figures) {
		const environments = `${figure.charted} environment${figure.charted === 1 ? "" : "s"}`;
		const disclosed =
			figure.incomplete === 0 ? "" : `, ${figure.incomplete} disclosed as incomplete`;
		const alt = escapeAttribute(
			`${figure.suiteName}: ${figure.tasks} pipeline tasks across ${environments}${disclosed}, ` +
				`stacked by task and sorted fastest-first`,
		);
		lines.push(
			`<img src="${escapeAttribute(figure.file)}" width="${figure.width}" alt="${alt}">`,
			"",
		);
	}
	return lines;
}

/** HTML attribute escaping for the `<img>` tags above: `Bun.escapeHTML` covers the full set
 *  (`& < > " '`), so an attribute cannot break out of its quotes no matter what a future
 *  suite is named. (The sibling `escapeHtml` above stays hand-rolled on purpose — it escapes
 *  MARKDOWN CELL TEXT, where quotes are inert and the committed artifact already carries them
 *  raw; swapping it would churn LEADERBOARD.md bytes for no safety gain.) */
const escapeAttribute = Bun.escapeHTML;

/** Format a metric value compactly: integers as-is, otherwise up to 4 significant digits, trimmed. */
function formatValue(value: number): string {
	if (Number.isInteger(value)) return String(value);
	// toPrecision(4) then strip trailing zeros / a trailing dot (e.g. 0.2304, 12.35, 1234).
	return Number.parseFloat(value.toPrecision(4)).toString();
}

/** Format a p-value for the table: tiny values as a bound, never as a misleading `0`. */
function formatPValue(p: number): string {
	if (p < 0.001) return "<0.001";
	return p.toPrecision(2);
}

/** Compact note for the main table's Note column — empty when nothing needs calling out. */
function rowNote(r: LeaderboardRow): string {
	const equalValues = r.tiedWithAbove === "identical-value";
	if (r.pVsPrevious === null) {
		return equalValues ? "equal values" : "";
	}
	if (r.verdict === "underpowered") {
		// "too few sandboxes", not "n too small": at R=3 the row can print n=70 trials and still be
		// undecidable, because the exchangeable unit is the machine. Naming `n` pointed at the one number
		// on the row that was not the constraint.
		const cause = r.pVsPrevious?.cluster ? "too few sandboxes" : "n too small";
		return equalValues ? `${cause}, equal medians` : cause;
	}
	if (r.verdict === "tied") return "tied";
	return "";
}

/**
 * `p vs. above` cell — the p-value of the test that DECIDED this row's verdict, not the descriptive one.
 * Where replicate sandboxes exist that is the sandbox-level cluster test; the pooled Mann-Whitney is
 * shown only where a single sandbox per side left nothing else to test on. Printing the pooled p here
 * was how the table came to advertise `<0.001` beside a note saying the comparison was undecidable.
 */
function formatPairwiseP(r: LeaderboardRow): string {
	const note = rowNote(r);
	if (r.pVsPrevious === null) return note ? `— (${note})` : "—";
	const p = formatPValue(r.pVsPrevious.cluster?.p ?? r.pVsPrevious.mannWhitney);
	return note ? `${p} (${note})` : p;
}

function formatInterval(r: LeaderboardRow): string {
	return r.interval.resamples === 0
		? "—"
		: `${formatValue(r.interval.lo)} – ${formatValue(r.interval.hi)}`;
}

/** One-line takeaway above each Metric table (leader vs next, or sole provider). */
function metricTakeaway(dimension: Dimension, metric: MetricDef, rows: LeaderboardRow[]): string {
	const leader = rows[0];
	if (!leader) return "";
	const better = metric.direction === "HIB" ? "higher is better" : "lower is better";
	// Immediate neighbor — not the next distinct rank — so a top-of-board statistical tie is not
	// misread as "only one provider ranked".
	const next = rows[1];
	if (!next) {
		return `${leader.displayName} is the only ranked provider (${formatValue(leader.value)} ${metric.unit}; ${better}).`;
	}
	// Collect the full top cohort, not just the immediate neighbor: three or more providers can share
	// rank 1 (statistical tie or identical values), and naming only the first two would silently drop
	// the rest. Rows are rank-sorted, so everything at the leader's rank is the contiguous top group.
	const coLeaders = rows.filter((r) => r.rank === leader.rank);
	if (coLeaders.length > 1) {
		const names = coLeaders.map((r) => r.displayName);
		const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
		return `${list} share the top on this metric (${better}).`;
	}
	if (metric.direction === "HIB") {
		const ratio = leader.value / next.value;
		if (Number.isFinite(ratio) && ratio >= 1.05) {
			return `${leader.displayName} leads · ~${ratio.toFixed(1)}× ${next.displayName} on median (${better}).`;
		}
	} else {
		const ratio = next.value / leader.value;
		if (Number.isFinite(ratio) && ratio >= 1.05) {
			const verb = dimension === "economics" ? "is cheapest" : "leads";
			// ratio = next / leader, so it is how many times HIGHER the neighbour is — phrase it that way.
			// "~1.5× lower than X" reads as "the leader is 1.5× below X", which is not what next/leader means
			// (4.898 vs 7.252 is 1.5× higher for the neighbour, i.e. 32% lower for the leader — not "1.5× lower").
			return `${leader.displayName} ${verb} · ${next.displayName} is ~${ratio.toFixed(1)}× higher (${better}).`;
		}
	}
	return `${leader.displayName} leads on median (${better}); see notes for how ranks are decided.`;
}

/** Summary line for coverage gaps by provider — keeps the main board scannable. */
function coverageSummary(gaps: CoverageGap[]): string {
	const byProvider = new Map<string, number>();
	for (const g of gaps) {
		byProvider.set(g.displayName, (byProvider.get(g.displayName) ?? 0) + 1);
	}
	const parts = [...byProvider.entries()]
		.sort(([a], [b]) => a.localeCompare(b, "en"))
		.map(([name, n]) => `${name} ${n}`);
	return `${gaps.length} uncovered result${gaps.length === 1 ? "" : "s"} across ${byProvider.size} provider${byProvider.size === 1 ? "" : "s"} (${parts.join(", ")}). A gap is a missing result — the provider **failing to cover** that workload — never a tie or a zero.`;
}

/** Compact requested/observed allocation description, omitting fields probes could not see. */
function formatSpec(spec: TargetSpec | ObservedSpecs): string {
	const parts = [
		spec.vcpus === undefined ? undefined : `${formatValue(spec.vcpus)} vCPU`,
		spec.memoryGb === undefined ? undefined : `${formatValue(spec.memoryGb)} GiB RAM`,
		spec.diskGb === undefined ? undefined : `${formatValue(spec.diskGb)} GB disk`,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? parts.join(" · ") : "allocation not observable";
}

/**
 * The "Providers in this run" section: a table naming each measured provider's isolation technology,
 * so the comparison discloses WHAT each provider runs — the declared technology (authoritative) beside
 * the probe's best-effort detected class, with ⚠ where a known detected class contradicts the
 * declaration. Empty (no lines) when the Run recorded no providers, so an empty run stays clean.
 */
function rosterSection(roster: readonly ProviderRosterEntry[]): string[] {
	if (roster.length === 0) return [];
	const anyMismatch = roster.some((entry) => entry.mismatch);
	const lines = [
		"## Providers in this run",
		"",
		"Each provider's isolation technology — the **declared** technology is authoritative; **detected**",
		"is a best-effort in-sandbox probe that cannot separate every isolation type (a container and a",
		"microVM can both read `kvm`; gVisor and a microVM can both read `unknown`), shown only as a",
		"cross-check.",
		"",
		"| Provider | Isolation (declared) | Detected |",
		"| --- | --- | --- |",
	];
	for (const entry of roster) {
		// Em-dash (matching `detected`) when the provider isn't in the registry, so an unregistered id
		// reads distinctly from the probe's "unknown" detection class rather than colliding with it.
		const declared = entry.declaredIsolation ?? "—";
		const detected = entry.detectedIsolation ?? "—";
		const flag = entry.mismatch ? " ⚠" : "";
		lines.push(`| ${entry.displayName} | ${declared} | ${detected}${flag} |`);
	}
	lines.push("");
	if (anyMismatch) {
		lines.push(
			"> **⚠ Isolation mismatch:** a provider's detected isolation contradicts its declared technology — verify its bake/create configuration.",
			"",
		);
	}
	return lines;
}

/**
 * Render a {@link Leaderboard} as a Markdown document — the committed comparison surface.
 *
 * `figures` are the suite charts the caller has already rendered (see {@link LeaderboardFigure} on
 * why they are passed rather than derived). The `realworld` section leads with them and then
 * COLLAPSES its per-task tables behind a disclosure, which is a deliberate half-measure and worth
 * saying why:
 *
 *  - The three charts are what a reader actually wants from that section. Seventeen ranked tables —
 *    one per (repo, task) — is a way of having the information without conveying it: nothing on the
 *    page told you that a pipeline on the slowest environment costs 3.4× what it costs on the
 *    fastest, because that number was never in any of the tables.
 *  - Deleting the tables would take the numbers off the page entirely, and every number this
 *    document prints is auditable back to the Run it came from. A picture of a bar is not: the SVG
 *    is glyph outlines, so the figures are exactly the one part of this file a reader cannot check.
 *    The tables are the receipts for the charts, and they stay one click away for that reason.
 *
 * The mechanism is the same `<details>` the synthetic dimensions already use, so the document has
 * one collapse idiom rather than two.
 */
export function renderLeaderboardMarkdown(
	board: Leaderboard,
	figures: readonly LeaderboardFigure[],
): string {
	// Render the board's OWN target, not the global constant, so the header can never claim the pinned
	// spec while the comparability warnings below report another one.
	const spec = formatSpec(board.targetSpec);
	const metricCount = board.dimensions.reduce(
		(sum, dimension) => sum + dimension.metrics.length,
		0,
	);
	const rows = board.dimensions.flatMap((dimension) =>
		dimension.metrics.flatMap((metric) => metric.rows),
	);
	const observationCount = rows.reduce((sum, row) => sum + row.n, 0);
	const providerCount = new Set(rows.map((row) => row.providerId)).size;
	const metricNoun = metricCount === 1 ? "metric" : "metrics";
	const providerNoun = providerCount === 1 ? "provider" : "providers";
	// Only claim a disclosure triangle when the document will actually render one — a synthetic
	// dimension, or the figure dimension with charts to fold its tables under. A board with
	// neither renders every table in the open, and a header that sent the reader hunting for a
	// triangle that does not exist would be wrong on its very first claim.
	const anyCollapsed = board.dimensions.some(
		(dimension) =>
			SYNTHETIC_DIMENSIONS.has(dimension.dimension as never) ||
			(dimension.dimension === FIGURE_DIMENSION && figures.length > 0),
	);
	const collapseNote = anyCollapsed ? " — some behind a disclosure triangle, none omitted" : "";
	// Header provenance: every identifier links to the thing it names, so a reader can audit any number
	// on this page without being told where to look — the workflow run that produced it, the commit it
	// was measured against, and the committed Run document it was rendered from.
	const lines: string[] = [
		"# Sandbox provider leaderboard",
		"",
		`Run ${runSourceLinks(board.runId)} · commit ${commitSourceLink(board.sha)} ·`,
		`dataset ${datasetSourceLink(board.runId)} · generated ${board.generatedAt}`,
		...(board.comparisonCohort
			? [
					"",
					`Comparison cohort: \`${board.comparisonCohort}\`. Compare scores only with the same workload and eligible metric cohort.`,
				]
			: []),
		"",
		`Requested target for every provider: **${spec}**. This run contains **${rows.length} metric records**`,
		`backed by **${observationCount} retained trial observations**, across **${metricCount} ${metricNoun}** and`,
		`**${providerCount} ${providerNoun}**; every emitted, catalogued metric has a ranked table below`,
		`(median across sandboxes), grouped by dimension with its headline first${collapseNote}.`,
		"Generated from the published Run dataset — do not edit by hand. Methodology:",
		"[`docs/methodology.md`](docs/methodology.md).",
		"",
		"**How to read:** value = median across sandboxes (one machine, one vote) · interval = cluster bootstrap,",
		"labelled 95% but ≈77% actual coverage at 3 sandboxes (see methodology) · rows share a rank only",
		"when statistically indistinguishable or tied on the median (see details below) · a coverage gap means unmeasured, never a score of zero.",
		"CPU/RAM comparability uses observed vCPU and RAM (±10% RAM); disk is a workload-capacity gate",
		"surfaced through coverage gaps, not part of the compute-match verdict.",
		"",
	];

	// Name the layout only when it is actually in play — the note lists the synthetic dimensions THIS
	// run rendered, so a board with none never explains a collapse the reader cannot see.
	const syntheticRendered = board.dimensions.filter(({ dimension }) =>
		SYNTHETIC_DIMENSIONS.has(dimension),
	);
	if (syntheticRendered.length > 0) {
		const names = syntheticRendered.map(({ dimension }) => `\`${dimension}\``).join(", ");
		lines.push(
			"**Document order:** the real-world developer workflows lead, because what a developer or a CI job",
			`actually waits on is what this benchmark exists to measure. The synthetic microbenchmarks (${names})`,
			"load one hardware axis in isolation — a real question, but a different one — so each is collapsed by",
			"default; expand a section to read its tables.",
			"",
		);
	}
	if (figures.length > 0) {
		lines.push(
			`**The \`${FIGURE_DIMENSION}\` section is drawn, not tabulated.** One stacked chart per repo, each bar a`,
			"whole pipeline on one environment and each segment a task. Its per-task rankings — the medians,",
			"intervals and trial counts every bar is built from — are still here, one triangle down: the charts",
			"are what the section is FOR, and the tables are how you check them.",
			"",
		);
	}
	lines.push(...rosterSection(board.roster));
	if (board.absentProviders.length > 0) {
		// One line, not per-suite `missing` rows: the Run does not record the dispatch plan
		// (BENCH_PROVIDERS), so "never dispatched" and "every cell lost before reporting anything" are
		// indistinguishable here — the wording deliberately covers both.
		const names = board.absentProviders.map((p) => p.displayName).join(", ");
		lines.push(
			`_Not present in this run: ${names} — registered providers that reported no data (not dispatched, or every cell was lost before reporting anything)._`,
			"",
		);
	}
	for (const caveat of board.comparabilityCaveats) {
		lines.push(
			`> **Comparability warning:** ${caveat.displayName}'s observed compute did not match the requested CPU/RAM target; its observed allocation was **${formatSpec(caveat.observedSpecs)}**. Its measured ranks are not like-for-like with compute-matched providers.`,
			"",
		);
	}

	if (board.dimensions.length === 0) {
		lines.push("_No ranked metrics yet (no provider produced a catalogued metric)._", "");
	}

	for (const { dimension, metrics } of board.dimensions) {
		lines.push(`## ${dimension}`, "");
		// The figure dimension puts its charts ABOVE the collapse, so the section reads as three
		// pictures with the receipts folded underneath.
		if (dimension === FIGURE_DIMENSION) lines.push(...figureSection(figures));
		// A synthetic dimension collapses its TABLES, never its heading: the heading stays in the rendered
		// document outline so the board still discloses which hardware axes were measured — collapsing it
		// too would make a measured dimension indistinguishable from one that never ran.
		//
		// The figure dimension collapses for a different reason — its charts replace the tables as the
		// thing you read — but only when there ARE charts. With none, its tables render in the open:
		// hiding them behind a triangle whose figures do not exist would take the numbers off the page.
		const collapsed =
			SYNTHETIC_DIMENSIONS.has(dimension) || (dimension === FIGURE_DIMENSION && figures.length > 0);
		if (collapsed) {
			const summary =
				dimension === FIGURE_DIMENSION ? figureTableSummary(metrics) : syntheticSummary(metrics);
			lines.push("<details>", `<summary>${summary}</summary>`, "");
		}
		for (const { metric, rows: metricRows } of metrics) {
			const better = metric.direction === "HIB" ? "higher is better" : "lower is better";
			const notes = metricRows.map(rowNote);
			const hasNotes = notes.some((note) => note !== "");
			const headline = metric.headline ? " _(headline)_" : "";
			lines.push(
				`### ${metric.label}${headline}`,
				"",
				`${metric.unit} · ${better}`,
				"",
				`_${metricTakeaway(dimension, metric, metricRows)}_`,
				"",
				// Sandboxes BEFORE trials, and both labelled. The unit of replication is the machine, and a
				// single `n` column silently mixed the two: n=12 meant twelve machines, n=70 meant three.
				hasNotes
					? `| Rank | Provider | ${metric.label} (${metric.unit}) | 95% bootstrap interval | Sandboxes | Trials | Note |`
					: `| Rank | Provider | ${metric.label} (${metric.unit}) | 95% bootstrap interval | Sandboxes | Trials |`,
				hasNotes
					? "| ---: | --- | ---: | ---: | ---: | ---: | --- |"
					: "| ---: | --- | ---: | ---: | ---: | ---: |",
				...metricRows.map((row, i) => {
					const base = `| ${row.rank} | ${row.displayName} | ${formatValue(row.value)} | ${formatInterval(row)} | ${row.sandboxes ?? 1} | ${row.n} |`;
					return hasNotes ? `${base} ${notes[i] || "—"} |` : base;
				}),
				"",
			);
		}
		if (collapsed) lines.push("</details>", "");
	}

	// Coverage gaps: summary first; full table + legends inside <details> so unfinished providers
	// don't bury the rankings.
	if (board.coverageGaps.length > 0) {
		const outcomes = new Set(board.coverageGaps.map((g) => g.outcome));
		lines.push(
			"## Coverage gaps",
			"",
			coverageSummary(board.coverageGaps),
			"",
			"<details>",
			"<summary>Full coverage table</summary>",
			"",
			"| Provider | Benchmark | Outcome | Detail |",
			"| --- | --- | --- | --- |",
			...board.coverageGaps.map((g) => {
				const what = g.scope === "operation" ? `${g.id} _(lifecycle op)_` : g.id;
				const outcome = g.disk ? "❌ **disk** (skipped)" : `**${g.outcome}**`;
				return `| ${g.displayName} | ${what} | ${outcome} | ${escapeCell(g.reason)} |`;
			}),
			"",
		);
		if (outcomes.has("skipped")) {
			lines.push(
				"**skipped** — a precondition said no before the benchmark was attempted. A ❌ **disk** skip is the",
				"loud one: the provider could not supply the disk the suite needs, so the workload does not run on",
				"its current allocation at all. That is a structural absence, not a slow result.",
				"",
			);
		}
		if (outcomes.has("failed")) {
			lines.push(
				"**failed** — the benchmark was attempted and broke: it threw, timed out, or died with the sandbox.",
				"Unlike a skip, this is a reliability fact about the provider, not a decision made on its behalf.",
				"",
			);
		}
		if (outcomes.has("missing")) {
			lines.push(
				"**missing** — nothing was reported at all: no result, and no marker explaining why. The suite ran",
				"elsewhere in this run, so it was part of the comparison, and this provider is simply absent from",
				"it — a dropped job, a lost artifact, or a sandbox that died before it could say anything. Treat it",
				"as unmeasured, never as a pass: the provider has not been shown to run this workload.",
				"",
			);
		}
		lines.push("</details>", "");
	}

	if (board.dimensions.length === 0) return `${lines.join("\n")}\n`;

	// Statistics essay + optional p-value / KS detail table for readers who want the receipts.
	lines.push(
		"<details>",
		"<summary>How rankings are decided</summary>",
		"",
		"The value is the median of the PER-SANDBOX medians — one machine, one vote — not the median of all",
		"trials pooled together. Pooling would weight each machine by how many trials it ran, and the harness",
		"chooses that count adaptively by watching the variance, so the noisiest machine would carry the most",
		"weight in the published number. The median, not the mean, because a single stalled pass drags a mean",
		"far more than it moves a median.",
		"",
		"The interval is a cluster bootstrap of that same statistic (10,000 resamples, seeded from the Run id",
		"so the table is reproducible byte-for-byte): whole sandboxes are resampled with replacement, keeping",
		"each machine's trials intact.",
		"",
		"**The interval is labelled 95%, and at these sandbox counts it does not achieve 95%.** Coverage is a",
		"property of how many machines were measured, not of the estimator: simulated at ≈77% for 3 sandboxes,",
		"≈92% at 6, and ≈95% at 20. No percentile bootstrap reaches nominal coverage at 3 clusters. Read a",
		"3-sandbox interval as a resampling envelope over three machines, **not** as a calibrated frequentist",
		"confidence interval. Within-sandbox trials may also be dependent on host scheduling.",
		"",
		`Rows are separated only when Mann-Whitney U (two-sided, α = ${DEFAULT_ALPHA}, enumerated exactly`,
		"over the permutation null rather than approximated) finds evidence of stochastic ordering — at these",
		"sample sizes the normal approximation can report a p the exact test cannot actually produce. Where",
		"replicate sandboxes exist that test runs on the PER-SANDBOX MEDIANS, so whole machines are the",
		"exchangeable unit; testing pooled trials instead would treat repeated measurements of one machine as",
		"independent evidence about the provider. KS is reported separately for distribution *shape* and does",
		"not drive the ranking.",
		"",
	);

	const sharedRankReasons: string[] = [];
	if (rows.some((r) => r.tiedWithAbove === "statistical")) {
		sharedRankReasons.push(
			"`tied` — the test could have separated those providers and did not, so a faster median earned",
			"inside the noise is not a faster provider. This is the only note that claims two providers are",
			"statistically indistinguishable.",
		);
	}
	if (rows.some((r) => r.tiedWithAbove === "identical-value")) {
		sharedRankReasons.push(
			"`equal medians` / `equal values` — arithmetic, not a finding: the ranking sorts on the value,",
			"and two identical values have no order between them. It says nothing about the distributions.",
		);
	}
	if (sharedRankReasons.length > 0) {
		lines.push(
			"**A Note cell always says why a rank is shared, and the reasons are not interchangeable.**",
			...sharedRankReasons,
			"",
		);
	}

	lines.push(
		"Each metric is measured on several independent sandboxes (the **Sandboxes** column), and within each",
		"sandbox the benchmark runs several trials (**Trials**). Trials capture within-machine noise —",
		"neighbours, host contention, virtualization; sandboxes capture the machine-to-machine variation a",
		"user actually experiences when they start a new environment. The ranking and its interval both treat",
		"the SANDBOX as the unit, so more trials on the same machine never make a row look better-evidenced.",
		"Under adaptive trial counts a large **Trials** figure is in fact a sign the machines were unstable",
		"(the harness kept re-running), not that the estimate is precise.",
		"",
		"At the sandbox counts this suite produces, a non-significant result means *not enough evidence to",
		"separate*, never *the providers are equal*.",
		"",
	);

	const floors = underpoweredFloors(board);
	if (floors.length > 0) {
		lines.push(
			"`too few sandboxes` is the extreme of that: the deciding test's best attainable p already exceeds α,",
			"so it could not have separated the rows at any effect size, however far apart their values are.",
			`The floor is a property of the design — here ${floors.join("; ")}.`,
			"At three sandboxes a side the floor is 2/C(6,3) = 0.1, which is above α, so **no** three-sandbox",
			"comparison in this table can ever be declared separated. That is a fact about the replicate count,",
			"not about the providers. One shape can appear more than once above with different floors: ties",
			"among a provider's per-sandbox medians raise the floor further (to 1.0 when every median in the",
			"comparison is equal), so the count alone does not determine it.",
			"Such rows are ranked on their observed medians and are **not** claimed to be tied — read the gap",
			"between the values, and treat the p-value as unable to settle them either way. Where such a row",
			"nevertheless shares the rank above it, the note reads `equal medians`: the two values are simply",
			"identical, which is the ranking having nothing to order them by — never a finding that the",
			"providers are alike.",
			"",
		);
	}

	// Detail table with p vs. above + KS for readers who want distribution shape.
	if (rows.some((r) => r.pVsPrevious !== null)) {
		lines.push(
			"### Pairwise tests (vs. row above)",
			"",
			"`p vs. above` is the SANDBOX-LEVEL test that decides the rank wherever replicate sandboxes exist —",
			"Mann-Whitney U on each provider's per-sandbox medians, whole machines as the exchangeable unit.",
			"(Only where a provider ran in a single sandbox does it fall back to Mann-Whitney on pooled trials,",
			"which treats repeated measurements of one machine as independent and is anti-conservative.)",
			"`p (KS)` is Kolmogorov-Smirnov on distribution",
			"*shape* — it does not drive the ranking. A tied Mann-Whitney beside a small KS often means the",
			"same typical speed with different behaviour (e.g. bimodal stalls).",
			"These are unadjusted, exploratory per-comparison p-values; no family-wise or false-discovery-rate",
			"correction is applied across providers or metrics.",
			"",
			"| Dimension | Metric | Provider | p vs. above | p (KS) |",
			"| --- | --- | --- | ---: | ---: |",
		);
		for (const { dimension, metrics } of board.dimensions) {
			for (const { metric, rows: metricRows } of metrics) {
				for (const row of metricRows) {
					const ks = row.pVsPrevious === null ? "—" : formatPValue(row.pVsPrevious.ks);
					lines.push(
						`| ${dimension} | ${metric.label} | ${row.displayName} | ${formatPairwiseP(row)} | ${ks} |`,
					);
				}
			}
		}
		lines.push("");
	}

	lines.push("</details>", "");

	return `${lines.join("\n")}\n`;
}
