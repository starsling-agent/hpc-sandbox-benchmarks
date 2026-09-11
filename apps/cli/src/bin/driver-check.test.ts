import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableStepTimeoutMs, parseArgs, workloadScript } from "./driver-check.ts";

const CLI = join(import.meta.dir, "driver-check.ts");

/**
 * Drive the bin as a subprocess with every E2B variable stripped, so `openDriver` skips on
 * missing credentials and no sandbox is ever allocated by a unit test — including on the
 * CI-with-secrets lanes, where the ambient key would otherwise make this hit the real control plane.
 */
async function runCli(...args: string[]) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("E2B_")),
	);
	// `--env-file=/dev/null`: Bun otherwise loads the repo-root `.env` into the child regardless of
	// the filtered `env` above, and a developer's real E2B_API_KEY turned this credentials-skip test
	// into a live create + teardown on every local `bun run test`.
	const proc = Bun.spawn(["bun", "--env-file=/dev/null", CLI, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

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

	test("rejects an unregistered provider", () => {
		expect(parseArgs(["--provider", "namespace"]).provider).toBe("namespace");
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

describe("report emission", () => {
	// `exitAfterSandboxCleanup` is the only thing that retries a sandbox whose `destroy` already
	// failed during the run. An unguarded write threw past it as an unhandled rejection — `beforeExit`
	// does not fire on that path — so an unwritable `--report-file` leaked a billable sandbox.
	test("an unwritable report path is diagnosed and never escapes past cleanup", async () => {
		const unwritable = join(tmpdir(), "driver-check-no-such-dir", "report.json");
		const { stderr, exitCode } = await runCli(
			"--provider",
			"e2b",
			"--report-file",
			unwritable,
			"--workload-seconds",
			"1",
		);

		// The skip proves no sandbox was created, so this exercises the emit guard in isolation.
		expect(stderr).toContain("missing-credentials");
		expect(stderr).toContain("could not emit the report");
		// The crash banner is the regression: it means the throw escaped instead of being folded in.
		expect(stderr).not.toContain("Bun v");
		expect(exitCode).toBe(1);
	});

	test("a writable report path receives the report and exits on the checks alone", async () => {
		const directory = mkdtempSync(join(tmpdir(), "driver-check-report-"));
		const reportFile = join(directory, "report.json");
		try {
			const { stdout, stderr, exitCode } = await runCli(
				"--provider",
				"e2b",
				"--report-file",
				reportFile,
				"--workload-seconds",
				"1",
			);

			// The guard must not swallow a write that succeeded: the file is the deliverable, and CI
			// consumes it as the artifact for this lane.
			expect(stderr).not.toContain("could not emit the report");
			expect(JSON.parse(readFileSync(reportFile, "utf8"))).toMatchObject({
				provider: "e2b",
				phase: "version",
				workloadSeconds: 1,
				checks: [{ name: "resolve", status: "skip" }],
			});
			// --report-file redirects the report off stdout so provider chatter cannot corrupt it.
			expect(stdout).toBe("");
			// Skips are not failures without --require-pass, so a clean emit leaves the lane green.
			expect(exitCode).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
