#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	aggregateExperiment,
	evaluateExperiment,
	writeRunDocument,
} from "@sandbox-benchmarks/results";
import { readExperimentAttempts, readExperimentPlan } from "../lib/experiment-artifacts.ts";

if (import.meta.main) {
	const [planFile, attemptsRoot, output] = process.argv.slice(2);
	if (!planFile || !attemptsRoot || !output)
		throw new Error(
			"usage: aggregate-experiment <plan.json> <attempts-directory> <candidate-directory>",
		);
	const plan = readExperimentPlan(planFile);
	const attempts = readExperimentAttempts(attemptsRoot);
	const coverage = evaluateExperiment(plan, attempts);
	mkdirSync(output, { recursive: true });
	writeFileSync(join(output, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
	if (!coverage.complete) {
		console.error(
			"Experiment is incomplete; retained attempt artifacts and coverage report are diagnostic evidence.",
		);
		process.exitCode = 1;
	} else {
		const run = aggregateExperiment(plan, attempts);
		writeRunDocument(run, join(output, "runs", `${run.runId}.json`), join(output, "index.json"));
	}
}
