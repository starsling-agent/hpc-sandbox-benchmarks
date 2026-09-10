// Drift gate: the GitHub workflows that dispatch live benchmarks must stay in lockstep with the
// suite registry and retain their safe delegation/timeout shape. Provider choices and provider-input
// wiring are generated from metadata and gated separately by check:provider-wiring. It mirrors
// runner-benchmarking's check-workflow-{env,suite}-sync.ts, adapted to this repo's workflows.
//
// Two workflows dispatch live benchmarks — bench-matrix.yml (the full provider × suite matrix, ending
// in a dataset commit) and bench-smoke.yml (the same pipeline narrowed to one dispatched provider ×
// suite and stopped before that commit) — and they are now the SAME implementation: each is a `plan`
// job over ./.github/actions/plan-bench-axes plus one suite-matrix job calling the reusable
// bench-suite.yml. The run-step env and live-run timeout therefore exist exactly once, in that
// reusable.
//
// Invariants not owned by generated provider wiring:
//   1. bench-smoke.yml's `suite` dispatch input options == SUITE_NAMES, with a valid default.
//   2. NEITHER dispatch lane owns a benchmark cell: no "Run suite and normalize" step, no `run:` that
//      invokes the cell driver, and no provider credential in any job- or step-level env (see
//      checkLaneDelegates). All three probes are needed: a name match alone misses a cell re-grown
//      under a fresh step name, and a step-level scan alone misses credentials hung off a job-level
//      env that every step inherits.
//   3. The live-run job (the reusable's fan-out) outlasts the longest registered sandbox lifetime by a
//      fixed margin, so a suite budget increase cannot leave an otherwise healthy job to be killed by
//      Actions first; and the budget literal it advertises equals that timeout.
//   4. Nesting wiring for BOTH lanes' suite-matrix callers (they are held to one shape, with the two
//      deliberate per-lane differences — the matrix's publish dependency, the smoke's
//      require_providers assertion — stated explicitly at each lane, in both directions) plus the
//      reusable's provider job name and the replicate axis reaching the cell as BENCH_REPLICATES data.
//   5. A smoke dispatch measures ONE sandbox unless asked otherwise — the dispatch default AND the
//      blank-value fallback, since `default:` alone does not survive a cleared field and blank means
//      "each suite's Suite.defaultReplicas" (R=12 on realworld). See workflow-nesting.ts.
//
// YAML navigation lives in workflow-yaml.ts; nesting checks in workflow-nesting.ts. This file owns
// timeout/delegation invariants plus runCheck orchestration, and re-exports the public surface the
// gate's tests import.
import { PROVIDERS, SUITE_NAMES, SUITES } from "@sandbox-benchmarks/schema";
import { checkExperimentNesting, checkLaneDelegates } from "./workflow-nesting.ts";
import type { DispatchInput } from "./workflow-yaml.ts";
import {
	dispatchInput,
	jobTimeoutMinutes,
	MATRIX_WORKFLOW,
	RUN_STEP,
	readWorkflow,
	SMOKE_WORKFLOW,
	SUITE_JOB,
	SUITE_WORKFLOW,
	stepEnv,
	WORKFLOW_TIMEOUT_MARGIN_MINUTES,
} from "./workflow-yaml.ts";
import { findRepoRoot } from "./workspace.ts";

export { checkExperimentNesting, checkLaneDelegates } from "./workflow-nesting.ts";
export type { DispatchInput } from "./workflow-yaml.ts";
export {
	dispatchInput,
	jobTimeoutMinutes,
	MATRIX_WORKFLOW,
	RUN_STEP,
	readWorkflow,
	SMOKE_WORKFLOW,
	SUITE_JOB,
	SUITE_WORKFLOW,
	stepEnv,
	WORKFLOW_TIMEOUT_MARGIN_MINUTES,
} from "./workflow-yaml.ts";

/** Every requiredEnvVars entry across the Provider registry, with provenance (key -> owning ids). */
export function requiredCredentialKeys(): Map<string, string[]> {
	const byKey = new Map<string, string[]>();
	for (const provider of PROVIDERS) {
		for (const key of provider.requiredEnvVars) {
			const owners = byKey.get(key) ?? [];
			owners.push(provider.id);
			byKey.set(key, owners);
		}
	}
	return byKey;
}

/** Pure comparison of a dispatch input's options against an expected id set. */
function checkChoiceOptions(
	input: DispatchInput,
	expected: string[],
	kind: string,
	source: string,
	label: string,
): string[] {
	const errors: string[] = [];
	// GitHub only enforces `options` for `type: choice`; under any other type (or none, which defaults
	// to free-text `string`) a dispatched run could pass an unlisted value, so a matching options list
	// would be cosmetic. Check this first — it's the invariant the options/default checks rest on.
	if (input.type !== "choice") {
		errors.push(
			`${label}: ${kind} input is not "type: choice" (got ${input.type ? `"${input.type}"` : "no type"}) — ` +
				`GitHub only enforces the options list for choice inputs, so a dispatched run could pass an unlisted ${kind}`,
		);
	}
	if (input.options === undefined) {
		errors.push(
			`${label}: ${kind} input has no options list — expected a "type: choice" listing every ${kind} from ${source}`,
		);
		return errors;
	}
	const expectedSet = new Set(expected);
	const optionSet = new Set(input.options);
	for (const id of expectedSet) {
		if (!optionSet.has(id)) {
			errors.push(
				`${label}: ${kind} input options missing "${id}" — it is in ${source}; a dispatched run can't target it`,
			);
		}
	}
	for (const opt of optionSet) {
		if (!expectedSet.has(opt)) {
			errors.push(
				`${label}: ${kind} input option "${opt}" is not in ${source} — remove it or add it to the registry`,
			);
		}
	}
	// The invariant requires a default that is one of the options. A missing default — or a malformed
	// non-string one, which dispatchInput coerces to undefined — must fail, not pass vacuously.
	if (input.default === undefined) {
		errors.push(
			`${label}: ${kind} input has no valid string default — it must default to one of ${source}`,
		);
	} else if (!expectedSet.has(input.default)) {
		errors.push(`${label}: ${kind} input default "${input.default}" is not in ${source}`);
	}
	return errors;
}

/** Invariant 2: the suite dispatch input options == SUITE_NAMES. */
export function checkSuiteInput(input: DispatchInput, label: string = SMOKE_WORKFLOW): string[] {
	return checkChoiceOptions(
		input,
		[...SUITE_NAMES],
		"suite",
		"SUITE_NAMES (packages/schema/src/suites.ts)",
		label,
	);
}

/** Invariant 5: every live-run job has margin beyond the longest registered sandbox lifetime. */
export function checkWorkflowTimeouts(timeoutByWorkflow: Record<string, number>): string[] {
	const longestSuite = Math.max(...Object.values(SUITES).map((suite) => suite.timeoutMinutes));
	const minimum = longestSuite + WORKFLOW_TIMEOUT_MARGIN_MINUTES;
	return Object.entries(timeoutByWorkflow)
		.filter(([, timeout]) => timeout < minimum)
		.map(
			([workflow, timeout]) =>
				`${workflow}: job timeout-minutes ${timeout} is below the required ${minimum} ` +
				`(${longestSuite}-minute longest suite + ${WORKFLOW_TIMEOUT_MARGIN_MINUTES}-minute host margin)`,
		);
}

/** The run-step env key carrying the cell's job budget down to `bench-suite`. */
export const CELL_BUDGET_ENV_KEY = "BENCH_CELL_BUDGET_MINUTES";

/**
 * Invariant 5 (second half): the budget the cell's run step advertises equals the job's real
 * `timeout-minutes`.
 *
 * `bench-suite` refuses a `--max-concurrency` cap whose serial waves cannot fit the cell's budget —
 * the check that keeps a capped fan-out from being cancelled mid-flight with all R shards lost. It
 * learns that budget from this env key, because `timeout-minutes` is not readable from an expression
 * context, so the value is a hand-copied literal. Copied literals drift: raising the job timeout
 * without raising the env would keep rejecting caps that now fit, and lowering it without lowering the
 * env would wave through caps that no longer do — the exact failure the guard exists to prevent,
 * re-entered through its own configuration. Assert them equal.
 */
export function checkCellBudgetEnv(
	env: Record<string, string>,
	timeoutMinutes: number,
	workflow: string,
): string[] {
	const raw = env[CELL_BUDGET_ENV_KEY];
	if (raw === undefined) {
		return [
			`${workflow}: run step must set ${CELL_BUDGET_ENV_KEY} so bench-suite can reject a ` +
				`--max-concurrency cap that cannot fit the job's ${timeoutMinutes}-minute budget`,
		];
	}
	if (Number(raw) !== timeoutMinutes) {
		return [
			`${workflow}: ${CELL_BUDGET_ENV_KEY} is "${raw}" but the job's timeout-minutes is ` +
				`${timeoutMinutes} — the cell would size its fan-out against a budget it does not have`,
		];
	}
	return [];
}

/**
 * The whole gate against the real workflow files under `root` — the single owner of which files feed
 * the gate, used by the real-file test in workflow-registry-sync.test.ts.
 */
export function runCheck(root: string = findRepoRoot()): string[] {
	const smoke = readWorkflow(SMOKE_WORKFLOW, root);
	const matrix = readWorkflow(MATRIX_WORKFLOW, root);
	// Both lanes' live-run timeout and cell budget live in the one reusable bench-suite.yml they call.
	// checkLaneDelegates keeps that true by rejecting a caller that grows a cell of its own again.
	const suiteWf = readWorkflow(SUITE_WORKFLOW, root);
	// Read once and share: the suite run step env feeds the cell-budget gate, and its job timeout feeds
	// both the margin gate and that same budget gate.
	const suiteEnv = stepEnv(suiteWf, SUITE_JOB, RUN_STEP, SUITE_WORKFLOW);
	const suiteTimeout = jobTimeoutMinutes(suiteWf, SUITE_JOB, SUITE_WORKFLOW);
	const credentialKeys = [...requiredCredentialKeys().keys()];
	return [
		...checkSuiteInput(dispatchInput(smoke, "suite", SMOKE_WORKFLOW)),
		// Credential keys make the delegation check more than a step-name match: a lane that hangs
		// any of them off a job- or step-level env is building a cell, whatever it calls the step.
		...checkLaneDelegates(smoke, SMOKE_WORKFLOW, credentialKeys),
		...checkLaneDelegates(matrix, MATRIX_WORKFLOW, credentialKeys),
		...checkWorkflowTimeouts({ [SUITE_WORKFLOW]: suiteTimeout }),
		...checkCellBudgetEnv(suiteEnv, suiteTimeout, SUITE_WORKFLOW),
		...checkExperimentNesting(
			Object.fromEntries(
				[
					"bench-matrix.yml",
					"bench-smoke.yml",
					"bench-account.yml",
					"bench-round.yml",
					"bench-suite.yml",
					"commit-dataset.yml",
				].map((file) => [file, readWorkflow(`.github/workflows/${file}`, root)]),
			),
		),
	];
}
