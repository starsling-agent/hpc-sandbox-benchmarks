#!/usr/bin/env bun
import { evaluateExperiment } from "@sandbox-benchmarks/results";
import { readExperimentAttempt, readExperimentPlan } from "../lib/experiment-artifacts.ts";

if (import.meta.main) {
	const [planFile, ...directories] = process.argv.slice(2);
	if (!planFile) throw new Error("usage: evaluate-experiment <plan.json> [attempt-directory...]");
	const coverage = evaluateExperiment(
		readExperimentPlan(planFile),
		directories.map(readExperimentAttempt),
	);
	console.log(JSON.stringify(coverage, null, 2));
	if (!coverage.complete) process.exitCode = 1;
}
