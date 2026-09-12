/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expression contract literals */
// Check the production account → round → bounded batch dispatch graph.
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

export function checkExperimentNesting(docs: Record<string, unknown>): string[] {
	const errors: string[] = [];
	const job = (file: string, name: string) =>
		asRecord(asRecord(asRecord(docs[file], file).jobs, file)[name], `${file}:${name}`);
	const expect = (condition: boolean, detail: string) => {
		if (!condition) errors.push(detail);
	};
	for (const file of ["bench-matrix.yml", "bench-smoke.yml"]) {
		const caller = job(file, "suite");
		expect(
			caller.uses === "./.github/workflows/bench-account.yml",
			`${file}: must dispatch account workflow`,
		);
		const strategy = asRecord(caller.strategy, file);
		expect(
			asRecord(strategy.matrix, file).account === "${{ fromJSON(needs.plan.outputs.accounts) }}",
			`${file}: account axis must come from frozen plan`,
		);
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
	}
	for (const [file, callee, axis] of [
		["bench-account.yml", "bench-round.yml", "round"],
		["bench-round.yml", "bench-suite.yml", "include"],
	]) {
		if (!file || !callee || !axis) continue;
		const caller = job(file, "execute");
		const strategy = asRecord(caller.strategy, file);
		// Rounds run one at a time so a later round's approval gate is raised only once the previous
		// round has finished; a round's batches are created together — no max-parallel, the account
		// concurrency queue serialises them — so ONE `privileged` approval releases the whole round
		// (GitHub approves only the jobs already pending). Neither level may cancel its peers.
		if (axis === "round") {
			expect(
				strategy["max-parallel"] === 1 && strategy["fail-fast"] === false,
				`${file}: rounds must run one at a time without cancelling peers`,
			);
		} else {
			expect(
				strategy["max-parallel"] === undefined && strategy["fail-fast"] === false,
				`${file}: a round's batches must be created together (no max-parallel) without cancelling peers`,
			);
		}
		expect(caller.uses === `./.github/workflows/${callee}`, `${file}: wrong execution delegate`);
		expect(
			asRecord(strategy.matrix, file)[axis] === "${{ fromJSON(needs.plan.outputs.axis) }}",
			`${file}: axis must come from frozen plan`,
		);
	}
	const worker = job("bench-suite.yml", "bench");
	const step = stepByName(worker, RUN_STEP, "bench-suite.yml");
	expect(
		step?.run === "bun apps/cli/src/bin/workflow-experiment.ts execute",
		"worker must use managed batch executor",
	);
	expect(
		asRecord(step?.env, "worker").BENCH_BATCH_ID === "${{ inputs.batch_id }}",
		"worker must bind batch identity",
	);
	const publish = job("bench-matrix.yml", "publish");
	expect(
		Array.isArray(publish.needs) &&
			publish.needs.includes("suite") &&
			publish.needs.includes("plan"),
		"publication must wait for plan and all account batches",
	);
	const commitJob = job("commit-dataset.yml", "commit");
	const aggregate = stepByName(commitJob, "Aggregate", "commit-dataset.yml");
	const coverage = stepByName(commitJob, "Upload coverage report", "commit-dataset.yml");
	const promotion = stepByName(commitJob, "Promote", "commit-dataset.yml");
	expect(
		typeof aggregate?.run === "string" &&
			aggregate.run.includes(
				"aggregate-experiment.ts experiment/manifest/plan.json experiment/attempts",
			),
		"publication must aggregate against the frozen plan and whole attempts",
	);
	expect(
		coverage?.if === "always() && hashFiles('data/candidate/coverage.json') != ''" &&
			asRecord(coverage.with, "coverage").path === "data/candidate/coverage.json",
		"incomplete aggregation must still upload coverage.json while refusing promotion",
	);
	expect(
		promotion?.if === "success()" &&
			typeof promotion.run === "string" &&
			promotion.run.includes("data/dataset experiment/manifest/plan.json experiment/attempts"),
		"promotion must verify the original plan and whole attempts only after a complete aggregate",
	);
	return errors;
}
