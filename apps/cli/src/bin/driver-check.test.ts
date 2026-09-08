import { describe, expect, test } from "bun:test";
import { durableStepTimeoutMs, parseArgs, workloadScript } from "./driver-check.ts";

describe("driver-check argv", () => {
	test("defaults to the published version phase and a short workload", () => {
		expect(parseArgs(["--provider", "e2b"])).toEqual({
			provider: "e2b",
			phase: "version",
			workloadSeconds: 3,
			keep: false,
			requirePass: false,
		});
	});

	test("accepts the candidate lane, an explicit ref and --keep", () => {
		expect(
			parseArgs([
				"--provider",
				"tama",
				"--phase",
				"candidate",
				"--artifact-ref",
				"ghcr.io/x:v8",
				"--workload-seconds",
				"10",
				"--keep",
			]),
		).toEqual({
			provider: "tama",
			phase: "candidate",
			artifactRef: "ghcr.io/x:v8",
			workloadSeconds: 10,
			keep: true,
			requirePass: false,
		});
	});

	test("strict validation requires every clause and refuses retained sandboxes", () => {
		expect(parseArgs(["--provider", "e2b", "--require-pass"]).requirePass).toBe(true);
		expect(() => parseArgs(["--provider", "e2b", "--require-pass", "--keep"])).toThrow(
			/cannot be combined/,
		);
		expect(() => parseArgs(["--provider", "e2b", "--require-pas"])).toThrow(/unknown option/);
		expect(() => parseArgs(["--provider", "e2b", "--provider", "tama"])).toThrow(
			/duplicate option/,
		);
	});

	test("accepts a dedicated machine-readable report path", () => {
		expect(parseArgs(["--provider", "e2b", "--report-file", "/tmp/report.json"]).reportFile).toBe(
			"/tmp/report.json",
		);
	});

	test("rejects a provider that has no driver module yet", () => {
		// The waived providers are still on packages/providers; driving them here would silently
		// exercise the legacy path and report it as driver-path evidence.
		expect(() => parseArgs(["--provider", "daytona-vm"])).toThrow(/has no driver module/);
		expect(() => parseArgs(["--provider", "nope"])).toThrow(/has no driver module/);
	});

	test("rejects malformed flags rather than guessing", () => {
		expect(() => parseArgs([])).toThrow(/--provider is required/);
		expect(() => parseArgs(["--provider"])).toThrow(/needs a value/);
		expect(() => parseArgs(["--provider", "--keep"])).toThrow(/needs a value/);
		expect(() => parseArgs(["e2b"])).toThrow(/unexpected argument/);
		expect(() => parseArgs(["--provider", "e2b", "--phase", "beta"])).toThrow(/must be candidate/);
		expect(() => parseArgs(["--provider", "e2b", "--workload-seconds", "0"])).toThrow(
			/positive integer/,
		);
		expect(() => parseArgs(["--provider", "e2b", "--workload-seconds", "1.5"])).toThrow(
			/positive integer/,
		);
	});
});

describe("durableStepTimeoutMs", () => {
	test("never drops below the cap, so the step still routes to the detached path", () => {
		// selectTransport picks detached at `timeoutMs >= syncCapMs`; below it the check would
		// silently measure the synchronous path and report it as durable-route evidence.
		expect(durableStepTimeoutMs(60_000, 3)).toBe(60_000);
		expect(durableStepTimeoutMs(30 * 60_000, 10)).toBe(30 * 60_000);
	});

	test("always outlasts the workload, so a healthy durable route cannot time out", () => {
		// runDetached kills the step at this deadline, so a workload at or beyond the cap would
		// otherwise fail a provider that is working correctly.
		expect(durableStepTimeoutMs(60_000, 60)).toBe(90_000);
		expect(durableStepTimeoutMs(60_000, 600)).toBe(630_000);
	});

	test("the deadline exceeds the workload for every cap/workload pair", () => {
		for (const syncCapMs of [1_000, 60_000, 30 * 60_000]) {
			for (const workloadSeconds of [1, 3, 59, 60, 61, 600]) {
				expect(durableStepTimeoutMs(syncCapMs, workloadSeconds)).toBeGreaterThan(
					workloadSeconds * 1_000,
				);
				expect(durableStepTimeoutMs(syncCapMs, workloadSeconds)).toBeGreaterThanOrEqual(syncCapMs);
			}
		}
	});
});

describe("workloadScript", () => {
	test("runs for the requested duration and reports it", () => {
		const script = workloadScript(7);
		expect(script).toContain("sleep 7");
		// `set -eu` matters: without it a failing step still exits 0 and the check would pass falsely.
		expect(script.startsWith("set -eu;")).toBe(true);
	});
});
