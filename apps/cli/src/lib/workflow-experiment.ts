import { evidenceDigest } from "@sandbox-benchmarks/results";
import type { ExperimentCell, ExperimentPlan, ExperimentWave } from "@sandbox-benchmarks/schema";
import {
	accountCapacityPolicySchema,
	EXPERIMENT_WAVES,
	quotaDomain,
	SUITES,
	suiteWave,
	TARGET_SPEC,
} from "@sandbox-benchmarks/schema";
import {
	VERCEL_PROJECT_NAME_DEFAULT,
	VERCEL_TEAM_SLUG_DEFAULT,
	vercelVcrImageRefs,
} from "@sandbox-benchmarks/schema/toolchain";
import { resolveDriverArtifact } from "./driver-run.ts";
import { planExperiment } from "./experiment-plan.ts";
import { planReplicateMap, selectProviders, selectSuites } from "./matrix.ts";

/** Resolve declarations without credentials. Workers must independently match these identities. */
export function workflowExperiment(env: NodeJS.ProcessEnv, createdOn: string): ExperimentPlan {
	const id = env.GITHUB_RUN_ID;
	const sha = env.GITHUB_SHA;
	if (!id || !sha) throw new Error("workflow identity is required");
	const replicas = planReplicateMap(env.BENCH_SUITES, env.BENCH_REPLICAS);
	const cells: ExperimentCell[] = [];
	const passOverride = env.BENCH_PTS_PASSES?.trim();
	const capacity = accountCapacityPolicySchema.assert(
		JSON.parse(env.BENCH_ACCOUNT_CAPACITY || "{}"),
	);
	if (env.BENCH_MAX_CONCURRENCY?.trim())
		throw new Error(
			"per-cell concurrency is retired; use reviewed BENCH_ACCOUNT_CAPACITY account policy",
		);
	for (const provider of selectProviders(env.BENCH_PROVIDERS)) {
		// Mirrored and custom artifact refs must be public planning inputs, never inferred from credentials.
		const ref = env[`BENCH_ARTIFACT_${provider.toUpperCase().replaceAll("-", "_")}`]?.trim();
		const artifact = resolveDriverArtifact(
			provider,
			ref
				? { ref }
				: provider === "vercel"
					? {
							ref: vercelVcrImageRefs(VERCEL_TEAM_SLUG_DEFAULT, VERCEL_PROJECT_NAME_DEFAULT)
								.version,
						}
					: {},
		);
		for (const suiteName of selectSuites(env.BENCH_SUITES)) {
			const suite = SUITES[suiteName];
			if (passOverride === "converge")
				throw new Error(
					`${suiteName}: convergence is not admitted for bounded publication; select an explicitly versioned fixed-pass experiment`,
				);
			const passes = passOverride ? Number(passOverride) : (suite.ptsTimesToRun ?? 2);
			if (!Number.isSafeInteger(passes) || passes < 1)
				throw new Error("fixed passes must be a positive integer");
			for (const replicate of replicas[suiteName] ?? [])
				cells.push({
					id: `${provider}-${suiteName}-r${replicate}`,
					provider,
					quotaDomain: quotaDomain(provider),
					suite: suiteName,
					replicate,
					workloadRevision: evidenceDigest({ sha, suite, passes }),
					environmentRevision: sha,
					artifactIdentity: evidenceDigest(artifact),
					target: { ...TARGET_SPEC },
					metrics: [...suite.metrics],
					exclusions: [],
					passes,
					startupMinutes: 40,
					workloadMinutes: suite.commandTimeoutMinutes * suite.commands.length,
					finishMinutes: 15,
				});
		}
	}
	const plan = planExperiment({ id, sha, createdOn, cells }, capacity);
	// Freeze only a plan whose every batch is dispatchable: both wave axes are built here, so an
	// experiment that cannot be expressed as two provider matrices fails at plan time rather than
	// stranding cells in a matrix GitHub refuses to expand.
	workflowWaveAxes(plan);
	return plan;
}

/** One dispatched benchmark job: the frozen batch it executes, named by provider and workload. */
export interface WorkflowWaveEntry {
	batch: string;
	provider: string;
	suite: string;
	budgetMinutes: number;
}

/** GitHub expands at most 256 jobs from one matrix, and refuses to expand an empty one. */
const MATRIX_JOB_LIMIT = 256;

/**
 * The `matrix.include` axis of one wave: every frozen batch whose cells run that wave's suites, as one
 * job per provider.
 *
 * This replaces the account -> round -> batch nesting the matrix used to fan out through. That nesting
 * re-planned the same frozen experiment at every level (three checkouts and three workspace setups
 * before a single sandbox was created) purely to keep each level's axis under the matrix limit, and
 * serialised rounds behind `max-parallel: 1` even where the accounts were independent. Waves are a
 * fixed pair, so the plan job emits both axes at once and a provider's job for a wave is created as
 * soon as the plan is frozen; per-account quota exclusion stays where it belongs, on the bench job's
 * `benchmark-account-<domain>` concurrency group.
 */
export function workflowWaveAxis(plan: ExperimentPlan, wave: ExperimentWave): WorkflowWaveEntry[] {
	const entries = plan.batches.flatMap((batch) => {
		const members = plan.cells.filter((cell) => batch.cells.includes(cell.id));
		const first = members[0];
		if (!first || members.length !== batch.cells.length)
			throw new Error(`batch cells are absent from the plan: ${batch.id}`);
		const waves = new Set(members.map((cell) => suiteWave(cell.suite)));
		const providers = new Set(members.map((cell) => cell.provider));
		if (
			waves.size !== 1 ||
			providers.size !== 1 ||
			batch.quotaDomain !== quotaDomain(first.provider)
		)
			throw new Error(`batch spans more than one provider wave: ${batch.id}`);
		if (!waves.has(wave)) return [];
		const suites = new Set(members.map((cell) => cell.suite));
		return [
			{
				batch: batch.id,
				provider: first.provider,
				// A wave of one suite reads as that suite; a full wave reads as the wave. Either way the
				// label is stable per batch, and batch ids — not this label — key the per-job credentials.
				suite: suites.size === 1 ? first.suite : wave,
				budgetMinutes: batch.budgetMinutes,
			},
		];
	});
	if (entries.length > MATRIX_JOB_LIMIT)
		throw new Error(
			`${wave} wave needs ${entries.length} jobs, above the ${MATRIX_JOB_LIMIT}-job matrix limit; ` +
				"lower the replicate count or raise the account sandbox capacity",
		);
	return entries;
}

/** Both wave axes of a frozen plan, keyed by wave, with every batch dispatched exactly once. */
export function workflowWaveAxes(
	plan: ExperimentPlan,
): Record<ExperimentWave, WorkflowWaveEntry[]> {
	const axes = Object.fromEntries(
		EXPERIMENT_WAVES.map((wave) => [wave, workflowWaveAxis(plan, wave)]),
	) as Record<ExperimentWave, WorkflowWaveEntry[]>;
	const dispatched = Object.values(axes).reduce((total, entries) => total + entries.length, 0);
	if (dispatched !== plan.batches.length)
		throw new Error("frozen batches are not covered by exactly one wave each");
	return axes;
}
