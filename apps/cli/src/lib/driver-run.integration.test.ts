import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverModule, ExecResult, SandboxSession } from "@sandbox-benchmarks/driver";
import {
	driverReadinessBudgetMs,
	verifyDriverReadiness,
} from "@sandbox-benchmarks/driver/conformance";
import e2bModule from "@sandbox-benchmarks/e2b";
import { runSuiteOnSandbox } from "@sandbox-benchmarks/harness";
import { writeNormalizedRun } from "@sandbox-benchmarks/results";
import type { ProviderId, Suite } from "@sandbox-benchmarks/schema";
import { bakedArtifactName } from "@sandbox-benchmarks/schema";
import { TOOLCHAIN_IMAGE_NAME, TOOLCHAIN_VERSION } from "@sandbox-benchmarks/schema/toolchain";
import { driverTransport, runDriverSuite, sessionHandle } from "./driver-run.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "driver-bench-spike-"));
	roots.push(root);
	return root;
}

function exited(stdout = ""): ExecResult {
	return {
		exit: { kind: "exited", code: 0 },
		stdout,
		stderr: "",
		durationMs: 1,
		truncated: false,
	};
}

describe("DriverModule benchmark path", () => {
	test("records a structured credential gap without loading or falling back", async () => {
		const resultsDir = join(freshRoot(), "e2b", "cpu-node");
		await runDriverSuite({
			runId: "driver-spike-missing-env",
			providerName: "e2b",
			suiteName: "cpu-node",
			resultsDir,
			env: {},
		});

		expect(
			JSON.parse(readFileSync(join(resultsDir, "sandbox-e2b-cpu-node--skipped.json"), "utf8")),
		).toEqual({
			provider: "e2b",
			suite: "cpu-node",
			outcome: "skipped",
			reason: "Missing credentials: E2B_API_KEY",
			cause: { kind: "missing-credentials", variables: ["E2B_API_KEY"] },
		});
	});

	test("preserves a construction failure when its gap marker cannot be written", async () => {
		const resultsDir = join(freshRoot(), "occupied");
		writeFileSync(resultsDir, "not a directory");
		const constructionError = new Error("driver env became unreadable");
		let reads = 0;
		const env = Object.defineProperty({} as Record<string, string | undefined>, "E2B_API_KEY", {
			get() {
				reads += 1;
				if (reads === 1) return "e2b_test";
				throw constructionError;
			},
		});
		const logged: string[] = [];
		const originalError = console.error;
		console.error = (...values: unknown[]) => logged.push(values.map(String).join(" "));
		try {
			await expect(
				runDriverSuite({
					runId: "driver-spike-marker-failure",
					providerName: "e2b",
					suiteName: "cpu-node",
					resultsDir,
					env,
				}),
			).rejects.toBe(constructionError);
		} finally {
			console.error = originalError;
		}
		expect(logged.join("\n")).toContain("driver-construction error below is unaffected");
		expect(readFileSync(resultsDir, "utf8")).toBe("not a directory");
	});

	test("rejects an unmigrated provider instead of falling back to packages/providers", async () => {
		await expect(
			runDriverSuite({
				runId: "driver-spike-no-fallback",
				providerName: "runcloud",
				suiteName: "cpu-node",
				resultsDir: freshRoot(),
				env: { DAYTONA_API_KEY: "must-not-be-used" },
			}),
		).rejects.toThrow(/runcloud has no DriverModule/);
	});

	test("persists verified E2B artifact evidence and normalizes a valid Run v6", async () => {
		const root = freshRoot();
		const rawRoot = join(root, "raw");
		const resultsDir = join(rawRoot, "e2b", "cpu-node");
		const artifact = { kind: "baked", ref: bakedArtifactName("e2b", "version") } as const;
		const commands: string[] = [];
		let destroyed = false;
		const session: SandboxSession = {
			sandboxRef: { provider: "e2b", id: "isandbox1" },
			artifact,
			native: {},
			async exec(command) {
				commands.push(command);
				if (command.includes("/toolchain-manifest.json")) {
					return exited(
						JSON.stringify({
							image_name: TOOLCHAIN_IMAGE_NAME,
							image_version: TOOLCHAIN_VERSION,
						}),
					);
				}
				// Force a deliberate precondition skip after readiness and fingerprinting. That keeps the
				// fixture cheap while still producing a complete, attributable Run v6 provider row.
				if (command.includes("df -Pk")) return exited("1\n");
				return exited();
			},
			async destroy() {
				destroyed = true;
			},
		};
		const suite: Suite = {
			setupPts: false,
			commandTimeoutMinutes: 1,
			timeoutMinutes: 1,
			minDiskGb: 1,
			ptsTimesToRun: 1,
			defaultReplicas: 1,
			dimensions: ["cpu"],
			metrics: ["node_web_tooling_runs_per_s"],
			commands: [],
		};

		await runSuiteOnSandbox(sessionHandle(session), {
			runId: "driver-spike-1",
			suite,
			suiteName: "cpu-node",
			providerName: "e2b",
			artifact,
			resultsDir,
			transport: driverTransport(e2bModule.execution),
			driverReadiness: {
				timeoutMs: driverReadinessBudgetMs(e2bModule as DriverModule<ProviderId>),
				verify: async ({ signal }) => {
					// The composition root performs this same one-time handle erasure after the generated
					// loader has proved that the selected module and provider id agree.
					const module = e2bModule as DriverModule<ProviderId>;
					const result = await verifyDriverReadiness(module, session, { signal });
					return { ready: result.status === "pass", detail: result.detail };
				},
			},
		});

		const run = writeNormalizedRun({
			rawRoot,
			runId: "driver-spike-1",
			sha: "local",
			outFile: join(root, "run.json"),
		});
		const e2b = run.providers.find((provider) => provider.providerId === "e2b");
		expect(run.schemaVersion).toBe("6");
		expect(e2b?.artifactEvidence).toEqual([
			expect.objectContaining({
				cell: { runId: "driver-spike-1", providerId: "e2b", suite: "cpu-node" },
				sandboxId: "isandbox1",
				provenance: expect.objectContaining({ source: "guest-fingerprint", requested: artifact }),
			}),
		]);
		expect(e2b?.gaps).toEqual([
			expect.objectContaining({
				id: "cpu-node",
				outcome: "skipped",
				cause: { kind: "disk-shortfall", freeGb: expect.any(Number), requiredGb: 1 },
			}),
		]);
		expect(commands).toContain("sh -c 'exit 0'");
		expect(commands).not.toContain("echo ok");
		expect(destroyed).toBe(true);
	});
});
