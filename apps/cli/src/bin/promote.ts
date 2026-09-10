#!/usr/bin/env bun
// `promote` — validate a candidate Run and publish it into the committed dataset. The promote half of
// candidate→promote: dataset writes require the original plan and attempt artifacts, and recompute
// complete coverage independently. Without a publish target this retains legacy validation behavior.
// Uses @actions/core for groups, annotations, and a job summary in CI.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import { aggregateExperiment, evidenceDigest, writeRunDocument } from "@sandbox-benchmarks/results";
import { parseRun } from "@sandbox-benchmarks/schema";
import {
	fail,
	inActions,
	logInfo,
	logProviderStatuses,
	providerSummaryRows,
	withGroup,
	writeJobSummary,
} from "../lib/actions-log.ts";
import { readExperimentAttempts, readExperimentPlan } from "../lib/experiment-artifacts.ts";

if (import.meta.main) {
	const [runFile, datasetDir, planFile, attemptsRoot] = process.argv.slice(2);
	if (!runFile) {
		fail("usage: promote <candidateRun.json> [datasetDir plan.json attemptsRoot]", {
			properties: { title: "promote usage" },
			exitCode: 2,
		});
	}

	logInfo(`Promoting candidate ${runFile}`);
	if (inActions()) core.debug(JSON.stringify({ runFile, datasetDir: datasetDir ?? null }));

	const run = await withGroup("Load candidate Run", async () => {
		const parsed = parseRun(JSON.parse(readFileSync(runFile, "utf8")));
		logInfo(`runId=${parsed.runId} sha=${parsed.sha} providers=${parsed.providers.length}`);
		// Already inside withGroup — don't nest another ::group::.
		await logProviderStatuses(parsed, { grouped: false });
		return parsed;
	});

	const validated = run.providers.filter((p) => p.validationStatus === "validated").length;

	// Gate FIRST: a Run with nothing validated (e.g. a partial collection with no PTS XML) must never
	// reach the published dataset.
	if (validated === 0) {
		await writeJobSummary({
			heading: `Promote ${run.runId}`,
			fields: [
				["Status", "failure", "plain"],
				["Run id", run.runId, "code"],
				["Candidate", runFile, "code"],
				["Validated", "0", "plain"],
			],
			tables: [{ heading: "Provider status", rows: providerSummaryRows(run) }],
			detail: "Refusing to promote a Run with zero validated providers",
			annotation: {
				failed: true,
				title: `Promote ${run.runId}`,
				message: "refusing to promote a Run with zero validated providers",
			},
		});
		// Annotation already written above — exit without a second ::error::.
		fail("promote: refusing to promote a Run with zero validated providers", {
			annotate: false,
		});
	}

	let outFile = "";
	// Publish into the committed dataset (data/dataset/runs/<id>.json + index.json), newest-first index.
	if (datasetDir) {
		if (!planFile || !attemptsRoot) {
			fail(
				"publication requires an immutable experiment plan and original attempt artifacts; historical completeness is unverified",
			);
		}
		const verified = aggregateExperiment(
			readExperimentPlan(planFile),
			readExperimentAttempts(attemptsRoot),
		);
		if (evidenceDigest(run) !== evidenceDigest(verified)) {
			fail("candidate does not match the verified experiment attempts");
		}
		outFile = join(datasetDir, "runs", `${run.runId}.json`);
		const indexFile = join(datasetDir, "index.json");
		await withGroup(`Publish ${outFile}`, async () => {
			writeRunDocument(run, outFile, indexFile);
			logInfo(`Published ${run.runId} → ${outFile}`);
		});
	} else {
		logInfo(`Validation-only promote for ${run.runId} (${validated} validated provider(s))`);
	}

	await writeJobSummary({
		heading: `Promote ${run.runId}`,
		fields: [
			["Status", "success", "plain"],
			["Run id", run.runId, "code"],
			["Validated", String(validated), "plain"],
			["Providers", String(run.providers.length), "plain"],
			["SHA", run.sha, "code"],
			["Dataset", outFile || "(validation only)", "code"],
		],
		tables: [{ heading: "Provider status", rows: providerSummaryRows(run) }],
		annotation: {
			failed: false,
			title: `Promote ${run.runId}`,
			message: `promoted=${run.runId} validatedProviders=${validated}`,
		},
	});

	// Machine-readable line for any caller that greps stdout — always on stdout (local and Actions)
	// so `result=$(bun promote …)` keeps working in CI wrappers. Mirror to the step log in Actions.
	const resultLine = JSON.stringify({
		promoted: run.runId,
		validatedProviders: validated,
	});
	process.stdout.write(`${resultLine}\n`);
	if (inActions()) core.info(resultLine);
}
