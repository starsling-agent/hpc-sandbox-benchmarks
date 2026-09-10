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
	expect(plan.batches).toHaveLength(45);
	expect(workflowAxes(plan)).toEqual(["daytona", "tama"]);
	expect(plan.accounts.every((account) => account.sandboxes === 1)).toBe(true);
	const daytona = plan.rounds.find((round) => round.quotaDomain === "daytona");
	expect(daytona).toBeDefined();
	expect(workflowAxes(plan, "daytona", daytona?.id)).toHaveLength(30);
	expect(
		plan.cells.filter((cell) => cell.suite === "realworld-mastra").map((cell) => cell.replicate),
	).toEqual([
		...Array.from({ length: 12 }, (_, i) => i),
		...Array.from({ length: 12 }, (_, i) => i),
		...Array.from({ length: 12 }, (_, i) => i),
	]);
});
test("convergence and implicit per-cell quota overrides fail admission", () => {
	expect(() => workflowExperiment({ ...env, BENCH_SUITES: "memory" }, "2026-09-10")).toThrow(
		"convergence",
	);
	expect(() => workflowExperiment({ ...env, BENCH_MAX_CONCURRENCY: "12" }, "2026-09-10")).toThrow(
		"retired",
	);
});
test("large account cohorts partition into bounded collection rounds", () => {
	const plan = workflowExperiment(
		{ ...env, BENCH_PROVIDERS: "tama", BENCH_SUITES: "system", BENCH_REPLICAS: "257" },
		"2026-09-10",
	);
	expect(plan.rounds.map((round) => round.batches.length)).toEqual([64, 64, 64, 64, 1]);
	expect(plan.cells.at(-1)?.replicate).toBe(256);
});
