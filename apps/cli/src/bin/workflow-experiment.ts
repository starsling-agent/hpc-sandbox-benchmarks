#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describeDriverFailure } from "@sandbox-benchmarks/driver";
import { diagnosticSecretsFromEnv } from "@sandbox-benchmarks/driver/env";
import { exitAfterSandboxCleanup } from "@sandbox-benchmarks/harness";
import { renderBatchSummary } from "../lib/batch-summary.ts";
import { batchIsComplete, executeExperimentBatch } from "../lib/execute-experiment.ts";
import { writeImmutableJson } from "../lib/experiment-artifacts.ts";
import { githubExperimentStore } from "../lib/experiment-store.ts";
import { downloadExperimentAttempts, downloadExperimentPlan } from "../lib/experiment-transfer.ts";
import { emitStepOutputs } from "../lib/gha-output.ts";
import { githubAccountJournal, githubGitRequest } from "../lib/github-account-journal.ts";
import { workflowExperiment, workflowWaveAxes } from "../lib/workflow-experiment.ts";

/** Append a Markdown block to the job summary; a local run prints it instead. */
function emitJobSummary(markdown: string): void {
	const file = process.env.GITHUB_STEP_SUMMARY;
	if (file) appendFileSync(file, markdown);
	else process.stdout.write(markdown);
}

if (import.meta.main) {
	try {
		const [command] = process.argv.slice(2);
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
		if (command === "plan") {
			// One plan job emits BOTH wave axes. The account and round readers this replaced re-planned
			// the same frozen experiment before every level of the fan-out; the waves are a fixed pair, so
			// there is nothing left to re-read between freezing the plan and creating the jobs.
			const axes = workflowWaveAxes(plan);
			emitStepOutputs(
				Object.entries(axes)
					.map(([wave, entries]) => `${wave}=${JSON.stringify(entries)}`)
					.join("\n"),
			);
			emitJobSummary(
				[
					`### Frozen experiment \`${plan.id}\``,
					"",
					`- ${plan.cells.length} cells across ${plan.accounts.length} account(s)`,
					...Object.entries(axes).map(
						([wave, entries]) =>
							`- ${wave} wave: ${entries.length} job(s) — ${entries
								.map((entry) => entry.provider)
								.join(", ")}`,
					),
					`- plan digest \`${plan.digest}\``,
					"",
				].join("\n"),
			);
		} else if (command === "execute") {
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
			// The job's own `timeout-minutes`, hand-copied into this env by the workflow, must cover the
			// budget the plan froze for this batch — including the pooled generations a wave larger than
			// its account cap will run. A worker that started anyway would be cancelled mid-flight with
			// its last generation's evidence lost.
			const ceiling = Number(process.env.BENCH_CELL_BUDGET_MINUTES);
			if (!Number.isFinite(ceiling) || ceiling < batch.budgetMinutes)
				throw new Error(
					`job budget ${process.env.BENCH_CELL_BUDGET_MINUTES ?? "(unset)"} minutes cannot hold ` +
						`the ${batch.budgetMinutes}-minute frozen budget of ${batchId}`,
				);
			const startedAt = Date.now();
			const attempts = await executeExperimentBatch({
				plan,
				batchId,
				root: join(root, "attempts"),
				workflowAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
				job: process.env.GITHUB_JOB ?? "unknown",
				store,
				journal: githubAccountJournal(githubGitRequest()),
			});
			emitJobSummary(renderBatchSummary(batch, attempts, (Date.now() - startedAt) / 60_000));
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
		} else throw new Error("usage: workflow-experiment plan | execute | collect");
	} catch (error) {
		console.error(describeDriverFailure(error, diagnosticSecretsFromEnv(process.env)));
		await exitAfterSandboxCleanup(1);
	}
}
