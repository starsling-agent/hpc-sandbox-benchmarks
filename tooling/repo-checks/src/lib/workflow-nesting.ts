/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expression contract literals */
// Check the production two-wave dispatch graph: one frozen plan, one provider matrix per wave.
import { asRecord, RUN_STEP, SUITE_WORKFLOW, stepByName } from "./workflow-yaml.ts";

const CELL_DRIVER_BIN = "bench-suite.ts";
function jobEnvKeys(job: Record<string, unknown>, label: string): string[] {
	const keys: string[] = [];
	const collect = (value: unknown): void => {
		if (value === undefined || value === null) return;
		keys.push(...Object.keys(asRecord(value, `${label}: env is not a mapping`)));
	};
	collect(job.env);
	if (Array.isArray(job.steps)) {
		for (const rawStep of job.steps) collect(asRecord(rawStep, `${label}: malformed step`).env);
	}
	return keys;
}

/**
 * Invariant 3b (the consolidation invariant): a dispatch lane owns no benchmark cell of its own — it
 * reaches sandboxes only through the reusable bench-suite.yml.
 *
 * bench-smoke.yml used to carry a hand-mirrored copy of the cell: its own checkout, its own Namespace
 * mint, its own per-provider credential block, its own timeout and its own upload. Keeping that copy
 * honest took a cross-lane credential gate (Invariant 4) and still let everything the gate did not
 * compare — the runner routing, the cell budget, the shard-gated upload, the replicate fan-out — drift
 * silently, so a smoke run could pass while exercising a different pipeline than the one it was meant
 * to rehearse. Now both lanes call the reusable, and this rejects the ways back in.
 *
 * THREE probes, because one is not enough. Matching {@link RUN_STEP} by name alone catches the literal
 * copy-paste and nothing else: a re-grown cell under a fresh step name, or provider credentials hung
 * off a job-level `env:`, would both sail through — and those are the shapes someone re-adding a cell
 * by hand actually writes. So also reject a `run:` that invokes the cell driver, and any provider
 * credential appearing anywhere in a lane's env at all. `credentialKeys` is passed in (rather than
 * imported) to keep this module free of the schema dependency; runCheck hands it the registry's
 * requiredEnvVars, so the probe widens automatically when a provider is added.
 */
export function checkLaneDelegates(
	doc: unknown,
	label: string,
	credentialKeys: Iterable<string>,
): string[] {
	const root = asRecord(doc, `${label}: not a YAML mapping`);
	const jobs = asRecord(root.jobs, `${label}: no jobs mapping`);
	const credentials = new Set(credentialKeys);
	const errors: string[] = [];
	const cell =
		`the benchmark cell (credentials, runner routing, cell budget, replicate fan-out, artifact ` +
		`upload) must live only in ${SUITE_WORKFLOW}, which both dispatch lanes call; a second copy is ` +
		`exactly the drift this consolidation removed`;
	for (const [jobId, rawJob] of Object.entries(jobs)) {
		const job = asRecord(rawJob, `${label}: job "${jobId}" is not a mapping`);
		if (stepByName(job, RUN_STEP, label) !== undefined) {
			errors.push(`${label}: job "${jobId}" declares a "${RUN_STEP}" step — ${cell}`);
		}
		const steps = Array.isArray(job.steps) ? job.steps : [];
		for (const rawStep of steps) {
			const step = asRecord(rawStep, `${label}: malformed step`);
			if (
				typeof step.run === "string" &&
				(step.run.includes(CELL_DRIVER_BIN) || step.run.includes("workflow-experiment.ts execute"))
			) {
				errors.push(
					`${label}: job "${jobId}" has a step whose run: invokes ${CELL_DRIVER_BIN} — ${cell}`,
				);
			}
		}
		const leaked = [...new Set(jobEnvKeys(job, label))].filter((k) => credentials.has(k)).sort();
		if (leaked.length > 0) {
			errors.push(
				`${label}: job "${jobId}" puts provider credential(s) ${leaked.join(", ")} in its env — ` +
					`${cell}. A lane never needs a provider secret: it passes none down, and the cell resolves ` +
					`its own from Environment "privileged"`,
			);
		}
	}
	return errors;
}

/** The execution waves, in dispatch order. Passed in by runCheck from the schema's EXPERIMENT_WAVES. */
export const DEFAULT_WAVES = ["synthetic", "realworld"] as const;

/** The reusable cell's file name as both dispatch lanes spell it in `uses:`. */
const SUITE_FILE = "bench-suite.yml";

/**
 * The dispatch graph both live lanes must have: `plan` -> one job per wave -> (matrix only) `publish`.
 *
 * Every clause here is a failure mode run 34672199543 actually paid for, so none of them is cosmetic:
 *
 *  - ONE plan job. The account and round readers this replaced re-froze nothing and re-read
 *    everything, costing three sequential checkouts and workspace setups per account before a single
 *    sandbox existed. A lane that grows another `workflow-experiment.ts plan`/`axes` step is that
 *    layering coming back.
 *  - Both wave axes come from that one job's outputs, so the dispatch can only select cells the plan
 *    froze, and each batch is dispatched by exactly one wave.
 *  - No `max-parallel` on either wave. A wave's provider jobs are created together, so ONE
 *    `privileged` approval releases the whole wave (GitHub approves only the jobs already pending);
 *    per-account quota exclusion belongs to the bench job's `benchmark-account-<domain>` queue, not to
 *    a workflow-level throttle that would also serialise INDEPENDENT accounts.
 *  - `fail-fast: false` on both. One provider's failure must never cancel the other eleven; a
 *    cancelled batch is a lost cell.
 *  - The real-world wave runs after the synthetic one and does not require it to have succeeded — the
 *    long wave is ordered second because an account cap cannot hold both at once, but a provider whose
 *    synthetic wave failed still owes the experiment its real-world evidence.
 */
export function checkExperimentNesting(
	docs: Record<string, unknown>,
	waves: readonly string[] = DEFAULT_WAVES,
): string[] {
	const errors: string[] = [];
	const jobs = (file: string) => asRecord(asRecord(docs[file], file).jobs, file);
	const job = (file: string, name: string) => asRecord(jobs(file)[name], `${file}:${name}`);
	const steps = (owner: Record<string, unknown>, file: string) =>
		Array.isArray(owner.steps) ? owner.steps.map((step) => asRecord(step, file)) : [];
	const needsOf = (owner: Record<string, unknown>): string[] =>
		Array.isArray(owner.needs) ? owner.needs.map((entry) => String(entry)) : [];
	const expect = (condition: boolean, detail: string) => {
		if (!condition) errors.push(detail);
	};
	const [first, second] = waves;
	for (const file of ["bench-matrix.yml", "bench-smoke.yml"]) {
		const step = stepByName(job(file, "plan"), "Plan", file);
		expect(
			step?.run === "bun apps/cli/src/bin/workflow-experiment.ts plan",
			`${file}: must freeze experiment before dispatch`,
		);
		const env = asRecord(step?.env, file);
		expect(
			env.BENCH_PROVIDERS ===
				(file === "bench-matrix.yml" ? "${{ inputs.providers }}" : "${{ inputs.provider }}"),
			`${file}: selected providers must enter plan`,
		);
		expect(
			env.BENCH_SUITES ===
				(file === "bench-matrix.yml" ? "${{ inputs.suites }}" : "${{ inputs.suite }}"),
			`${file}: selected suites must enter plan`,
		);
		expect(
			env.BENCH_REPLICAS ===
				(file === "bench-matrix.yml" ? "${{ inputs.replicas }}" : "${{ inputs.replicas || '1' }}"),
			`${file}: preserve replicate defaults`,
		);
		const outputs = asRecord(job(file, "plan").outputs, `${file}: plan declares no outputs`);
		// Exactly one planner. A second `workflow-experiment.ts` step anywhere in the lane is the
		// account/round re-read this consolidation removed.
		const planners = Object.values(jobs(file)).flatMap((rawJob) =>
			steps(asRecord(rawJob, file), file).filter(
				(step) => typeof step.run === "string" && step.run.includes("workflow-experiment.ts"),
			),
		);
		expect(
			planners.length === 1,
			`${file}: the frozen experiment must be read once, by the plan job (found ${planners.length})`,
		);
		for (const wave of waves) {
			expect(
				outputs[wave] === `\${{ steps.plan.outputs.${wave} }}`,
				`${file}: plan must publish the ${wave} wave axis`,
			);
			const caller = job(file, wave);
			expect(
				caller.uses === `./.github/workflows/${SUITE_FILE}`,
				`${file}: ${wave} wave must dispatch the reusable benchmark cell`,
			);
			const strategy = asRecord(caller.strategy, file);
			expect(
				asRecord(strategy.matrix, file).include === `\${{ fromJSON(needs.plan.outputs.${wave}) }}`,
				`${file}: ${wave} wave axis must come from the frozen plan`,
			);
			expect(
				strategy["max-parallel"] === undefined && strategy["fail-fast"] === false,
				`${file}: ${wave} wave jobs must be created together (no max-parallel) without cancelling peers`,
			);
			expect(
				asRecord(caller.with, file).batch_id === "${{ matrix.batch }}",
				`${file}: ${wave} wave must pass the frozen batch identity`,
			);
		}
		// Wave order: the long real-world wave is dispatched behind the synthetic one, but on
		// `!cancelled()` so a failed synthetic wave does not withhold the real-world evidence.
		const later = job(file, String(second));
		const needs = needsOf(later);
		expect(
			needs.includes("plan") && needs.includes(String(first)),
			`${file}: the ${second} wave must run after the ${first} wave`,
		);
		expect(
			typeof later.if === "string" && later.if.includes("!cancelled()"),
			`${file}: a failed ${first} wave must not withhold the ${second} wave`,
		);
	}
	const worker = job(SUITE_FILE, "bench");
	const step = stepByName(worker, RUN_STEP, SUITE_WORKFLOW);
	expect(
		step?.run === "bun apps/cli/src/bin/workflow-experiment.ts execute",
		"worker must use managed batch executor",
	);
	expect(
		asRecord(step?.env, "worker").BENCH_BATCH_ID === "${{ inputs.batch_id }}",
		"worker must bind batch identity",
	);
	// Anything a sibling job must not share is keyed on the batch, the only per-job identity. The
	// Namespace mint was keyed on the suite, and two batches of one provider therefore asked the
	// credential API for the same token name — refused `AlreadyExists`, taking 30 cells with it.
	const mint = stepByName(worker, "Set up Namespace credentials", SUITE_WORKFLOW);
	const tokenName = asRecord(mint?.with, `${SUITE_FILE}: credential mint has no inputs`)[
		"token-name"
	];
	expect(
		typeof tokenName === "string" && tokenName.includes("${{ inputs.batch_id }}"),
		"the Namespace token name must be unique per batch",
	);
	expect(
		mint?.["continue-on-error"] === undefined,
		"an unusable Namespace credential must fail its job, not every cell behind it",
	);
	const publishNeeds = needsOf(job("bench-matrix.yml", "publish"));
	expect(
		publishNeeds.includes("plan") && waves.every((wave) => publishNeeds.includes(wave)),
		"publication must wait for plan and every wave",
	);
	const commit = job("commit-dataset.yml", "commit");
	const promotion = stepByName(commit, "Aggregate + promote", "commit-dataset.yml");
	expect(
		typeof promotion?.run === "string" &&
			promotion.run.includes(
				"aggregate-experiment.ts experiment/manifest/plan.json experiment/attempts",
			) &&
			promotion.run.includes("data/dataset experiment/manifest/plan.json experiment/attempts"),
		"publication must verify original plan and whole attempts",
	);
	// The refusal to publish is correct; losing the evidence of WHY is not. Coverage is written before
	// that refusal, so it must be retained even though the job is already failing.
	const retain = stepByName(commit, "Retain the per-cell coverage report", "commit-dataset.yml");
	expect(
		typeof retain?.if === "string" && retain.if.includes("always()"),
		"an incomplete experiment must still retain its per-cell coverage report",
	);
	return errors;
}
