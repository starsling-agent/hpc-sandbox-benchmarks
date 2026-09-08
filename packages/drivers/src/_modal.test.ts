import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { ModalClient, NotFoundError } from "modal";
import type { ClientMiddleware, ServiceDefinition } from "nice-grpc";
import { ClientError, createServer, Status } from "nice-grpc";
import { defineComputeSdkDriver } from "./_computesdk.ts";
import type { ModalControlRunner } from "./_modal.ts";
import {
	createModalControlRunner,
	defineModalDriver,
	execModalCommand,
	launchModalCommand,
	lazyModalCompute,
	MODAL_APP_NAME,
	MODAL_CONTROL_TIMEOUT_MS,
	MODAL_COST_SDK_PROVENANCE,
	MODAL_SANDBOX_LIFETIME_MS,
	MODAL_V1_SANDBOX_ID,
	MODAL_V2_SANDBOX_ID,
	modalControlPlane,
	modalCreateOptions,
	modalCreateRecovery,
	modalDetachedCommand,
	modalLifecycle,
	modalProbes,
	modalSandboxId,
	verifyModalDiskCapacity,
} from "./_modal.ts";
import modalGvisor from "./modal-gvisor.ts";
import modalVm from "./modal-vm.ts";

const request = (overrides: Partial<CreateRequest> = {}): CreateRequest => ({
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: { kind: "image", ref: "registry.example/toolchain:version" },
	deadlineMs: 300_000,
	env: { BENCHMARK_MODE: "true" },
	...overrides,
});

const modalRef = { provider: "modal-vm", id: "sb-rxWrDWGgOCJXeCSavkiDL6" } as const;

function directRunner(control: unknown): ModalControlRunner {
	return {
		run: async (options, operation) => {
			options.signal?.throwIfAborted();
			const result = await operation(control as never);
			options.signal?.throwIfAborted();
			return result;
		},
	};
}

function unsupported(detail: string): never {
	throw new Error(detail);
}

/** The version of `packageName` as this package resolves it — the copy the driver actually loads. */
function installedVersion(packageName: string): string {
	let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));
	for (;;) {
		const manifest = join(directory, "package.json");
		try {
			const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
			if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
				const { name, version } = parsed as { name?: unknown; version?: unknown };
				if (name === packageName && typeof version === "string") return version;
			}
		} catch {
			// Keep walking: dist directories often have no manifest of their own.
		}
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`could not resolve an installed ${packageName}`);
		directory = parent;
	}
}

describe("Modal shared driver factory", () => {
	it("attaches the shared implementation only through the two literal modules", () => {
		expect(modalGvisor.id).toBe("modal-gvisor");
		expect(modalVm.id).toBe("modal-vm");
		expect(modalGvisor.execution).toEqual({
			syncCapMs: 30 * 60_000,
			durable: "shell-detach",
		});
		expect(modalVm.execution).toEqual(modalGvisor.execution);
	});

	it("pins cost-evidence provenance to the native SDK this driver actually loads", () => {
		// Resolved from this package, which is where `_modal.ts` imports `modal` from: the record must
		// name the SDK whose public surface was searched, not the older copy nested under the wrapper.
		expect(MODAL_COST_SDK_PROVENANCE.packageName).toBe("modal");
		expect(String(MODAL_COST_SDK_PROVENANCE.version)).toBe(installedVersion("modal"));
	});

	it("wires Modal costEvidence on both DriverModule variants", async () => {
		expect(modalGvisor.costEvidence).toBeDefined();
		expect(modalVm.costEvidence).toBeDefined();
		const capture = modalGvisor.costEvidence?.captureAfterTeardown;
		expect(typeof capture).toBe("function");
		const completed = await capture?.({
			cell: { runId: "run-1", providerId: "modal-gvisor", suite: "cpu-node" },
			providerId: "modal-gvisor",
			sandboxId: "sb-123",
			teardown: {
				completed: true,
				attemptedAt: "2026-08-08T00:00:00.000Z",
				completedAt: "2026-08-08T00:00:01.000Z",
			},
		});
		expect(completed).toMatchObject({
			kind: "missing",
			reason: "unsupported_public_api",
			subject: { kind: "sandbox", sandboxId: "sb-123", appName: MODAL_APP_NAME },
		});
		if (completed?.kind !== "missing") throw new Error("Modal hook returned observed evidence");
		expect(completed.detail).toContain("was not invoked");
		expect(
			await modalVm.costEvidence?.captureAfterTeardown({
				cell: { runId: "run-1", providerId: "modal-vm", suite: "cpu-node" },
				providerId: "modal-vm",
				sandboxId: "sb-123",
				teardown: { completed: false, attemptedAt: "2026-08-08T00:00:00.000Z" },
			}),
		).toMatchObject({ kind: "missing", reason: "sandbox_teardown_unconfirmed" });
	});

	it("defers the wrapper's eager app lookup until create and reuses one instance", async () => {
		let factoryCalls = 0;
		let createCalls = 0;
		const compute = lazyModalCompute({}, () => {
			factoryCalls += 1;
			return {
				sandbox: {
					create: async () => {
						createCalls += 1;
						return {};
					},
				},
			} as never;
		});
		expect(factoryCalls).toBe(0);
		await compute.sandbox.create();
		await compute.sandbox.create();
		expect(factoryCalls).toBe(1);
		expect(createCalls).toBe(2);
	});

	it("clears a wrapper whose captured app lookup rejects so a later create can recover", async () => {
		let factoryCalls = 0;
		const compute = lazyModalCompute({}, () => {
			factoryCalls += 1;
			const attempt = factoryCalls;
			return {
				sandbox: {
					create: async () => {
						if (attempt === 1) throw new Error("transient Modal app lookup failure");
						return { attempt };
					},
				},
			} as never;
		});
		await expect(compute.sandbox.create()).rejects.toThrow(/transient Modal app lookup/);
		const recovered = await compute.sandbox.create();
		expect((recovered as unknown as { attempt: number }).attempt).toBe(2);
		expect(factoryCalls).toBe(2);
	});

	it("cannot attach the shared factory outside the registered Modal id union", () => {
		const invalidAttachmentsAreCompileOnly = () => {
			// @ts-expect-error — identity and backend are selected by one closed provider literal
			defineModalDriver("e2b");
		};
		expect(invalidAttachmentsAreCompileOnly).toBeFunction();
	});

	it("binds VM to V1 ids and gVisor to V2 ids", () => {
		expect(MODAL_V1_SANDBOX_ID.assert("sb-rxWrDWGgOCJXeCSavkiDL6")).toBe(
			"sb-rxWrDWGgOCJXeCSavkiDL6",
		);
		expect(MODAL_V2_SANDBOX_ID.assert("sb-01M0BXHCKJJHRYBN29EC21NMW4")).toBe(
			"sb-01M0BXHCKJJHRYBN29EC21NMW4",
		);
		expect(() => MODAL_V1_SANDBOX_ID.assert("sb-01M0BXHCKJJHRYBN29EC21NMW4")).toThrow();
		expect(() => MODAL_V2_SANDBOX_ID.assert("sb-rxWrDWGgOCJXeCSavkiDL6")).toThrow();
		expect(() => MODAL_V1_SANDBOX_ID.assert("sb-too-short")).toThrow();
		expect(() => MODAL_V1_SANDBOX_ID.assert("sb-rxWrDWGgOCJXeCSavkiDL6/escape")).toThrow();
		for (const malformed of [
			`sb-${"a".repeat(21)}`,
			`sb-${"a".repeat(23)}`,
			"sb-01m0bxhckjjhrybn29ec21nmw4",
			"sb-01M0BXHCKJJHRYBN29EC21NMI4",
			"sb-01M0BXHCKJJHRYBN29EC21NMO4",
			"sb-81M0BXHCKJJHRYBN29EC21NMW4",
			"sb-91M0BXHCKJJHRYBN29EC21NMW4",
		]) {
			expect(() => MODAL_V2_SANDBOX_ID.assert(malformed)).toThrow();
		}
	});

	it("maps the canonical shape and image for gVisor", () => {
		const options = modalCreateOptions("gvisor", "registry.example/toolchain:version").map(
			request(),
			unsupported,
		);
		expect(options).toMatchObject({
			templateId: "registry.example/toolchain:version",
			timeout: MODAL_SANDBOX_LIFETIME_MS,
			cpu: 4,
			cpuLimit: 4,
			memoryMiB: 8192,
			memoryLimitMiB: 8192,
			envs: { BENCHMARK_MODE: "true" },
		});
		expect(options.name).toMatch(/^benchmark-[0-9a-f-]{36}$/);
		expect(options).not.toHaveProperty("experimentalOptions");
	});

	it("adds only the VM runtime projection for modal-vm", () => {
		const options = modalCreateOptions("vm", "registry.example/toolchain:version").map(
			request(),
			unsupported,
		);
		expect(options.experimentalOptions).toEqual({ vm_runtime: true });
	});

	it("rejects a request artifact that disagrees with the joined context", () => {
		expect(() =>
			modalCreateOptions("gvisor", "registry.example/toolchain:version").map(
				request({ artifact: { kind: "image", ref: "registry.example/toolchain:candidate" } }),
				unsupported,
			),
		).toThrow(/does not match the resolved Modal image/);
	});
});

// Long enough that a loopback connection, the auth RPC, and the guarded call all reach the test
// server on a loaded CI runner before the ceiling expires. The test gates on the handler
// actually being entered, so this bounds the run rather than defining what is asserted.
const MODAL_TEST_CONTROL_TIMEOUT_MS = 2_000;
const MODAL_TEST_STAGE_TIMEOUT_MS = 10_000;

/**
 * Await a transport milestone with a named failure. A bare await surfaces a slow or absent
 * milestone as an anonymous test timeout, which cannot distinguish "the RPC never arrived" from
 * "cancellation never came back" — the two failures this test exists to tell apart.
 */
async function awaitStage(label: string, reached: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			reached,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} within ${MODAL_TEST_STAGE_TIMEOUT_MS}ms`)),
					MODAL_TEST_STAGE_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

describe("Modal enforced control deadline", () => {
	function neverSettlingRunner(phase: "lookup" | "poll" | "terminate" | "exec") {
		const callOptions: Array<{
			readonly retries?: number;
			readonly timeoutMs?: number;
			readonly signal?: AbortSignal;
		}> = [];
		let settled = 0;
		let detached = 0;
		const runner = createModalControlRunner((middleware: ClientMiddleware) => {
			const hang = async (): Promise<never> => {
				const generator = middleware(
					{
						method: { path: "/modal.client.ModalClient/Test" },
						requestStream: false,
						responseStream: false,
						request: {},
						next: async function* (
							_request: unknown,
							options: {
								readonly retries?: number;
								readonly timeoutMs?: number;
								readonly signal?: AbortSignal;
							},
						) {
							callOptions.push(options);
							await new Promise<never>((_resolve, reject) => {
								const abort = () => {
									settled += 1;
									reject(options.signal?.reason ?? new Error("cancelled"));
								};
								if (options.signal?.aborted) abort();
								else options.signal?.addEventListener("abort", abort, { once: true });
							});
							return {};
						},
					} as never,
					{},
				);
				await generator.next();
				throw new Error("unreachable");
			};
			const sandbox = {
				poll: phase === "poll" ? hang : async () => null,
				terminate: phase === "terminate" ? hang : async () => 0,
				exec:
					phase === "exec"
						? hang
						: async () => {
								throw new Error("unused");
							},
				detach: () => {
					detached += 1;
				},
			};
			return {
				sandboxes: {
					fromId: phase === "lookup" ? hang : async () => sandbox,
					fromName: phase === "lookup" ? hang : async () => sandbox,
					experimentalFromName: phase === "lookup" ? hang : async () => sandbox,
				},
			} as never;
		}, 10);
		return { runner, callOptions, settled: () => settled, detached: () => detached };
	}

	it("cancels and settles hanging name lookup, poll, terminate, and exec setup", async () => {
		for (const phase of ["lookup", "poll", "terminate", "exec"] as const) {
			const state = neverSettlingRunner(phase);
			const operation =
				phase === "lookup"
					? modalLifecycle("vm", state.runner).destroy(
							{} as never,
							undefined,
							{},
							{
								kind: "name",
								value: "benchmark-12345678-1234-1234-1234-123456789abc",
							},
						)
					: phase === "poll"
						? modalProbes(state.runner).observe({} as never, modalRef)
						: phase === "terminate"
							? modalLifecycle("vm", state.runner).destroy({} as never, modalRef, {})
							: launchModalCommand(state.runner, {} as never, "sleep 1", modalRef);
			await expect(operation).rejects.toThrow(/exceeded 10ms/);
			expect(state.settled()).toBe(1);
			expect(state.callOptions).toHaveLength(1);
			expect(state.callOptions[0]).toMatchObject({ retries: 1, timeoutMs: 10 });
			expect(state.callOptions[0]?.signal?.aborted).toBeTrue();
			if (phase === "lookup") expect(state.detached()).toBe(0);
			else expect(state.detached()).toBeGreaterThanOrEqual(1);
		}
	});

	it("forwards caller cancellation through the same settling boundary", async () => {
		const state = neverSettlingRunner("terminate");
		const controller = new AbortController();
		const operation = modalLifecycle("vm", state.runner).destroy({} as never, modalRef, {
			signal: controller.signal,
		});
		controller.abort(new Error("caller cancelled Modal teardown"));
		await expect(operation).rejects.toThrow(/caller cancelled/);
		expect(state.settled()).toBe(1);
		expect(state.callOptions[0]?.signal?.aborted).toBeTrue();
		expect(state.callOptions[0]?.signal?.reason).toBe(controller.signal.reason);
	});

	it("carries cancellation through Modal 0.9's actual timeout and retry chain", async () => {
		const encodeStringField = (value: string): Uint8Array => {
			const bytes = new TextEncoder().encode(value);
			if (bytes.length >= 128) throw new Error("test protobuf string is too long");
			return Uint8Array.of(10, bytes.length, ...bytes);
		};
		const service = {
			authTokenGet: {
				path: "/modal.client.ModalClient/AuthTokenGet",
				requestStream: false,
				responseStream: false,
				requestSerialize: () => new Uint8Array(),
				requestDeserialize: () => ({}),
				responseSerialize: (response: { token: string }) => encodeStringField(response.token),
				responseDeserialize: () => ({ token: "" }),
				options: {},
			},
			sandboxGetFromName: {
				path: "/modal.client.ModalClient/SandboxGetFromName",
				requestStream: false,
				responseStream: false,
				requestSerialize: () => new Uint8Array(),
				requestDeserialize: () => ({}),
				responseSerialize: () => new Uint8Array(),
				responseDeserialize: () => ({ sandboxId: "" }),
				options: {},
			},
		} as const satisfies ServiceDefinition;
		const server = createServer();
		let transportSettled = 0;
		// Both signals come from the server handler, so this test waits on real transport events
		// rather than on wall-clock budgets a loaded runner cannot honor: `handlerEntered` proves the
		// RPC actually reached the server, and `transportSettledOnce` proves the deadline's
		// cancellation propagated all the way back to it.
		let markHandlerEntered: () => void = () => {};
		const handlerEntered = new Promise<void>((resolve) => {
			markHandlerEntered = resolve;
		});
		let markTransportSettled: () => void = () => {};
		const transportSettledOnce = new Promise<void>((resolve) => {
			markTransportSettled = resolve;
		});
		server.add(service, {
			authTokenGet: async () => ({
				// A syntactically valid JWT with an expiry in 2100 avoids another auth RPC.
				token: "e30.eyJleHAiOjQxMDI0NDQ4MDB9.signature",
			}),
			sandboxGetFromName: async (_request, context) => {
				markHandlerEntered();
				await new Promise<void>((resolve) => {
					if (context.signal.aborted) resolve();
					else context.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				transportSettled += 1;
				markTransportSettled();
				return { sandboxId: "" };
			},
		});
		const port = await server.listen("127.0.0.1:0");
		const previousServer = process.env.MODAL_SERVER_URL;
		process.env.MODAL_SERVER_URL = `http://127.0.0.1:${port}`;
		let client: ModalClient | undefined;
		let runner: ModalControlRunner;
		try {
			runner = createModalControlRunner((middleware) => {
				client = new ModalClient({
					tokenId: "test-token-id",
					tokenSecret: "test-token-secret",
					grpcMiddleware: [middleware],
				});
				return modalControlPlane(client);
			}, MODAL_TEST_CONTROL_TIMEOUT_MS);
		} finally {
			if (previousServer === undefined) delete process.env.MODAL_SERVER_URL;
			else process.env.MODAL_SERVER_URL = previousServer;
		}
		try {
			const bounded = runner.run({}, (control) =>
				control.sandboxes.fromName(MODAL_APP_NAME, "benchmark-timeout"),
			);
			// Gate on arrival first: a ceiling that expired before the RPC reached the server would
			// prove nothing about cancellation reaching the transport.
			await awaitStage("the guarded RPC never reached the test gRPC server", handlerEntered);
			await expect(bounded).rejects.toThrow();
			await awaitStage(
				"the deadline's cancellation never reached the server handler",
				transportSettledOnce,
			);
			// Exactly one server invocation: the bounded retry must not re-issue an already-cancelled RPC.
			expect(transportSettled).toBe(1);
		} finally {
			client?.close();
			server.forceShutdown();
		}
	}, 30_000);
});

describe("Modal truthful lifecycle and recovery projections", () => {
	it("terminates by canonical id, waits, and surfaces teardown failures", async () => {
		const terminated: Array<{ id: string; wait: boolean }> = [];
		const control = {
			sandboxes: {
				fromId: async (id: string) => ({
					poll: async () => null,
					terminate: async ({ wait }: { wait: true }) => {
						terminated.push({ id, wait });
						return 0;
					},
				}),
				fromName: async () => {
					throw new Error("unused");
				},
				experimentalFromName: async () => {
					throw new Error("unused");
				},
			},
		};
		const lifecycle = modalLifecycle("vm", directRunner(control));
		await lifecycle.destroy(
			{} as never,
			{ provider: "modal-vm", id: "sb-rxWrDWGgOCJXeCSavkiDL6" },
			{},
		);
		expect(terminated).toEqual([{ id: "sb-rxWrDWGgOCJXeCSavkiDL6", wait: true }]);

		control.sandboxes.fromId = async () => {
			throw new Error("control plane unavailable");
		};
		await expect(
			lifecycle.destroy({} as never, { provider: "modal-vm", id: "sb-rxWrDWGgOCJXeCSavkiDL6" }, {}),
		).rejects.toThrow(/control plane unavailable/);
	});

	it("treats only sandbox-RPC not-found as converged teardown", async () => {
		const errors = [
			new ClientError("/modal.client.ModalClient/SandboxTerminate", Status.NOT_FOUND, "gone"),
			new ClientError("/modal.client.ModalClient/SandboxTerminateV2", Status.NOT_FOUND, "gone"),
		];
		const control = {
			sandboxes: {
				fromId: async () => ({
					poll: async () => null,
					terminate: async () => {
						throw errors.shift();
					},
				}),
				fromName: async () => {
					throw new Error("unused");
				},
				experimentalFromName: async () => {
					throw new Error("unused");
				},
			},
		};
		for (const provider of ["modal-gvisor", "modal-vm"] as const) {
			await expect(
				modalLifecycle(
					provider === "modal-gvisor" ? "gvisor" : "vm",
					directRunner(control),
				).destroy({} as never, { provider, id: "sb-rxWrDWGgOCJXeCSavkiDL6" }, {}),
			).resolves.toBeUndefined();
		}
	});

	it("never classifies auth or unrelated gRPC not-found as sandbox absence", async () => {
		for (const path of [
			"/modal.client.ModalClient/AuthTokenGet",
			"/modal.client.ModalClient/AppGetOrCreate",
		]) {
			const control = {
				sandboxes: {
					fromId: async () => ({
						poll: async () => null,
						terminate: async () => {
							throw new ClientError(path, Status.NOT_FOUND, "not a sandbox absence");
						},
						detach: () => {},
					}),
				},
			};
			await expect(
				modalLifecycle("vm", directRunner(control)).destroy({} as never, modalRef, {}),
			).rejects.toMatchObject({ path, code: Status.NOT_FOUND });
		}
	});

	it("preserves an auth-token NOT_FOUND through production name recovery", async () => {
		const authMissing = new ClientError(
			"/modal.client.ModalClient/AuthTokenGet",
			Status.NOT_FOUND,
			"token is missing",
		);
		const client = {
			environmentName: () => "",
			cpClient: {
				sandboxGetFromName: async () => {
					throw authMissing;
				},
			},
			sandboxes: {
				fromId: async () => {
					throw new Error("unused");
				},
			},
		} as unknown as ModalClient;
		await expect(
			modalCreateRecovery("vm", directRunner(modalControlPlane(client))).cleanup(
				{} as never,
				{ kind: "name", value: "benchmark-12345678-1234-1234-1234-123456789abc" },
				{},
			),
		).rejects.toBe(authMissing);
	});

	it("rejects cross-generation ids returned by each name endpoint", async () => {
		const client = {
			environmentName: () => "",
			cpClient: {
				sandboxGetFromName: async () => ({ sandboxId: "sb-01M0BXHCKJJHRYBN29EC21NMW4" }),
				sandboxGetFromNameV2: async () => ({ sandboxId: "sb-rxWrDWGgOCJXeCSavkiDL6" }),
			},
			sandboxes: {
				fromId: async () => {
					throw new Error("unused");
				},
			},
		} as unknown as ModalClient;
		const control = modalControlPlane(client);
		await expect(control.sandboxes.fromName(MODAL_APP_NAME, "wrong-v1")).rejects.toThrow();
		await expect(
			control.sandboxes.experimentalFromName(MODAL_APP_NAME, "wrong-v2"),
		).rejects.toThrow();
	});

	it("uses the recovery name without touching a hostile native handle", async () => {
		const unavailable = new ClientError(
			"/modal.client.ModalClient/SandboxTerminate",
			Status.UNAVAILABLE,
			"retry",
		);
		let nativeReads = 0;
		const hostileNative = {
			getInstance: () => {
				nativeReads += 1;
				throw new NotFoundError("hostile accessor");
			},
		};
		const lookups: string[] = [];
		const control = {
			sandboxes: {
				fromId: async () => {
					throw new Error("unused");
				},
				fromName: async (app: string, name: string) => {
					lookups.push(`${app}:${name}`);
					return {
						terminate: async (params: { wait: true }) => {
							expect(params).toEqual({ wait: true });
							throw unavailable;
						},
					};
				},
				experimentalFromName: async () => {
					throw new Error("unused");
				},
			},
		};
		await expect(
			modalLifecycle("vm", directRunner(control)).destroy(
				hostileNative as never,
				undefined,
				{},
				{
					kind: "name",
					value: "benchmark-12345678-1234-1234-1234-123456789abc",
				},
			),
		).rejects.toBe(unavailable);
		expect(nativeReads).toBe(0);
		expect(lookups).toEqual([`${MODAL_APP_NAME}:benchmark-12345678-1234-1234-1234-123456789abc`]);
	});

	it("does not release name-owned cleanup on an eventually consistent first miss", async () => {
		const firstMiss = new ClientError(
			"/modal.client.ModalClient/SandboxGetFromName",
			Status.NOT_FOUND,
			"name index has not observed the allocation yet",
		);
		const control = {
			sandboxes: {
				fromName: async () => {
					throw firstMiss;
				},
			},
		};
		await expect(
			modalLifecycle("vm", directRunner(control)).destroy(
				{} as never,
				undefined,
				{},
				{
					kind: "name",
					value: "benchmark-12345678-1234-1234-1234-123456789abc",
				},
			),
		).rejects.toBe(firstMiss);
	});

	it("checks both name backends for every recovery and waits for every allocation", async () => {
		const lookups: string[] = [];
		const waits: boolean[] = [];
		const sandbox = () => ({
			poll: async () => null,
			terminate: async ({ wait }: { wait: true }) => {
				waits.push(wait);
				return 0;
			},
			detach: () => {},
		});
		const control = {
			sandboxes: {
				fromId: async () => {
					throw new Error("unused");
				},
				fromName: async (app: string, name: string) => {
					lookups.push(`stable:${app}:${name}`);
					return sandbox();
				},
				experimentalFromName: async (app: string, name: string) => {
					lookups.push(`v2:${app}:${name}`);
					return sandbox();
				},
			},
		};
		const locator = {
			kind: "name" as const,
			value: "benchmark-12345678-1234-1234-1234-123456789abc",
		};
		expect(
			await modalCreateRecovery("gvisor", directRunner(control)).cleanup({} as never, locator, {}),
		).toEqual({ status: "destroyed" });
		expect(
			await modalCreateRecovery("vm", directRunner(control)).cleanup({} as never, locator, {}),
		).toEqual({ status: "destroyed" });
		expect(lookups).toEqual([
			`v2:${MODAL_APP_NAME}:benchmark-12345678-1234-1234-1234-123456789abc`,
			`stable:${MODAL_APP_NAME}:benchmark-12345678-1234-1234-1234-123456789abc`,
			`stable:${MODAL_APP_NAME}:benchmark-12345678-1234-1234-1234-123456789abc`,
			`v2:${MODAL_APP_NAME}:benchmark-12345678-1234-1234-1234-123456789abc`,
		]);
		expect(waits).toEqual([true, true, true, true]);
	});

	it("destroys a cross-generation allocation before rejecting the wrapper id", async () => {
		const name = "benchmark-12345678-1234-1234-1234-123456789abc";
		const expectedMiss = new ClientError(
			"/modal.client.ModalClient/SandboxGetFromNameV2",
			Status.NOT_FOUND,
			"not present in V2",
		);
		const lookups: string[] = [];
		let terminated = 0;
		let wrapperDestroys = 0;
		const control = {
			sandboxes: {
				fromId: async () => {
					throw new Error("unsafe direct cleanup");
				},
				fromName: async (app: string, lookupName: string) => {
					lookups.push(`stable:${app}:${lookupName}`);
					return {
						terminate: async ({ wait }: { wait: true }) => {
							expect(wait).toBe(true);
							terminated += 1;
							return 0;
						},
						detach: () => {},
					};
				},
				experimentalFromName: async (app: string, lookupName: string) => {
					lookups.push(`v2:${app}:${lookupName}`);
					throw expectedMiss;
				},
			},
		};
		const runner = directRunner(control);
		const compute = {
			sandbox: {
				create: async (_options?: Record<string, unknown>) => ({
					sandboxId: "sb-rxWrDWGgOCJXeCSavkiDL6",
					getInstance: () => ({}),
					runCommand: async (_command: string) => ({ exitCode: 0, stdout: "", stderr: "" }),
					destroy: async () => {
						wrapperDestroys += 1;
					},
				}),
			},
		};
		const module = defineComputeSdkDriver("modal-gvisor", {
			provenance: { packageName: "@computesdk/modal", version: "1.9.3" },
			readiness: { startup: "create-returns-ready" },
			execution: { syncCapMs: null, durable: "none" },
			spec: () => ({
				compute,
				sandboxId: modalSandboxId("gvisor"),
				createOptions: {
					coverage: {
						spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "runtime-verified" },
						artifact: "context",
						deadlineMs: "harness",
						gpu: { model: "unsupported", count: "unsupported" },
						env: "mapped",
					},
					map: () => ({ name }),
				},
				lifecycle: modalLifecycle<typeof compute>("gvisor", runner),
				createRecovery: modalCreateRecovery<typeof compute>("gvisor", runner),
				prepareAndVerifyCreatedRequest: async () => ({ status: "honored" }),
				hasWorkingFilesystem: false,
			}),
		});
		const driver = module.driver({
			env: { MODAL_TOKEN_ID: "test-token", MODAL_TOKEN_SECRET: "test-secret" },
			artifact: { kind: "image" },
			resolvedArtifact: { kind: "image", ref: "registry.example/toolchain:version" },
		});
		const error = await driver.create(request()).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "invalid-sandbox-ref", provider: "modal-gvisor" });
		expect(lookups).toEqual([`v2:${MODAL_APP_NAME}:${name}`, `stable:${MODAL_APP_NAME}:${name}`]);
		expect({ terminated, wrapperDestroys }).toEqual({ terminated: 1, wrapperDestroys: 0 });
	});

	it("reports real gRPC not-found from poll as an absence observation", async () => {
		const control = {
			sandboxes: {
				fromId: async () => ({
					poll: async () => {
						throw new ClientError(
							"/modal.client.ModalClient/SandboxWait",
							Status.NOT_FOUND,
							"gone",
						);
					},
					terminate: async () => 0,
					detach: () => {},
				}),
				fromName: async () => {
					throw new Error("unused");
				},
				experimentalFromName: async () => {
					throw new Error("unused");
				},
			},
		};
		expect(
			await modalProbes(directRunner(control)).observe({} as never, {
				provider: "modal-vm",
				id: "sb-rxWrDWGgOCJXeCSavkiDL6",
			}),
		).toEqual({ state: "absent" });
	});

	it("accepts only null or safe-integer poll results", async () => {
		for (const malformed of [undefined, "0", 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
			const control = {
				sandboxes: {
					fromId: async () => ({
						poll: async () => malformed,
						terminate: async () => 0,
						detach: () => {},
					}),
					fromName: async () => {
						throw new Error("unused");
					},
					experimentalFromName: async () => {
						throw new Error("unused");
					},
				},
			};
			await expect(
				modalProbes(directRunner(control)).observe({} as never, {
					provider: "modal-vm",
					id: "sb-rxWrDWGgOCJXeCSavkiDL6",
				}),
			).rejects.toThrow(/malformed exit code/);
		}
	});
});

describe("Modal post-create verification", () => {
	it("accepts sufficient disk, rejects insufficient disk, and bounds the probe", async () => {
		const optionsSeen: unknown[] = [];
		const idsSeen: string[] = [];
		let wrapperIdReads = 0;
		const control = (kilobytes: unknown) => ({
			sandboxes: {
				fromId: async (id: string) => {
					idsSeen.push(id);
					return {
						poll: async () => null,
						terminate: async () => 0,
						exec: async (_command: unknown, options: unknown) => {
							optionsSeen.push(options);
							return {
								stdout: { readText: async () => `${kilobytes}\n` },
								stderr: { readText: async () => "" },
								wait: async () => 0,
							};
						},
						detach: () => {},
					};
				},
			},
		});
		const sandbox = {
			get sandboxId() {
				wrapperIdReads += 1;
				return "sb-01M0BXHCKJJHRYBN29EC21NMW4";
			},
		};
		expect(
			await verifyModalDiskCapacity(
				directRunner(control(50 * 1024 * 1024)),
				sandbox as never,
				request(),
				{},
				modalRef,
			),
		).toEqual({ status: "honored" });
		expect(
			await verifyModalDiskCapacity(
				directRunner(control(20 * 1024 * 1024)),
				sandbox as never,
				request(),
				{},
				modalRef,
			),
		).toMatchObject({ status: "unsupported" });
		expect(idsSeen).toEqual(["sb-rxWrDWGgOCJXeCSavkiDL6", "sb-rxWrDWGgOCJXeCSavkiDL6"]);
		expect(optionsSeen).toEqual([
			{ stdout: "pipe", stderr: "pipe", timeoutMs: MODAL_CONTROL_TIMEOUT_MS },
			{ stdout: "pipe", stderr: "pipe", timeoutMs: MODAL_CONTROL_TIMEOUT_MS },
		]);
		await expect(
			verifyModalDiskCapacity(
				directRunner(control(`${Number.MAX_SAFE_INTEGER}0`)),
				sandbox as never,
				request(),
				{},
				modalRef,
			),
		).rejects.toThrow(/invalid capacity/);
		expect(wrapperIdReads).toBe(0);
	});

	it("settles a bounded disk probe before observing a mid-flight abort", async () => {
		const controller = new AbortController();
		let settled = false;
		const control = {
			sandboxes: {
				fromId: async () => ({
					poll: async () => null,
					terminate: async () => 0,
					exec: async () => ({
						stdout: { readText: async () => `${50 * 1024 * 1024}\n` },
						stderr: { readText: async () => "" },
						wait: async () => {
							controller.abort();
							settled = true;
							return 0;
						},
					}),
					detach: () => {},
				}),
			},
		};
		await expect(
			verifyModalDiskCapacity(
				directRunner(control),
				{ sandboxId: "sb-rxWrDWGgOCJXeCSavkiDL6" } as never,
				request(),
				{ signal: controller.signal },
				modalRef,
			),
		).rejects.toThrow();
		expect(settled).toBeTrue();
	});
});

describe("Modal command projection", () => {
	function commandControl(
		stdout: unknown,
		stderr: unknown,
		exitCode: unknown,
		seen: Array<{ command: unknown; options: unknown }> = [],
	) {
		return {
			sandboxes: {
				fromId: async () => ({
					poll: async () => null,
					terminate: async () => 0,
					exec: async (command: unknown, options: unknown) => {
						seen.push({ command, options });
						return {
							stdout: { readText: async () => stdout },
							stderr: { readText: async () => stderr },
							wait: async () => exitCode,
						};
					},
					detach: () => {},
				}),
			},
		};
	}

	it("detaches an accepted control channel when foreground exec-start rejects", async () => {
		const primary = new Error("Modal exec-start rejected");
		let detachCalls = 0;
		const control = {
			sandboxes: {
				fromId: async () => ({
					poll: async () => null,
					terminate: async () => 0,
					exec: async () => Promise.reject(primary),
					detach: () => {
						detachCalls += 1;
					},
				}),
			},
		};
		await expect(
			execModalCommand(directRunner(control), {} as never, "true", modalRef),
		).rejects.toBe(primary);
		expect(detachCalls).toBe(1);
	});

	it("preserves the real nonzero exit and split streams", async () => {
		const seen: Array<{ command: unknown; options: unknown }> = [];
		expect(
			await execModalCommand(
				directRunner(commandControl("out", "err", 7, seen)),
				{} as never,
				"exit 7",
				modalRef,
			),
		).toEqual({
			stdout: "out",
			stderr: "err",
			exitCode: 7,
		});
		expect(seen).toEqual([
			{
				command: ["sh", "-c", "exit 7"],
				// Modal 0.9 rejects a defined timeoutMs <= 0. Omission means the foreground
				// process owns its duration after the bounded attachment/start transaction.
				options: { stdout: "pipe", stderr: "pipe" },
			},
		]);
	});

	it("uses the harness 50ms detached-acceptance contract and bounds the process", async () => {
		const seen: Array<{ command: unknown; options: unknown }> = [];
		await expect(
			launchModalCommand(
				directRunner(commandControl("", "", 0, seen)),
				{} as never,
				"sleep 1",
				modalRef,
			),
		).resolves.toBeUndefined();
		expect(seen).toEqual([
			{
				command: ["sh", "-c", modalDetachedCommand("sleep 1")],
				options: { stdout: "pipe", stderr: "pipe", timeoutMs: MODAL_CONTROL_TIMEOUT_MS },
			},
		]);
		expect(seen[0]?.command).toEqual([
			"sh",
			"-c",
			'nohup /bin/sh -lc \'sleep 1\' </dev/null >/dev/null 2>&1 & child=$!; finish() { wait "$child"; exit $?; }; sleep 0.05; if ! kill -0 "$child" 2>/dev/null; then finish; fi; if command -v ps >/dev/null 2>&1; then state=$(ps -o state= -p "$child" 2>/dev/null || :); case "$state" in *Z*) finish ;; "") if ! kill -0 "$child" 2>/dev/null; then finish; fi ;; esac; fi; exit 0',
		]);
		await expect(
			launchModalCommand(
				directRunner(commandControl("", "command not found", 127)),
				{} as never,
				"missing",
				modalRef,
			),
		).rejects.toThrow(/exited 127: command not found/);
	});

	it("joins every process result operation before surfacing the primary failure", async () => {
		const primary = new Error("stdout transport failed");
		let stderrSettled = false;
		let waitSettled = false;
		const control = {
			sandboxes: {
				fromId: async () => ({
					poll: async () => null,
					terminate: async () => 0,
					exec: async () => ({
						stdout: { readText: async () => Promise.reject(primary) },
						stderr: {
							readText: async () => {
								await Bun.sleep(5);
								stderrSettled = true;
								return "";
							},
						},
						wait: async () => {
							await Bun.sleep(10);
							waitSettled = true;
							return 0;
						},
					}),
					detach: () => {},
				}),
			},
		};
		await expect(
			launchModalCommand(directRunner(control), {} as never, "true", modalRef),
		).rejects.toBe(primary);
		expect({ stderrSettled, waitSettled }).toEqual({ stderrSettled: true, waitSettled: true });
	});

	it("joins started siblings when a later process accessor throws synchronously", async () => {
		const primary = new Error("stderr accessor is unreadable");
		let stdoutSettled = false;
		let waitSettled = false;
		const control = {
			sandboxes: {
				fromId: async () => ({
					poll: async () => null,
					terminate: async () => 0,
					exec: async () => ({
						stdout: {
							readText: async () => {
								await Bun.sleep(10);
								stdoutSettled = true;
								return "";
							},
						},
						get stderr(): never {
							throw primary;
						},
						wait: async () => {
							waitSettled = true;
							return 0;
						},
					}),
					detach: () => {},
				}),
			},
		};
		await expect(
			execModalCommand(directRunner(control), {} as never, "true", modalRef),
		).rejects.toBe(primary);
		expect({ stdoutSettled, waitSettled }).toEqual({ stdoutSettled: true, waitSettled: true });
	});

	it("detaches on the first process failure before joining cancellation-bound siblings", async () => {
		const primary = new Error("stdout transport failed");
		let detached = false;
		let stderrSettled = false;
		let waitSettled = false;
		let releaseStderr: (() => void) | undefined;
		let releaseWait: (() => void) | undefined;
		const cancellationBound = (settled: () => void, install: (release: () => void) => void) => {
			if (detached) {
				settled();
				return Promise.resolve("");
			}
			return new Promise<string>((resolve) => {
				install(() => {
					settled();
					resolve("");
				});
			});
		};
		const control = {
			sandboxes: {
				fromId: async () => ({
					poll: async () => null,
					terminate: async () => 0,
					exec: async () => ({
						stdout: { readText: async () => Promise.reject(primary) },
						stderr: {
							readText: () =>
								cancellationBound(
									() => {
										stderrSettled = true;
									},
									(release) => {
										releaseStderr = release;
									},
								),
						},
						wait: () =>
							cancellationBound(
								() => {
									waitSettled = true;
								},
								(release) => {
									releaseWait = release;
								},
							).then(() => 0),
					}),
					detach: () => {
						detached = true;
						releaseStderr?.();
						releaseWait?.();
					},
				}),
			},
		};
		const operation = execModalCommand(directRunner(control), {} as never, "true", modalRef);
		const outcome = await Promise.race([
			operation.then(
				() => ({ kind: "success" as const }),
				(error: unknown) => ({ kind: "error" as const, error }),
			),
			Bun.sleep(50).then(() => ({ kind: "pending" as const })),
		]);
		if (outcome.kind === "pending") {
			detached = true;
			releaseStderr?.();
			releaseWait?.();
			await operation.catch(() => undefined);
		}
		expect(outcome).toEqual({ kind: "error", error: primary });
		expect({ detached, stderrSettled, waitSettled }).toEqual({
			detached: true,
			stderrSettled: true,
			waitSettled: true,
		});
	});

	it("rejects malformed command envelopes instead of canonicalizing them", async () => {
		for (const [stdout, stderr, exitCode] of [
			[{}, "", 0],
			["", {}, 0],
			["", "", 1.5],
			["", "", 2 ** 53],
		] as const) {
			await expect(
				execModalCommand(
					directRunner(commandControl(stdout, stderr, exitCode)),
					{} as never,
					"true",
					modalRef,
				),
			).rejects.toThrow(/malformed result/);
		}
	});
});
