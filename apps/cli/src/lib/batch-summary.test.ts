import { expect, test } from "bun:test";
import type { ExperimentAttempt } from "@sandbox-benchmarks/schema";
import { renderBatchSummary, summarizeBatch } from "./batch-summary.ts";

const batch = {
	id: "batch-1",
	quotaDomain: "runcloud",
	cells: ["a", "b", "c", "d"],
	maxConcurrency: 2,
	budgetMinutes: 300,
};

function attempt(overrides: Partial<ExperimentAttempt> & { cellId: string }): ExperimentAttempt {
	return {
		schemaVersion: "1",
		id: `${overrides.cellId}-a1`,
		planDigest: `sha256:${"b".repeat(64)}`,
		sha: "a".repeat(40),
		workloadRevision: "w",
		environmentRevision: "e",
		artifactIdentity: "i",
		passes: 1,
		workflowRun: "1",
		workflowAttempt: 1,
		job: "bench",
		sequence: 0,
		outcome: "completed",
		measurementStarted: true,
		retryable: false,
		cleanup: "confirmed",
		completion: "known-success",
		...overrides,
	};
}

test("a provider capacity refusal is counted apart from a measurement failure", () => {
	const summary = summarizeBatch([
		attempt({ cellId: "a" }),
		attempt({
			cellId: "b",
			outcome: "failed",
			measurementStarted: false,
			cleanup: "not-allocated",
			completion: "unknown",
			diagnostic: "run.cloud API 429: concurrent sandbox resource limit reached",
		}),
		attempt({
			cellId: "c",
			outcome: "failed",
			cleanup: "unresolved",
			completion: "known-failure",
			diagnostic: "failed to provision; inspect it in the console",
		}),
	]);
	// A 429 is an account-capacity signal, not a benchmark result: it is not measured, and it must not
	// read as a provider that ran badly.
	expect(summary).toEqual({ completed: 1, failed: 2, unresolved: 1, refused: 1, measured: 2 });
});

test("the summary reports planned cells that never produced an attempt", () => {
	const markdown = renderBatchSummary(batch, [attempt({ cellId: "a" })], 12.34);
	expect(markdown).toContain(
		"4 planned cell(s), at most 2 allocated at once over 2 pooled generations",
	);
	expect(markdown).toContain("1 completed, 0 failed, 3 never attempted");
	expect(markdown).toContain("12.3 min elapsed of the 300-minute frozen budget");
	// Nothing failed, so there is no failure table to read past.
	expect(markdown).not.toContain("| cell |");
});

test("each failed cell reports its own first diagnostic line, escaped for the table", () => {
	const markdown = renderBatchSummary(
		batch,
		[
			attempt({
				cellId: "b",
				outcome: "failed",
				measurementStarted: false,
				cleanup: "not-allocated",
				completion: "unknown",
				diagnostic: "NSC_TOKEN_FILE must be a string (was missing)\nstack frame\nstack frame",
			}),
		],
		1,
	);
	expect(markdown).toContain(
		"| b | not-allocated | no | NSC_TOKEN_FILE must be a string (was missing) |",
	);
	expect(markdown).not.toContain("stack frame");
});
