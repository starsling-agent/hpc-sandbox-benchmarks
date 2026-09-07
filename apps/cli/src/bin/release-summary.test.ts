import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyRelease,
	escapeHtml,
	isFailure,
	readReportFile,
	readReports,
	renderCell,
} from "./release-summary.ts";

const REQUIRED = ["e2b", "daytona-vm", "modal-gvisor"];

describe("isFailure", () => {
	// Both spellings are in circulation (GitHub's job.status says `failure`; the bake report and the
	// composite's documented vocabulary say `failed`). Matching only one renders a FAILED phase as a
	// green notice — the exact way a broken release looks healthy.
	test("treats both `failure` and `failed` as failure", () => {
		expect(isFailure("failure")).toBe(true);
		expect(isFailure("failed")).toBe(true);
		expect(isFailure("FAILED")).toBe(true);
		expect(isFailure(" failure ")).toBe(true);
	});

	test("does not treat a success/skip status as failure", () => {
		expect(isFailure("success")).toBe(false);
		expect(isFailure("ok")).toBe(false);
		expect(isFailure("skipped")).toBe(false);
		expect(isFailure("")).toBe(false);
	});
});

describe("escapeHtml", () => {
	test("escapes the HTML metacharacters so a value can't inject into the summary table", () => {
		expect(escapeHtml("<img src=x onerror=alert(1)> & \"ok\" 'x'")).toBe(
			"&lt;img src=x onerror=alert(1)&gt; &amp; &quot;ok&quot; &#39;x&#39;",
		);
	});

	test("escapes & before < > so an entity can't be double-decoded", () => {
		expect(escapeHtml("a & <b>")).toBe("a &amp; &lt;b&gt;");
	});
});

describe("renderCell", () => {
	test("wraps code values in <code> after escaping", () => {
		expect(renderCell("ghcr.io/x@sha256:ab", "code")).toBe("<code>ghcr.io/x@sha256:ab</code>");
	});

	test("leaves plain prose unwrapped (still escaped)", () => {
		expect(renderCell("2 vCPU / 8 GiB", "plain")).toBe("2 vCPU / 8 GiB");
		expect(renderCell("<b>", "plain")).toBe("&lt;b&gt;");
	});
});

describe("classifyRelease", () => {
	test("the run 29896891577 promote: green job, best-effort daytona-container failed → warning, no discrepancy", () => {
		// After the exit-code fix this promote job is GREEN (it published :v5). The summary must still make
		// the daytona-container failure obvious at a glance — a warning result, not a silent success.
		const v = classifyRelease({
			jobStatus: "success",
			reports: [
				{ provider: "e2b", status: "ok" },
				{ provider: "daytona-vm", status: "ok" },
				{ provider: "daytona-container", status: "failed" },
				{ provider: "modal-gvisor", status: "ok" },
				{ provider: "image", status: "ok" },
			],
			required: REQUIRED,
		});
		expect(v.kind).toBe("warning");
		expect(v.result).toBe("Passed with non-blocking failure(s): daytona-container");
		expect(v.blocking).toEqual([]);
		expect(v.nonBlocking).toEqual(["daytona-container"]);
		expect(v.discrepancy).toBeUndefined();
	});

	test("a required provider failure → failure result naming the blocker", () => {
		const v = classifyRelease({
			jobStatus: "failure",
			reports: [
				{ provider: "e2b", status: "ok" },
				{ provider: "daytona-vm", status: "failed" },
			],
			required: REQUIRED,
		});
		expect(v.kind).toBe("failure");
		expect(v.result).toBe("Failed — blocking: daytona-vm");
		expect(v.discrepancy).toBeUndefined();
	});

	test("the `image` commit-point failure blocks even though it is not a required provider", () => {
		const v = classifyRelease({
			jobStatus: "failure",
			reports: [{ provider: "image", status: "failed", reason: "v5 already exists" } as never],
			required: REQUIRED,
		});
		expect(v.kind).toBe("failure");
		expect(v.result).toBe("Failed — blocking: image");
	});

	test("green-but-failed: job status GREEN but a blocking failure recorded → escalates with a discrepancy banner", () => {
		const v = classifyRelease({
			jobStatus: "success",
			reports: [{ provider: "daytona-vm", status: "failed" }],
			required: REQUIRED,
		});
		expect(v.kind).toBe("failure");
		expect(v.discrepancy).toContain("GREEN but a blocking outcome");
	});

	test("a required provider skip is blocking, even when the raw job status is green", () => {
		const verdict = classifyRelease({
			jobStatus: "success",
			reports: [{ provider: "e2b", status: "skipped" }],
			required: REQUIRED,
		});
		expect(verdict).toMatchObject({
			kind: "failure",
			result: "Failed — blocking: e2b",
			blocking: ["e2b"],
		});
		expect(verdict.discrepancy).toContain("GREEN but a blocking outcome");
	});

	test("red-but-nothing-failed: job failed with no blocking report → points outside the provider reports", () => {
		const v = classifyRelease({
			jobStatus: "failure",
			reports: [{ provider: "e2b", status: "ok" }],
			required: REQUIRED,
		});
		expect(v.kind).toBe("failure");
		expect(v.discrepancy).toContain("outside the provider reports");
	});

	test("all clean → OK; a skip is noted but not a failure", () => {
		expect(
			classifyRelease({
				jobStatus: "success",
				reports: [
					{ provider: "e2b", status: "ok" },
					{ provider: "blaxel", status: "skipped" },
				],
				required: REQUIRED,
			}),
		).toMatchObject({ kind: "ok", result: "OK (skipped: blaxel)" });
	});

	test("no report (plan/build phase) → mirrors the raw job status", () => {
		expect(classifyRelease({ jobStatus: "success", reports: [], required: [] }).result).toBe("OK");
		expect(classifyRelease({ jobStatus: "failure", reports: [], required: [] })).toMatchObject({
			kind: "failure",
			result: "Failed (failure)",
			discrepancy: undefined,
		});
	});

	test("a cancelled job is never summarized as OK", () => {
		expect(classifyRelease({ jobStatus: "cancelled", reports: [], required: [] })).toMatchObject({
			kind: "failure",
			result: "Cancelled",
		});
		expect(
			classifyRelease({
				jobStatus: "cancelled",
				reports: [{ provider: "e2b", status: "ok" }],
				required: REQUIRED,
			}),
		).toMatchObject({
			kind: "failure",
			result: "Cancelled — no blocking provider outcome recorded; check the step log",
		});
	});
});

describe("readReports", () => {
	test("extracts a well-formed reports array from a promote/bake payload", () => {
		const json = JSON.stringify({
			version: { image: "x" },
			reports: [
				{ provider: "e2b", status: "ok", durationMs: 12061 },
				{ provider: "daytona-container", status: "failed", reason: "No runners…" },
			],
		});
		expect(readReports(json)).toEqual([
			{ provider: "e2b", status: "ok", durationMs: 12061 },
			{ provider: "daytona-container", status: "failed", reason: "No runners…" },
		]);
	});

	test("tolerates absence and malformed input (metadata still renders)", () => {
		expect(readReports(undefined)).toEqual([]);
		expect(readReports("")).toEqual([]);
		expect(readReports("not json")).toEqual([]);
		expect(readReports(JSON.stringify({ candidate: {} }))).toEqual([]);
		// Drops entries missing the provider/status contract rather than throwing.
		expect(
			readReports(JSON.stringify({ reports: [{ provider: "e2b" }, { status: "ok" }] })),
		).toEqual([]);
	});

	test("drops malformed optional fields instead of letting rendering throw", () => {
		expect(
			readReports(
				JSON.stringify({
					reports: [
						{ provider: "e2b", status: "failed", reason: { nested: true }, durationMs: "slow" },
					],
				}),
			),
		).toEqual([{ provider: "e2b", status: "failed" }]);
	});
});

describe("readReportFile", () => {
	test("falls back to an empty report for missing and malformed files", async () => {
		const missing = join(tmpdir(), `missing-release-report-${crypto.randomUUID()}.json`);
		expect(await readReportFile(missing)).toEqual([]);

		const malformed = join(tmpdir(), `malformed-release-report-${crypto.randomUUID()}.json`);
		try {
			await Bun.write(malformed, "{not-json");
			expect(await readReportFile(malformed)).toEqual([]);
		} finally {
			await rm(malformed, { force: true });
		}
	});
});
