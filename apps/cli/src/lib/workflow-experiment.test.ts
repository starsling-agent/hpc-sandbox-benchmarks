import { expect, test } from "bun:test";
import { workflowExperiment, workflowWaveAxes, workflowWaveAxis } from "./workflow-experiment.ts";

const env = {
	GITHUB_RUN_ID: "123",
	GITHUB_SHA: "a".repeat(40),
	BENCH_PROVIDERS: "daytona-vm,daytona-container,tama",
	BENCH_SUITES: "system,realworld-mastra",
};
test("workflow planning preserves samples and defaults shared accounts to one sandbox", () => {
	const plan = workflowExperiment(env, "2026-09-10");
	expect(plan.cells).toHaveLength(45);
	expect(plan.batches).toHaveLength(45);
	expect(plan.accounts.every((account) => account.sandboxes === 1)).toBe(true);
	expect(
		plan.cells.filter((cell) => cell.suite === "realworld-mastra").map((cell) => cell.replicate),
	).toEqual([
		...Array.from({ length: 12 }, (_, i) => i),
		...Array.from({ length: 12 }, (_, i) => i),
		...Array.from({ length: 12 }, (_, i) => i),
	]);
	// A one-sandbox account cannot pool 12 real-world replicates into a job, so each is its own batch —
	// but each batch still belongs to exactly one wave.
	const axes = workflowWaveAxes(plan);
	expect(axes.synthetic).toHaveLength(9);
	expect(axes.realworld).toHaveLength(36);
	expect(new Set(axes.synthetic.map((entry) => entry.suite))).toEqual(new Set(["system"]));
	expect(new Set(axes.realworld.map((entry) => entry.provider))).toEqual(
		new Set(["daytona-vm", "daytona-container", "tama"]),
	);
});
test("convergence and implicit per-cell quota overrides fail admission", () => {
	expect(() =>
		workflowExperiment(
			{ ...env, BENCH_SUITES: "memory", BENCH_PTS_PASSES: "converge" },
			"2026-09-10",
		),
	).toThrow("convergence");
	expect(() => workflowExperiment({ ...env, BENCH_MAX_CONCURRENCY: "12" }, "2026-09-10")).toThrow(
		"retired",
	);
});
test("a wave larger than the matrix limit is refused at plan time", () => {
	// 257 single-sandbox batches cannot be expressed as one provider matrix. Freezing a plan the
	// dispatch could never expand would strand its overflow cells in a run that still reports itself
	// incomplete, so the planner refuses it and names the two levers that fix it.
	expect(() =>
		workflowExperiment(
			{ ...env, BENCH_PROVIDERS: "tama", BENCH_SUITES: "system", BENCH_REPLICAS: "257" },
			"2026-09-10",
		),
	).toThrow("above the 256-job matrix limit");
	const plan = workflowExperiment(
		{ ...env, BENCH_PROVIDERS: "tama", BENCH_SUITES: "system", BENCH_REPLICAS: "256" },
		"2026-09-10",
	);
	expect(workflowWaveAxis(plan, "synthetic")).toHaveLength(256);
	expect(workflowWaveAxis(plan, "realworld")).toEqual([]);
});

test("a full provider plan is exactly two pooled jobs, one per wave", () => {
	const plan = workflowExperiment(
		{
			...env,
			BENCH_PROVIDERS: "e2b",
			BENCH_SUITES: "",
			BENCH_ACCOUNT_CAPACITY: JSON.stringify({ e2b: { sandboxes: 30 } }),
		},
		"2026-09-10",
	);
	expect(plan.cells).toHaveLength(54);
	for (const suite of new Set(plan.cells.map((cell) => cell.suite))) {
		const cells = plan.cells.filter((cell) => cell.suite === suite);
		const realworld = suite.startsWith("realworld-");
		expect(cells.map((cell) => cell.replicate)).toEqual(
			Array.from({ length: realworld ? 12 : 3 }, (_, i) => i),
		);
		expect(cells.every((cell) => cell.passes === (realworld ? 1 : 2))).toBe(true);
	}
	// Six synthetic suites x 3 replicates, then three real-world suites x 12. The real-world wave holds
	// more replicates than the account admits at once, so it pools: peak 30, two generations of budget,
	// still one job rather than the second batch run 34672199543 spilled into.
	expect(plan.batches.map((batch) => batch.cells.length)).toEqual([18, 36]);
	expect(plan.batches.map((batch) => batch.maxConcurrency)).toEqual([18, 30]);
	expect(plan.batches.map((batch) => batch.budgetMinutes)).toEqual([145, 300]);
	expect(workflowWaveAxes(plan)).toEqual({
		synthetic: [{ batch: "batch-0", provider: "e2b", suite: "synthetic", budgetMinutes: 145 }],
		realworld: [{ batch: "batch-1", provider: "e2b", suite: "realworld", budgetMinutes: 300 }],
	});
});

test("providers sharing a quota domain keep one job each per wave", () => {
	const plan = workflowExperiment(
		{
			...env,
			BENCH_PROVIDERS: "modal-gvisor,modal-vm",
			BENCH_SUITES: "",
			BENCH_ACCOUNT_CAPACITY: JSON.stringify({ modal: { sandboxes: 30 } }),
		},
		"2026-09-10",
	);
	// One shared Modal account, two isolation variants: four jobs, all on the `modal` quota domain, so
	// the bench job's account concurrency group — not a workflow-level `max-parallel` — serialises them.
	const axes = workflowWaveAxes(plan);
	expect(axes.synthetic.map((entry) => entry.provider)).toEqual(["modal-gvisor", "modal-vm"]);
	expect(axes.realworld.map((entry) => entry.provider)).toEqual(["modal-gvisor", "modal-vm"]);
	expect(plan.batches.every((batch) => batch.quotaDomain === "modal")).toBe(true);
});
