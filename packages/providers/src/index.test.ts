import { describe, expect, it } from "bun:test";
// The stock wrapper factory, imported so the novita test can prove the connection methods were
// actually REPLACED (identity inequality against an unpatched instance's methods table).
import { e2b } from "@computesdk/e2b";
import { PROVIDERS, TARGET_SPEC, TOOLCHAIN_IMAGE_NAME } from "@sandbox-benchmarks/schema";
import { normalizeProviderInput } from "@sandbox-benchmarks/schema/provider-meta";
import { REGISTRY } from "@sandbox-benchmarks/schema/providers";
import { ENV_KEYS } from "./config.ts";
import {
	config,
	microsandboxCloudCompute,
	microsandboxLocalCompute,
	NOVITA_E2B_DOMAIN,
	novitaCompute,
	novitaConnection,
	providers,
} from "./index.ts";
import { runE2bCommandAsRoot } from "./lib/e2b-root.ts";
import { assertCreateCeilingDeclared, assertProviderJoin } from "./lib/join.ts";

describe("@sandbox-benchmarks/providers", () => {
	// The failure this prevents is not hypothetical: TAMA_CLI was declared in the registry as an
	// optional variable but never added to the gatekeeper's key list, so the tama adapter read it
	// straight off process.env. CI exports an unconfigured variable input as `X: ${{ … || '' }}` —
	// set AND EMPTY, because GitHub Actions cannot express "unset" — `??` accepted that empty string
	// as a value, and spawn("") killed all 54 tama replicates of matrix run 33712242440 before a
	// single sandbox existed.
	//
	// The gatekeeper is where that empty-is-unset rule lives, so every optional variable has to pass
	// through it. A subset assertion rather than deriving ENV_KEYS outright: the list legitimately
	// carries keys with no registry input (BENCH_TOOLCHAIN_IMAGE, VERCEL_CANDIDATE_IMAGE, and the
	// API keys re-exposed as config). Required inputs need no coverage — missingCreds already treats
	// "" as missing, which is why a raw process.env read of a TOKEN is safe and a variable is not.
	it("routes every optional provider variable through the config gatekeeper", () => {
		const optionalVariables = Object.values(REGISTRY)
			.flatMap((meta) => meta.inputs.map(normalizeProviderInput))
			.filter((input) => input.source.kind === "variable" && !input.required)
			.map((input) => input.name);
		expect(optionalVariables.length).toBeGreaterThan(0);
		// Widened: ENV_KEYS is `as const`, so its literal union would reject a registry-derived string
		// at the call rather than reporting the drift this test exists to report.
		const covered: readonly string[] = ENV_KEYS;
		for (const name of new Set(optionalVariables)) {
			expect(covered).toContain(name);
		}
	});

	it("wires every unmigrated schema provider through to a computesdk factory", () => {
		// Migrated DriverModule ids are omitted from this join on purpose.
		expect(providers.map((p) => p.name).sort()).toEqual(
			PROVIDERS.map((m) => m.id)
				.filter((id) => id !== "e2b" && id !== "modal-gvisor" && id !== "modal-vm" && id !== "tama")
				.sort(),
		);
		for (const p of providers) {
			expect(typeof p.createCompute).toBe("function");
			expect(p.requiredEnvVars.length).toBeGreaterThan(0);
		}
	});

	it("carries each provider's schema-owned transport capability through to the config", () => {
		// The join must surface the same transport the schema declares, so the harness selects a
		// transport from the provider's real capability rather than a hardcoded default.
		expect(providers.length).toBeGreaterThan(0);
		for (const adapter of providers) {
			const meta = PROVIDERS.find((m) => m.id === adapter.name);
			if (meta === undefined) throw new Error(`missing schema meta for ${adapter.name}`);
			expect(adapter.transport).toEqual(meta.transport);
		}
	});

	it("carries the exact boot artifact beside each legacy create policy", () => {
		expect(providers.length).toBe(
			PROVIDERS.filter(
				(m) => m.id !== "e2b" && m.id !== "modal-gvisor" && m.id !== "modal-vm" && m.id !== "tama",
			).length,
		);
		for (let i = 0; i < providers.length; i++) {
			const meta = PROVIDERS.find((m) => m.id === providers[i]?.name);
			expect(providers[i]?.artifact.kind).toBe(meta?.artifact.kind);
		}
		expect(providers.find((provider) => provider.name === "namespace")?.artifact).toEqual({
			kind: "image",
			ref: config.toolchainImage,
		});
		expect(providers.find((provider) => provider.name === "vercel")?.artifact).toEqual({
			kind: "mirror",
			ref: config.vercelImage,
		});
	});

	it("configures Vercel through its custom provider factory", () => {
		const adapter = providers.find((provider) => provider.name === "vercel");
		expect(adapter?.requiredEnvVars).toEqual(["VERCEL_OIDC_TOKEN"]);
		expect(adapter?.createOptions).toEqual({});
		expect(adapter?.createCompute().name).toBe("vercel");
	});

	it("pins Runloop's custom Devbox to the shared target spec", () => {
		const adapter = providers.find((provider) => provider.name === "runloop");
		expect(adapter).toBeDefined();
		expect(adapter?.requiredEnvVars).toEqual(["RUNLOOP_API_KEY"]);
		const compute = adapter?.createCompute();
		expect(compute?.name).toBe("runloop");
		expect(compute?.snapshot).toBeDefined();
		expect(adapter?.createOptions).toEqual({
			timeout: 20 * 60 * 1000,
			blueprint_name: config.runloopBlueprintVersion,
			launch_parameters: {
				resource_size_request: "CUSTOM_SIZE",
				custom_cpu_cores: TARGET_SPEC.vcpus,
				custom_gb_memory: TARGET_SPEC.memoryGb,
				custom_disk_size: TARGET_SPEC.diskGb,
				keep_alive_time_seconds: 3 * 60 * 60,
			},
		});
		expect(config.runloopBlueprint).toBe(config.runloopBlueprintVersion);
		expect(config.runloopBlueprintVersion).toBe(
			`${TOOLCHAIN_IMAGE_NAME}-${config.toolchainVersion}`,
		);
		expect(config.runloopBlueprintCandidate).toBe(`${config.runloopBlueprintVersion}-candidate`);
		// The credential belongs only to the SDK control plane, never guest-visible create options.
		expect(JSON.stringify(adapter?.createOptions)).not.toContain("RUNLOOP_API_KEY");
	});

	it("pins run.cloud to the shared image and target spec", () => {
		const adapter = providers.find((provider) => provider.name === "runcloud");
		expect(adapter?.requiredEnvVars).toEqual(["RUN_CLOUD_API_KEY"]);
		expect(adapter?.createOptions).toMatchObject({
			image: config.toolchainImage,
			cpu: TARGET_SPEC.vcpus,
			memory: TARGET_SPEC.memoryGb * 1024,
			disk: TARGET_SPEC.diskGb,
		});
		// The adapter waits for readiness and cleans up failed allocations itself. A harness timeout would
		// abandon that non-cancellable promise and bench-suite's process exit could kill the cleanup.
		expect(adapter?.createTimeoutMs).toBeNull();
		expect(adapter?.createCompute().name).toBe("runcloud");
		expect(adapter?.costEvidence).toBeDefined();
	});

	it("re-points the e2b wrapper at Novita without the e2b_ key-format guard", () => {
		// Construction must accept an nvta_-prefixed key and still expose the universal manager surface
		// the harness drives, with the mispointed snapshot/template managers removed (their every call
		// would reconnect to e2b.dev). This also exercises the patch's runtime shape assertion, so a
		// wrapper upgrade that moves the internal methods table fails here instead of mid-run.
		const compute = novitaCompute("nvta_unit-test-key");
		expect(typeof compute.sandbox.create).toBe("function");
		expect(typeof compute.sandbox.destroy).toBe("function");
		expect(typeof compute.sandbox.list).toBe("function");
		// The stock wrapper's connection methods (whose create() enforces the e2b_ prefix and whose
		// every call omits the domain) must have been REPLACED, not just still-callable — a stock
		// `create` is also `typeof "function"`, so compare the internal methods table against an
		// unpatched wrapper's by identity. Reaches the same internal seam the patch itself asserts.
		const methodsOf = (p: unknown) =>
			(p as { sandbox: { methods: Record<string, unknown> } }).sandbox.methods;
		const stock = methodsOf(e2b({ apiKey: "e2b_unit-test-key" }));
		const patched = methodsOf(compute);
		for (const method of ["create", "getById", "destroy", "list"] as const) {
			// Precondition that makes the inequality below meaningful: the wrapper hands every instance
			// the SAME module-level methods object (defineProvider passes it by reference). If an upgrade
			// switches to per-instance closures, this fails loudly instead of the patch check passing
			// vacuously against a never-shared function.
			expect(methodsOf(e2b({ apiKey: "e2b_unit-test-key" }))[method]).toBe(stock[method]);
			expect(patched[method]).not.toBe(stock[method]);
		}
		expect(patched.runCommand).toBe(runE2bCommandAsRoot);
		expect(patched.runCommand).not.toBe(stock.runCommand);
		expect(compute.snapshot).toBeUndefined();
		// `template` is a runtime property of the generated provider (computesdk's type doesn't model
		// it), so reach through a structural cast to pin its removal too.
		expect((compute as { template?: unknown }).template).toBeUndefined();
	});

	it("refuses construction without a key, unconditionally", () => {
		// The factory (not env state) owns the missing-credential error, so this holds even in an
		// environment where NOVITA_API_KEY is set.
		expect(() => novitaCompute(undefined)).toThrow(/NOVITA_API_KEY/);
	});

	it("keeps the account key in the SDK's apiKey channel — never in connection headers", () => {
		// SECURITY PIN: the SDK replays connection `headers` into the envd RPC transport, so a
		// credential riding `headers` is delivered to the daemon INSIDE the guest on every
		// command/filesystem call — where TLS has already terminated and any root process (including
		// a supply-chain-compromised benchmark suite) can read it. `apiKey` becomes an X-API-KEY
		// header inside the control-plane ApiClient only. If a future revision reintroduces a headers
		// override (e.g. to dodge a key-format guard again), this must fail.
		const connection = novitaConnection("nvta_unit-test-key");
		expect(connection).toEqual({
			apiKey: "nvta_unit-test-key",
			domain: NOVITA_E2B_DOMAIN,
		});
		expect(connection).not.toHaveProperty("headers");
	});

	it("boots novita from the configured template, erroring on use — not import — without a key", () => {
		const novita = providers.find((p) => p.name === "novita");
		expect(novita).toBeDefined();
		expect(novita?.requiredEnvVars).toEqual(["NOVITA_API_KEY"]);
		expect(novita?.createOptions?.snapshotId).toBe(config.novitaTemplate);
		// The registry module must stay importable without credentials; the factory throws only when
		// the harness actually selects the provider (after its requiredEnvVars gate).
		if (!process.env.NOVITA_API_KEY) {
			expect(() => novita?.createCompute()).toThrow(/NOVITA_API_KEY/);
		}
	});

	it("keeps Daytona alive for long suites and pins region off createOptions", () => {
		const daytona = providers.find((p) => p.name === "daytona-vm");
		expect(daytona).toBeDefined();
		expect(daytona?.createOptions?.snapshotId).toBe(config.daytonaVm.snapshot);
		// ComputeSDK maps its universal timeout to the Daytona SDK's create-operation timeout, not the
		// sandbox lifetime. Pass the native option through so an 8+ minute detached suite is not stopped
		// underneath the harness; runSuite's finally block remains the cleanup authority.
		expect(daytona?.createOptions?.autoStopInterval).toBe(0);

		// The container variant shares the account key and region but boots its own snapshot. The
		// region pin must NOT ride createOptions — the native SDK ignores createParams.target (only the
		// client-level target reaches the wire), so a reintroduced `target` createOption here would be
		// dead code masquerading as a region pin; daytona-target.ts owns the real channel.
		const container = providers.find((p) => p.name === "daytona-container");
		expect(container?.createOptions?.snapshotId).toBe(config.daytonaContainer.snapshot);
		expect(container?.createOptions).not.toHaveProperty("target");

		// No adapter override — requiredEnvVars falls back to the schema meta's static list. Pin the
		// concrete value rather than only comparing the two lookups against each other: if both `find`s
		// missed (provider renamed on one side), `undefined === undefined` would pass — a false green.
		const daytonaMeta = PROVIDERS.find((m) => m.id === "daytona-vm");
		expect(daytonaMeta?.requiredEnvVars).toEqual(["DAYTONA_API_KEY"]);
		expect(daytona?.requiredEnvVars).toEqual(daytonaMeta?.requiredEnvVars);
	});

	it("keeps Microsandbox local and cloud as separate, capability-accurate providers", () => {
		const base = {
			image: config.toolchainImage,
			cpus: TARGET_SPEC.vcpus,
			memoryMib: TARGET_SPEC.memoryGb * 1024,
			rootDiskMib: TARGET_SPEC.diskGb * 1024,
			namePrefix: "test-msb-",
			timeoutMs: 10_800_000,
		} as const;
		const local = microsandboxLocalCompute({
			...base,
			variant: "microsandbox-local",
			backend: "local",
			ephemeral: false,
		});
		const cloud = microsandboxCloudCompute({
			...base,
			variant: "microsandbox-cloud",
			backend: { kind: "cloud", url: "https://msb.invalid", apiKey: "unit-test-key" },
			ephemeral: true,
		});

		expect(local.name).toBe("microsandbox-local");
		expect(local.snapshot).toBeDefined();
		expect(cloud.name).toBe("microsandbox-cloud");
		// Cloud snapshots are not implemented by msb-cloud yet. Omitting the manager makes the lifecycle
		// harness record an explicit skipped capability instead of attempting a knowingly invalid call.
		expect(cloud.snapshot).toBeUndefined();

		const localAdapter = providers.find((provider) => provider.name === "microsandbox-local");
		const cloudAdapter = providers.find((provider) => provider.name === "microsandbox-cloud");
		expect(localAdapter?.requiredEnvVars).toEqual(["MICROSANDBOX_LOCAL_BENCH"]);
		expect(cloudAdapter?.requiredEnvVars).toEqual(["MSB_API_KEY"]);
		expect(localAdapter?.createOptions).toEqual({ templateId: config.toolchainImage });
		expect(cloudAdapter?.createOptions).toEqual({ templateId: config.toolchainImage });
		// The control-plane credential belongs only to the SDK backend config; it must never enter the
		// universal create options because those can be translated into guest-visible provider fields.
		expect(JSON.stringify(cloudAdapter?.createOptions)).not.toContain("unit-test-key");
	});

	it("defers missing Microsandbox Cloud credentials until that provider is selected", () => {
		const cloud = providers.find((provider) => provider.name === "microsandbox-cloud");
		expect(cloud).toBeDefined();
		if (!process.env.MSB_API_KEY) {
			expect(() => cloud?.createCompute()).toThrow(/MSB_API_KEY/);
		}
	});

	it("passes E2B-compatible cwd and env options through envd's structured root channel", async () => {
		const calls: Array<{ command: string; options?: Record<string, unknown> }> = [];
		const sandbox = {
			commands: {
				run: async (command: string, options?: Record<string, unknown>) => {
					calls.push({ command, options });
					return { stdout: "ok", stderr: "", exitCode: 0 };
				},
			},
		};
		const result = await runE2bCommandAsRoot(sandbox as never, "echo hi", {
			cwd: "/work dir",
			env: { TOKEN: "not a shell; value" },
			timeout: 1234,
		});

		expect(result).toMatchObject({ stdout: "ok", stderr: "", exitCode: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			command: "echo hi",
			options: {
				user: "root",
				cwd: "/work dir",
				envs: { TOKEN: "not a shell; value" },
				timeoutMs: 1234,
				background: false,
			},
		});
	});

	it("forwards ComputeSDK stream callbacks through the patched E2B command path", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const sandbox = {
			commands: {
				run: async (
					_command: string,
					options?: {
						onStdout?: (chunk: string) => void;
						onStderr?: (chunk: string) => void;
					},
				) => {
					options?.onStdout?.("live stdout");
					options?.onStderr?.("live stderr");
					return { stdout: "live stdout", stderr: "live stderr", exitCode: 0 };
				},
			},
		};

		await runE2bCommandAsRoot(sandbox as never, "echo hi", {
			onStdout: (chunk) => stdout.push(chunk),
			onStderr: (chunk) => stderr.push(chunk),
		});

		expect(stdout).toEqual(["live stdout"]);
		expect(stderr).toEqual(["live stderr"]);
	});

	it("translates a native background handle into ComputeSDK's completed launch result", async () => {
		const calls: Array<{ command: string; options?: Record<string, unknown> }> = [];
		const sandbox = {
			commands: {
				run: async (command: string, options?: Record<string, unknown>) => {
					calls.push({ command, options });
					return { pid: 42 };
				},
			},
		};
		const result = await runE2bCommandAsRoot(sandbox as never, "long command", {
			background: true,
		});

		expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
		expect(calls).toEqual([
			{ command: "long command", options: { user: "root", background: true } },
		]);
	});

	it("recovers a failed command's structured result when the SDK throws it", async () => {
		const sandbox = {
			commands: {
				run: async () => {
					throw { result: { stdout: "partial", stderr: "boom", exitCode: 2 } };
				},
			},
		};
		const result = await runE2bCommandAsRoot(sandbox as never, "false", {});
		expect(result).toMatchObject({ stdout: "partial", stderr: "boom", exitCode: 2 });
	});

	it("defaults a thrown result's missing fields rather than crashing", async () => {
		const sandbox = {
			commands: {
				run: async () => {
					throw { result: {} };
				},
			},
		};
		const result = await runE2bCommandAsRoot(sandbox as never, "false", {});
		expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 1 });
	});
});

describe("assertProviderJoin", () => {
	it("passes silently when the schema ids and the adapter ids are the same set", () => {
		// The real registries are already index-aligned, so the live module load (above) exercises the
		// happy path; assert it explicitly here too, including when order differs between the two sides.
		expect(() =>
			assertProviderJoin(["e2b", "daytona", "modal"], ["modal", "e2b", "daytona"]),
		).not.toThrow();
		expect(() =>
			assertProviderJoin(
				PROVIDERS.map((m) => m.id).filter(
					(id) => id !== "e2b" && id !== "modal-gvisor" && id !== "modal-vm" && id !== "tama",
				),
				providers.map((p) => p.name),
			),
		).not.toThrow();
	});

	it("throws naming a provider that's in the schema but missing an adapter", () => {
		// A provider added to the schema registry without a matching harness adapter — the compile-time
		// Record can't catch this across a version drift, so the runtime guard must.
		expect(() => assertProviderJoin(["e2b", "daytona", "modal"], ["e2b", "daytona"])).toThrow(
			/missing a harness adapter: modal/,
		);
	});

	it("throws naming an adapter that has no schema entry", () => {
		expect(() => assertProviderJoin(["e2b", "daytona"], ["e2b", "daytona", "modal"])).toThrow(
			/no schema PROVIDERS entry: modal/,
		);
	});

	it("reports both one-sided directions at once", () => {
		const err = (() => {
			try {
				assertProviderJoin(["e2b", "ghost"], ["e2b", "modal"]);
			} catch (e) {
				return e as Error;
			}
		})();
		expect(err?.message).toContain("missing a harness adapter: ghost");
		expect(err?.message).toContain("no schema PROVIDERS entry: modal");
	});
});

describe("assertCreateCeilingDeclared", () => {
	it("passes for adapters the harness bounds itself, whether or not they set a timeout", () => {
		expect(() =>
			assertCreateCeilingDeclared({ e2b: {}, modal: { createTimeoutMs: 10 * 60 * 1000 } }),
		).not.toThrow();
	});

	it("passes when an adapter that disables the race declares its own ceiling", () => {
		expect(() =>
			assertCreateCeilingDeclared({
				runcloud: { createTimeoutMs: null, createAttemptCeilingMs: 20 * 60 * 1000 },
			}),
		).not.toThrow();
	});

	it("throws naming an adapter that disabled the race without declaring a ceiling", () => {
		// The pairing the create-retry budget depends on: with the harness race off and no ceiling, the
		// loop has nothing to subtract and can start an attempt that outlives the budget.
		expect(() =>
			assertCreateCeilingDeclared({ e2b: {}, runcloud: { createTimeoutMs: null } }),
		).toThrow(/runcloud disabled the harness create timeout/);
	});

	it("throws on a ceiling that is present but cannot bound anything", () => {
		// Zero, negative, and NaN (arithmetic over an unset constant) all reserve nothing, so they are
		// the same overrun wearing a declared field — and a declared value reads as compliance, which
		// makes it the more dangerous shape of the two.
		for (const createAttemptCeilingMs of [0, -1, Number.NaN]) {
			expect(() =>
				assertCreateCeilingDeclared({
					runcloud: { createTimeoutMs: null, createAttemptCeilingMs },
				}),
			).toThrow(/without declaring a positive createAttemptCeilingMs/);
		}
	});

	it("holds for the real registry, so every race-disabling provider is budgetable", () => {
		// run.cloud is the live instance of this shape; assert against the registry rather than naming
		// it, so a future adapter that disables the race is covered by the same test.
		expect(() =>
			assertCreateCeilingDeclared(Object.fromEntries(providers.map((p) => [p.name, p]))),
		).not.toThrow();
		const raceDisabled = providers.filter((p) => p.createTimeoutMs === null);
		expect(raceDisabled.length).toBeGreaterThan(0);
		for (const p of raceDisabled) expect(p.createAttemptCeilingMs).toBeGreaterThan(0);
	});
});
