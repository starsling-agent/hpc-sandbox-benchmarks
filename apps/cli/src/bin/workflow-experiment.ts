#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describeDriverFailure } from "@sandbox-benchmarks/driver";
import { diagnosticSecretsFromEnv } from "@sandbox-benchmarks/driver/env";
import { exitAfterSandboxCleanup } from "@sandbox-benchmarks/harness";
import { batchIsComplete, executeExperimentBatch } from "../lib/execute-experiment.ts";
import { writeImmutableJson } from "../lib/experiment-artifacts.ts";
import { githubExperimentStore } from "../lib/experiment-store.ts";
import { downloadExperimentAttempts, downloadExperimentPlan } from "../lib/experiment-transfer.ts";
import { githubAccountJournal, githubGitRequest } from "../lib/github-account-journal.ts";
import { workflowAxes, workflowExperiment } from "../lib/workflow-experiment.ts";

if (import.meta.main) {
	try {
		const [command, account, round] = process.argv.slice(2);
		const id = process.env.BENCH_EXPERIMENT_ID ?? process.env.GITHUB_RUN_ID;
		if (!id) throw new Error("experiment id is required");
		const store = githubExperimentStore(id);
		const root = "experiment";
		const planRoot = join(root, "manifest");
		mkdirSync(planRoot, { recursive: true });
		let plan: ReturnType<typeof workflowExperiment>;
		if (command === "plan" && process.env.GITHUB_RUN_ATTEMPT === "1") {
			plan = workflowExperiment(process.env, new Date().toISOString().slice(0, 10));
			writeImmutableJson(join(planRoot, "plan.json"), plan);
			await store.upload(`experiment-plan-${plan.id}`, planRoot);
		} else plan = await downloadExperimentPlan(store, id, planRoot);
		if (command !== "collect" && plan.sha !== process.env.GITHUB_SHA)
			throw new Error("checkout revision differs from frozen experiment");
		if (command === "plan" || command === "axes") {
			const axis = workflowAxes(plan, account, round);
			if (!process.env.GITHUB_OUTPUT) throw new Error("workflow output file is required");
			appendFileSync(process.env.GITHUB_OUTPUT, `axis=${JSON.stringify(axis)}\n`);
		} else if (command === "execute") {
			if (process.env.BENCH_CELL_BUDGET_MINUTES !== "180")
				throw new Error("worker must preserve the 180-minute job ceiling");
			const batchId = process.env.BENCH_BATCH_ID;
			if (!batchId) throw new Error("batch id is required");
			const batch = plan.batches.find((entry) => entry.id === batchId);
			if (
				!batch ||
				batch.cells.some(
					(id) =>
						plan.cells.find((cell) => cell.id === id)?.provider !== process.env.BENCH_PROVIDER,
				)
			)
				throw new Error("worker provider differs from frozen batch");
			const attempts = await executeExperimentBatch({
				plan,
				batchId,
				root: join(root, "attempts"),
				workflowAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
				job: process.env.GITHUB_JOB ?? "unknown",
				store,
				journal: githubAccountJournal(githubGitRequest()),
			});
			await exitAfterSandboxCleanup(
				batchIsComplete(plan, join(root, "attempts"), attempts) ? 0 : 1,
			);
		} else if (command === "collect") {
			await downloadExperimentAttempts(
				store,
				githubAccountJournal(githubGitRequest()),
				plan,
				join(root, "attempts"),
			);
		} else
			throw new Error(
				"usage: workflow-experiment plan | axes [account] [round] | execute | collect",
			);
	} catch (error) {
		console.error(describeDriverFailure(error, diagnosticSecretsFromEnv(process.env)));
		await exitAfterSandboxCleanup(1);
	}
}
