import { expect, test } from "bun:test";
import { workflowAxes, workflowExperiment } from "./workflow-experiment.ts";

const env = {
	GITHUB_RUN_ID: "123",
	GITHUB_SHA: "a".repeat(40),
	BENCH_PROVIDERS: "daytona-vm,daytona-container,tama",
	BENCH_SUITES: "system,realworld-mastra",
};
test("workflow planning preserves samples and defaults shared accounts to one sandbox", () => {
	const plan = workflowExperiment(env, "2026-09-10");
	expect(plan.cells).toHaveLength(45);
	// One rolling batch per provider × wave under default sandboxes=1.
	expect(plan.batches).toHaveLength(6);
	expect(workflowAxes(plan)).toEqual(["daytona", "tama"]);
	expect(plan.accounts.every((account) => account.sandboxes === 1)).toBe(true);
	expect(workflowAxes(plan, "daytona")).toEqual(["synthetic", "realworld"]);
	expect(workflowAxes(plan, "daytona", "synthetic")).toEqual([
		{ batch: "batch-0", provider: "daytona-vm", suite: "system", wave: "synthetic" },
		{ batch: "batch-1", provider: "daytona-container", suite: "system", wave: "synthetic" },
	]);
	expect(
		plan.cells.filter((cell) => cell.suite === "realworld-mastra").map((cell) => cell.replicate),
	).toEqual([
		...Array.from({ length: 12 }, (_, i) => i),
		...Array.from({ length: 12 }, (_, i) => i),
		...Array.from({ length: 12 }, (_, i) => i),
	]);
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
test("large account cohorts stay in one rolling batch under collection rounds", () => {
	const plan = workflowExperiment(
		{ ...env, BENCH_PROVIDERS: "tama", BENCH_SUITES: "system", BENCH_REPLICAS: "257" },
		"2026-09-10",
	);
	expect(plan.batches).toHaveLength(1);
	expect(plan.batches[0]?.cells).toHaveLength(257);
	expect(plan.batches[0]?.maxConcurrency).toBe(1);
	expect(plan.rounds.map((round) => round.batches.length)).toEqual([1]);
	expect(plan.cells.at(-1)?.replicate).toBe(256);
});

test("full provider plans separate synthetic and realworld under the account cap", () => {
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
	expect(plan.batches.map((batch) => batch.cells.length)).toEqual([18, 36]);
	expect(plan.batches.map((batch) => batch.wave)).toEqual(["synthetic", "realworld"]);
	expect(plan.batches.every((batch) => batch.maxConcurrency === 30)).toBe(true);
	for (const suite of new Set(plan.cells.map((cell) => cell.suite))) {
		const cells = plan.cells.filter((cell) => cell.suite === suite);
		const realworld = suite.startsWith("realworld-");
		expect(cells.map((cell) => cell.replicate)).toEqual(
			Array.from({ length: realworld ? 12 : 3 }, (_, i) => i),
		);
		expect(cells.every((cell) => cell.passes === (realworld ? 1 : 2))).toBe(true);
	}
	expect(workflowAxes(plan, "e2b", "synthetic")).toEqual([
		{ batch: "batch-0", provider: "e2b", suite: "mixed", wave: "synthetic" },
	]);
	expect(workflowAxes(plan, "e2b", "realworld")).toEqual([
		{ batch: "batch-1", provider: "e2b", suite: "mixed", wave: "realworld" },
	]);
});
