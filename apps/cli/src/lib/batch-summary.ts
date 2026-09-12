// Render one execution batch's outcome as the job summary a maintainer reads first. The bench job's
// log is 30 concurrent sandboxes interleaved, so "what actually happened" is not recoverable from it
// by scrolling: run 34672199543 reported 24 red batches whose real causes (a refused credential mint,
// a provider quota refusal, a missing metric behind a green wrapper exit) were only visible by
// downloading 648 attempt artifacts. This turns the same evidence into a table at the top of the job.
//
// Evidence only. Nothing here decides completeness — `batchIsComplete` does, from the same attempts —
// so a summary can never make an incomplete batch look publishable.
import type { ExperimentAttempt, ExperimentBatch } from "@sandbox-benchmarks/schema";

/** Provider admission refusals read as capacity, not as a benchmark result; count them apart. */
const ADMISSION_REFUSAL = /\b(429|quota|rate limit|concurrent sandbox resource limit)\b/i;

export interface BatchSummary {
	completed: number;
	failed: number;
	/** Attempts whose sandbox is neither confirmed gone nor known never to have existed. */
	unresolved: number;
	/** Attempts the provider refused to allocate — an account-capacity signal, not a measurement. */
	refused: number;
	/** Attempts that reached a benchmark step; a failure below this line never measured anything. */
	measured: number;
}

export function summarizeBatch(attempts: readonly ExperimentAttempt[]): BatchSummary {
	return {
		completed: attempts.filter((attempt) => attempt.outcome === "completed").length,
		failed: attempts.filter((attempt) => attempt.outcome !== "completed").length,
		unresolved: attempts.filter((attempt) => attempt.cleanup === "unresolved").length,
		refused: attempts.filter(
			(attempt) =>
				attempt.cleanup === "not-allocated" && ADMISSION_REFUSAL.test(attempt.diagnostic ?? ""),
		).length,
		measured: attempts.filter((attempt) => attempt.measurementStarted).length,
	};
}

/** The first line of an attempt's diagnostic, clipped so one bad cell cannot flood the summary. */
function reason(attempt: ExperimentAttempt): string {
	const first = (attempt.diagnostic ?? "").split("\n", 1)[0]?.trim() ?? "";
	const text = first.length > 0 ? first : "no diagnostic recorded";
	return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/**
 * The Markdown block for `$GITHUB_STEP_SUMMARY`: the headline counts, then one row per failed cell.
 *
 * `planned` is the batch's frozen cell count rather than the attempt count, so a batch that died
 * before it could even attempt some of its cells reports the shortfall instead of a clean-looking
 * "0 failed of 4".
 */
export function renderBatchSummary(
	batch: Pick<ExperimentBatch, "id" | "quotaDomain" | "cells" | "maxConcurrency" | "budgetMinutes">,
	attempts: readonly ExperimentAttempt[],
	elapsedMinutes: number,
): string {
	const summary = summarizeBatch(attempts);
	const generations = Math.ceil(batch.cells.length / batch.maxConcurrency);
	const lines = [
		`### ${batch.id} — ${batch.quotaDomain}`,
		"",
		`- ${batch.cells.length} planned cell(s), at most ${batch.maxConcurrency} allocated at once` +
			`${generations > 1 ? ` over ${generations} pooled generations` : ""}`,
		`- ${summary.completed} completed, ${summary.failed} failed, ` +
			`${batch.cells.length - attempts.length} never attempted`,
		`- ${summary.measured} reached a benchmark step; ${summary.refused} refused by provider capacity`,
		`- cleanup unresolved for ${summary.unresolved} attempt(s)`,
		`- ${elapsedMinutes.toFixed(1)} min elapsed of the ${batch.budgetMinutes}-minute frozen budget`,
	];
	const failures = attempts.filter((attempt) => attempt.outcome !== "completed");
	if (failures.length > 0) {
		lines.push("", "| cell | cleanup | measured | reason |", "| --- | --- | --- | --- |");
		for (const attempt of failures)
			lines.push(
				`| ${attempt.cellId} | ${attempt.cleanup} | ${attempt.measurementStarted ? "yes" : "no"} ` +
					`| ${reason(attempt).replaceAll("|", "\\|")} |`,
			);
	}
	return `${lines.join("\n")}\n`;
}
