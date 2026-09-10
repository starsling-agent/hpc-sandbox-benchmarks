#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateExperiment, writeRunDocument } from "@sandbox-benchmarks/results";
import { readExperimentAttempts, readExperimentPlan } from "../lib/experiment-artifacts.ts";

if (import.meta.main) {
	const [planFile, attemptsRoot, output] = process.argv.slice(2);
	if (!planFile || !attemptsRoot || !output)
		throw new Error(
			"usage: aggregate-experiment <plan.json> <attempts-directory> <candidate-directory>",
		);
	const plan = readExperimentPlan(planFile);
	const attempts = readExperimentAttempts(attemptsRoot);
	// One evaluation: the coverage report is written either way, and the Run exists only when it is
	// complete.
	const { coverage, run } = aggregateExperiment(plan, attempts);
	mkdirSync(output, { recursive: true });
	writeFileSync(join(output, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
	if (!run) {
		console.error(
			"Experiment is incomplete; retained attempt artifacts and coverage report are diagnostic evidence.",
		);
		process.exitCode = 1;
	} else {
		writeRunDocument(run, join(output, "runs", `${run.runId}.json`), join(output, "index.json"));
	}
}
