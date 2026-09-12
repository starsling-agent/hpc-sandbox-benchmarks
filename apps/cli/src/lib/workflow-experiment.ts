import { evidenceDigest } from "@sandbox-benchmarks/results";
import type { ExperimentCell, ExperimentPlan } from "@sandbox-benchmarks/schema";
import {
	accountCapacityPolicySchema,
	quotaDomain,
	SUITES,
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
	workflowAxes(plan);
	for (const account of plan.accounts) workflowAxes(plan, account.quotaDomain);
	return plan;
}

/** Every nesting level stays within the Actions matrix limit under one frozen plan. */
export function workflowAxes(
	plan: ExperimentPlan,
	account?: string,
	wave?: string,
): unknown[] {
	if (account === undefined) {
		const domains = [...new Set(plan.rounds.map((entry) => entry.quotaDomain))];
		if (domains.length > 256)
			throw new Error("experiment requires explicit account collection partitions");
		return domains;
	}
	if (wave === undefined) {
		const waves = [
			...new Set(
				plan.rounds.filter((entry) => entry.quotaDomain === account).map((entry) => entry.wave),
			),
		];
		if (waves.length === 0 || waves.length > 256)
			throw new Error("account requires explicit wave collection partitions");
		return waves;
	}
	if (wave !== "synthetic" && wave !== "realworld") throw new Error("unknown collection wave");
	const selected = plan.batches.filter(
		(batch) => batch.quotaDomain === account && batch.wave === wave,
	);
	if (selected.length === 0) return [];
	if (selected.length > 256) throw new Error("wave requires explicit batch collection partitions");
	return selected.map((batch) => {
		const cell = plan.cells.find((entry) => entry.id === batch.cells[0]);
		if (!cell || batch.quotaDomain !== quotaDomain(cell.provider))
			throw new Error("invalid workflow quota domain");
		const suites = new Set(
			plan.cells.filter((entry) => batch.cells.includes(entry.id)).map((entry) => entry.suite),
		);
		return {
			batch: batch.id,
			provider: cell.provider,
			suite: suites.size === 1 ? [...suites][0] : "mixed",
			wave: batch.wave,
		};
	});
}
