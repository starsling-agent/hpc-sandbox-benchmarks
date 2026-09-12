// Invariant: the GitHub workflows that dispatch live benchmarks stay in lockstep with the suite
// registry and retain their safe delegation/timeout shape. Provider choices and provider input env are
// generated from metadata and owned by check:provider-wiring, so this gate deliberately does not
// compare those managed regions a second time. Both dispatch lanes — bench-matrix.yml (the full
// matrix, ending in a dataset commit) and
// bench-smoke.yml (the same pipeline narrowed to one provider × suite and stopped before that commit) —
// are one `plan` job plus one suite-matrix job calling the reusable bench-suite.yml (native nesting:
// suite / provider). The credential block + run-job timeout live in that single reusable, so the
// credential/timeout checks read it; separate invariants assert both callers stay wired to
// plan.outputs.suites and that neither lane grows a benchmark cell of its own again. Mirrors
// runner-benchmarking's test/workflow-{env,suite}-sync.test.ts. See ./lib/workflow-sync.ts for the
// parsers + pure checks. Nesting (invariant 6) lives in ./lib/workflow-nesting.ts; YAML helpers in
// ./lib/workflow-yaml.ts — workflow-sync.ts re-exports the public surface.
//
// The runCheck() test against the real workflow files IS the gate's CI enforcement point (it runs under
// `bun test`, same precedent as boundary.test.ts); the rest is unit coverage of the parsers and the
// failure messages on synthetic drift, so a future regression names the offending file + key.
import { describe, expect, test } from "bun:test";
import { BENCH_JOB_CEILING_MINUTES, SUITE_NAMES } from "@sandbox-benchmarks/schema";
import {
	CELL_BUDGET_ENV_KEY,
	checkCellBudgetEnv,
	checkJobCeiling,
	checkLaneDelegates,
	checkSuiteInput,
	checkWorkflowTimeouts,
	dispatchInput,
	jobTimeoutMinutes,
	MATRIX_WORKFLOW,
	RUN_STEP,
	readWorkflow,
	requiredCredentialKeys,
	runCheck,
	SMOKE_WORKFLOW,
	SUITE_JOB,
	SUITE_WORKFLOW,
	stepEnv,
	WORKFLOW_TIMEOUT_MARGIN_MINUTES,
} from "./lib/workflow-sync.ts";

const matrix = readWorkflow(MATRIX_WORKFLOW);
const smoke = readWorkflow(SMOKE_WORKFLOW);
const suiteWf = readWorkflow(SUITE_WORKFLOW);
const suiteInput = dispatchInput(smoke, "suite", SMOKE_WORKFLOW);
const suiteEnv = stepEnv(suiteWf, SUITE_JOB, RUN_STEP, SUITE_WORKFLOW);

describe("parsers against the real workflow files", () => {
	test("dispatchInput extracts the smoke suite choice", () => {
		expect(new Set(suiteInput.options)).toEqual(new Set(SUITE_NAMES));
		expect(suiteInput.type).toBe("choice");
	});

	test("stepEnv extracts the one real credential block, in the reusable cell", () => {
		expect(suiteEnv).toContainKey("E2B_API_KEY");
		expect(suiteEnv).toContainKey("DAYTONA_API_KEY");
		// A real block (credentials + runtime context), not a parse fragment.
		expect(Object.keys(suiteEnv).length).toBeGreaterThanOrEqual(8);
	});

	test("the live-run job reserves the planner's whole pooled ceiling", () => {
		expect(jobTimeoutMinutes(suiteWf, SUITE_JOB, SUITE_WORKFLOW)).toBe(BENCH_JOB_CEILING_MINUTES);
	});

	test("dispatchInput throws on a missing input instead of passing vacuously", () => {
		expect(() => dispatchInput(smoke, "no-such-input", SMOKE_WORKFLOW)).toThrow(
			'input "no-such-input" not found',
		);
	});

	test("stepEnv throws on a missing job, step, or env mapping", () => {
		expect(() => stepEnv(suiteWf, "no-such-job", RUN_STEP, SUITE_WORKFLOW)).toThrow(
			'job "no-such-job" not found',
		);
		expect(() => stepEnv(suiteWf, SUITE_JOB, "No Such Step", SUITE_WORKFLOW)).toThrow(
			'has no step named "No Such Step"',
		);
		const yaml = Bun.YAML.stringify({ jobs: { j: { steps: [{ name: "bare" }] } } });
		expect(() => stepEnv(Bun.YAML.parse(yaml), "j", "bare", "synthetic.yml")).toThrow(
			"has no env mapping",
		);
	});
});

describe("checkJobCeiling", () => {
	test("the real live-run timeout is the planner's ceiling", () => {
		expect(
			checkJobCeiling(jobTimeoutMinutes(suiteWf, SUITE_JOB, SUITE_WORKFLOW), SUITE_WORKFLOW),
		).toEqual([]);
	});

	// The drift that strands a wave: the planner keeps packing a provider's whole real-world wave into
	// one pooled batch sized against the ceiling, while Actions kills the job at the lower number.
	test("flags a live-run timeout below the ceiling the planner packs against", () => {
		const errors = checkJobCeiling(BENCH_JOB_CEILING_MINUTES - 1, SUITE_WORKFLOW);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("BENCH_JOB_CEILING_MINUTES");
	});
});

describe("checkWorkflowTimeouts", () => {
	test("passes timeouts with the required host margin", () => {
		expect(checkWorkflowTimeouts({ bench: 180 })).toEqual([]);
	});

	test("flags a job cap that cannot outlast the longest suite", () => {
		// The longest registered suite budget is 90 min, so the required floor is 90 + 15 = 105. A 100-min
		// cap outlasts the suite itself but not by the host margin — exactly the drift this invariant catches.
		const errors = checkWorkflowTimeouts({ smoke: 100 });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("smoke");
		expect(errors[0]).toContain(`${WORKFLOW_TIMEOUT_MARGIN_MINUTES}-minute host margin`);
	});
});

describe("checkCellBudgetEnv", () => {
	// The real workflow: the literal the run step advertises must be the job's own timeout-minutes.
	test("the real cell budget matches the real job timeout", () => {
		expect(
			checkCellBudgetEnv(
				suiteEnv,
				jobTimeoutMinutes(suiteWf, SUITE_JOB, SUITE_WORKFLOW),
				SUITE_WORKFLOW,
			),
		).toEqual([]);
	});

	// Dropping the key disables the fan-out budget guard entirely — a capped cell would then be
	// cancelled three hours in with every shard lost, which is what the guard exists to prevent.
	test("flags a missing budget key", () => {
		const errors = checkCellBudgetEnv({}, 180, SUITE_WORKFLOW);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(CELL_BUDGET_ENV_KEY);
	});

	// The drift that matters: raising `timeout-minutes` without raising the copied literal keeps
	// rejecting caps that now fit; lowering it without lowering the literal waves through caps that
	// no longer do.
	test("flags a budget that has drifted from the job timeout", () => {
		const errors = checkCellBudgetEnv({ [CELL_BUDGET_ENV_KEY]: "180" }, 240, SUITE_WORKFLOW);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('is "180"');
		expect(errors[0]).toContain("timeout-minutes is 240");
	});
});

describe("checkSuiteInput", () => {
	test("the real suite choice is in sync", () => {
		expect(checkSuiteInput(suiteInput)).toEqual([]);
	});

	test("flags a registry suite dropped from the options", () => {
		const [first] = SUITE_NAMES;
		const drifted = { ...suiteInput, options: suiteInput.options?.filter((o) => o !== first) };
		const errors = checkSuiteInput(drifted);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(`missing "${first}"`);
		expect(errors[0]).toContain("SUITE_NAMES");
	});

	test("flags a stray suite option not in the registry", () => {
		const drifted = { ...suiteInput, options: [...(suiteInput.options ?? []), "gpu"] };
		const errors = checkSuiteInput(drifted);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('option "gpu" is not in SUITE_NAMES');
	});

	test("flags a non-choice suite type (shared check applies on the suite axis too)", () => {
		const errors = checkSuiteInput({ ...suiteInput, type: "string" });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('not "type: choice"');
	});
});

describe("requiredCredentialKeys", () => {
	test("requiredCredentialKeys records provenance per provider", () => {
		const required = requiredCredentialKeys();
		expect(required.get("E2B_API_KEY")).toEqual(["e2b"]);
		// A credential shared by a vendor's isolation variants records every owner, in registry order.
		expect(required.get("MODAL_TOKEN_ID")).toEqual(["modal-gvisor", "modal-vm"]);
		expect(required.get("DAYTONA_API_KEY")).toEqual(["daytona-vm", "daytona-container"]);
	});
});

describe("checkLaneDelegates", () => {
	const CREDENTIALS = [...requiredCredentialKeys().keys()];
	const lane = (doc: unknown, label = "synthetic.yml"): string[] =>
		checkLaneDelegates(doc, label, CREDENTIALS);
	const laneYaml = (jobs: object): string[] => lane(Bun.YAML.parse(Bun.YAML.stringify({ jobs })));

	// Invariant 3b: the consolidation itself. Both dispatch lanes must reach sandboxes only through the
	// reusable — a re-introduced cell in either is the copy-paste this change removed.
	test("the real dispatch lanes own no benchmark cell", () => {
		expect(lane(smoke, SMOKE_WORKFLOW)).toEqual([]);
		expect(lane(matrix, MATRIX_WORKFLOW)).toEqual([]);
	});

	test("the reusable itself is where the cell lives (so it would NOT pass this lane check)", () => {
		const errors = lane(suiteWf, SUITE_WORKFLOW);
		// All three probes fire on the real cell: the step name, the run: that drives it, and its
		// credential block. That is the shape the lanes must never have.
		expect(errors.length).toBeGreaterThanOrEqual(3);
		for (const error of errors) expect(error).toContain(SUITE_JOB);
	});

	test("flags a lane that re-grows its own run step, naming the job", () => {
		const errors = laneYaml({
			plan: { "runs-on": "ubuntu-24.04", steps: [{ name: "Plan" }] },
			smoke: { "runs-on": "ubuntu-24.04", steps: [{ name: RUN_STEP }] },
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('job "smoke"');
		expect(errors[0]).toContain(RUN_STEP);
	});

	// The bypass a name-only check misses: same cell, fresh step name. This is the shape someone
	// re-adding a cell by hand writes — they do not copy the reusable's step name along with it.
	test("flags a re-grown cell hiding under a different step name", () => {
		const errors = laneYaml({
			smoke: {
				"runs-on": "ubuntu-24.04",
				steps: [
					{ name: "Benchmark the cell", run: "bun apps/cli/src/bin/bench-suite.ts e2b system" },
				],
			},
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("bench-suite.ts");
	});

	// The other bypass: credentials on a JOB-level env, which every step inherits, so no per-step scan
	// would ever see them.
	test("flags provider credentials hung off a job-level env", () => {
		const errors = laneYaml({
			smoke: {
				"runs-on": "ubuntu-24.04",
				env: { E2B_API_KEY: "x", DAYTONA_API_KEY: "y", SOME_RUNTIME_CONTEXT: "z" },
				steps: [{ name: "Something else" }],
			},
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("DAYTONA_API_KEY, E2B_API_KEY");
		// Non-credential env is not the lane's business.
		expect(errors[0]).not.toContain("SOME_RUNTIME_CONTEXT");
	});

	test("flags provider credentials on a step env too", () => {
		const errors = laneYaml({
			smoke: { "runs-on": "ubuntu-24.04", steps: [{ name: "x", env: { NOVITA_API_KEY: "k" } }] },
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("NOVITA_API_KEY");
	});

	// A lane legitimately runs bun bins (the planners) and carries non-credential env; neither is a cell.
	test("passes a lane that plans and orchestrates without touching a credential", () => {
		expect(
			laneYaml({
				plan: {
					"runs-on": "ubuntu-24.04",
					steps: [
						{
							name: "Plan",
							run: "bun apps/cli/src/bin/plan-suites.ts",
							env: { BENCH_SUITES: "s" },
						},
					],
				},
				suite: { uses: "./.github/workflows/bench-suite.yml", with: { suite: "system" } },
			}),
		).toEqual([]);
	});
});

test("production workflows preserve planned account batching and strict promotion", () => {
	expect(runCheck()).toEqual([]);
});

test("the integrated workflow gate rejects throttled waves, detached axes, a shared credential mint and legacy promotion", async () => {
	const { checkExperimentNesting } = await import("./lib/workflow-nesting.ts");
	const docs = Object.fromEntries(
		["bench-matrix.yml", "bench-smoke.yml", "bench-suite.yml", "commit-dataset.yml"].map((file) => [
			file,
			readWorkflow(`.github/workflows/${file}`),
		]),
	);
	const source = JSON.stringify(docs);
	for (const [before, after] of [
		// A wave's provider jobs are created together — one `privileged` approval releases the wave, and
		// independent accounts never wait on each other. max-parallel is both of those, undone.
		[
			'"fail-fast":false,"matrix":{"include":',
			'"fail-fast":false,"max-parallel":1,"matrix":{"include":',
		],
		// The axis must be the frozen plan's, not something the dispatch composed for itself.
		["fromJSON(needs.plan.outputs.synthetic)", "fromJSON(inputs.providers)"],
		// The long wave must stay ordered behind the short one.
		['"needs":["plan","synthetic"]', '"needs":["plan"]'],
		// Per-job identity for the credential mint: the collision that failed 30 Namespace cells.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression contract literals
		["sandbox-benchmarks-${{ inputs.batch_id }}", "sandbox-benchmarks-${{ inputs.suite }}"],
		// Promotion must re-verify the original plan and the whole attempt set.
		["data/dataset experiment/manifest/plan.json experiment/attempts", "data/dataset"],
		["workflow-experiment.ts execute", "bench-suite.ts"],
		// Coverage must survive the refusal to publish it.
		["Retain the per-cell coverage report", "Retain nothing"],
	] as const) {
		expect(source).toContain(before);
		expect(
			checkExperimentNesting(JSON.parse(source.replaceAll(before, after))).length,
		).toBeGreaterThan(0);
	}
});

test("the gate rejects a lane that re-reads the frozen plan at a second level", async () => {
	const { checkExperimentNesting } = await import("./lib/workflow-nesting.ts");
	const docs = Object.fromEntries(
		["bench-matrix.yml", "bench-smoke.yml", "bench-suite.yml", "commit-dataset.yml"].map((file) => [
			file,
			readWorkflow(`.github/workflows/${file}`),
		]),
	);
	// The account/round readers this consolidation removed: an extra job whose only work is to
	// re-download the frozen plan and emit the next axis.
	const withReader = JSON.parse(JSON.stringify(docs));
	withReader["bench-matrix.yml"].jobs.round = {
		"runs-on": "ubuntu-24.04",
		steps: [{ name: "Read frozen round axis", run: "bun apps/cli/src/bin/workflow-experiment.ts" }],
	};
	const errors = checkExperimentNesting(withReader);
	expect(errors.some((error) => error.includes("read once"))).toBe(true);
});
