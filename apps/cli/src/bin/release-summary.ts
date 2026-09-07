#!/usr/bin/env bun
// `release-summary` — the script behind the release-summary composite action. It combines the raw
// GitHub job status with bake/promote reports and the release's required-provider set so summaries
// distinguish blockers from best-effort failures instead of reducing every phase to one opaque word.
import * as core from "@actions/core";
import type { CellKind, SummaryRow } from "../lib/actions-log.ts";
import {
	canWriteSummary,
	escapeHtml,
	fieldTable,
	isFailure,
	renderCell,
} from "../lib/actions-log.ts";
import { blockingReports, isBlockingReport, nonBlockingFailures } from "../lib/bake/gates.ts";
import type { BakeReport } from "../lib/bake/types.ts";

// Re-export pure helpers so existing unit tests keep importing from this bin path.
export { escapeHtml, isFailure, renderCell };

export interface ReleaseResult {
	/** Drives the annotation channel: error (blocking/non-success), warning (best-effort), or notice. */
	kind: "failure" | "warning" | "ok";
	/** The one-line verdict shown as the summary's first row. */
	result: string;
	/** Provider/sentinel outcomes that block the release, including required skips. */
	blocking: string[];
	/** Failed providers that are best-effort (recorded, non-blocking). */
	nonBlocking: string[];
	/** Providers that skipped (missing credentials or another declared prerequisite). */
	skipped: string[];
	/** A mismatch between `job.status` and the report-derived result. */
	discrepancy?: string;
}

const uniqueProviders = (reports: ReadonlyArray<{ provider: string }>): string[] => [
	...new Set(reports.map((report) => report.provider)),
];

/** Classify a phase from GitHub's job status plus its structured provider outcomes. */
export function classifyRelease(input: {
	jobStatus: string;
	reports: ReadonlyArray<{ provider: string; status: string }>;
	required: readonly string[];
}): ReleaseResult {
	const { jobStatus, reports, required } = input;
	const blocking = uniqueProviders(blockingReports(reports, required));
	const nonBlocking = uniqueProviders(nonBlockingFailures(reports, required));
	const skipped = uniqueProviders(reports.filter((report) => report.status === "skipped"));
	const normalizedJobStatus = jobStatus.trim().toLowerCase();
	const jobCancelled = normalizedJobStatus === "cancelled";
	const jobNonSuccess = isFailure(jobStatus) || jobCancelled;

	let kind: ReleaseResult["kind"];
	let result: string;
	if (blocking.length > 0) {
		kind = "failure";
		result = `Failed — blocking: ${blocking.join(", ")}`;
	} else if (jobNonSuccess) {
		kind = "failure";
		const label = jobCancelled ? "Cancelled" : `Failed${jobStatus ? ` (${jobStatus})` : ""}`;
		result =
			reports.length > 0
				? `${label} — no blocking provider outcome recorded; check the step log`
				: label;
	} else if (nonBlocking.length > 0) {
		kind = "warning";
		result = `Passed with non-blocking failure(s): ${nonBlocking.join(", ")}`;
	} else {
		kind = "ok";
		result = skipped.length > 0 ? `OK (skipped: ${skipped.join(", ")})` : "OK";
	}

	let discrepancy: string | undefined;
	if (!jobNonSuccess && blocking.length > 0) {
		discrepancy =
			`Job status "${jobStatus || "success"}" is GREEN but a blocking outcome was recorded ` +
			`(${blocking.join(", ")}) — the green status is wrong.`;
	} else if (jobNonSuccess && reports.length > 0 && blocking.length === 0) {
		discrepancy =
			`Job status "${jobStatus}" is non-success but no blocking provider outcome was recorded — ` +
			"the cause is outside the provider reports (check earlier steps).";
	}

	return { kind, result, blocking, nonBlocking, skipped, discrepancy };
}

/** Parse the `reports` array out of a bake/promote payload; malformed data degrades to no reports. */
export function readReports(json: string | undefined): BakeReport[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json) as { reports?: unknown };
		if (!Array.isArray(parsed.reports)) return [];
		return parsed.reports.flatMap((report): BakeReport[] => {
			if (typeof report !== "object" || report === null) return [];
			const candidate = report as Partial<BakeReport>;
			if (
				typeof candidate.provider !== "string" ||
				(candidate.status !== "ok" &&
					candidate.status !== "skipped" &&
					candidate.status !== "failed")
			) {
				return [];
			}
			return [
				{
					provider: candidate.provider,
					status: candidate.status,
					...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
					...(typeof candidate.durationMs === "number" && Number.isFinite(candidate.durationMs)
						? { durationMs: candidate.durationMs }
						: {}),
				},
			];
		});
	} catch {
		return [];
	}
}

/** Read and parse a report in one guarded operation. Missing, unreadable, and malformed files are all
 * valid fallbacks: plan/build phases have no report, and a failed phase may crash before writing one. */
export async function readReportFile(path: string): Promise<BakeReport[]> {
	if (!path.trim()) return [];
	try {
		return readReports(await Bun.file(path).text());
	} catch {
		return [];
	}
}

/** Split the composite action's comma-separated required-provider input. */
function splitList(raw: string): string[] {
	return raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

/** One row per provider report: id, status, blocking policy, wall time, and reason. */
function providerReportRows(
	reports: readonly BakeReport[],
	required: readonly string[],
): SummaryRow[] {
	const header: SummaryRow = [
		{ data: "Provider", header: true },
		{ data: "Status", header: true },
		{ data: "Blocking", header: true },
		{ data: "Duration", header: true },
		{ data: "Reason", header: true },
	];
	const rows: SummaryRow[] = reports.map((report) => {
		const policy =
			report.status === "ok" ? "—" : isBlockingReport(report, required) ? "yes" : "best-effort";
		const duration =
			report.durationMs !== undefined ? `${(report.durationMs / 1000).toFixed(1)}s` : "—";
		return [
			renderCell(report.provider, "code"),
			renderCell(report.status, "plain"),
			renderCell(policy, "plain"),
			renderCell(duration, "plain"),
			renderCell(report.reason || "—", "plain"),
		];
	});
	return [header, ...rows];
}

if (import.meta.main) {
	const env = (key: string): string => process.env[key]?.trim() ?? "";
	const phase = env("PHASE") || "release";
	const status = env("STATUS");
	const required = splitList(env("REQUIRED"));
	const reports = await readReportFile(env("REPORT_FILE"));
	const verdict = classifyRelease({ jobStatus: status, reports, required });

	const runId = env("RUN_ID");
	const runAttempt = env("RUN_ATTEMPT");
	const jobLine = [env("JOB"), runId && `run ${runId}`, runAttempt && `attempt ${runAttempt}`]
		.filter(Boolean)
		.join(" · ");
	const triggeredBy = [env("ACTOR"), env("EVENT")].filter(Boolean).join(" · ");

	const fields: Array<[label: string, value: string, kind: CellKind]> = [
		["Result", verdict.result, "plain"],
		["Job status", status, "plain"],
		["Phase", phase, "plain"],
		["Mode", env("MODE"), "code"],
		["Scope", env("SCOPE"), "plain"],
		["Job", jobLine, "code"],
		["Triggered by", triggeredBy, "plain"],
		["Source ref", env("SOURCE_REF"), "code"],
		["Image", env("IMAGE"), "code"],
		["Base image", env("BASE_IMAGE"), "code"],
		["Provider target", env("PROVIDER_TARGET"), "code"],
		["Size tier", env("SIZE_TIER"), "plain"],
		["Required providers", required.join(", "), "code"],
		["Published", env("PUBLISHED"), "code"],
		["Verify command", env("VERIFY"), "code"],
		["Elapsed", env("ELAPSED"), "plain"],
	];

	if (canWriteSummary()) {
		core.summary.addHeading(`Image release: ${escapeHtml(phase)}`, 3).addTable(fieldTable(fields));
		if (verdict.discrepancy) {
			core.summary.addRaw(`<strong>⚠ ${escapeHtml(verdict.discrepancy)}</strong>`).addEOL();
		}
		if (reports.length > 0) {
			core.summary.addHeading("Providers", 4).addTable(providerReportRows(reports, required));
		}

		const diagnostics = env("DIAGNOSTICS");
		const runUrl = env("RUN_URL");
		if (diagnostics) {
			core.summary.addRaw("Diagnostics: ", false);
			if (runUrl) core.summary.addLink(escapeHtml(diagnostics), `${runUrl}#artifacts`);
			else core.summary.addRaw(escapeHtml(diagnostics));
			core.summary.addEOL();
		}
		await core.summary.write();
	}

	const title = `Image release: ${phase} — ${verdict.result}`;
	const detail = [
		verdict.discrepancy,
		env("IMAGE") && `image=${env("IMAGE")}`,
		env("PUBLISHED") && `published=${env("PUBLISHED")}`,
	]
		.filter(Boolean)
		.join(" · ");
	const message = detail || verdict.result;
	if (verdict.kind === "failure" || verdict.discrepancy) core.error(message, { title });
	else if (verdict.kind === "warning") core.warning(message, { title });
	else core.notice(message, { title });
}
