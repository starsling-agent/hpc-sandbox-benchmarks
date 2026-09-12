import { expect, test } from "bun:test";
import type { CoverageReport } from "@sandbox-benchmarks/results";
import { renderCoverageSummary } from "./coverage-summary.ts";

const base: CoverageReport = {
	planDigest: `sha256:${"c".repeat(64)}`,
	complete: false,
	selectedAttempts: [],
	cells: [],
	conflicts: [],
};

test("an incomplete experiment names the cells and the metrics that fell short", () => {
	const markdown = renderCoverageSummary({
		...base,
		selectedAttempts: ["namespace-realworld-openclaw-r0-a1"],
		cells: [
			{ id: "e2b-memory-r0", status: "complete", missingMetrics: [], excludedMetrics: [] },
			{
				id: "namespace-realworld-openclaw-r0",
				status: "failed",
				// The exact shape of the run-34672199543 shortfall: a green wrapper exit that still left
				// three of eight declared metrics without a sample.
				missingMetrics: [
					"realworld_openclaw_task_lint_oxlint",
					"realworld_openclaw_task_shrinkwrap_check",
					"realworld_openclaw_task_test_unit_fast",
				],
				excludedMetrics: [],
			},
			{
				id: "runcloud-realworld-mastra-r7",
				status: "missing",
				missingMetrics: [],
				excludedMetrics: [],
			},
		],
	});
	expect(markdown).toContain("INCOMPLETE");
	expect(markdown).toContain("- complete: 1");
	expect(markdown).toContain("- failed: 1");
	expect(markdown).toContain("- missing: 1");
	expect(markdown).toContain("| namespace-realworld-openclaw-r0 | failed |");
	expect(markdown).toContain("realworld_openclaw_task_lint_oxlint");
	// A cell that is complete is not a shortfall row.
	expect(markdown).not.toContain("| e2b-memory-r0 |");
});

test("conflicts are listed in full, never collapsed into a count", () => {
	const markdown = renderCoverageSummary({
		...base,
		conflicts: ["duplicate attempt: x", "attempt provenance mismatch: y"],
	});
	expect(markdown).toContain("- duplicate attempt: x");
	expect(markdown).toContain("- attempt provenance mismatch: y");
});

test("a long shortfall list is capped and says how many rows it withheld", () => {
	const markdown = renderCoverageSummary({
		...base,
		cells: Array.from({ length: 60 }, (_, index) => ({
			id: `cell-${index}`,
			status: "missing" as const,
			missingMetrics: [],
			excludedMetrics: [],
		})),
	});
	expect(markdown).toContain("| cell-39 | missing |");
	expect(markdown).not.toContain("| cell-40 | missing |");
	expect(markdown).toContain("…and 20 more; see the coverage artifact.");
});

test("a complete experiment says so without a shortfall table", () => {
	const markdown = renderCoverageSummary({
		...base,
		complete: true,
		selectedAttempts: ["a"],
		cells: [{ id: "e2b-memory-r0", status: "complete", missingMetrics: [], excludedMetrics: [] }],
	});
	expect(markdown).toContain("complete");
	expect(markdown).not.toContain("INCOMPLETE");
	expect(markdown).not.toContain("| cell |");
});
