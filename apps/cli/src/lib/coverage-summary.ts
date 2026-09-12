// Render an experiment's per-cell coverage report as the Markdown block the publish job puts in its
// job summary.
//
// The aggregator already refuses to publish an incomplete experiment, and that refusal is one line of
// stderr ("Experiment is incomplete; retained attempt artifacts and coverage report are diagnostic
// evidence."). What it does not say is WHICH of the frozen cells fell short and how — the question
// every red publish starts with. This answers it from the same report, without changing what
// publication requires.
import type { CoverageReport } from "@sandbox-benchmarks/results";

/** Cells whose status is worth a maintainer's attention, grouped by the shape of the shortfall. */
const REPORTED: ReadonlyArray<CoverageReport["cells"][number]["status"]> = [
	"missing",
	"failed",
	"cancelled",
];

/** How many shortfall rows to print before collapsing the rest into a count. */
const ROW_LIMIT = 40;

export function renderCoverageSummary(coverage: CoverageReport): string {
	const byStatus = new Map<string, typeof coverage.cells>();
	for (const cell of coverage.cells)
		byStatus.set(cell.status, [...(byStatus.get(cell.status) ?? []), cell]);
	const lines = [
		`### Experiment coverage — ${coverage.complete ? "complete" : "INCOMPLETE"}`,
		"",
		`- ${coverage.cells.length} frozen cell(s), ${coverage.selectedAttempts.length} attempt(s) selected`,
		...[...byStatus.entries()]
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([status, cells]) => `- ${status}: ${cells.length}`),
		`- plan digest \`${coverage.planDigest}\``,
	];
	if (coverage.conflicts.length > 0) {
		lines.push("", "#### Conflicts", "");
		// A conflict invalidates the evidence itself (a duplicate attempt, a provenance mismatch), so it
		// is never collapsed into a count the way an ordinary shortfall row is.
		for (const conflict of coverage.conflicts) lines.push(`- ${conflict}`);
	}
	const shortfalls = coverage.cells.filter((cell) =>
		REPORTED.includes(cell.status as (typeof REPORTED)[number]),
	);
	if (shortfalls.length > 0) {
		lines.push("", "| cell | status | missing metrics |", "| --- | --- | --- |");
		for (const cell of shortfalls.slice(0, ROW_LIMIT))
			lines.push(`| ${cell.id} | ${cell.status} | ${cell.missingMetrics.join(", ") || "—"} |`);
		if (shortfalls.length > ROW_LIMIT)
			lines.push("", `…and ${shortfalls.length - ROW_LIMIT} more; see the coverage artifact.`);
	}
	return `${lines.join("\n")}\n`;
}
