import { describe, expect, test } from "bun:test";
import type { CreateRequest, ExecOptions, SandboxDriver } from "@sandbox-benchmarks/driver";
import {
	DriverError,
	FailedCreateCleanupError,
	isRetryableDriverCreate,
} from "@sandbox-benchmarks/driver";
import { type } from "arktype";
import type {
	ComputeSdkCreateRequestCoverage,
	ComputeSdkCreateRequestMapper,
	ComputeSdkDriverModuleSpec,
	ComputeSdkDriverSpec,
	ComputeSdkLike,
	ComputeSdkNativeOf,
	ComputeSdkSandboxLike,
} from "./computesdk.ts";
import { computeSdkSpec, defineComputeSdkDriver } from "./computesdk.ts";

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: { kind: "baked", ref: "template-1" },
	deadlineMs: 30_000,
};

function fakeCompute<TSandbox extends ComputeSdkSandboxLike>(sandbox: TSandbox, withList = false) {
	const createOptionsSeen: object[] = [];
	const compute: ComputeSdkLike<TSandbox> = {
		sandbox: {
			create: async (options) => {
				createOptionsSeen.push(options ?? {});
				return sandbox;
			},
			...(withList ? { list: async () => ["sb-1"] } : {}),
		},
	};
	return { compute, createOptionsSeen };
}

const nativeSandbox = { commands: { run: async () => "native-result" } };

const baseSandbox: ComputeSdkSandboxLike<typeof nativeSandbox> = {
	sandboxId: "i2f3k4abc",
	getInstance: () => nativeSandbox,
	runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
	destroy: async () => {},
};

const e2bSandboxId = type(/^i[a-z0-9]+$/);

const mappedCoverage = {
	spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "mapped", count: "mapped" },
	env: "mapped",
} as const satisfies ComputeSdkCreateRequestCoverage;

const artifactCoverage = {
	spec: { vcpus: { artifact: 4 }, memoryGb: { artifact: 8 }, diskGb: { artifact: 40 } },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies ComputeSdkCreateRequestCoverage;

const bridgePolicy = {
	provenance: { packageName: "@computesdk/fake", version: "1.0.0" },
	readiness: { startup: "create-returns-ready" },
	execution: { syncCapMs: 60_000, durable: "shell-detach" },
	// The generic bridge fixture maps GPU request axes, so it must also declare how the shared gate
	// would observe them. Production providers that reject GPU requests omit this strategy.
	accelerator: {
		family: "test",
		command: "test-gpu-observation",
		parse: () => ({ model: "test-gpu", count: 1 }),
		matches: () => true,
	},
} as const;

const createRequestMapper = (
	map: ComputeSdkCreateRequestMapper["map"] = () => ({}),
	coverage: ComputeSdkCreateRequestCoverage = mappedCoverage,
): ComputeSdkCreateRequestMapper => ({ coverage, map });

function expectCredentialSafe(error: unknown, code?: DriverError["code"]): DriverError {
	const typed = error as DriverError;
	if (code !== undefined) expect(typed.code).toBe(code);
	expect(typed.message).not.toContain("test-key");
	expect(typed.vendorMessage ?? "").not.toContain("test-key");
	expect(String(typed.cause ?? "")).not.toContain("test-key");
	return typed;
}

function expectRedacted(error: unknown, code?: DriverError["code"]): void {
	const typed = expectCredentialSafe(error, code);
	expect(`${typed.message} ${typed.vendorMessage ?? ""}`).toContain("[REDACTED]");
}

function expectOmitted(error: unknown, code?: DriverError["code"]): void {
	const typed = expectCredentialSafe(error, code);
	expect(`${typed.message} ${String(typed.cause ?? "")}`).toContain("omitted");
}

function bridge<TSandbox extends ComputeSdkSandboxLike>(
	compute: ComputeSdkLike<TSandbox>,
	options: Partial<
		Omit<ComputeSdkDriverSpec<ComputeSdkLike<TSandbox>>, "compute" | "sandboxId" | "createOptions">
	> & {
		readonly createOptions?: ComputeSdkCreateRequestMapper["map"];
		readonly requestCoverage?: ComputeSdkCreateRequestCoverage;
		readonly sandboxId?: ComputeSdkDriverSpec<ComputeSdkLike<TSandbox>>["sandboxId"];
	} = {},
): SandboxDriver<ComputeSdkNativeOf<TSandbox>> {
	return defineComputeSdkDriver("e2b", {
		...bridgePolicy,
		spec: ({ env, artifact, resolvedArtifact }) => {
			expect(env.E2B_API_KEY).toBe("test-key");
			expect(artifact).toEqual({ kind: "baked" });
			expect(resolvedArtifact).toEqual({ kind: "baked", ref: "template-1" });
			const { createOptions, requestCoverage, sandboxId, ...rest } = options;
			return {
				compute,
				sandboxId: sandboxId ?? e2bSandboxId,
				createOptions: createRequestMapper(createOptions, requestCoverage),
				hasWorkingFilesystem: false,
				...rest,
			};
		},
	}).driver({
		env: { E2B_API_KEY: "test-key" },
		artifact: { kind: "baked" },
		resolvedArtifact: { kind: "baked", ref: "template-1" },
	});
}

describe("computeSdkDriver", () => {
	test("rejects native-launch policy before allocation when the provider spec has no launch", () => {
		let createCalls = 0;
		const compute = {
			sandbox: {
				create: async () => {
					createCalls += 1;
					return baseSandbox;
				},
			},
		};
		const module_ = defineComputeSdkDriver("e2b", {
			...bridgePolicy,
			execution: { syncCapMs: 60_000, durable: "native-launch" },
			spec: () => ({
				compute,
				sandboxId: e2bSandboxId,
				createOptions: createRequestMapper(),
				hasWorkingFilesystem: false,
			}),
		});
		expect(() =>
			module_.driver({
				env: { E2B_API_KEY: "test-key" },
				artifact: { kind: "baked" },
				resolvedArtifact: { kind: "baked", ref: "template-1" },
			}),
		).toThrow(expect.objectContaining({ code: "vendor-contract-violation", provider: "e2b" }));
		expect(createCalls).toBe(0);
	});

	test("keeps the first compute argument authoritative when an extracted spec has excess state", () => {
		const { compute: authoritative } = fakeCompute(baseSandbox);
		const { compute: accidental } = fakeCompute({ ...baseSandbox, sandboxId: "iaccidental" });
		const extracted = {
			compute: accidental,
			sandboxId: e2bSandboxId,
			createOptions: createRequestMapper(),
			hasWorkingFilesystem: false,
		};
		const joined = computeSdkSpec(authoritative, extracted);
		expect(joined.compute).toBe(authoritative);
	});

	test("the joined helper has one provider id and contextually types its exact env slice", () => {
		const { compute } = fakeCompute(baseSandbox);
		const module_ = defineComputeSdkDriver("e2b", {
			...bridgePolicy,
			createBudget: { owner: "harness", timeoutMs: 45_000 },
			spec: ({ env, resolvedArtifact }) => ({
				compute,
				sandboxId: e2bSandboxId,
				createOptions: createRequestMapper(() => ({
					apiKeyWasResolved: env.E2B_API_KEY.length > 0,
					snapshotId: resolvedArtifact.ref,
				})),
				hasWorkingFilesystem: false,
			}),
		});
		expect(module_.id).toBe("e2b");
		expect(module_.createBudget).toEqual({ owner: "harness", timeoutMs: 45_000 });

		const driverOwnedBudget = () =>
			defineComputeSdkDriver("e2b", {
				...bridgePolicy,
				// @ts-expect-error — the wrapper exposes no cancellable hard attempt ceiling
				createBudget: { owner: "driver", attemptCeilingMs: 45_000 },
				spec: () => ({
					compute,
					sandboxId: e2bSandboxId,
					createOptions: createRequestMapper(),
					hasWorkingFilesystem: false,
				}),
			});
		void driverOwnedBudget;
		expect(() =>
			defineComputeSdkDriver("e2b", {
				...bridgePolicy,
				createBudget: { owner: "driver", attemptCeilingMs: 45_000 } as never,
				spec: () => ({
					compute,
					sandboxId: e2bSandboxId,
					createOptions: createRequestMapper(),
					hasWorkingFilesystem: false,
				}),
			}),
		).toThrow(expect.objectContaining({ code: "vendor-contract-violation", provider: "e2b" }));

		const uncheckedParser = () =>
			defineComputeSdkDriver("e2b", {
				...bridgePolicy,
				spec: () => ({
					compute,
					// @ts-expect-error — module-owned ids must cross an arktype trust boundary
					sandboxId: (value: string) => value,
					createOptions: createRequestMapper(),
					hasWorkingFilesystem: false,
				}),
			});
		void uncheckedParser;

		const missingRequestMapper = () =>
			defineComputeSdkDriver("e2b", {
				...bridgePolicy,
				// @ts-expect-error — every provider must explicitly validate/map the canonical request
				spec: () => ({
					compute,
					sandboxId: e2bSandboxId,
					hasWorkingFilesystem: false,
				}),
			});
		void missingRequestMapper;

		const missingTargetAxis = () =>
			createRequestMapper(undefined, {
				// @ts-expect-error — every TargetSpec key is an explicit review decision
				spec: { vcpus: "mapped", memoryGb: "mapped" },
				artifact: "context",
				deadlineMs: "harness",
				gpu: { model: "mapped", count: "mapped" },
				env: "mapped",
			});
		void missingTargetAxis;

		const missingOptionalAxis = () =>
			createRequestMapper(undefined, {
				spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
				artifact: "context",
				deadlineMs: "harness",
				// @ts-expect-error — GPU model and count cannot drift independently
				gpu: { model: "mapped" },
				env: "mapped",
			});
		void missingOptionalAxis;

		const missingTopLevelAxis = () =>
			createRequestMapper(
				undefined,
				// @ts-expect-error — every current and future top-level CreateRequest key is required
				{
					spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
					artifact: "context",
					deadlineMs: "harness",
					gpu: { model: "mapped", count: "mapped" },
				},
			);
		void missingTopLevelAxis;
	});

	test("snapshots joined module policy once and omits hostile getter diagnostics", () => {
		const { compute } = fakeCompute(baseSandbox);
		const context = {
			env: { E2B_API_KEY: "test-key" },
			artifact: { kind: "baked" },
			resolvedArtifact: { kind: "baked", ref: "template-1" },
		} as const;
		let budgetReads = 0;
		let specReads = 0;
		const budget = { owner: "harness" as const, timeoutMs: 45_000 };
		let specFactory: ComputeSdkDriverModuleSpec<"e2b", typeof compute>["spec"] = () => ({
			compute,
			sandboxId: e2bSandboxId,
			createOptions: createRequestMapper(),
			hasWorkingFilesystem: false,
		});
		const mutableModule = Object.defineProperties(
			{},
			{
				provenance: { value: bridgePolicy.provenance, enumerable: true },
				readiness: { value: bridgePolicy.readiness, enumerable: true },
				execution: { value: bridgePolicy.execution, enumerable: true },
				createBudget: {
					enumerable: true,
					get: () => {
						budgetReads += 1;
						return budget;
					},
				},
				spec: {
					enumerable: true,
					get: () => {
						specReads += 1;
						return specFactory;
					},
				},
			},
		) as ComputeSdkDriverModuleSpec<"e2b", typeof compute>;
		const module_ = defineComputeSdkDriver("e2b", mutableModule);
		budget.timeoutMs = 1;
		specFactory = () => {
			throw new Error("mutated-module-secret");
		};
		expect(module_.createBudget).toEqual({ owner: "harness", timeoutMs: 45_000 });
		expect(Object.isFrozen(module_.createBudget)).toBe(true);
		expect(typeof module_.driver(context).create).toBe("function");
		expect({ budgetReads, specReads }).toEqual({ budgetReads: 1, specReads: 1 });

		for (const hostileField of ["createBudget", "spec"] as const) {
			const secret = `hostile-${hostileField}-secret`;
			const hostileModule = Object.defineProperties(
				{},
				{
					provenance: { value: bridgePolicy.provenance, enumerable: true },
					readiness: { value: bridgePolicy.readiness, enumerable: true },
					execution: { value: bridgePolicy.execution, enumerable: true },
					createBudget: { value: { owner: "harness", timeoutMs: 45_000 }, enumerable: true },
					spec: { value: specFactory, enumerable: true },
					[hostileField]: {
						enumerable: true,
						get: () => {
							throw new Error(secret);
						},
					},
				},
			) as ComputeSdkDriverModuleSpec<"e2b", typeof compute>;
			let error: unknown;
			try {
				defineComputeSdkDriver("e2b", hostileModule);
			} catch (caught) {
				error = caught;
			}
			expectCredentialSafe(error, "vendor-contract-violation");
			expect(String((error as Error).message)).not.toContain(secret);
			expect(String((error as Error & { cause?: unknown }).cause ?? "")).not.toContain(secret);
		}
	});

	test("omits arbitrary module-spec diagnostics before an SDK escapes", () => {
		const secret = "closure-only-computesdk-secret";
		const module_ = defineComputeSdkDriver<"e2b", ComputeSdkLike>("e2b", {
			...bridgePolicy,
			spec: (): ComputeSdkDriverSpec<ComputeSdkLike> => {
				const nested = Object.assign(new Error(`nested ${secret}`), { credential: secret });
				throw Object.assign(new Error(`factory ${secret}`, { cause: nested }), {
					credential: secret,
				});
			},
		});
		let error: unknown;
		try {
			module_.driver({
				env: { E2B_API_KEY: "test-key" },
				artifact: { kind: "baked" },
				resolvedArtifact: { kind: "baked", ref: "template-1" },
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
		expectOmitted(error, "vendor-contract-violation");
		expect((error as Error).message).not.toContain(secret);
		expect(String((error as Error).cause)).not.toContain(secret);
		expect(((error as Error).cause as Error).cause).toBeUndefined();
	});

	test("snapshots nested recovery policy before an ambiguous create runs", async () => {
		const secret = "compute-module-secret";
		let maxAttemptReads = 0;
		const recovery = new Proxy(
			{
				absenceConfirmationMs: 1,
				maxAttempts: 2,
				locator: () => ({ kind: "name" as const, value: "attempt-1" }),
				cleanup: async () => ({ status: "destroyed" as const }),
			},
			{
				get(target, property, receiver) {
					if (property === "maxAttempts" && maxAttemptReads++ > 0) throw new Error(secret);
					return Reflect.get(target, property, receiver);
				},
			},
		);
		const driver = bridge(
			{
				sandbox: { create: async () => Promise.reject(new Error("response lost")) },
			},
			{ createRecovery: recovery },
		);
		const error = (await driver.create(request).catch((caught: unknown) => caught)) as DriverError;
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(error.message).not.toContain(secret);
		expect(maxAttemptReads).toBe(1);
	});

	test("passes composition-resolved create options without confusing deadline with lifetime", async () => {
		const { compute, createOptionsSeen } = fakeCompute(baseSandbox);
		const driver = bridge(compute, {
			createOptions: ({ spec, gpu, env }) => ({
				snapshotId: "template-1",
				cpu: spec.vcpus,
				memoryMiB: spec.memoryGb * 1024,
				diskGb: spec.diskGb,
				gpuModel: gpu?.model,
				gpuCount: gpu?.count,
				guestEnv: env,
			}),
			hasWorkingFilesystem: false,
		});
		const session = await driver.create({
			...request,
			gpu: { model: "H100", count: 2 },
			env: { BENCH_RUN_ID: "run-1" },
		});
		expect(session.sandboxRef).toEqual({ provider: "e2b", id: "i2f3k4abc" });
		expect(session.artifact).toEqual({ kind: "baked", ref: "template-1" });
		expect(session.native).toBe(nativeSandbox);
		expect(await session.native.commands.run()).toBe("native-result");
		expect(createOptionsSeen).toEqual([
			{
				snapshotId: "template-1",
				cpu: 4,
				memoryMiB: 8192,
				diskGb: 40,
				gpuModel: "H100",
				gpuCount: 2,
				guestEnv: { BENCH_RUN_ID: "run-1" },
			},
		]);
	});

	test("preserves an explicitly undefined wrapper native value", async () => {
		const { compute } = fakeCompute({ ...baseSandbox, getInstance: () => undefined });
		const session = await bridge(compute).create(request);
		expect(session.native).toBeUndefined();
	});

	test("preflights create-option mapping before the wrapper can allocate", async () => {
		const secret = "mapper-closure-secret";
		let createCalls = 0;
		const compute: ComputeSdkLike<typeof baseSandbox> = {
			sandbox: {
				create: async () => {
					createCalls += 1;
					return baseSandbox;
				},
			},
		};
		const error = await bridge(compute, {
			createOptions: () => {
				throw Object.assign(new Error(`capacity mapping leaked ${secret}`), {
					credential: secret,
				});
			},
		})
			.create({ ...request, gpu: { model: "unsupported", count: 1 } })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
		expect((error as Error).message).not.toContain(secret);
		expect(String((error as Error).cause)).not.toContain(secret);
		expect(createCalls).toBe(0);
	});

	test("omits post-create hook diagnostics and still tears the accepted handle down", async () => {
		const secret = "post-allocation-callback-secret";
		let destroys = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
			},
		});
		const error = (await bridge(compute, {
			prepareAndVerifyCreatedRequest: async () => {
				const nested = Object.assign(new Error(`nested ${secret}`), { credential: secret });
				throw Object.assign(new Error(`verification ${secret}`, { cause: nested }), {
					credential: secret,
				});
			},
		})
			.create(request)
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(error.message).not.toContain(secret);
		expect(String(error.cause)).not.toContain(secret);
		expect(destroys).toBe(1);
	});

	test("rolls back when the caller aborts during an uncancellable post-create hook", async () => {
		let destroys = 0;
		const cancellation = new AbortController();
		const { compute } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
			},
		});
		const error = await bridge(compute, {
			prepareAndVerifyCreatedRequest: async () => {
				cancellation.abort(new Error("caller stopped waiting"));
				return { status: "honored" };
			},
		})
			.create(request, { signal: cancellation.signal })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect((error as Error).message).toContain("was aborted");
		expect(destroys).toBe(1);
	});

	test("retains cleanup when post-create abort rollback double-faults", async () => {
		let destroys = 0;
		const cancellation = new AbortController();
		const { compute } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
				if (destroys === 1) throw new Error("transient cleanup failure");
			},
		});
		const error = (await bridge(compute, {
			prepareAndVerifyCreatedRequest: async () => {
				cancellation.abort(new Error("caller stopped waiting"));
				return { status: "honored" };
			},
		})
			.create(request, { signal: cancellation.signal })
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error.locator).toEqual({ kind: "id", value: "i2f3k4abc" });
		expect(error.suppressed).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(error.error).toMatchObject({ code: "destroy-failed", provider: "e2b" });
		await error.cleanup();
		expect(destroys).toBe(2);
	});

	test("post-create hook failure double-fault retains canonical ownership without accessor rereads", async () => {
		let identityReads = 0;
		let nativeReads = 0;
		let destroys = 0;
		const stableNative = { id: "native" };
		const sandbox: ComputeSdkSandboxLike = {
			...baseSandbox,
			get sandboxId() {
				identityReads += 1;
				if (identityReads > 1) throw new Error("identity reread");
				return "i2f3k4abc";
			},
			getInstance: () => {
				nativeReads += 1;
				if (nativeReads > 1) throw new Error("native reread");
				return stableNative;
			},
		};
		const { compute } = fakeCompute(sandbox);
		const error = (await bridge(compute, {
			prepareAndVerifyCreatedRequest: async () => {
				throw new Error("preparation failed");
			},
			lifecycle: {
				destroy: async (_sandbox, ref) => {
					destroys += 1;
					expect(ref?.id).toBe("i2f3k4abc");
					if (destroys === 1) throw new Error("transient cleanup failure");
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error.locator).toEqual({ kind: "id", value: "i2f3k4abc" });
		expect(error.suppressed).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(error.error).toMatchObject({ code: "destroy-failed", provider: "e2b" });
		await error.cleanup();
		expect(destroys).toBe(2);
		expect(identityReads).toBe(1);
		expect(nativeReads).toBe(1);
	});

	test("rejects an unsupported canonical axis as terminal input before allocation", async () => {
		let createCalls = 0;
		const compute: ComputeSdkLike<typeof baseSandbox> = {
			sandbox: {
				create: async () => {
					createCalls += 1;
					return baseSandbox;
				},
			},
		};
		const error = await bridge(compute, {
			requestCoverage: artifactCoverage,
		})
			.create({ ...request, gpu: { model: "H100", count: 2 } })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "invalid-create-request", provider: "e2b" });
		expect((error as Error).message).toContain("GPU H100 x2 is unsupported");
		expect(createCalls).toBe(0);
	});

	test("rejects unknown runtime coverage axes before allocation", () => {
		let createCalls = 0;
		const compute: ComputeSdkLike<typeof baseSandbox> = {
			sandbox: {
				create: async () => {
					createCalls += 1;
					return baseSandbox;
				},
			},
		};
		const futureCoverage = {
			...mappedCoverage,
			network: "unsupported",
			gpu: { ...mappedCoverage.gpu, partition: "unsupported" },
		} as unknown as ComputeSdkCreateRequestCoverage;
		expect(() => bridge(compute, { requestCoverage: futureCoverage })).toThrow(
			expect.objectContaining({ code: "vendor-contract-violation", provider: "e2b" }),
		);
		expect(createCalls).toBe(0);
	});

	test("rejects enumerable prototype pollution without consulting inherited accessors", () => {
		const secret = "closure-only-coverage-secret";
		let poisonedReads = 0;
		const poisonedPrototype = Object.defineProperty({}, "spec", {
			get() {
				poisonedReads += 1;
				throw new Error(secret);
			},
			set() {},
		});
		const requestCoverage: Record<string, unknown> = {};
		Object.defineProperty(requestCoverage, "__proto__", {
			value: poisonedPrototype,
			enumerable: true,
		});
		for (const [key, value] of Object.entries(artifactCoverage)) {
			Object.defineProperty(requestCoverage, key, { value, enumerable: true });
		}
		let createCalls = 0;
		let error: unknown;
		try {
			bridge(
				{
					sandbox: {
						create: async () => {
							createCalls++;
							return baseSandbox;
						},
					},
				},
				{ requestCoverage: requestCoverage as ComputeSdkCreateRequestCoverage },
			);
		} catch (caught) {
			error = caught;
		}
		expectCredentialSafe(error, "vendor-contract-violation");
		expect(String((error as Error).message)).not.toContain(secret);
		expect(String((error as Error & { cause?: unknown }).cause ?? "")).not.toContain(secret);
		expect(poisonedReads).toBe(0);
		expect(createCalls).toBe(0);
	});

	test("requires every canonical coverage axis and exact ownership literal before allocation", () => {
		const malformedCoverages = [
			{
				...mappedCoverage,
				spec: { vcpus: "mapped", diskGb: "mapped" },
			},
			{
				...mappedCoverage,
				gpu: { model: "mapped" },
			},
			{
				spec: mappedCoverage.spec,
				artifact: "context",
				deadlineMs: "harness",
				gpu: mappedCoverage.gpu,
			},
			{ ...mappedCoverage, artifact: "request" },
			{ ...mappedCoverage, deadlineMs: "driver" },
		] as unknown as readonly ComputeSdkCreateRequestCoverage[];
		let createCalls = 0;
		for (const requestCoverage of malformedCoverages) {
			expect(() =>
				bridge(
					{
						sandbox: {
							create: async () => {
								createCalls += 1;
								return baseSandbox;
							},
						},
					},
					{ requestCoverage },
				),
			).toThrow(expect.objectContaining({ code: "vendor-contract-violation", provider: "e2b" }));
		}
		expect(createCalls).toBe(0);
	});

	test("reports the configured artifact so the shared mismatch guard destroys a wrong boot", async () => {
		let destroys = 0;
		const { compute, createOptionsSeen } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
			},
		});
		const module_ = defineComputeSdkDriver("e2b", {
			...bridgePolicy,
			spec: ({ resolvedArtifact }) => ({
				compute,
				sandboxId: e2bSandboxId,
				createOptions: createRequestMapper(
					() => ({ snapshotId: resolvedArtifact.ref }),
					artifactCoverage,
				),
				hasWorkingFilesystem: false,
			}),
		});
		const driver = module_.driver({
			env: { E2B_API_KEY: "test-key" },
			artifact: { kind: "baked" },
			resolvedArtifact: { kind: "baked", ref: "template-context" },
		});
		const error = await driver
			.create({ ...request, artifact: { kind: "baked", ref: "template-request" } })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "artifact-mismatch" });
		expect(createOptionsSeen).toEqual([{ snapshotId: "template-context" }]);
		expect(destroys).toBe(1);
	});

	test("an artifact-mismatch cleanup fault retains the validated wrapper allocation", async () => {
		let destroys = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
				if (destroys === 1) throw new Error("transient destroy failure");
			},
		});
		const module_ = defineComputeSdkDriver("e2b", {
			...bridgePolicy,
			spec: ({ resolvedArtifact }) => ({
				compute,
				sandboxId: e2bSandboxId,
				createOptions: createRequestMapper(
					() => ({ snapshotId: resolvedArtifact.ref }),
					artifactCoverage,
				),
				hasWorkingFilesystem: false,
			}),
		});
		const driver = module_.driver({
			env: { E2B_API_KEY: "test-key" },
			artifact: { kind: "baked" },
			resolvedArtifact: { kind: "baked", ref: "template-context" },
		});
		const error = (await driver
			.create({ ...request, artifact: { kind: "baked", ref: "template-request" } })
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error.locator).toEqual({ kind: "id", value: "i2f3k4abc" });
		expect(error.suppressed).toMatchObject({ code: "artifact-mismatch" });
		await error[Symbol.asyncDispose]();
		expect(destroys).toBe(2);
	});

	test("an invalid unparsed id never masquerades as a stable cleanup locator", async () => {
		const invalidId = "wrong-id";
		const { compute } = fakeCompute({
			...baseSandbox,
			sandboxId: invalidId,
			destroy: async () => {
				throw new Error("cleanup unavailable");
			},
		});
		const error = (await bridge(compute)
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error.locator).toEqual({ kind: "native-handle" });
		expect(error.message).not.toContain(invalidId);
	});

	test("an invalid returned id reconciles the preallocated name across a transient first miss", async () => {
		const { compute } = fakeCompute({ ...baseSandbox, sandboxId: "wrong-id" });
		let recoveryCalls = 0;
		let lifecycleCalls = 0;
		const error = (await bridge(compute, {
			createOptions: () => ({ name: "benchmark-stable" }),
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 3,
				locator: () => ({ kind: "name", value: "benchmark-stable" }),
				cleanup: async (_compute, locator) => {
					expect(locator).toEqual({ kind: "name", value: "benchmark-stable" });
					recoveryCalls += 1;
					return recoveryCalls === 1 ? { status: "absent" } : { status: "destroyed" };
				},
			},
			lifecycle: {
				destroy: async () => {
					lifecycleCalls += 1;
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error).toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
		expect(recoveryCalls).toBe(2);
		expect(lifecycleCalls).toBe(0);
	});

	test("redacts a credential-shaped invalid id from ArkType summaries before rollback returns", async () => {
		let destroys = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			sandboxId: "test-key",
			destroy: async () => {
				destroys += 1;
			},
		});
		const error = (await bridge(compute)
			.create(request)
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error).toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
		expect(error.message).not.toContain("test-key");
		expect(String(error.cause ?? "")).not.toContain("test-key");
		expect(error.message).toContain("[REDACTED]");
		expect(error.ref).toBeUndefined();
		expect(destroys).toBe(1);
	});

	test("types and redacts a throwing id parser through a failed rollback", async () => {
		let destroys = 0;
		const throwingSchema = type("string").narrow(() => {
			throw new Error("validator echoed test-key");
		});
		const { compute } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
				if (destroys === 1) throw new Error("cleanup echoed test-key");
			},
		});
		const error = (await bridge(compute, { sandboxId: throwingSchema })
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error.locator).toEqual({ kind: "native-handle" });
		expect(error.suppressed).toMatchObject({
			code: "vendor-contract-violation",
			provider: "e2b",
		});
		expectOmitted(error.suppressed, "vendor-contract-violation");
		expectRedacted(error.error, "destroy-failed");
		await error.cleanup();
		expect(destroys).toBe(2);
	});

	test("types and redacts a throwing id parser after a successful rollback", async () => {
		let destroys = 0;
		const throwingSchema = type("string").narrow(() => {
			throw new Error("validator echoed test-key");
		});
		const { compute } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
			},
		});
		const error = await bridge(compute, { sandboxId: throwingSchema })
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
		expectOmitted(error, "vendor-contract-violation");
		expect(destroys).toBe(1);
	});

	test("normalizes unreadable ArkType diagnostics and validates successful id outputs", async () => {
		const secret = "compute-schema-summary-secret";
		const realErrors = e2bSandboxId("wrong-id");
		if (!(realErrors instanceof type.errors)) throw new Error("test fixture unexpectedly parsed");
		const unreadableErrors = new Proxy(realErrors, {
			get(target, property, receiver) {
				if (property === "summary") throw new Error(`summary leaked ${secret}`);
				return Reflect.get(target, property, receiver);
			},
		});
		const unreadableSchema = new Proxy(e2bSandboxId, { apply: () => unreadableErrors });
		for (const sandboxId of [unreadableSchema, new Proxy(e2bSandboxId, { apply: () => ({}) })]) {
			let destroys = 0;
			const { compute } = fakeCompute({
				...baseSandbox,
				destroy: async () => {
					destroys += 1;
				},
			});
			const error = (await bridge(compute, { sandboxId: sandboxId as never })
				.create(request)
				.catch((caught: unknown) => caught)) as DriverError;
			expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
			expect(error.message).not.toContain(secret);
			expect(String(error.cause)).not.toContain(secret);
			expect(destroys).toBe(1);
		}
	});

	test("rejects an empty transformed id before constructing a session or stable locator", async () => {
		let destroys = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
			},
		});
		const error = await bridge(compute, {
			sandboxId: {
				fromVendor: type("string").pipe(() => ""),
				canonical: type("string >= 1"),
			},
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
		expect((error as Error).message).toContain("empty canonical id");
		expect(destroys).toBe(1);
	});

	test("types null and wrong-typed runtime sandbox ids before schema evaluation", async () => {
		for (const malformedId of [null, 42]) {
			let destroys = 0;
			const malformed = {
				...baseSandbox,
				sandboxId: malformedId,
				destroy: async () => {
					destroys += 1;
				},
			} as unknown as ComputeSdkSandboxLike;
			const { compute } = fakeCompute(malformed);
			const error = await bridge(compute)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
			expect((error as Error).message).toContain("nonempty string sandboxId");
			expect(destroys).toBe(1);
		}
	});

	test("redacts a throwing sandbox-id accessor and retains cleanup after a double fault", async () => {
		let destroys = 0;
		const malformed = {
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
				if (destroys === 1) throw new Error("cleanup echoed test-key");
			},
		};
		Object.defineProperty(malformed, "sandboxId", {
			get: () => {
				throw new Error("sandboxId getter echoed test-key");
			},
		});
		const { compute } = fakeCompute(malformed);
		const error = (await bridge(compute)
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expectCredentialSafe(error.suppressed, "vendor-contract-violation");
		expectRedacted(error.error, "destroy-failed");
		await error.cleanup();
		expect(destroys).toBe(2);
	});

	test("a withheld exit code becomes the representable unknown arm, never a forged number", async () => {
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => ({ stdout: "partial", stderr: "" }),
		});
		const session = await bridge(compute, {
			hasWorkingFilesystem: false,
		}).create(request);
		const result = await session.exec("true");
		expect(result.exit).toEqual({
			kind: "unknown",
			detail: "computesdk adapter reported no exit code",
		});
		expect(result.stdout).toBe("partial");
	});

	test("rejects malformed resolved command envelopes for exec and launch", async () => {
		for (const malformed of [null, [], { exitCode: "0", stdout: "", stderr: "" }]) {
			const { compute } = fakeCompute({
				...baseSandbox,
				runCommand: async () => malformed as never,
			});
			const session = await bridge(compute).create(request);
			await expect(session.exec("true")).rejects.toMatchObject({
				code: "vendor-contract-violation",
				provider: "e2b",
				ref: session.sandboxRef,
			});
			await expect(session.launch?.("task")).rejects.toMatchObject({
				code: "vendor-contract-violation",
				provider: "e2b",
				ref: session.sandboxRef,
			});
		}
	});

	test("types and redacts a throwing background-result diagnostic accessor", async () => {
		const malformed = { exitCode: 9, stdout: "" };
		Object.defineProperty(malformed, "stderr", {
			get: () => {
				throw new Error("stderr getter echoed test-key");
			},
		});
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => malformed,
		});
		const session = await bridge(compute).create(request);
		const error = await session.launch?.("task").catch((caught: unknown) => caught);
		expectCredentialSafe(error, "vendor-contract-violation");
		expect(error).toMatchObject({ ref: session.sandboxRef });
	});

	test("the filesystem stub never escapes: files exists only when declared working AND present", async () => {
		const throwingStub = {
			readFile: async () => {
				throw new Error("filesystem not supported by this sandbox environment");
			},
			exists: async () => {
				throw new Error("filesystem not supported by this sandbox environment");
			},
			writeFile: async () => {
				throw new Error("filesystem not supported by this sandbox environment");
			},
		};
		const { compute: stubbed } = fakeCompute({ ...baseSandbox, filesystem: throwingStub });
		const withoutTrust = await bridge(stubbed, {
			hasWorkingFilesystem: false,
		}).create(request);
		expect(withoutTrust.files).toBeUndefined();

		const reads: string[] = [];
		const { compute: working } = fakeCompute({
			...baseSandbox,
			filesystem: {
				readFile: async (path) => {
					reads.push(path);
					return "content";
				},
				exists: async () => true,
				writeFile: async () => {},
			},
		});
		const withTrust = await bridge(working, {
			hasWorkingFilesystem: true,
		}).create(request);
		expect(await withTrust.files?.readFile("/bench/a")).toBe("content");
		expect(reads).toEqual(["/bench/a"]);

		let missingDestroyed = 0;
		const { compute: missing } = fakeCompute({
			...baseSandbox,
			filesystem: undefined,
			destroy: async () => {
				missingDestroyed += 1;
			},
		});
		const missingError = await bridge(missing, {
			hasWorkingFilesystem: true,
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(missingError).toBeInstanceOf(DriverError);
		expect(missingError).toMatchObject({ code: "vendor-contract-violation" });
		expect(missingDestroyed).toBe(1);

		const transientSandbox: ComputeSdkSandboxLike = {
			...baseSandbox,
			filesystem: {
				readFile: async () => "content",
				exists: async () => true,
				writeFile: async () => {},
			},
		};
		const { compute: transient } = fakeCompute(transientSandbox);
		const transientSession = await bridge(transient, {
			hasWorkingFilesystem: true,
		}).create(request);
		Object.defineProperty(transientSandbox, "filesystem", { value: undefined });
		const withdrawn = await transientSession.files
			?.readFile("/bench/a")
			.catch((caught: unknown) => caught);
		const withdrawnExists = await transientSession.files
			?.exists("/bench/a")
			.catch((caught: unknown) => caught);
		expect(withdrawn).toBeInstanceOf(DriverError);
		expect(withdrawn).toMatchObject({ code: "vendor-contract-violation" });
		expect(withdrawnExists).toMatchObject({ code: "vendor-contract-violation" });
	});

	test("types and redacts a filesystem accessor that starts throwing after create", async () => {
		const workingFilesystem = {
			readFile: async () => "content",
			exists: async () => true,
			writeFile: async () => {},
		};
		let accesses = 0;
		const sandbox = { ...baseSandbox };
		Object.defineProperty(sandbox, "filesystem", {
			get: () => {
				accesses += 1;
				if (accesses > 1) throw new Error("filesystem getter echoed test-key");
				return workingFilesystem;
			},
		});
		const { compute } = fakeCompute(sandbox as ComputeSdkSandboxLike);
		const session = await bridge(compute, { hasWorkingFilesystem: true }).create(request);
		const error = await session.files?.readFile("/bench/a").catch((caught: unknown) => caught);
		expectCredentialSafe(error, "vendor-contract-violation");
		expect(error).toMatchObject({ ref: session.sandboxRef });
	});

	test("rejects an incomplete filesystem capability during create and rolls back", async () => {
		let destroys = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			filesystem: {} as never,
			destroy: async () => {
				destroys += 1;
			},
		});
		const error = await bridge(compute, { hasWorkingFilesystem: true })
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			code: "vendor-contract-violation",
			provider: "e2b",
		});
		expect((error as Error).message).toContain("every required callable method");
		expect(destroys).toBe(1);
	});

	test("retains cleanup when the initial filesystem accessor and rollback both fail", async () => {
		let destroys = 0;
		const sandbox = {
			...baseSandbox,
			destroy: async () => {
				destroys += 1;
				if (destroys === 1) throw new Error("cleanup echoed test-key");
			},
		};
		Object.defineProperty(sandbox, "filesystem", {
			get: () => {
				throw new Error("filesystem getter echoed test-key");
			},
		});
		const { compute } = fakeCompute(sandbox as ComputeSdkSandboxLike);
		const error = (await bridge(compute, { hasWorkingFilesystem: true })
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expectCredentialSafe(error.suppressed, "vendor-contract-violation");
		expectRedacted(error.error, "destroy-failed");
		await error.cleanup();
		expect(destroys).toBe(2);
	});

	test("launch rides the wrapper's background convention", async () => {
		const commands: Array<[string, boolean | undefined]> = [];
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async (command, options) => {
				commands.push([command, options?.background]);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		const session = await bridge(compute, {
			hasWorkingFilesystem: false,
		}).create(request);
		await session.launch?.("bash task.sh");
		expect(commands).toEqual([["bash task.sh", true]]);
	});

	test("a command projection composes over the exact wrapper without mutating its method table", async () => {
		const projected: Array<
			[ComputeSdkSandboxLike, string, "exec" | "launch", ExecOptions | undefined, string]
		> = [];
		const sandbox = {
			...baseSandbox,
			runCommand: async () => {
				throw new Error("the universal wrapper command must not run");
			},
		};
		const { compute } = fakeCompute(sandbox);
		const session = await bridge(compute, {
			commands: {
				exec: async (sandbox, command, options, ref) => {
					projected.push([sandbox, command, "exec", options, ref.id]);
					return { exitCode: 0, stdout: "root\n", stderr: "" };
				},
				launch: async (sandbox, command, options, ref) => {
					projected.push([sandbox, command, "launch", options, ref.id]);
				},
			},
		}).create(request);

		const cancellation = new AbortController();
		const execOptions = { maxOutputBytes: 4, signal: cancellation.signal } as const;
		expect((await session.exec("id -u", execOptions)).stdout).toBe("root");
		await session.launch?.("daemon --start", execOptions);
		expect(
			projected.map(([, command, operation, options, id]) => [command, operation, options, id]),
		).toEqual([
			["id -u", "exec", execOptions, "i2f3k4abc"],
			["daemon --start", "launch", execOptions, "i2f3k4abc"],
		]);
		expect(projected[0]?.[3]).toBe(execOptions);
		expect(projected[1]?.[3]).toBe(execOptions);
		expect(projected.every(([projectedSandbox]) => projectedSandbox === sandbox)).toBe(true);
	});

	test("native command failures retain useful diagnostics through the redaction boundary", async () => {
		const { compute } = fakeCompute(baseSandbox);
		const session = await bridge(compute, {
			commands: {
				exec: async () => {
					throw new Error("native exec transport refused test-key");
				},
				launch: async () => {
					throw new Error("native launch session unavailable test-key");
				},
			},
		}).create(request);
		const execError = await session.exec("true").catch((caught: unknown) => caught);
		const launchError = await session.launch?.("task").catch((caught: unknown) => caught);
		expectRedacted(execError, "exec-failed");
		expectRedacted(launchError, "exec-failed");
		expect(execError).toMatchObject({ vendorMessage: "native exec transport refused [REDACTED]" });
		expect(launchError).toMatchObject({
			vendorMessage: "native launch session unavailable [REDACTED]",
		});
	});

	test("launch rejects a background command that the wrapper reports as failed", async () => {
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => ({ exitCode: 9, stdout: "", stderr: "launch rejected" }),
		});
		const session = await bridge(compute, {
			hasWorkingFilesystem: false,
		}).create(request);
		const error = await session.launch?.("bash task.sh").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DriverError);
		expect(error).toMatchObject({
			code: "exec-failed",
			vendorExitCode: 9,
			vendorMessage: "launch rejected",
		});
	});

	test("an opaque list is not misrepresented as a per-sandbox lifecycle probe", () => {
		const { compute: withList } = fakeCompute(baseSandbox, true);
		expect(bridge(withList, { hasWorkingFilesystem: false }).probes).toBeUndefined();
		const { compute: withoutList } = fakeCompute(baseSandbox, false);
		expect(bridge(withoutList, { hasWorkingFilesystem: false }).probes).toBeUndefined();
		expect(bridge(withoutList, { hasWorkingFilesystem: false }).snapshots).toBeUndefined();
	});

	test("projects explicitly implemented probes and snapshots without inventing absent ones", async () => {
		const { compute } = fakeCompute(baseSandbox, true);
		const calls: string[] = [];
		const driver = bridge(compute, {
			probes: {
				observe: async (_compute, ref) => {
					calls.push(`observe:${ref.id}`);
					return { state: "running" };
				},
				list: async (provider) => provider.sandbox.list?.(),
				describe: async (_compute, ref) => ({ id: ref.id }),
			},
			snapshots: {
				create: async (_compute, session) => {
					expect(session.native).toBe(nativeSandbox);
					calls.push(`snapshot:${session.sandboxRef.id}`);
					return { snapshotId: "snap-1" };
				},
				delete: async (_compute, snapshotId) => {
					calls.push(`delete:${snapshotId}`);
				},
			},
		});
		const session = await driver.create(request);
		expect(await driver.probes?.observe(session.sandboxRef)).toEqual({ state: "running" });
		expect(await driver.probes?.list?.()).toEqual(["sb-1"]);
		expect(await driver.probes?.describe?.(session.sandboxRef)).toEqual({ id: "i2f3k4abc" });
		await expect(
			driver.probes?.observe({ provider: "daytona-vm", id: "i2f3k4abc" }),
		).rejects.toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
		await expect(driver.probes?.observe({ provider: "e2b", id: "wrong-id" })).rejects.toMatchObject(
			{ code: "invalid-sandbox-ref", provider: "e2b" },
		);
		const snapshot = await driver.snapshots?.create(session);
		expect(snapshot).toEqual({ snapshotId: "snap-1" });
		await expect(
			driver.snapshots?.create({
				...session,
				sandboxRef: { provider: "daytona-vm", id: "bad" },
			}),
		).rejects.toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
		await driver.snapshots?.delete("snap-1");
		expect(calls).toEqual(["observe:i2f3k4abc", "snapshot:i2f3k4abc", "delete:snap-1"]);
	});

	test("projects inventory and destroy-by-id through the canonical id boundary", async () => {
		const { compute } = fakeCompute(baseSandbox);
		const destroyed: string[] = [];
		const driver = bridge(compute, {
			inventory: { list: async () => ({ owned: ["i2f3k4abc", "iother"], foreignCount: 2 }) },
			destroyById: async (_compute, ref) => {
				destroyed.push(ref.id);
			},
		});
		expect(await driver.inventory?.list()).toEqual({
			owned: [
				{ provider: "e2b", id: "i2f3k4abc" },
				{ provider: "e2b", id: "iother" },
			],
			foreignCount: 2,
		});
		await driver.destroyById?.({ provider: "e2b", id: "i2f3k4abc" });
		expect(destroyed).toEqual(["i2f3k4abc"]);
		await expect(
			driver.destroyById?.({ provider: "daytona-vm", id: "i2f3k4abc" }),
		).rejects.toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
		await expect(driver.destroyById?.({ provider: "e2b", id: "wrong-id" })).rejects.toMatchObject({
			code: "invalid-sandbox-ref",
			provider: "e2b",
		});
		// A non-canonical owned id crosses the same boundary a bad ref does.
		await expect(
			bridge(compute, {
				inventory: { list: async () => ({ owned: ["not-canonical"], foreignCount: 0 }) },
			}).inventory?.list(),
		).rejects.toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
		// An inventory that could authorize deleting the wrong thing is a contract violation.
		for (const snapshot of [
			{ owned: ["i2f3k4abc", "i2f3k4abc"], foreignCount: 0 },
			{ owned: [], foreignCount: -1 },
			{ owned: [], foreignCount: 1.5 },
			{ owned: "i2f3k4abc", foreignCount: 0 },
			null,
		]) {
			const broken = bridge(compute, {
				inventory: { list: async () => snapshot as never },
			});
			await expect(broken.inventory?.list()).rejects.toMatchObject({
				code: "vendor-contract-violation",
				provider: "e2b",
			});
		}
		const secret = "inventory-callback-secret";
		const failing = bridge(compute, {
			inventory: {
				list: async () => {
					throw new Error(secret);
				},
			},
			destroyById: async () => {
				throw new Error(secret);
			},
		});
		const listError = await failing.inventory?.list().catch((caught: unknown) => caught);
		expect(listError).toMatchObject({ code: "probe-failed", provider: "e2b" });
		expect(String((listError as Error).cause)).not.toContain(secret);
		const destroyError = await failing
			.destroyById?.({ provider: "e2b", id: "i2f3k4abc" })
			.catch((caught: unknown) => caught);
		expect(destroyError).toMatchObject({ code: "destroy-failed", provider: "e2b" });
		expect(String((destroyError as Error).cause)).not.toContain(secret);
		const bare = bridge(compute, { hasWorkingFilesystem: false });
		expect(bare.inventory).toBeUndefined();
		expect(bare.destroyById).toBeUndefined();
	});

	test("normalizes successful probe and snapshot envelopes before they escape", async () => {
		const secret = "capability-envelope-secret";
		const { compute } = fakeCompute(baseSandbox);
		const driver = bridge(compute, {
			probes: {
				observe: async () =>
					new Proxy(
						{ state: "running" as const },
						{
							get() {
								throw new Error(secret);
							},
						},
					),
			},
			snapshots: {
				create: async () =>
					new Proxy(
						{ snapshotId: "snap-1" },
						{
							get() {
								throw new Error(secret);
							},
						},
					),
				delete: async () => {},
			},
		});
		const session = await driver.create(request);
		const probeError = await driver.probes
			?.observe(session.sandboxRef)
			.catch((caught: unknown) => caught);
		const snapshotError = await driver.snapshots
			?.create(session)
			.catch((caught: unknown) => caught);
		expectOmitted(probeError, "probe-failed");
		expectOmitted(snapshotError, "snapshot-failed");
		expect((probeError as Error).message).not.toContain(secret);
		expect((snapshotError as Error).message).not.toContain(secret);
	});

	test("decodes a raw wrapper id once and validates the stable canonical id thereafter", async () => {
		const { compute } = fakeCompute({ ...baseSandbox, sandboxId: "raw-I2F3K4ABC" });
		let receivedId = "";
		let observedId = "";
		const driver = bridge(compute, {
			sandboxId: {
				fromVendor: type(/^raw-/).pipe((id) => id.slice(4).toLowerCase()),
				canonical: e2bSandboxId,
			},
			probes: {
				observe: async (_compute, ref) => {
					observedId = ref.id;
					return { state: "running" };
				},
			},
			snapshots: {
				create: async (_compute, session) => {
					receivedId = session.sandboxRef.id;
					return { snapshotId: "snapshot-1" };
				},
				delete: async () => {},
			},
		});
		const session = await driver.create(request);
		expect(session.sandboxRef).toEqual({ provider: "e2b", id: "i2f3k4abc" });
		expect(await driver.probes?.observe(session.sandboxRef)).toEqual({ state: "running" });
		expect(observedId).toBe("i2f3k4abc");
		await driver.snapshots?.create(session);
		expect(receivedId).toBe("i2f3k4abc");
		await expect(
			driver.snapshots?.create({
				...session,
				sandboxRef: { provider: "e2b", id: "raw-I2F3K4ABC" },
			}),
		).rejects.toMatchObject({ code: "invalid-sandbox-ref", provider: "e2b" });
	});

	test("types and redacts a canonical-id validator throw before capability callbacks", async () => {
		const canonical = type("string").narrow((id) => {
			if (id === "test-key") throw new Error("canonical validator echoed test-key");
			return /^i[a-z0-9]+$/.test(id);
		});
		const { compute } = fakeCompute(baseSandbox);
		let observations = 0;
		const driver = bridge(compute, {
			sandboxId: { fromVendor: e2bSandboxId, canonical },
			probes: {
				observe: async () => {
					observations += 1;
					return { state: "running" };
				},
			},
		});
		await driver.create(request);
		const error = (await driver.probes
			?.observe({ provider: "e2b", id: "test-key" })
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
		expect(error.message).not.toContain("test-key");
		expect(String(error.cause ?? "")).not.toContain("test-key");
		expect(`${error.message} ${String(error.cause ?? "")}`).toContain("omitted");
		expect(error.ref).toBeUndefined();
		expect(observations).toBe(0);
	});

	test("types native extraction failures and retains cleanup ownership on a double fault", async () => {
		let destroys = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			getInstance: () => {
				throw new Error("native unwrap failed with test-key");
			},
			destroy: async () => {
				destroys += 1;
				if (destroys === 1) throw new Error("cleanup echoed test-key");
			},
		});
		const error = (await bridge(compute)
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error.locator).toEqual({ kind: "id", value: "i2f3k4abc" });
		expect(error.suppressed).toMatchObject({
			code: "vendor-contract-violation",
			provider: "e2b",
		});
		expect(error.error).toMatchObject({ code: "destroy-failed", provider: "e2b" });
		expect(String((error.suppressed as Error).message)).not.toContain("test-key");
		expect(String((error.error as Error).message)).not.toContain("test-key");
		await error.cleanup();
		expect(destroys).toBe(2);
	});

	test("types a native extraction failure before returning after successful rollback", async () => {
		let destroys = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			getInstance: () => {
				throw new Error("native unwrap failed");
			},
			destroy: async () => {
				destroys += 1;
			},
		});
		const error = await bridge(compute)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DriverError);
		expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
		expect(destroys).toBe(1);
	});

	test("redacts registry credentials from every wrapper diagnostic path", async () => {
		const leaked = "test-key";

		const createError = await bridge({
			sandbox: { create: async () => Promise.reject(new Error(`create echoed ${leaked}`)) },
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expectRedacted(createError);

		const wrapper = (overrides: Partial<ComputeSdkSandboxLike> = {}) =>
			fakeCompute({ ...baseSandbox, ...overrides }).compute;
		const execSession = await bridge(
			wrapper({ runCommand: async () => Promise.reject(new Error(`exec echoed ${leaked}`)) }),
		).create(request);
		expectRedacted(await execSession.exec("true").catch((caught: unknown) => caught));

		const launchSession = await bridge(
			wrapper({
				runCommand: async () => ({ exitCode: 7, stderr: `launch echoed ${leaked}` }),
			}),
		).create(request);
		expectRedacted(await launchSession.launch?.("task").catch((caught: unknown) => caught));

		const destroySession = await bridge(
			wrapper({ destroy: async () => Promise.reject(new Error(`destroy echoed ${leaked}`)) }),
		).create(request);
		expectRedacted(await destroySession.destroy().catch((caught: unknown) => caught));
	});

	test("normalizes hostile wrapper rejections without invoking prototype or message coercion", async () => {
		const secret = "compute-prototype-secret";
		const hostile = new Proxy(Object.assign(new Error("placeholder"), { credential: secret }), {
			getPrototypeOf() {
				throw new Error(`prototype leaked ${secret}`);
			},
			get(target, property, receiver) {
				if (property === "message") {
					return {
						toString() {
							throw new Error(`message leaked ${secret}`);
						},
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const error = (await bridge({
			sandbox: { create: async () => Promise.reject(hostile) },
		})
			.create(request)
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(error.message).not.toContain(secret);
		expect(error.vendorMessage ?? "").not.toContain(secret);
		expect(String(error.cause)).not.toContain(secret);
	});

	test("types and redacts every projected filesystem, probe, and snapshot failure", async () => {
		const rejected = (operation: string) =>
			Promise.reject(new Error(`${operation} echoed test-key`));
		const { compute } = fakeCompute({
			...baseSandbox,
			filesystem: {
				readFile: () => rejected("read"),
				exists: () => rejected("exists"),
				writeFile: () => rejected("write"),
			},
		});
		const driver = bridge(compute, {
			hasWorkingFilesystem: true,
			probes: {
				observe: () => rejected("observe"),
				list: () => rejected("list"),
				describe: () => rejected("describe"),
			},
			snapshots: {
				create: () => rejected("snapshot create"),
				delete: () => rejected("snapshot delete"),
			},
		});
		const session = await driver.create(request);
		const attempts = [
			session.files?.readFile("/secret"),
			session.files?.exists("/secret"),
			session.files?.writeText("/secret", "text"),
			driver.probes?.observe(session.sandboxRef),
			driver.probes?.list?.(),
			driver.probes?.describe?.(session.sandboxRef),
			driver.snapshots?.create(session),
			driver.snapshots?.delete("snapshot-1"),
		];
		const codes = [
			"filesystem-failed",
			"filesystem-failed",
			"filesystem-failed",
			"probe-failed",
			"probe-failed",
			"probe-failed",
			"snapshot-failed",
			"snapshot-failed",
		] as const;
		const errors = await Promise.all(
			attempts.map((attempt) => attempt?.catch((caught: unknown) => caught)),
		);
		for (const [index, error] of errors.entries()) {
			if (index < 3) expectRedacted(error, codes[index]);
			else expectOmitted(error, codes[index]);
		}
	});

	test("does not redact ordinary one-character guest environment values", async () => {
		const error = await bridge({
			sandbox: {
				create: async () => {
					throw new Error("HTTP 401 after 1 attempt");
				},
			},
		})
			.create({ ...request, env: { BENCH_ATTEMPT: "1" } })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			code: "create-failed",
			vendorMessage: "HTTP 401 after 1 attempt",
		});
	});

	test("uses stdout when empty stderr cannot explain a missing background status", async () => {
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => ({ stderr: "", stdout: "launch failed without status" }),
		});
		const session = await bridge(compute).create(request);
		await expect(session.launch?.("task")).rejects.toMatchObject({
			code: "exec-failed",
			provider: "e2b",
			vendorMessage: "launch failed without status",
		});
	});

	test("supplies a nonempty fallback when a failed background launch has no diagnostic", async () => {
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => ({ exitCode: 9, stderr: "", stdout: "" }),
		});
		const session = await bridge(compute).create(request);
		await expect(session.launch?.("task")).rejects.toMatchObject({
			code: "exec-failed",
			provider: "e2b",
			vendorMessage: "exit 9 with no diagnostic",
		});
	});

	test("a vendor id in the wrong format for the provider fails ref construction", async () => {
		let destroyed = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			sandboxId: "totally wrong id!",
			destroy: async () => {
				destroyed += 1;
			},
		});
		const error = (await bridge(compute, { hasWorkingFilesystem: false })
			.create(request)
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error.code).toBe("invalid-sandbox-ref");
		expect(error.message).toMatch(/id must be matched by/);
		expect(destroyed).toBe(1);
	});

	test("the kit's central byte cap reaches a computesdk session (was ignored before)", async () => {
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => ({ exitCode: 0, stdout: "y".repeat(100), stderr: "" }),
		});
		const session = await bridge(compute, {
			hasWorkingFilesystem: false,
		}).create(request);
		const capped = await session.exec("noisy", { maxOutputBytes: 10 });
		expect(capped.stdout).toHaveLength(10);
		expect(capped.truncated).toBe(true);
	});

	test("a sandbox without an id fails create loudly", async () => {
		let destroyed = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			sandboxId: undefined,
			destroy: async () => {
				destroyed += 1;
			},
		});
		const error = (await bridge(compute, { hasWorkingFilesystem: false })
			.create(request)
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error.code).toBe("vendor-contract-violation");
		expect(error.message).toContain("without a nonempty string sandboxId");
		expect(destroyed).toBe(1);
	});

	test("a malformed resolved wrapper handle fails through the typed boundary", async () => {
		const compute = {
			sandbox: { create: async () => null },
		} as unknown as ComputeSdkLike;
		const error = await bridge(compute)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DriverError);
		expect(error).toMatchObject({
			code: "vendor-contract-violation",
			provider: "e2b",
		});
		expect((error as Error).message).toContain("non-object sandbox handle");
	});

	test("a malformed successful create enters marker recovery before ownership is released", async () => {
		let cleanupCalls = 0;
		const compute = {
			sandbox: { create: async () => null },
		} as unknown as ComputeSdkLike;
		const error = await bridge(compute, {
			createOptions: () => ({ attempt: "attempt-malformed" }),
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 2,
				locator: () => ({ kind: "name", value: "attempt-malformed" }),
				cleanup: async () => {
					cleanupCalls += 1;
					return { status: "destroyed" };
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
		expect(cleanupCalls).toBe(1);
	});

	test("an already-aborted create never invokes the wrapper", async () => {
		let createCalls = 0;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					createCalls += 1;
					return baseSandbox;
				},
			},
		};
		const cancellation = new AbortController();
		cancellation.abort(new Error("shutdown"));
		const error = await bridge(compute)
			.create(request, { signal: cancellation.signal })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(createCalls).toBe(0);
	});

	test("an abort during an uncancellable wrapper create reconciles the accepted handle first", async () => {
		let releaseCreate!: (sandbox: ComputeSdkSandboxLike) => void;
		const createResult = new Promise<ComputeSdkSandboxLike>((resolve) => {
			releaseCreate = resolve;
		});
		let noteCreateStarted!: () => void;
		const createStartedResult = new Promise<void>((resolve) => {
			noteCreateStarted = resolve;
		});
		let releaseDestroy!: () => void;
		const destroyResult = new Promise<void>((resolve) => {
			releaseDestroy = resolve;
		});
		let noteDestroyStarted!: () => void;
		const destroyStartedResult = new Promise<void>((resolve) => {
			noteDestroyStarted = resolve;
		});
		let destroyStarted = false;
		const accepted: ComputeSdkSandboxLike = {
			...baseSandbox,
			destroy: async () => {
				destroyStarted = true;
				noteDestroyStarted();
				await destroyResult;
			},
		};
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					noteCreateStarted();
					return createResult;
				},
			},
		};
		const cancellation = new AbortController();
		let settled = false;
		const creating = bridge(compute)
			.create(request, { signal: cancellation.signal })
			.catch((caught: unknown) => caught)
			.finally(() => {
				settled = true;
			});

		await createStartedResult;
		cancellation.abort(new Error("shutdown"));
		releaseCreate(accepted);
		await destroyStartedResult;
		expect(destroyStarted).toBe(true);
		expect(settled).toBe(false);
		releaseDestroy();

		const error = await creating;
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(settled).toBe(true);
	});

	test("a validation/cleanup double fault preserves both failures and retryable ownership", async () => {
		let destroyCalls = 0;
		const { compute } = fakeCompute({
			...baseSandbox,
			sandboxId: undefined,
			destroy: async () => {
				destroyCalls++;
				if (destroyCalls === 1) throw new Error("cleanup exploded");
			},
		});
		const error = (await bridge(compute, {
			hasWorkingFilesystem: false,
		})
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error).toBeInstanceOf(SuppressedError);
		expect((error.error as DriverError).code).toBe("destroy-failed");
		expect((error.suppressed as DriverError).code).toBe("vendor-contract-violation");
		expect(error).toMatchObject({ provider: "e2b", locator: { kind: "native-handle" } });

		await error[Symbol.asyncDispose]();
		await error[Symbol.asyncDispose]();
		expect(destroyCalls).toBe(2);
	});

	test("a lifecycle projection replaces a wrapper destroy that would swallow teardown failures", async () => {
		let wrapperDestroys = 0;
		let projectedDestroys = 0;
		const sandbox = {
			...baseSandbox,
			destroy: async () => {
				wrapperDestroys += 1;
			},
		};
		const { compute } = fakeCompute(sandbox);
		const session = await bridge(compute, {
			lifecycle: {
				destroy: async (received) => {
					expect(received).toBe(sandbox);
					projectedDestroys += 1;
				},
			},
		}).create(request);
		await session.destroy();
		expect(projectedDestroys).toBe(1);
		expect(wrapperDestroys).toBe(0);
	});

	test("a lifecycle projection receives the canonical id without rereading mutable wrapper identity", async () => {
		let identityReads = 0;
		const sandbox: ComputeSdkSandboxLike = {
			...baseSandbox,
			get sandboxId() {
				identityReads += 1;
				return identityReads === 1 ? "iright" : "iwrong";
			},
		};
		const { compute } = fakeCompute(sandbox);
		let destroyedRef: string | undefined;
		const session = await bridge(compute, {
			lifecycle: {
				destroy: async (_sandbox, ref) => {
					destroyedRef = ref?.id;
				},
			},
		}).create(request);
		await session.destroy();
		expect(destroyedRef).toBe("iright");
		expect(identityReads).toBe(1);
	});

	test("post-create preparation receives the stable native handle and canonical identity", async () => {
		let identityReads = 0;
		let nativeReads = 0;
		const stableNative = { id: "native-handle" };
		const sandbox: ComputeSdkSandboxLike = {
			...baseSandbox,
			get sandboxId() {
				identityReads += 1;
				return identityReads === 1 ? "iright" : "iwrong";
			},
			getInstance: () => {
				nativeReads += 1;
				if (nativeReads > 1) throw new Error("mutable native accessor was reread");
				return stableNative;
			},
		};
		const { compute } = fakeCompute(sandbox);
		let verifiedRef: string | undefined;
		let preparedNative: unknown;
		const session = await bridge(compute, {
			prepareAndVerifyCreatedRequest: async (_sandbox, native, _request, _options, ref) => {
				preparedNative = native;
				verifiedRef = ref.id;
				return { status: "honored" };
			},
		}).create(request);
		expect(session.sandboxRef.id).toBe("iright");
		expect(verifiedRef).toBe("iright");
		expect(preparedNative).toBe(stableNative);
		expect(session.native).toBe(stableNative);
		expect(identityReads).toBe(1);
		expect(nativeReads).toBe(1);
	});

	test("ambiguous create cleanup retains a stable locator and retryable ownership", async () => {
		let cleanupCalls = 0;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw new Error("response lost after remote acceptance");
				},
			},
		};
		const error = (await bridge(compute, {
			createOptions: () => ({ attempt: "attempt-123" }),
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 3,
				locator: (createOptions) => ({
					kind: "marker",
					key: "attempt-id",
					value: String("attempt" in createOptions ? createOptions.attempt : undefined),
				}),
				cleanup: async (_compute, locator) => {
					expect(locator).toEqual({
						kind: "marker",
						key: "attempt-id",
						value: "attempt-123",
					});
					cleanupCalls += 1;
					if (cleanupCalls === 1) throw new Error("control plane unavailable");
					return { status: "destroyed" };
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error).toMatchObject({
			provider: "e2b",
			locator: { kind: "marker", key: "attempt-id", value: "attempt-123" },
		});
		expect((error.suppressed as DriverError).code).toBe("create-failed");
		expect((error.error as DriverError).code).toBe("destroy-failed");
		await error.cleanup();
		expect(cleanupCalls).toBe(2);
	});

	test("a definitive create rejection skips reconciliation and stays a plain create failure", async () => {
		let cleanupCalls = 0;
		const rejection = new Error("invalid api key");
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw rejection;
				},
			},
		};
		const error = await bridge(compute, {
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 3,
				locator: () => ({ kind: "name", value: "attempt-definitive" }),
				isDefinitive: (caught) => caught === rejection,
				cleanup: async () => {
					cleanupCalls += 1;
					return { status: "destroyed" };
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).not.toBeInstanceOf(FailedCreateCleanupError);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		// A refused request owns nothing; polling for it would only burn the caller's budget.
		expect(cleanupCalls).toBe(0);
		expect(isRetryableDriverCreate(error)).toBe(false);
	});

	test("a definitive rejection the module also calls retryable keeps its retry", async () => {
		// Both classifiers can be right at once: the control plane refused before allocating (nothing to
		// reconcile) AND the refusal was capacity. The definitive answer is the STRONGER proof of the
		// mark's safety half, so skipping the lookup must not also cost the retry it justifies.
		let cleanupCalls = 0;
		const refused = new Error("no capacity for this account right now");
		const error = await bridge(
			{
				sandbox: {
					create: async () => {
						throw refused;
					},
				},
			},
			{
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 3,
					locator: () => ({ kind: "name", value: "attempt-definitive-capacity" }),
					isDefinitive: (caught) => caught === refused,
					isRetryableCreate: (caught) => caught === refused,
					cleanup: async () => {
						cleanupCalls += 1;
						return { status: "destroyed" };
					},
				},
			},
		)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(cleanupCalls).toBe(0);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(isRetryableDriverCreate(error)).toBe(true);
	});

	test("a marked create-failed survives wrapping and stays retryable after cleanup", async () => {
		const marked = new DriverError("create-failed", "no slot right now", {
			provider: "e2b",
			retryable: true,
		});
		let cleanupCalls = 0;
		const error = await bridge(
			{
				sandbox: {
					create: async () => {
						throw marked;
					},
				},
			},
			{
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 3,
					locator: () => ({ kind: "name", value: "attempt-marked" }),
					cleanup: async () => {
						cleanupCalls += 1;
						return { status: "destroyed" };
					},
				},
			},
		)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(cleanupCalls).toBe(1);
		expect(error).toBeInstanceOf(DriverError);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(isRetryableDriverCreate(error)).toBe(true);
	});

	test("a module isRetryableCreate mark retries; unclassified 429 prose does not", async () => {
		const rateLimited = new Error("429 Too Many Requests");
		let cleanupCalls = 0;
		const retryable = await bridge(
			{
				sandbox: {
					create: async () => {
						throw rateLimited;
					},
				},
			},
			{
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 3,
					locator: () => ({ kind: "name", value: "attempt-rate-limit" }),
					isRetryableCreate: (caught) => caught === rateLimited,
					cleanup: async () => {
						cleanupCalls += 1;
						return { status: "destroyed" };
					},
				},
			},
		)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(cleanupCalls).toBe(1);
		expect(isRetryableDriverCreate(retryable)).toBe(true);

		cleanupCalls = 0;
		const prose = await bridge(
			{
				sandbox: {
					create: async () => {
						throw new Error("429 Too Many Requests");
					},
				},
			},
			{
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 3,
					locator: () => ({ kind: "name", value: "attempt-prose" }),
					cleanup: async () => {
						cleanupCalls += 1;
						return { status: "destroyed" };
					},
				},
			},
		)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(cleanupCalls).toBe(1);
		expect(isRetryableDriverCreate(prose)).toBe(false);
		expect(prose).toMatchObject({ code: "create-failed", vendorMessage: "429 Too Many Requests" });
	});

	test("a throwing isRetryableCreate classifier is treated as unmarked", async () => {
		const error = await bridge(
			{
				sandbox: {
					create: async () => {
						throw new Error("capacity");
					},
				},
			},
			{
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 3,
					locator: () => ({ kind: "name", value: "attempt-classifier-throw" }),
					isRetryableCreate: () => {
						throw new Error("classifier exploded");
					},
					cleanup: async () => ({ status: "destroyed" }),
				},
			},
		)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(isRetryableDriverCreate(error)).toBe(false);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
	});

	test("an unproven create failure still reconciles even when the classifier misbehaves", async () => {
		for (const isDefinitive of [
			() => false,
			() => {
				throw new Error("classifier exploded");
			},
			() => "yes" as unknown as boolean,
		]) {
			let cleanupCalls = 0;
			const compute: ComputeSdkLike = {
				sandbox: {
					create: async () => {
						throw new Error("response lost after remote acceptance");
					},
				},
			};
			const error = await bridge(compute, {
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 3,
					locator: () => ({ kind: "name", value: "attempt-ambiguous" }),
					isDefinitive,
					cleanup: async () => {
						cleanupCalls += 1;
						return { status: "destroyed" };
					},
				},
			})
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
			// Only an explicit `true` may release recovery; everything else reconciles.
			expect(cleanupCalls).toBe(1);
		}
	});

	test("ambiguous create cleanup cannot mutate the bridge-owned keyed marker", async () => {
		const originalMarker = "attempt-original";
		const seenLocators: Array<[string, string]> = [];
		let cleanupCalls = 0;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw new Error("response lost after remote acceptance");
				},
			},
		};
		const error = (await bridge(compute, {
			createOptions: () => ({ marker: originalMarker }),
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 2,
				locator: () => ({ kind: "marker", key: "externalId", value: originalMarker }),
				cleanup: async (_compute, locator) => {
					cleanupCalls += 1;
					if (locator.kind !== "marker") throw new Error("expected a marker locator");
					seenLocators.push([locator.key, locator.value]);
					expect(Object.isFrozen(locator)).toBe(true);
					try {
						Object.defineProperty(locator, "value", { value: "attempt-mutated" });
						Object.defineProperty(locator, "key", { value: "mutated-key" });
					} catch {
						// A hostile cleanup cannot rewrite the bridge-owned locator.
					}
					if (cleanupCalls === 1) throw new Error("control plane unavailable");
					return { status: "destroyed" };
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(error.locator).toEqual({
			kind: "marker",
			key: "externalId",
			value: originalMarker,
		});
		expect(error.message).not.toContain("attempt-mutated");
		expect(error.message).not.toContain("mutated-key");
		await error.cleanup();
		expect(seenLocators).toEqual([
			["externalId", originalMarker],
			["externalId", originalMarker],
		]);
	});

	test("rejects a malformed keyed recovery marker before allocation", async () => {
		let createCalls = 0;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					createCalls += 1;
					return baseSandbox;
				},
			},
		};
		const error = await bridge(compute, {
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 2,
				locator: () => ({ kind: "marker", key: "", value: "attempt-1" }),
				cleanup: async () => ({ status: "destroyed" }),
			},
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
		expect((error as Error).message).toContain("readable nonempty name or keyed marker");
		expect(createCalls).toBe(0);
	});

	test("rejects credential-bearing recovery marker fields before allocation", async () => {
		for (const sensitiveField of ["key", "value"] as const) {
			let createCalls = 0;
			const compute: ComputeSdkLike = {
				sandbox: {
					create: async () => {
						createCalls += 1;
						return baseSandbox;
					},
				},
			};
			const marker = {
				kind: "marker" as const,
				key: sensitiveField === "key" ? "attempt-test-key" : "attempt-id",
				value: sensitiveField === "value" ? "attempt-test-key" : "attempt-1",
			};
			const error = await bridge(compute, {
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 2,
					locator: () => marker,
					cleanup: async () => ({ status: "destroyed" }),
				},
			})
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "vendor-contract-violation", provider: "e2b" });
			expect((error as Error).message).not.toContain("test-key");
			expect(createCalls).toBe(0);
		}
	});

	test("ambiguous create cleanup never rereads options the wrapper mutated", async () => {
		const originalName = "benchmark-original";
		const replacementName = "benchmark-mutated";
		let cleanupLocator: unknown;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async (options) => {
					(options as Record<string, unknown>).name = replacementName;
					throw new Error("response lost after options mutation");
				},
			},
		};
		const error = await bridge(compute, {
			createOptions: () => ({ name: originalName }),
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 2,
				locator: (options) => ({
					kind: "name",
					value: String("name" in options ? options.name : undefined),
				}),
				cleanup: async (_compute, locator) => {
					cleanupLocator = locator;
					return { status: "destroyed" };
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(cleanupLocator).toEqual({ kind: "name", value: originalName });
	});

	test("ambiguous create absence needs two horizon-separated observations", async () => {
		let cleanupCalls = 0;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw new Error("response lost");
				},
			},
		};
		const started = performance.now();
		const error = await bridge(compute, {
			createOptions: () => ({ attempt: "attempt-absent" }),
			createRecovery: {
				absenceConfirmationMs: 10,
				maxAttempts: 3,
				locator: () => ({ kind: "name", value: "attempt-absent" }),
				cleanup: async () => {
					cleanupCalls += 1;
					return { status: "absent" };
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(error).not.toBeInstanceOf(FailedCreateCleanupError);
		expect(cleanupCalls).toBeGreaterThanOrEqual(2);
		expect(performance.now() - started).toBeGreaterThanOrEqual(9);
	});

	test("ambiguous create recovery forwards the caller signal into its first observation", async () => {
		const cancellation = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw new Error("response lost");
				},
			},
		};
		const error = await bridge(compute, {
			createOptions: () => ({ attempt: "attempt-signal" }),
			createRecovery: {
				absenceConfirmationMs: 5,
				maxAttempts: 2,
				locator: () => ({ kind: "name", value: "attempt-signal" }),
				cleanup: async (_compute, _locator, options) => {
					receivedSignal = options.signal;
					return { status: "destroyed" };
				},
			},
		})
			.create(request, { signal: cancellation.signal })
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(receivedSignal).toBe(cancellation.signal);
	});

	test("contradicted absence cannot extend ambiguous-create recovery forever", async () => {
		let cleanupCalls = 0;
		const compute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw new Error("response lost");
				},
			},
		};
		const error = (await bridge(compute, {
			createOptions: () => ({ attempt: "attempt-loop" }),
			createRecovery: {
				absenceConfirmationMs: 1,
				maxAttempts: 3,
				locator: () => ({ kind: "name", value: "attempt-loop" }),
				cleanup: async () => {
					cleanupCalls += 1;
					return { status: "absent", contradictedPriorAbsence: true };
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught)) as FailedCreateCleanupError;
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect((error.error as DriverError).code).toBe("destroy-failed");
		expect(cleanupCalls).toBe(3);
	});

	test("rejects invalid numeric request coverage and unimplemented runtime verification", () => {
		const { compute } = fakeCompute(baseSandbox);
		for (const numericBound of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
			const requestCoverage = {
				...mappedCoverage,
				spec: { ...mappedCoverage.spec, vcpus: { artifact: numericBound } },
			} as ComputeSdkCreateRequestCoverage;
			expect(() => bridge(compute, { requestCoverage })).toThrow(
				expect.objectContaining({ code: "vendor-contract-violation", provider: "e2b" }),
			);
		}
		const runtimeCoverage = {
			...mappedCoverage,
			spec: { ...mappedCoverage.spec, diskGb: "runtime-verified" },
		} as const satisfies ComputeSdkCreateRequestCoverage;
		expect(() => bridge(compute, { requestCoverage: runtimeCoverage })).toThrow(
			expect.objectContaining({ code: "vendor-contract-violation", provider: "e2b" }),
		);
	});

	test("requires at least two ambiguous-create observations", () => {
		const { compute } = fakeCompute(baseSandbox);
		expect(() =>
			bridge(compute, {
				createRecovery: {
					absenceConfirmationMs: 5,
					maxAttempts: 1,
					locator: () => ({ kind: "name", value: "attempt-one" }),
					cleanup: async () => ({ status: "absent" }),
				},
			}),
		).toThrow(expect.objectContaining({ code: "vendor-contract-violation", provider: "e2b" }));
	});

	test("wrapper rejections use the shared typed error family", async () => {
		const retained = new FailedCreateCleanupError(
			new Error("wrapper cleanup failed"),
			new Error("wrapper create failed"),
			{
				provider: "e2b",
				locator: { kind: "id", value: "i-retained" },
				cleanup: async () => {},
			},
		);
		const retainedCompute: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw retained;
				},
			},
		};
		expect(
			await bridge(retainedCompute)
				.create(request)
				.catch((caught: unknown) => caught),
		).toBe(retained);

		const createFailure: ComputeSdkLike = {
			sandbox: {
				create: async () => {
					throw new Error("provider unavailable");
				},
			},
		};
		const createError = await bridge(createFailure, {
			hasWorkingFilesystem: false,
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(createError).toMatchObject({
			code: "create-failed",
			provider: "e2b",
			vendorMessage: "provider unavailable",
		});

		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => {
				throw new Error("transport closed");
			},
		});
		const session = await bridge(compute, {
			hasWorkingFilesystem: false,
		}).create(request);
		const execError = await session.exec("true").catch((caught: unknown) => caught);
		expect(execError).toMatchObject({
			code: "exec-failed",
			provider: "e2b",
			vendorMessage: "transport closed",
		});
	});

	test("never preserves a foreign provider ref from an already-typed wrapper error", async () => {
		const foreign = new DriverError("destroy-failed", "wrong wrapper channel", {
			provider: "daytona-vm",
			ref: { provider: "daytona-vm", id: "wrong-id" },
		});
		const error = (await bridge({
			sandbox: {
				create: async () => {
					throw foreign;
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught)) as DriverError;
		expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(error.ref).toBeUndefined();
	});

	test("never preserves a failed-create cleanup capability across provider or operation boundaries", async () => {
		let foreignCleanupCalls = 0;
		const foreign = new FailedCreateCleanupError(
			new Error("foreign cleanup failed"),
			new Error("foreign create failed"),
			{
				provider: "daytona-vm",
				locator: { kind: "id", value: "foreign-id" },
				cleanup: async () => {
					foreignCleanupCalls++;
				},
			},
		);
		const createError = await bridge({
			sandbox: {
				create: async () => {
					throw foreign;
				},
			},
		})
			.create(request)
			.catch((caught: unknown) => caught);
		expect(createError).not.toBeInstanceOf(FailedCreateCleanupError);
		expect(createError).toMatchObject({ code: "create-failed", provider: "e2b" });
		expect(createError).not.toHaveProperty("locator");
		expect(foreignCleanupCalls).toBe(0);

		let wrongChannelCleanupCalls = 0;
		const wrongChannel = new FailedCreateCleanupError(
			new Error("cleanup failed"),
			new Error("create failed"),
			{
				provider: "e2b",
				locator: { kind: "id", value: "i-retained" },
				cleanup: async () => {
					wrongChannelCleanupCalls++;
				},
			},
		);
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => {
				throw wrongChannel;
			},
		});
		const session = await bridge(compute, { hasWorkingFilesystem: false }).create(request);
		const execError = await session.exec("true").catch((caught: unknown) => caught);
		expect(execError).not.toBeInstanceOf(FailedCreateCleanupError);
		expect(execError).toMatchObject({
			code: "exec-failed",
			provider: "e2b",
			ref: session.sandboxRef,
		});
		expect(execError).not.toHaveProperty("locator");
		expect(wrongChannelCleanupCalls).toBe(0);
	});

	test("normalizes foreign typed-error codes to the current operation boundary", async () => {
		const wrongChannel = () =>
			new DriverError("create-failed", "wrapper chose the create channel", {
				provider: "daytona-vm",
			});
		const { compute } = fakeCompute({
			...baseSandbox,
			runCommand: async () => {
				throw wrongChannel();
			},
			filesystem: {
				readFile: async () => {
					throw wrongChannel();
				},
				exists: async () => true,
				writeFile: async () => {},
			},
		});
		const session = await bridge(compute, { hasWorkingFilesystem: true }).create(request);
		await expect(session.exec("true")).rejects.toMatchObject({
			code: "exec-failed",
			provider: "e2b",
		});
		await expect(session.files?.readFile("/tmp/file")).rejects.toMatchObject({
			code: "filesystem-failed",
			provider: "e2b",
			ref: session.sandboxRef,
		});
	});
});
