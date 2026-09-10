import { afterAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTransport } from "@sandbox-benchmarks/schema";
import { harnessGapMarkerJson } from "@sandbox-benchmarks/schema";
import {
	collectResults,
	writeGapMarker,
	writeProviderArtifactEvidence,
	writeProviderCostEvidence,
} from "./collect.ts";
import type { SandboxHandle } from "./execute.ts";
import { MIN, StepRunner } from "./execute.ts";

const work = mkdtempSync(join(tmpdir(), "harness-collect-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Marker extraction is transport-agnostic, so run collect synchronously (uncapped) — the dumb payload
// fakes return their stdout for every command, which the detached cat-poll would misread as a done-file.
// The detached collect path is covered by execute.test.ts and end-to-end in index.test.ts.
const UNCAPPED: ProviderTransport = { streaming: false, syncCapMs: null, detachedPoll: false };
// The LogReadbackError-retry test needs the real detached path (log-file read-back is where the
// transport failure lives), so it runs capped with an fs-transport fake.
const CAPPED: ProviderTransport = { streaming: false, syncCapMs: MIN, detachedPoll: true };

// Build the exact stdout the in-sandbox collect command emits: markers around a base64'd tar of a
// benchmark-results/ directory holding the given files (name → contents).
function collectPayload(files: Record<string, string>): string {
	const src = mkdtempSync(join(tmpdir(), "harness-src-"));
	mkdirSync(join(src, "benchmark-results"), { recursive: true });
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(src, "benchmark-results", name), contents);
	}
	// Bun.spawnSync, not node:child_process — the fixture mirrors the in-sandbox collect command, and
	// the harness runs entirely on Bun's own process API.
	const tar = Bun.spawnSync(["bash", "-c", "tar -czf - benchmark-results | base64 | tr -d '\\n'"], {
		cwd: src,
	});
	if (tar.exitCode !== 0) {
		throw new Error(`fixture tar failed (${tar.exitCode}): ${tar.stderr.toString()}`);
	}
	const b64 = tar.stdout.toString();
	rmSync(src, { recursive: true, force: true });
	return `noise\n__BENCH_RESULTS_TGZ_BEGIN__\n${b64}\n__BENCH_RESULTS_TGZ_END__\ntrailing\n`;
}

function collectPayloadWithSymlinkCycle(): string {
	const src = mkdtempSync(join(tmpdir(), "harness-symlink-src-"));
	const root = join(src, "benchmark-results");
	mkdirSync(join(root, "loop"), { recursive: true });
	writeFileSync(join(root, "pts_node-web-tooling.xml"), "<xml/>");
	symlinkSync("../loop", join(root, "loop", "back"), "dir");
	const tar = Bun.spawnSync(["bash", "-c", "tar -czf - benchmark-results | base64 | tr -d '\\n'"], {
		cwd: src,
	});
	if (tar.exitCode !== 0) throw new Error(`fixture tar failed (${tar.exitCode})`);
	const payload = `__BENCH_RESULTS_TGZ_BEGIN__\n${tar.stdout.toString()}\n__BENCH_RESULTS_TGZ_END__\n`;
	rmSync(src, { recursive: true, force: true });
	return payload;
}

function collectPayloadWithPtsSymlinkEscape(): string {
	const src = mkdtempSync(join(tmpdir(), "harness-symlink-src-"));
	const root = join(src, "benchmark-results");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(src, "outside.xml"), "<forged/>");
	symlinkSync("../outside.xml", join(root, "pts_node-web-tooling.xml"), "file");
	const tar = Bun.spawnSync(["bash", "-c", "tar -czf - benchmark-results | base64 | tr -d '\\n'"], {
		cwd: src,
	});
	if (tar.exitCode !== 0) throw new Error(`fixture tar failed (${tar.exitCode})`);
	const payload = `__BENCH_RESULTS_TGZ_BEGIN__\n${tar.stdout.toString()}\n__BENCH_RESULTS_TGZ_END__\n`;
	rmSync(src, { recursive: true, force: true });
	return payload;
}

function payloadSandbox(files: Record<string, string>): SandboxHandle {
	return {
		runCommand: async () => ({ exitCode: 0, stdout: collectPayload(files) }),
		destroy: async () => undefined,
	};
}

const sandbox = payloadSandbox({ "pts_node-web-tooling.xml": "<xml/>" });

describe("collectResults", () => {
	it("extracts the base64 tar stream into the results directory", async () => {
		const resultsDir = join(work, "daytona");
		await collectResults(new StepRunner(sandbox, UNCAPPED), resultsDir);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(true);
		expect(readFileSync(join(resultsDir, "pts_node-web-tooling.xml"), "utf8")).toBe("<xml/>");
	});

	it("rejects forged sandbox cost evidence before it can reach the host raw tree", async () => {
		const resultsDir = join(work, "forged-cost-evidence");
		const forged = payloadSandbox({
			"pts_node-web-tooling.xml": "<xml/>",
			"provider-cost-evidence.json": '{"kind":"observed","amount":0}',
		});
		await expect(collectResults(new StepRunner(forged, UNCAPPED), resultsDir)).rejects.toThrow(
			/reserved host-owned file provider-cost-evidence\.json/,
		);
		expect(existsSync(join(resultsDir, "provider-cost-evidence.json"))).toBe(false);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(false);
	});

	for (const name of ["execution-forged.json", "cleanup-forged.json"]) {
		it(`rejects sandbox-forged ${name}`, async () => {
			const resultsDir = join(work, name);
			const forged = payloadSandbox({
				"pts_node-web-tooling.xml": "<xml/>",
				[name]: '{"completed":true}',
			});
			await expect(collectResults(new StepRunner(forged, UNCAPPED), resultsDir)).rejects.toThrow(
				"reserved host-owned file",
			);
			expect(existsSync(join(resultsDir, name))).toBe(false);
		});
	}

	it("rejects forged sandbox artifact evidence before it can replace host attribution", async () => {
		const resultsDir = join(work, "forged-artifact-evidence");
		const forged = payloadSandbox({
			"pts_node-web-tooling.xml": "<xml/>",
			"provider-artifact-evidence.json": '{"provenance":{"source":"guest-fingerprint"}}',
		});
		await expect(collectResults(new StepRunner(forged, UNCAPPED), resultsDir)).rejects.toThrow(
			/reserved host-owned file provider-artifact-evidence\.json/,
		);
		expect(existsSync(join(resultsDir, "provider-artifact-evidence.json"))).toBe(false);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(false);
	});

	it("rejects a directory symlink cycle rather than following or preserving it", async () => {
		const resultsDir = join(work, "symlink-cycle");
		const cyclic: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: collectPayloadWithSymlinkCycle() }),
			destroy: async () => undefined,
		};
		await expect(collectResults(new StepRunner(cyclic, UNCAPPED), resultsDir)).rejects.toThrow(
			/forbidden symbolic link/,
		);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(false);
	});

	it("rejects a recognized PTS result symlink that escapes the collected tree", async () => {
		const resultsDir = join(work, "pts-symlink-escape");
		const escaped: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: collectPayloadWithPtsSymlinkEscape() }),
			destroy: async () => undefined,
		};
		await expect(collectResults(new StepRunner(escaped, UNCAPPED), resultsDir)).rejects.toThrow(
			/forbidden symbolic link pts_node-web-tooling\.xml/,
		);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(false);
	});

	it("accepts a results tree whose only signal is a skip marker", async () => {
		const resultsDir = join(work, "skip-only");
		const skipped = payloadSandbox({
			"pts_node-web-tooling--skipped.json": '{"skipped":true,"benchmark":"pts_node-web-tooling"}',
			"manifest.ndjson": "{}\n",
		});
		await collectResults(new StepRunner(skipped, UNCAPPED), resultsDir);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling--skipped.json"))).toBe(true);
	});

	it("accepts a results tree whose only signal is a FAILURE marker", async () => {
		// The guard keys on the filename, so it has to recognise BOTH marker suffixes: a suite that ran and
		// crashed reports a `--failed.json` and nothing else, and rejecting that as "no usable output" would
		// throw away the one file that says what went wrong.
		const resultsDir = join(work, "fail-only");
		const failed = payloadSandbox({
			"sandbox-daytona-cpu-node--failed.json":
				'{"provider":"daytona","suite":"cpu-node","outcome":"failed","reason":"PTS died"}',
			"manifest.ndjson": "{}\n",
		});
		await collectResults(new StepRunner(failed, UNCAPPED), resultsDir);
		expect(existsSync(join(resultsDir, "sandbox-daytona-cpu-node--failed.json"))).toBe(true);
	});

	it("throws when the collected tree has no PTS result or gap marker (silent data loss)", async () => {
		// A suite that produced only provenance/timing files and neither a result nor a marker must
		// fail collection, not upload an empty-of-signal directory as a green run.
		const empty = payloadSandbox({ "manifest.ndjson": "{}\n", "cpu-info.json": "{}" });
		await expect(
			collectResults(new StepRunner(empty, UNCAPPED), join(work, "no-signal")),
		).rejects.toThrow(/no PTS result or gap marker/);
	});

	it("retries the collect step on a marker miss and succeeds when a later attempt delivers", async () => {
		// Regression: collect was single-attempt, so ONE transient read-back failure (empty stdout from
		// an alive sandbox — Blaxel, 2026-07-19) permanently discarded a completed suite's results even
		// though re-running the idempotent tar|base64 step would have succeeded.
		let calls = 0;
		const payload = collectPayload({ "pts_node-web-tooling.xml": "<xml/>" });
		const flaky: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: ++calls === 1 ? "" : payload }),
			destroy: async () => undefined,
		};
		const resultsDir = join(work, "flaky");
		await collectResults(new StepRunner(flaky, UNCAPPED), resultsDir);
		expect(calls).toBe(2);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(true);
	});

	it("throws the transport-failure diagnosis when every attempt returns empty stdout", async () => {
		let calls = 0;
		const empty: SandboxHandle = {
			runCommand: async () => {
				calls++;
				return { exitCode: 0, stdout: "" };
			},
			destroy: async () => undefined,
		};
		await expect(
			collectResults(new StepRunner(empty, UNCAPPED), join(work, "empty-stdout")),
		).rejects.toThrow(/markers.*transport failure/s);
		// Every attempt in the retry budget was spent before giving up.
		expect(calls).toBe(3);
	});

	it("retries when the completed step's log read-back itself failed (LogReadbackError)", async () => {
		// The transport-failure THROW from readCompletedLog must be retryable here — the transports
		// can recover between attempts (the Blaxel shape) — while command failures and timeouts still
		// propagate. First collect: every fs read fails AND the exec cat fails (exit 1, which must
		// surface as failure, not as an empty successful read) -> LogReadbackError. Second collect:
		// the fs API has recovered and delivers the payload.
		const READBACK_ATTEMPTS = 5; // mirrors execute.ts — first collect burns exactly this many fs reads
		let logReads = 0;
		const payload = collectPayload({ "pts_node-web-tooling.xml": "<xml/>" });
		const flakyFs: SandboxHandle = {
			runCommand: async (command: string) => {
				if (command.includes("cat ")) return { exitCode: 1, stdout: "" };
				return { exitCode: 0, stdout: "launched" };
			},
			destroy: async () => undefined,
			filesystem: {
				exists: async (path) => path.endsWith(".done"),
				readFile: async (path) => {
					if (path.endsWith(".done")) return `v1 ${path.split("/")[2]} 0`;
					if (++logReads <= READBACK_ATTEMPTS) throw new Error("fs API down");
					return payload;
				},
			},
		};
		const resultsDir = join(work, "flaky-readback");
		await collectResults(new StepRunner(flakyFs, CAPPED, async () => undefined), resultsDir);
		expect(logReads).toBeGreaterThan(READBACK_ATTEMPTS);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(true);
	});

	it("throws the truncation diagnosis when stdout is non-empty but markerless", async () => {
		// A payload that came back but lost its markers is a different failure (truncated/malformed
		// payload) from one that never came back at all — the error must not conflate them.
		const noMarkers: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: "no markers here" }),
			destroy: async () => undefined,
		};
		await expect(
			collectResults(new StepRunner(noMarkers, UNCAPPED), join(work, "x")),
		).rejects.toThrow(/markers.*truncated or malformed/s);
	});

	it("retries when a marker-bounded payload fails to extract, then succeeds", async () => {
		// A payload that arrived WITH both markers but is corrupt mid-stream (a cut that still landed
		// END) must be retried like a marker miss — decode + tar extract live inside the retry boundary,
		// so the idempotent re-collect can deliver an intact tar rather than aborting the suite on the
		// host-side tar failure.
		let calls = 0;
		const good = collectPayload({ "pts_node-web-tooling.xml": "<xml/>" });
		const corrupt = "noise\n__BENCH_RESULTS_TGZ_BEGIN__\nZZZnotarZZZ\n__BENCH_RESULTS_TGZ_END__\n";
		const flaky: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: ++calls === 1 ? corrupt : good }),
			destroy: async () => undefined,
		};
		const resultsDir = join(work, "corrupt-then-good");
		await collectResults(new StepRunner(flaky, UNCAPPED), resultsDir);
		expect(calls).toBe(2);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(true);
	});

	it("does not retry a valid tree that simply has no PTS result or marker (deterministic)", async () => {
		// The content gate is deterministic: a re-collect of the same in-sandbox tree can't conjure a
		// result, so it must fail on the FIRST attempt rather than burn the whole retry budget on a
		// re-run that cannot change the outcome.
		let calls = 0;
		const empty: SandboxHandle = {
			runCommand: async () => {
				calls++;
				return { exitCode: 0, stdout: collectPayload({ "manifest.ndjson": "{}\n" }) };
			},
			destroy: async () => undefined,
		};
		await expect(
			collectResults(new StepRunner(empty, UNCAPPED), join(work, "no-signal-once")),
		).rejects.toThrow(/no PTS result or gap marker/);
		expect(calls).toBe(1);
	});
});

describe("writeGapMarker", () => {
	it("atomically writes validated provider artifact evidence bytes", () => {
		const dir = join(work, "artifact-evidence");
		writeProviderArtifactEvidence(dir, {
			cell: { runId: "run-1", providerId: "e2b", suite: "cpu-node" },
			sandboxId: "sb-1",
			provenance: {
				source: "request-fallback",
				requested: { kind: "baked", ref: "sandbox-benchmarks-toolchain-v8" },
			},
		});
		const path = join(dir, "provider-artifact-evidence.json");
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
			cell: { runId: "run-1", providerId: "e2b", suite: "cpu-node" },
			provenance: { source: "request-fallback" },
		});
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("atomically writes validated provider cost evidence bytes", () => {
		const dir = join(work, "cost-evidence");
		writeProviderCostEvidence(dir, {
			kind: "missing",
			cell: { runId: "run-1", providerId: "modal-gvisor", suite: "cpu-node" },
			subject: { kind: "sandbox", sandboxId: "sb-1" },
			capturedAt: "2026-08-08T00:00:00.000Z",
			sdk: { packageName: "modal", version: "0.7.6" },
			reason: "unsupported_public_api",
			detail: "No public sandbox usage endpoint.",
		});
		const path = join(dir, "provider-cost-evidence.json");
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ kind: "missing" });
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
	it("writes the harness skip marker the normalizer reads", () => {
		const dir = join(work, "skip");
		writeGapMarker(dir, "daytona", "cpu-node", "skipped", "Missing credentials");
		// Pin the exact bytes, not just a shape: the producer/harness/normalizer share
		// harnessGapMarkerJson as the single source of truth, so a key-order or newline drift here
		// would silently break the cross-package contract.
		expect(readFileSync(join(dir, "sandbox-daytona-cpu-node--skipped.json"), "utf8")).toBe(
			harnessGapMarkerJson("daytona", "cpu-node", "skipped", "Missing credentials"),
		);
	});

	it("writes a FAILED marker to its own filename, so the outcome survives in the name alone", () => {
		// The suffix is what the collector's "did this suite report anything?" guard and the extractor both
		// key on, so a crash and a deliberate skip must not land in the same file. A failure recorded as a
		// skip would publish an outage as a decision we made.
		const dir = join(work, "fail");
		writeGapMarker(dir, "daytona", "cpu-node", "failed", "PTS produced no pts_*.xml");
		expect(readFileSync(join(dir, "sandbox-daytona-cpu-node--failed.json"), "utf8")).toBe(
			harnessGapMarkerJson("daytona", "cpu-node", "failed", "PTS produced no pts_*.xml"),
		);
		expect(existsSync(join(dir, "sandbox-daytona-cpu-node--skipped.json"))).toBe(false);
	});
});
