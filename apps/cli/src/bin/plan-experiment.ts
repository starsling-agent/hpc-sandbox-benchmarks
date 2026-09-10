#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { accountCapacityPolicySchema, experimentRequestSchema } from "@sandbox-benchmarks/schema";
import { writeImmutableJson } from "../lib/experiment-artifacts.ts";
import { planExperiment } from "../lib/experiment-plan.ts";

if (import.meta.main) {
	const [requestFile, output, policyFile] = process.argv.slice(2);
	if (!requestFile || !output)
		throw new Error("usage: plan-experiment <request.json> <plan.json> [capacity-policy.json]");
	const request = experimentRequestSchema.assert(JSON.parse(readFileSync(requestFile, "utf8")));
	const policy = policyFile
		? accountCapacityPolicySchema.assert(JSON.parse(readFileSync(policyFile, "utf8")))
		: {};
	const plan = planExperiment(request, policy);
	writeImmutableJson(output, plan);
	console.log(
		JSON.stringify({
			digest: plan.digest,
			domains: [...new Set(plan.cells.map((cell) => cell.quotaDomain))],
			batches: plan.batches.length,
		}),
	);
}
