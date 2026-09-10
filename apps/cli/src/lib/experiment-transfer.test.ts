import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExperimentAttempts, writeImmutableJson } from "./experiment-artifacts.ts";
import { downloadExperimentAttempts, downloadExperimentPlan } from "./experiment-transfer.ts";
import { workflowExperiment } from "./workflow-experiment.ts";

const root = mkdtempSync(join(tmpdir(), "experiment-transfer-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const plan = workflowExperiment(
	{
		GITHUB_RUN_ID: "123",
		GITHUB_SHA: "a".repeat(40),
		BENCH_PROVIDERS: "tama",
		BENCH_SUITES: "system",
		BENCH_REPLICAS: "1",
	},
	"2026-09-10",
);
const store = { list: async () => [], upload: async () => {}, download: async () => {} };
test("missing plan artifacts never regenerate a smaller experiment", async () => {
	await expect(downloadExperimentPlan(store, "123", root)).rejects.toThrow("one immutable");
});
test("interrupted attempts survive collection even when every terminal artifact is absent", async () => {
	const directory = join(root, "interrupted");
	await downloadExperimentAttempts(
		store,
		{
			read: async () => [
				{
					version: "1",
					kind: "intent",
					account: "tama",
					attempt: "lost",
					cellId: "tama-system-r0",
					planDigest: plan.digest,
				},
			],
			append: async () => {},
		},
		plan,
		directory,
	);
	expect(() => readExperimentAttempts(directory)).toThrow("unterminated");
});
test("a plan artifact from another workflow cannot supply experiment provenance", async () => {
	await expect(
		downloadExperimentPlan(
			{
				...store,
				list: async () => [
					{ id: 1, name: "experiment-plan-123", expired: false, workflow_run: { id: 456 } },
				],
				download: async (_artifact, directory) => {
					mkdirSync(directory, { recursive: true });
					writeImmutableJson(join(directory, "plan.json"), plan);
				},
			},
			"123",
			join(root, "wrong-workflow"),
		),
	).rejects.toThrow("workflow provenance");
});
