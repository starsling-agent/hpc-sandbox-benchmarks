import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectProvider, ProviderConfig } from "@sandbox-benchmarks/providers";
import { markRetryableCreate } from "@sandbox-benchmarks/providers";
import type { ProviderCostEvidence, Suite } from "@sandbox-benchmarks/schema";
import {
	bakedArtifactName,
	parseGapMarker,
	parseProviderArtifactEvidence,
	sandboxFailureMarkerFile,
} from "@sandbox-benchmarks/schema";
import type { SuiteRunContext } from "./index.ts";
import {
	benchmarkLifecycle,
	benchmarkLifecycleCompute,
	createSuiteSandbox,
	createSuiteSandboxFromPlan,
	hasRequiredCreds,
	missingCreds,
	requiredProviders,
	runSuite,
	runSuiteOnSandbox,
	SuiteUsageError,
	timeOperation,
	unmetRequirements,
	withSandbox,
} from "./index.ts";
import type { CommandResult, SandboxHandle } from "./lib/execute.ts";
import type { LifecycleCompute } from "./lib/lifecycle.ts";
import { READINESS_CMD } from "./lib/readiness.ts";
import { cleanupOwnedSandboxes } from "./lib/sandbox-owner.ts";

// A transport capability for the test fixtures — capped-with-detach, matching a single-round-trip
// provider; none of these tests exercise real exec, so the exact values are inert here.
const fixtureTransport = { streaming: false, syncCapMs: 60_000, detachedPoll: true } as const;

// timeOperation only reads identity, never calls createCompute — a throwing stub keeps this unit
// test free of any real SDK while staying fully typed.
const config: ProviderConfig = {
	name: "e2b",
	artifact: { kind: "baked", ref: "test-template" },
	requiredEnvVars: [],
	transport: fixtureTransport,
	createCompute: () => {
		throw new Error("not exercised");
	},
};

// A fake provider that records its lifecycle calls, so withSandbox can be exercised offline with no
// real SDK. Only the methods withSandbox touches are implemented; the cast recovers the full type.
function fakeProvider(calls: string[], opts: { destroyFails?: boolean } = {}): ProviderConfig {
	let remainingDestroyFailures = opts.destroyFails ? 1 : 0;
	const sandbox = {
		sandboxId: "sb-1",
		provider: "e2b",
		runCommand: (cmd: string) => {
			calls.push(`run:${cmd}`);
			return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
		},
		destroy: () => {
			calls.push("destroy");
			if (remainingDestroyFailures > 0) {
				remainingDestroyFailures--;
				return Promise.reject(new Error("destroy failed"));
			}
			return Promise.resolve();
		},
	};
	const compute = {
		sandbox: {
			create: () => {
				calls.push("create");
				return Promise.resolve(sandbox);
			},
		},
	} as unknown as DirectProvider;
	return {
		name: "e2b",
		artifact: { kind: "baked", ref: "test-template" },
		requiredEnvVars: [],
		transport: fixtureTransport,
		createCompute: () => compute,
	};
}

afterEach(async () => {
	expect(await cleanupOwnedSandboxes()).toEqual([]);
});

describe("@sandbox-benchmarks/harness", () => {
	it("times an operation and emits a raw run for the provider", async () => {
		const run = await timeOperation(config, "spawn", () => {});
		expect(run.provider).toBe("e2b");
		expect(run.operation).toBe("spawn");
		expect(run.durationMs).toBeGreaterThan(0);
	});

	it("withSandbox creates, runs the body, then destroys", async () => {
		const calls: string[] = [];
		const out = await withSandbox(fakeProvider(calls), async (sb) => {
			await sb.runCommand("echo hi");
			return "result";
		});
		expect(out).toBe("result");
		expect(calls).toEqual(["create", "run:echo hi", "destroy"]);
	});

	it("withSandbox destroys even when the body throws", async () => {
		const calls: string[] = [];
		await expect(
			withSandbox(fakeProvider(calls), async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(calls).toEqual(["create", "destroy"]);
	});

	it("withSandbox surfaces the body error, not a teardown error, when both fail", async () => {
		const calls: string[] = [];
		// destroy also rejects — the original "boom" must win so the root cause isn't masked, and
		// destroy must be attempted exactly once (no double-teardown).
		await expect(
			withSandbox(fakeProvider(calls, { destroyFails: true }), async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(calls).toEqual(["create", "destroy"]);
	});

	it("withSandbox surfaces a teardown failure on the success path", async () => {
		const calls: string[] = [];
		// fn succeeded but destroy fails — a leaked sandbox is worth failing on, so it surfaces.
		await expect(
			withSandbox(fakeProvider(calls, { destroyFails: true }), async () => "ok"),
		).rejects.toThrow("destroy failed");
		expect(calls).toEqual(["create", "destroy"]);
	});

	// Named "modal-gvisor", so it carries modal's real (uncapped) transport rather than the capped
	// fixtureTransport — these creds tests never read transport, but keeping the fixture faithful to
	// the name stops a future transport-aware test from exercising E2B/Daytona semantics under a
	// modal-named config.
	const credsCfg: ProviderConfig = {
		name: "modal-gvisor",
		artifact: { kind: "image", ref: "test-image" },
		requiredEnvVars: ["A", "B"],
		transport: { streaming: false, syncCapMs: null, detachedPoll: true },
		createCompute: () => {
			throw new Error("not exercised");
		},
	};

	it("missingCreds lists the required vars that are unset or empty", () => {
		expect(missingCreds(credsCfg, { A: "1", B: "2" })).toEqual([]);
		expect(missingCreds(credsCfg, { A: "1", B: "" })).toEqual(["B"]);
		expect(missingCreds(credsCfg, {})).toEqual(["A", "B"]);
	});

	it("hasRequiredCreds is true only when every required var is present and non-empty", () => {
		expect(hasRequiredCreds(credsCfg, { A: "1", B: "2" })).toBe(true);
		expect(hasRequiredCreds(credsCfg, { A: "1", B: "" })).toBe(false);
		expect(hasRequiredCreds(credsCfg, { A: "1" })).toBe(false);
		expect(hasRequiredCreds({ ...credsCfg, requiredEnvVars: [] }, {})).toBe(true);
	});

	it("requiredProviders parses --require, --require=, and the env fallback (empty by default)", () => {
		expect(requiredProviders([], {})).toEqual([]);
		expect(requiredProviders(["--require", "e2b,daytona,modal"], {})).toEqual([
			"e2b",
			"daytona",
			"modal",
		]);
		expect(requiredProviders(["--require=e2b, daytona"], {})).toEqual(["e2b", "daytona"]);
		// A bare --require with no value falls through to the env var rather than swallowing the next flag.
		expect(requiredProviders(["--require", "--other"], { REQUIRE_PROVIDERS: "modal" })).toEqual([
			"modal",
		]);
		// CLI takes precedence over env.
		expect(requiredProviders(["--require", "e2b"], { REQUIRE_PROVIDERS: "modal" })).toEqual([
			"e2b",
		]);
	});

	// A lifecycle-capable fake provider: createCompute returns a structural LifecycleCompute (cast to the
	// SDK's DirectProvider, as the real adapters do), letting benchmarkLifecycle run with no real SDK.
	function lifecycleConfig(
		opts: { withSnapshot?: boolean; withList?: boolean; failCreateOnCycle?: number } = {},
	): ProviderConfig {
		let created = 0;
		const sandbox = {
			create: async () => {
				const cycle = ++created;
				if (cycle === opts.failCreateOnCycle) throw new Error("spawn boom");
				return {
					sandboxId: `sb-${cycle}`,
					runCommand: async () => ({ exitCode: 0 }),
					getInfo: async () => ({ status: "running" }),
					destroy: async () => undefined,
				};
			},
			...(opts.withList ? { list: async () => [] } : {}),
		};
		const compute: LifecycleCompute = { sandbox };
		if (opts.withSnapshot) {
			compute.snapshot = {
				create: async () => ({ id: "snap-1" }),
				delete: async () => undefined,
			};
		}
		return {
			name: "e2b",
			artifact: { kind: "baked", ref: "test-template" },
			requiredEnvVars: [],
			transport: fixtureTransport,
			createCompute: () => compute as unknown as DirectProvider,
		};
	}

	it("benchmarkLifecycle runs N cold-start cycles and aggregates Samples per Metric", async () => {
		const result = await benchmarkLifecycle(
			lifecycleConfig({ withSnapshot: true, withList: true }),
			{
				iterations: 3,
				controlPlaneSamples: 2,
			},
		);
		expect(result.provider).toBe("e2b");
		// 3 cold starts → 3 spawn + 3 teardown Samples; 2 info probes per cycle → 6.
		const spawn = result.aggregates.find((a) => a.metricId === "lifecycle_spawn_ms");
		const info = result.aggregates.find((a) => a.metricId === "control_plane_info_ms");
		expect(spawn?.aggregates.n).toBe(3);
		expect(info?.aggregates.n).toBe(6);
		expect(result.gaps).toEqual([]);
	});

	it("benchmarkLifecycle dedups a repeated unsupported-op skip across cycles", async () => {
		const result = await benchmarkLifecycle(lifecycleConfig(), { iterations: 4 });
		// No snapshot/list support → one skip each, not four, despite four cycles.
		const snapshotSkips = result.gaps.filter((g) => g.id === "lifecycle_snapshot_ms");
		const listSkips = result.gaps.filter((g) => g.id === "control_plane_list_ms");
		expect(snapshotSkips.length).toBe(1);
		expect(listSkips.length).toBe(1);
		// Cold-start Samples still accrue per cycle.
		expect(result.aggregates.find((a) => a.metricId === "lifecycle_spawn_ms")?.aggregates.n).toBe(
			4,
		);
	});

	it("benchmarkLifecycle records a mid-run spawn failure as a failed gap and keeps the surviving cycles", async () => {
		const result = await benchmarkLifecycle(lifecycleConfig({ failCreateOnCycle: 2 }), {
			iterations: 3,
		});
		// Cycle 2 fails to spawn; cycles 1 and 3 still produce spawn/teardown Samples (not discarded).
		expect(result.aggregates.find((a) => a.metricId === "lifecycle_spawn_ms")?.aggregates.n).toBe(
			2,
		);
		expect(
			result.aggregates.find((a) => a.metricId === "lifecycle_teardown_ms")?.aggregates.n,
		).toBe(2);
		// The failure surfaces as a FAILED spawn gap carrying the create error — the provider was asked
		// for a sandbox and did not produce one, which is an outage, not a decision.
		const spawnGap = result.gaps.find((g) => g.id === "lifecycle_spawn_ms");
		expect(spawnGap?.reason).toBe("spawn boom");
		expect(spawnGap?.outcome).toBe("failed");
	});

	it("benchmarkLifecycle skips control-plane info when the sandbox exposes no getInfo", async () => {
		const compute: LifecycleCompute = {
			sandbox: {
				create: async () => ({
					sandboxId: "sb-1",
					runCommand: async () => ({ exitCode: 0 }),
					destroy: async () => undefined,
				}),
			},
		};
		const result = await benchmarkLifecycleCompute("e2b", compute, { iterations: 2 });
		const infoSkips = result.gaps.filter((g) => g.id === "control_plane_info_ms");
		expect(infoSkips).toHaveLength(1);
		expect(infoSkips[0]?.outcome).toBe("skipped");
		expect(infoSkips[0]?.reason).toMatch(/no sandbox info/);
		expect(result.aggregates.find((a) => a.metricId === "lifecycle_spawn_ms")?.aggregates.n).toBe(
			2,
		);
	});

	it("benchmarkLifecycle clamps a non-finite iterations to a single cycle", async () => {
		const result = await benchmarkLifecycle(lifecycleConfig(), { iterations: Number.NaN });
		// NaN must not make `i < iterations` never run (zero Samples) — it falls back to one cold start.
		expect(result.aggregates.find((a) => a.metricId === "lifecycle_spawn_ms")?.aggregates.n).toBe(
			1,
		);
	});

	it("unmetRequirements flags required providers that did not run-and-pass", () => {
		const reports = [
			{ provider: "e2b", status: "ok" },
			{ provider: "daytona", status: "skipped" },
			{ provider: "modal", status: "failed" },
		];
		expect(unmetRequirements(reports, [])).toEqual([]);
		expect(unmetRequirements(reports, ["e2b"])).toEqual([]);
		// skipped, failed, and entirely-absent (a typo'd id) all count as unmet.
		expect(unmetRequirements(reports, ["e2b", "daytona", "modal", "typo"])).toEqual([
			"daytona",
			"modal",
			"typo",
		]);
	});
});

const work = mkdtempSync(join(tmpdir(), "harness-runsuite-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let dirSeq = 0;
const freshDir = (): string => join(work, `r${dirSeq++}`);

// Build the stdout the in-sandbox collect command emits: BEGIN/END markers around a base64'd tar of a
// benchmark-results/ directory holding the given files — what runSuiteOnSandbox extracts.
function collectPayload(files: Record<string, string>): string {
	const src = mkdtempSync(join(tmpdir(), "harness-collect-src-"));
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
	return `__BENCH_RESULTS_TGZ_BEGIN__\n${b64}\n__BENCH_RESULTS_TGZ_END__\n`;
}

// A fake sandbox that dispatches on command content: the disk probe, the benchmark command (token
// `benchmark-cmd`), and the base64 collect stream. No filesystem, so a detached step uses the
// cat-poll fallback — the detached launch wraps the real script (so the step's result is computed
// from the launch command) and is stashed under the step's tag for the done-file/log `cat` polls to
// read back, exercising the no-filesystem transport end-to-end. `destroyed` flips when teardown runs.
function makeSandbox(opts: {
	freeKb?: string;
	benchmarkFails?: boolean;
	collectFails?: boolean;
	collectFiles?: Record<string, string>;
	/** Contents returned for the release-owned manifest probe. */
	manifest?: string;
	/** Never answer the readiness probe — a sandbox whose image never finishes pulling. */
	neverReady?: boolean;
	destroyed: { hit: boolean };
}): SandboxHandle {
	// Results of detached steps, keyed by their /tmp/<tag> so the cat-polls can read them back.
	const detached = new Map<string, { exit: number; out: string }>();
	const resultFor = (command: string): CommandResult => {
		if (command.includes("/toolchain-manifest.json")) {
			return opts.manifest === undefined
				? { exitCode: 1, stderr: "manifest missing" }
				: { exitCode: 0, stdout: opts.manifest };
		}
		if (command.includes("df -Pk")) return { exitCode: 0, stdout: opts.freeKb ?? "999999999" };
		if (command.includes("base64")) {
			if (opts.collectFails) return { exitCode: 1, stderr: "collect boom" };
			const files = opts.collectFiles ?? { "pts_node-web-tooling.xml": "<xml/>" };
			return { exitCode: 0, stdout: collectPayload(files) };
		}
		if (command.includes("benchmark-cmd")) {
			return opts.benchmarkFails ? { exitCode: 1, stderr: "bench boom" } : { exitCode: 0 };
		}
		return { exitCode: 0, stdout: "" };
	};
	const tagOf = (command: string, ext: string): string | undefined =>
		command.match(new RegExp(`/tmp/(bench-[0-9a-f-]+)/(?:output|completion)\\.${ext}`))?.[1];
	return {
		sandboxId: "sb-test-1",
		async runCommand(command) {
			// Readiness probe: issued raw (not through StepRunner), so it arrives unwrapped by the preamble.
			if (command === READINESS_CMD) return { exitCode: opts.neverReady ? 1 : 0 };
			// Detached launch (double-fork, so it carries nohup): compute the wrapped step's result and
			// stash it under its tag for the cat-polls. The launch itself just acknowledges.
			if (command.includes("nohup")) {
				const tag = tagOf(command, "log");
				if (tag) {
					const r = resultFor(command);
					detached.set(tag, { exit: r.exitCode, out: r.stdout ?? r.stderr ?? "" });
				}
				return { exitCode: 0, stdout: "launched" };
			}
			// Cat-poll of the done-file: the stashed exit code (present from launch), else still-running.
			const doneTag = tagOf(command, "done");
			if (doneTag) {
				const d = detached.get(doneTag);
				return { exitCode: 0, stdout: d ? `v1 ${doneTag} ${d.exit}` : "__RUNNING__" };
			}
			// Cat-read of the log: the stashed output (stderr merged into stdout, mirroring live 2>&1).
			const logTag = tagOf(command, "log");
			if (logTag) return { exitCode: 0, stdout: detached.get(logTag)?.out ?? "" };
			// Synchronous foreground exec (short steps: the disk probe, observed-specs).
			return resultFor(command);
		},
		async destroy() {
			opts.destroyed.hit = true;
			return undefined;
		},
	};
}

const suite = (overrides: Partial<Suite>): Suite => ({
	commandTimeoutMinutes: 1,
	timeoutMinutes: 1,
	// The harness never reads dimensions/metrics (those drive the results contract, not orchestration);
	// keep the fixture empty so it stays decoupled from real catalog ids — like setup.test.ts's bare suite.
	dimensions: [],
	metrics: [],
	commands: ["benchmark-cmd"],
	...overrides,
});

const ctx = (s: Suite, resultsDir: string): SuiteRunContext => ({
	runId: "run-test-1",
	artifact: { kind: "baked", ref: "test-template" },
	suite: s,
	suiteName: "cpu-node",
	providerName: "daytona-vm",
	resultsDir,
	// Daytona-shaped: synchronous execs capped, detached+poll available. The fake sandbox has no
	// filesystem, so a detached selection drives the cat-poll fallback (done-file read over exec).
	transport: fixtureTransport,
});

describe("runSuite (resolution + credential gate)", () => {
	it("rejects an unknown suite as a usage error", async () => {
		await expect(
			runSuite({
				runId: "test",
				providerName: "daytona-vm",
				suiteName: "nope",
				resultsDir: freshDir(),
			}),
		).rejects.toBeInstanceOf(SuiteUsageError);
	});

	it("rejects an unknown provider as a usage error", async () => {
		await expect(
			runSuite({
				runId: "test",
				providerName: "nope",
				suiteName: "cpu-node",
				resultsDir: freshDir(),
			}),
		).rejects.toBeInstanceOf(SuiteUsageError);
	});

	it("rejects migrated providers on the retired legacy entry point", async () => {
		await expect(
			runSuite({
				runId: "test",
				providerName: "namespace",
				suiteName: "cpu-node",
				resultsDir: freshDir(),
				env: {},
			}),
		).rejects.toBeInstanceOf(SuiteUsageError);
	});
});

describe("createSuiteSandbox (creation-failure marker)", () => {
	// The daytona-container incident shape: creation itself throws, so no sandbox — and no result —
	// ever exists for the cell. The marker is the shard's ONLY record of the failure.
	const createCtx = (
		resultsDir: string,
		overrides: {
			createTimeoutMs?: number | null;
			createAttemptCeilingMs?: number;
			retryDelayMs?: number;
			retryBudgetMs?: number;
			sleep?: (ms: number) => Promise<void>;
		} = {},
	) => ({
		suite: suite({}),
		suiteName: "cpu-node",
		providerName: "daytona-container",
		resultsDir,
		retryBudgetMs: 60 * 60_000,
		...overrides,
	});
	const MARKER = "sandbox-daytona-container-cpu-node--failed.json";

	it("returns the created sandbox and writes no marker on success", async () => {
		const resultsDir = freshDir();
		const handle = makeSandbox({ destroyed: { hit: false } });
		const compute = { sandbox: { create: async () => handle } };
		await expect(createSuiteSandbox(() => compute, createCtx(resultsDir))).resolves.toBe(handle);
		expect(existsSync(join(resultsDir, MARKER))).toBe(false);
	});

	it("writes a FAILED marker before rethrowing a non-capacity creation error", async () => {
		const resultsDir = freshDir();
		const compute = {
			sandbox: {
				create: (): Promise<SandboxHandle> =>
					Promise.reject(new Error("Snapshot toolchain-v3-container is not available")),
			},
		};
		await expect(createSuiteSandbox(() => compute, createCtx(resultsDir))).rejects.toThrow(
			/Snapshot .* is not available/,
		);
		// The marker carries the WHY into the raw tree the caller normalizes — without it the shard's
		// Run document is empty (no result, no gap) while the job log claims a gap was recorded.
		expect(JSON.parse(readFileSync(join(resultsDir, MARKER), "utf8"))).toEqual({
			provider: "daytona-container",
			suite: "cpu-node",
			outcome: "failed",
			reason: "Failed to create sandbox: Snapshot toolchain-v3-container is not available",
			// The classification the thrower knew, carried into the marker so consumers need not
			// re-read the sentence above to learn it was a creation failure.
			cause: {
				kind: "sandbox-create-failed",
				detail: "Snapshot toolchain-v3-container is not available",
			},
		});
	});

	it("retries a create the adapter marked retryable, then returns the sandbox", async () => {
		const resultsDir = freshDir();
		const handle = makeSandbox({ destroyed: { hit: false } });
		let attempts = 0;
		const compute = {
			sandbox: {
				create: async (): Promise<SandboxHandle> => {
					attempts++;
					// A stalled control plane: the message names no quota, rate limit or 429, so only the
					// adapter's explicit mark can keep this cell alive.
					if (attempts < 3) {
						throw markRetryableCreate(new Error("run.cloud create did not settle within 30000ms"));
					}
					return handle;
				},
			},
		};
		await expect(
			createSuiteSandbox(() => compute, createCtx(resultsDir, { retryDelayMs: 1 })),
		).resolves.toBe(handle);
		expect(attempts).toBe(3);
		// The cell recovered, so nothing failed and no marker belongs in the shard.
		expect(existsSync(join(resultsDir, MARKER))).toBe(false);
	});

	it("does not retry an unmarked create failure whose message names no capacity limit", async () => {
		const resultsDir = freshDir();
		let attempts = 0;
		const compute = {
			sandbox: {
				create: async (): Promise<SandboxHandle> => {
					attempts++;
					// Same sentence, no mark: the adapter never established that nothing was allocated, so
					// re-issuing could stack allocations it cannot see.
					throw new Error("run.cloud create did not settle within 30000ms");
				},
			},
		};
		await expect(
			createSuiteSandbox(() => compute, createCtx(resultsDir, { retryDelayMs: 1 })),
		).rejects.toThrow("did not settle");
		expect(attempts).toBe(1);
		expect(existsSync(join(resultsDir, MARKER))).toBe(true);
	});

	it("still retries on the message match, for adapters that do not set the mark", async () => {
		const resultsDir = freshDir();
		const handle = makeSandbox({ destroyed: { hit: false } });
		let attempts = 0;
		const compute = {
			sandbox: {
				create: async (): Promise<SandboxHandle> => {
					attempts++;
					if (attempts < 2) throw new Error("429 Too Many Requests");
					return handle;
				},
			},
		};
		await expect(
			createSuiteSandbox(() => compute, createCtx(resultsDir, { retryDelayMs: 1 })),
		).resolves.toBe(handle);
		expect(attempts).toBe(2);
	});

	it("does not leak the legacy message matcher into an explicit create plan", async () => {
		const resultsDir = freshDir();
		let attempts = 0;
		await expect(
			createSuiteSandboxFromPlan(
				{
					create: async () => {
						attempts++;
						throw new Error("429 Too Many Requests");
					},
					isRetryable: () => false,
				},
				createCtx(resultsDir, { retryDelayMs: 1 }),
			),
		).rejects.toThrow("429 Too Many Requests");
		expect(attempts).toBe(1);
		expect(existsSync(join(resultsDir, MARKER))).toBe(true);
	});

	it.each([
		0,
		undefined,
	])("writes a FAILED marker without a positive retry budget (%s)", async (retryBudgetMs) => {
		const resultsDir = freshDir();
		let attempts = 0;
		const compute = {
			sandbox: {
				create: async (): Promise<SandboxHandle> => {
					attempts++;
					throw markRetryableCreate(new Error("no slot right now"));
				},
			},
		};
		// A budget smaller than one delay leaves no room for another attempt, so the first failure is
		// also the last: patience is bounded, and the cell still records why it produced nothing.
		await expect(
			createSuiteSandbox(() => compute, createCtx(resultsDir, { retryDelayMs: 50, retryBudgetMs })),
		).rejects.toThrow("no slot right now");
		expect(attempts).toBe(1);
		expect(JSON.parse(readFileSync(join(resultsDir, MARKER), "utf8")).outcome).toBe("failed");
	});

	it("stops when the budget can cover the backoff but not another adapter-bounded attempt", async () => {
		const resultsDir = freshDir();
		let attempts = 0;
		const compute = {
			sandbox: {
				create: async (): Promise<SandboxHandle> => {
					attempts++;
					throw markRetryableCreate(new Error("create did not settle"));
				},
			},
		};
		// The run.cloud shape: the harness race is off, so an attempt is bounded only by the ceiling the
		// adapter declares. Room for the 10ms backoff but not the 5s attempt behind it — starting one
		// would put the failure marker (and the matrix cell) seconds past the budget it promised.
		await expect(
			createSuiteSandbox(
				() => compute,
				createCtx(resultsDir, {
					createTimeoutMs: null,
					createAttemptCeilingMs: 5_000,
					retryDelayMs: 10,
					retryBudgetMs: 1_000,
				}),
			),
		).rejects.toThrow("create did not settle");
		expect(attempts).toBe(1);
		expect(JSON.parse(readFileSync(join(resultsDir, MARKER), "utf8")).outcome).toBe("failed");
	});

	it("re-checks the budget after a backoff timer that fires late", async () => {
		const resultsDir = freshDir();
		let attempts = 0;
		const compute = {
			sandbox: {
				create: async (): Promise<SandboxHandle> => {
					attempts++;
					throw markRetryableCreate(new Error("create did not settle"));
				},
			},
		};
		// setTimeout promises a floor, not a ceiling: a loaded runner can return from the backoff long
		// after it was asked to. The pre-sleep reservation was arithmetic on a clock reading that is now
		// stale, so without the recheck this late sleep would start an attempt the budget cannot cover.
		await expect(
			createSuiteSandbox(
				() => compute,
				createCtx(resultsDir, {
					createTimeoutMs: null,
					createAttemptCeilingMs: 10,
					retryDelayMs: 1,
					retryBudgetMs: 40,
					sleep: () => new Promise((r) => setTimeout(r, 60)),
				}),
			),
		).rejects.toThrow("create did not settle");
		expect(attempts).toBe(1);
		expect(JSON.parse(readFileSync(join(resultsDir, MARKER), "utf8")).outcome).toBe("failed");
	});

	it("keeps retrying while the budget still covers the backoff and one whole attempt", async () => {
		const resultsDir = freshDir();
		const handle = makeSandbox({ destroyed: { hit: false } });
		let attempts = 0;
		const compute = {
			sandbox: {
				create: async (): Promise<SandboxHandle> => {
					attempts++;
					if (attempts < 2) throw markRetryableCreate(new Error("create did not settle"));
					return handle;
				},
			},
		};
		// Same shape, ample budget: reserving one attempt's worth must not collapse the retry loop into
		// a single try for the adapters that need it most.
		await expect(
			createSuiteSandbox(
				() => compute,
				createCtx(resultsDir, {
					createTimeoutMs: null,
					createAttemptCeilingMs: 5_000,
					retryDelayMs: 1,
					retryBudgetMs: 60_000,
				}),
			),
		).resolves.toBe(handle);
		expect(attempts).toBe(2);
		expect(existsSync(join(resultsDir, MARKER))).toBe(false);
	});

	it("writes a FAILED marker when adapter construction (the factory) throws before create", async () => {
		const resultsDir = freshDir();
		// A computesdk provider can throw while BUILDING the adapter — before `sandbox.create` is ever
		// reached. That path produced the same empty Run this marker guards against, so it must be recorded.
		const factory = (): { sandbox: { create(): Promise<SandboxHandle> } } => {
			throw new Error("provider config invalid: DAYTONA_REGION unset");
		};
		await expect(createSuiteSandbox(factory, createCtx(resultsDir))).rejects.toThrow(
			/DAYTONA_REGION unset/,
		);
		expect(JSON.parse(readFileSync(join(resultsDir, MARKER), "utf8"))).toEqual({
			provider: "daytona-container",
			suite: "cpu-node",
			outcome: "failed",
			reason: "Failed to create sandbox: provider config invalid: DAYTONA_REGION unset",
			// The classification the thrower knew, carried into the marker so consumers need not
			// re-read the sentence above to learn it was a creation failure.
			cause: {
				kind: "sandbox-create-failed",
				detail: "provider config invalid: DAYTONA_REGION unset",
			},
		});
	});

	it("destroys a sandbox that resolves after the create attempt timed out (no leak)", async () => {
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		const handle = makeSandbox({ destroyed });
		// create outlives the (tiny, injected) attempt timeout: withTimeout only races, so the handle it
		// eventually yields is orphaned. The leak guard must destroy it — a Daytona sandbox with
		// autoStopInterval: 0 would otherwise run for its full lifetime with no one to tear it down.
		const compute = {
			sandbox: {
				create: (): Promise<SandboxHandle> => new Promise((r) => setTimeout(() => r(handle), 30)),
			},
		};
		await expect(
			createSuiteSandbox(() => compute, createCtx(resultsDir, { createTimeoutMs: 5 })),
		).rejects.toThrow(/Sandbox creation timed out/);
		// Let the late create settle and the attached cleanup run.
		await new Promise((r) => setTimeout(r, 60));
		expect(destroyed.hit).toBe(true);
	});

	it("does not abandon an adapter-owned create/cleanup promise when its timeout is disabled", async () => {
		const resultsDir = freshDir();
		const handle = makeSandbox({ destroyed: { hit: false } });
		const compute = {
			sandbox: {
				create: (): Promise<SandboxHandle> =>
					new Promise((resolve) => setTimeout(() => resolve(handle), 30)),
			},
		};

		await expect(
			createSuiteSandbox(() => compute, createCtx(resultsDir, { createTimeoutMs: null })),
		).resolves.toBe(handle);
		expect(existsSync(join(resultsDir, MARKER))).toBe(false);
	});

	it("folds into a suite-scope FAILED gap through the extractor's marker reader", async () => {
		const resultsDir = freshDir();
		const compute = {
			sandbox: { create: (): Promise<SandboxHandle> => Promise.reject(new Error("boom")) },
		};
		await expect(createSuiteSandbox(() => compute, createCtx(resultsDir))).rejects.toThrow("boom");
		// parseGapMarker is the single reader the results extractor routes every marker through, so
		// this proves the written bytes normalize into the suite-scope failed gap on the shard Run.
		const gap = parseGapMarker(
			MARKER,
			JSON.parse(readFileSync(join(resultsDir, MARKER), "utf8")),
			"daytona-container",
		);
		expect(gap).toEqual({
			scope: "suite",
			id: "cpu-node",
			outcome: "failed",
			reason: "Failed to create sandbox: boom",
			// The classification the thrower knew, carried into the marker so consumers need not
			// re-read the sentence above to learn it was a creation failure.
			cause: { kind: "sandbox-create-failed", detail: "boom" },
		});
	});
});

describe("runSuiteOnSandbox (orchestration + teardown)", () => {
	it("persists the honest requested-artifact fallback before touching the sandbox", async () => {
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		await expect(
			runSuiteOnSandbox(makeSandbox({ destroyed, neverReady: true }), {
				...ctx(suite({}), resultsDir),
				readiness: {
					maxAttempts: 1,
					retryDelayMs: 0,
					probeTimeoutMs: 5,
					delay: () => Promise.resolve(),
				},
			}),
		).rejects.toThrow(/never ready/);
		const evidence = parseProviderArtifactEvidence(
			readFileSync(join(resultsDir, "provider-artifact-evidence.json"), "utf8"),
		);
		expect(evidence).toEqual({
			cell: { runId: "run-test-1", providerId: "daytona-vm", suite: "cpu-node" },
			sandboxId: "sb-test-1",
			provenance: {
				source: "request-fallback",
				requested: { kind: "baked", ref: "test-template" },
			},
		});
		expect(destroyed.hit).toBe(true);
	});

	it("upgrades a canonical release artifact only after the guest manifest matches", async () => {
		const resultsDir = freshDir();
		const artifact = { kind: "baked", ref: bakedArtifactName("daytona-vm", "version") } as const;
		await runSuiteOnSandbox(
			makeSandbox({
				destroyed: { hit: false },
				manifest: JSON.stringify({
					image_name: "sandbox-benchmarks-toolchain",
					image_version: "v8",
				}),
			}),
			{ ...ctx(suite({}), resultsDir), artifact },
		);
		const evidence = parseProviderArtifactEvidence(
			readFileSync(join(resultsDir, "provider-artifact-evidence.json"), "utf8"),
		);
		expect(evidence.provenance).toEqual({
			source: "guest-fingerprint",
			requested: artifact,
			fingerprint: {
				authority: "toolchain-manifest-v1",
				imageName: "sandbox-benchmarks-toolchain",
				imageVersion: "v8",
			},
		});
	});

	it("fails before benchmarking when a canonical artifact carries a stale guest manifest", async () => {
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		const artifact = { kind: "baked", ref: bakedArtifactName("daytona-vm", "version") } as const;
		await expect(
			runSuiteOnSandbox(
				makeSandbox({
					destroyed,
					manifest: JSON.stringify({
						image_name: "sandbox-benchmarks-toolchain",
						image_version: "v7",
					}),
				}),
				{ ...ctx(suite({}), resultsDir), artifact },
			),
		).rejects.toThrow(/matching sandbox-benchmarks-toolchain@v8/);
		const evidence = parseProviderArtifactEvidence(
			readFileSync(join(resultsDir, "provider-artifact-evidence.json"), "utf8"),
		);
		expect(evidence.provenance.source).toBe("request-fallback");
		expect(destroyed.hit).toBe(true);
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(false);
	});

	it("captures and persists provider evidence strictly after confirmed teardown", async () => {
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		const calls: string[] = [];
		const sandbox = makeSandbox({ destroyed, freeKb: "1" });
		const originalDestroy = sandbox.destroy.bind(sandbox);
		sandbox.destroy = async () => {
			calls.push("destroy");
			return originalDestroy();
		};
		await runSuiteOnSandbox(sandbox, {
			...ctx(suite({ minDiskGb: 50 }), resultsDir),
			providerName: "modal-gvisor",
			artifact: { kind: "image", ref: "test-image" },
			costEvidence: {
				sdk: { packageName: "modal", version: "0.7.6" },
				captureAfterTeardown: async (input) => {
					calls.push("capture");
					expect(input.teardown.completed).toBe(true);
					return {
						kind: "missing",
						cell: input.cell,
						subject: { kind: "sandbox", sandboxId: input.sandboxId },
						capturedAt: "2026-08-08T00:00:00.000Z",
						sdk: { packageName: "modal", version: "0.7.6" },
						reason: "unsupported_public_api",
						detail: "No public sandbox usage endpoint.",
					};
				},
			},
		});
		expect(calls).toEqual(["destroy", "capture"]);
		expect(
			JSON.parse(readFileSync(join(resultsDir, "provider-cost-evidence.json"), "utf8")),
		).toMatchObject({
			cell: { runId: "run-test-1", providerId: "modal-gvisor", suite: "cpu-node" },
			subject: { sandboxId: "sb-test-1" },
		});
	});

	for (const mismatch of ["cell", "sandbox", "sdk"] as const) {
		it(`replaces a provider response with ${mismatch} mismatch by fixed invalid evidence`, async () => {
			const resultsDir = freshDir();
			const sandbox = makeSandbox({ destroyed: { hit: false }, freeKb: "1" });
			await runSuiteOnSandbox(sandbox, {
				...ctx(suite({ minDiskGb: 50 }), resultsDir),
				providerName: "modal-gvisor",
				artifact: { kind: "image", ref: "test-image" },
				costEvidence: {
					sdk: { packageName: "modal", version: "0.7.6" },
					captureAfterTeardown: async (input) => ({
						kind: "missing",
						cell: mismatch === "cell" ? { ...input.cell, runId: "forged-run" } : input.cell,
						subject: {
							kind: "sandbox",
							sandboxId: mismatch === "sandbox" ? "forged-sandbox" : input.sandboxId,
						},
						capturedAt: "2026-08-08T00:00:00.000Z",
						sdk:
							mismatch === "sdk"
								? { packageName: "modal", version: "forged-version" }
								: { packageName: "modal", version: "0.7.6" },
						reason: "unsupported_public_api",
						detail: "Untrusted provider detail.",
					}),
				},
			});
			const persisted = JSON.parse(
				readFileSync(join(resultsDir, "provider-cost-evidence.json"), "utf8"),
			) as Record<string, unknown>;
			expect(persisted).toMatchObject({
				kind: "missing",
				reason: "invalid_provider_response",
				cell: { runId: "run-test-1", providerId: "modal-gvisor", suite: "cpu-node" },
				subject: { sandboxId: "sb-test-1" },
				sdk: { packageName: "modal", version: "0.7.6" },
				detail: "Provider response failed structural or requested-cell binding validation.",
			});
		});
	}

	it("persists no provider error credential canary when capture throws", async () => {
		const resultsDir = freshDir();
		const canary = "prefix.SECRET_SUFFIX_CANARY";
		await runSuiteOnSandbox(makeSandbox({ destroyed: { hit: false }, freeKb: "1" }), {
			...ctx(suite({ minDiskGb: 50 }), resultsDir),
			providerName: "modal-gvisor",
			artifact: { kind: "image", ref: "test-image" },
			costEvidence: {
				sdk: { packageName: "modal", version: "0.7.6" },
				captureAfterTeardown: async () => {
					throw new Error(`headers={"Authorization":"Bearer ${canary}"}`);
				},
			},
		});
		const artifact = readFileSync(join(resultsDir, "provider-cost-evidence.json"), "utf8");
		expect(artifact).not.toContain(canary);
		expect(artifact).not.toContain("SECRET_SUFFIX_CANARY");
		expect(JSON.parse(artifact)).toMatchObject({ kind: "missing", reason: "provider_api_error" });
	});

	it("sanitizes a successful hook responseJson before host persistence", async () => {
		const resultsDir = freshDir();
		const bearer = "bearer.SECRET_SUFFIX_CANARY";
		const basic = "basic.SECRET_SUFFIX_CANARY";
		const assignment = "assignment.SECRET_SUFFIX_CANARY";
		const tuple = "tuple.SECRET_SUFFIX_CANARY";
		const userinfo = "userinfo.SECRET_SUFFIX_CANARY";
		await runSuiteOnSandbox(makeSandbox({ destroyed: { hit: false }, freeKb: "1" }), {
			...ctx(suite({ minDiskGb: 50 }), resultsDir),
			providerName: "modal-gvisor",
			artifact: { kind: "image", ref: "test-image" },
			costEvidence: {
				sdk: { packageName: "modal", version: "0.7.6" },
				captureAfterTeardown: async (input) => ({
					kind: "observed",
					cell: input.cell,
					subject: { kind: "sandbox", sandboxId: input.sandboxId },
					capturedAt: "2026-08-08T00:00:00.000Z",
					sdk: { packageName: "modal", version: "0.7.6" },
					apiOperation: "sandbox.cost",
					usage: [{ resource: "cpu", quantity: 1, unit: "second" }],
					amount: 1,
					currency: "USD",
					source: "provider_reported",
					responseJson: JSON.stringify({
						authorization: `Bearer ${bearer}`,
						logA: `api_key=${assignment}&access_token=${assignment} token=${assignment} secret=${assignment} password=${assignment}`,
						logB: `cookie=${assignment}; session=${assignment}`,
						headerText: `Authorization: Basic ${basic}`,
						logC: `X-Api-Key: ${assignment}`,
						bare: `Bearer ${bearer} Basic ${basic}`,
						tuples: [
							["Authorization", `Bearer ${tuple}`],
							["X-Api-Key", tuple],
						],
						url: `https://user:${userinfo}@vendor.invalid/path`,
					}),
				}),
			},
		});
		const artifact = readFileSync(join(resultsDir, "provider-cost-evidence.json"), "utf8");
		expect(artifact).not.toContain(bearer);
		expect(artifact).not.toContain(basic);
		expect(artifact).not.toContain(assignment);
		expect(artifact).not.toContain(tuple);
		expect(artifact).not.toContain(userinfo);
		const persisted = JSON.parse(artifact) as { responseJson: string };
		const response = JSON.parse(persisted.responseJson) as Record<string, unknown>;
		expect(response).toMatchObject({
			authorization: "[REDACTED]",
			bare: "Bearer [REDACTED] Basic [REDACTED]",
			headerText: "Authorization: Basic [REDACTED]",
			logA: "api_key=[REDACTED]&access_token=[REDACTED] token=[REDACTED] secret=[REDACTED] password=[REDACTED]",
			logB: "cookie=[REDACTED]; session=[REDACTED]",
			logC: "X-Api-Key: [REDACTED]",
			url: "https://[REDACTED]@vendor.invalid/path",
		});
		expect(response.tuples).toEqual([
			["Authorization", "[REDACTED]"],
			["X-Api-Key", "[REDACTED]"],
		]);
	});

	it("rejects accessors, deep objects, and proxies before ArkType traversal", async () => {
		for (const shape of ["accessor", "deep", "root-proxy", "nested-proxy"] as const) {
			const resultsDir = freshDir();
			let getterCalls = 0;
			await runSuiteOnSandbox(makeSandbox({ destroyed: { hit: false }, freeKb: "1" }), {
				...ctx(suite({ minDiskGb: 50 }), resultsDir),
				providerName: "modal-gvisor",
				artifact: { kind: "image", ref: "test-image" },
				costEvidence: {
					sdk: { packageName: "modal", version: "0.7.6" },
					captureAfterTeardown: async (input) => {
						const returned: Record<string, unknown> = {
							kind: "missing",
							cell: input.cell,
							subject: { kind: "sandbox", sandboxId: input.sandboxId },
							capturedAt: "2026-08-08T00:00:00.000Z",
							sdk: { packageName: "modal", version: "0.7.6" },
							reason: "unsupported_public_api",
							detail: "fixed",
						};
						if (shape === "accessor") {
							Object.defineProperty(returned, "extra", {
								enumerable: true,
								get: () => {
									getterCalls++;
									return "secret";
								},
							});
						} else if (shape === "deep") {
							let nested: Record<string, unknown> = {};
							returned.extra = nested;
							for (let index = 0; index < 20; index++) nested = nested.next = {};
						} else if (shape === "nested-proxy") {
							returned.extra = new Proxy({ safe: true }, {});
						}
						return (
							shape === "root-proxy" ? new Proxy(returned, {}) : returned
						) as ProviderCostEvidence;
					},
				},
			});
			expect(getterCalls).toBe(0);
			expect(
				JSON.parse(readFileSync(join(resultsDir, "provider-cost-evidence.json"), "utf8")),
			).toMatchObject({
				kind: "missing",
				reason: "invalid_provider_response",
			});
		}
	});
	it("runs the suite, collects results, and tears the sandbox down", async () => {
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		const sandbox = makeSandbox({
			destroyed,
			collectFiles: { "pts_node-web-tooling.xml": "<x/>" },
		});
		await runSuiteOnSandbox(sandbox, ctx(suite({ setupPts: true }), resultsDir));
		expect(existsSync(join(resultsDir, "pts_node-web-tooling.xml"))).toBe(true);
		expect(destroyed.hit).toBe(true);
	});

	it("fails a sandbox that never becomes ready, before charging the wait to the first step", async () => {
		// The namespace regression: create() resolves while the image is still pulling, so the FIRST step
		// absorbed the wait and reported it as its own timeout ("check free disk timed out after 60s" —
		// nothing to do with disk). The readiness gate must own that wait and name it, and a sandbox that
		// never answers must still be torn down and recorded as a failed cell, not a disk skip.
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		const sandbox = makeSandbox({ destroyed, neverReady: true });
		await expect(
			runSuiteOnSandbox(sandbox, {
				...ctx(suite({}), resultsDir),
				readiness: {
					maxAttempts: 3,
					retryDelayMs: 0,
					probeTimeoutMs: 5,
					delay: () => Promise.resolve(),
				},
			}),
		).rejects.toThrow(/never ready/);
		expect(destroyed.hit).toBe(true);
		const marker = join(resultsDir, sandboxFailureMarkerFile("daytona-vm", "cpu-node"));
		expect(parseGapMarker(marker, JSON.parse(readFileSync(marker, "utf8")), "daytona-vm")).toEqual({
			scope: "suite",
			id: "cpu-node",
			outcome: "failed",
			reason: expect.stringMatching(/never ready/),
		});
	});

	it("cancels and settles DriverModule readiness before tearing the sandbox down", async () => {
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		const events: string[] = [];
		const base = makeSandbox({ destroyed });
		const sandbox: SandboxHandle = {
			...base,
			async destroy() {
				events.push("destroy");
				return base.destroy();
			},
		};

		await expect(
			runSuiteOnSandbox(sandbox, {
				...ctx(suite({}), resultsDir),
				driverReadiness: {
					timeoutMs: 10,
					verify: ({ signal }) =>
						new Promise((_resolve, reject) => {
							signal.addEventListener(
								"abort",
								() => {
									events.push("abort");
									queueMicrotask(() => {
										events.push("settled");
										reject(signal.reason);
									});
								},
								{ once: true },
							);
						}),
				},
			}),
		).rejects.toThrow(/exceeded its 10ms policy budget/);
		expect(events).toEqual(["abort", "settled", "destroy"]);
		expect(destroyed.hit).toBe(true);
	});

	it("tears the sandbox down when an invalid ptsTimesToRun (k < 1) fails preamble construction", async () => {
		// StepRunner builds the preamble in its constructor, and buildPreamble rejects k < 1. That throw
		// must land inside the teardown try/finally rather than before it — otherwise the already-created
		// sandbox leaks. Guards the "constructed inside the try" placement in runSuiteOnSandbox.
		const destroyed = { hit: false };
		const sandbox = makeSandbox({ destroyed });
		await expect(
			runSuiteOnSandbox(sandbox, ctx(suite({ ptsTimesToRun: 0 }), freshDir())),
		).rejects.toThrow(/positive integer/);
		expect(destroyed.hit).toBe(true);
	});

	it("tears the sandbox down even when the benchmark fails, and propagates the error", async () => {
		const destroyed = { hit: false };
		const sandbox = makeSandbox({ destroyed, benchmarkFails: true });
		await expect(runSuiteOnSandbox(sandbox, ctx(suite({}), freshDir()))).rejects.toThrow(
			/exit code 1/,
		);
		expect(destroyed.hit).toBe(true);
	});

	it("prefers the benchmark error over a later collect failure", async () => {
		const destroyed = { hit: false };
		const sandbox = makeSandbox({ destroyed, benchmarkFails: true, collectFails: true });
		// The in-flight benchmark error wins; the collect failure is logged, not thrown.
		await expect(runSuiteOnSandbox(sandbox, ctx(suite({}), freshDir()))).rejects.toThrow(
			/bench boom|exit code 1/,
		);
		expect(destroyed.hit).toBe(true);
	});

	it("surfaces a collect failure when the benchmark succeeded", async () => {
		const destroyed = { hit: false };
		const sandbox = makeSandbox({ destroyed, collectFails: true });
		await expect(runSuiteOnSandbox(sandbox, ctx(suite({}), freshDir()))).rejects.toThrow(
			/exit code 1/,
		);
		expect(destroyed.hit).toBe(true);
	});

	it("skips (marker, no throw) and tears down when free disk is below the suite minimum", async () => {
		const resultsDir = freshDir();
		const destroyed = { hit: false };
		// 1 KiB free, suite needs 50 GiB.
		const sandbox = makeSandbox({ destroyed, freeKb: "1" });
		await runSuiteOnSandbox(sandbox, ctx(suite({ minDiskGb: 50 }), resultsDir));
		expect(existsSync(join(resultsDir, "sandbox-daytona-vm-cpu-node--skipped.json"))).toBe(true);
		expect(destroyed.hit).toBe(true);
	});

	it("fails a PTS suite that collected no pts_*.xml (silent PTS failure)", async () => {
		const destroyed = { hit: false };
		// Collect succeeds (a skip marker satisfies collection) but yields no pts_*.xml.
		const sandbox = makeSandbox({
			destroyed,
			collectFiles: { "sandbox-daytona-vm-cpu-node--skipped.json": '{"skipped":true}' },
		});
		await expect(
			runSuiteOnSandbox(sandbox, ctx(suite({ setupPts: true }), freshDir())),
		).rejects.toThrow(/no pts_\*\.xml/);
		expect(destroyed.hit).toBe(true);
	});
});
