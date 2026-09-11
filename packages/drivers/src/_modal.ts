// Both Modal variants use the pinned native SDK for allocation and execution. The shared bridge
// owns request validation, error normalization, recovery, and session assembly.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
	CreateRequest,
	DriverContext,
	DriverOperationOptions,
	ExecOptions,
	ProviderCostEvidenceCapability,
	SandboxObservation,
	SandboxRef,
} from "@sandbox-benchmarks/driver";
import { shellQuote } from "@sandbox-benchmarks/driver";
import { type } from "arktype";
import { ModalClient, NotFoundError, Sandbox } from "modal";
import type { ClientMiddleware } from "nice-grpc";
import { ClientError, Status } from "nice-grpc";
import type {
	ComputeSdkCreatedRequestVerification,
	ComputeSdkCreateRecovery,
	ComputeSdkCreateRequestCoverage,
	ComputeSdkDriverSpec,
	ComputeSdkLifecycle,
	ComputeSdkLike,
	ComputeSdkSandboxIdSchema,
	ComputeSdkSandboxOf,
} from "./_computesdk.ts";
import { computeSdkSpec, defineComputeSdkDriver } from "./_computesdk.ts";
import { matchesAnyCause } from "./_errors.ts";
import { nativeSdkCompute } from "./_native.ts";
import { MODAL_NATIVE_PROVENANCE, MODAL_PROVENANCE } from "./_provenance.ts";

export { MODAL_NATIVE_PROVENANCE, MODAL_PROVENANCE };

export type ModalProviderId = "modal-gvisor" | "modal-vm";
export type ModalVariant = "gvisor" | "vm";

type ModalCompute = ReturnType<typeof nativeModalCompute>;
type ModalSandboxHandle = ComputeSdkSandboxOf<ModalCompute>;

interface ModalControlSandbox {
	poll(): Promise<number | null>;
	terminate(params: { readonly wait: true }): Promise<number>;
	exec(
		command: string[],
		params: { readonly stdout: "pipe"; readonly stderr: "pipe"; readonly timeoutMs?: number },
	): Promise<ModalTextProcess>;
	detach(): void;
}

interface ModalControlApp {
	readonly appId: string;
}

interface ModalControlPlane {
	readonly apps: {
		/** The named App, or undefined when this workspace has never created it. */
		fromName(name: string): Promise<ModalControlApp | undefined>;
		list(): Promise<Awaited<ReturnType<ModalClient["cpClient"]["appList"]>>["apps"]>;
	};
	readonly sandboxes: {
		fromId(id: string): Promise<ModalControlSandbox>;
		fromName(appName: string, name: string): Promise<ModalControlSandbox>;
		experimentalFromName(appName: string, name: string): Promise<ModalControlSandbox>;
		/** Every v1 sandbox in the environment, or only those under `appId`. */
		list(params: { readonly appId?: string }): AsyncIterable<{ readonly sandboxId: string }>;
		/** Every v2 sandbox under one App; the SDK cannot enumerate v2 environment-wide. */
		experimentalList(params: {
			readonly appId: string;
		}): AsyncIterable<{ readonly sandboxId: string }>;
	};
}

export interface ModalControlRunner<Control = ModalControlPlane> {
	run<T>(
		options: DriverOperationOptions,
		operation: (control: Control) => Promise<T>,
		onAbort?: () => void,
	): Promise<T>;
}

export const MODAL_APP_NAME = "sandbox-benchmarks";
/**
 * Native Modal SDK identity for cost-evidence records (not the `@computesdk/modal` wrapper).
 *
 * This module imports `modal` directly for its control plane, so the SDK whose public surface was
 * searched for a sandbox-scoped usage endpoint is the catalog-pinned copy this package resolves —
 * NOT the older one the wrapper vendors. Generated from that same pin so the recorded version
 * cannot drift from the installed one; `_modal.test.ts` asserts it against the resolved package.
 */
export const MODAL_COST_SDK_PROVENANCE =
	MODAL_NATIVE_PROVENANCE satisfies ProviderCostEvidenceCapability["sdk"];
export const MODAL_SANDBOX_LIFETIME_MS = 3 * 60 * 60_000;
export const MODAL_CONTROL_TIMEOUT_MS = 5_000;
/** Enumerating an account is a multi-page loop, not one bounded RPC; it gets its own budget. */
export const MODAL_INVENTORY_TIMEOUT_MS = 60_000;
export const MODAL_RECOVERY_CONFIRMATION_MS = 2_000;
export const MODAL_RECOVERY_MAX_ATTEMPTS = 4;
export const MODAL_READINESS = Object.freeze({ startup: "create-returns-ready" as const });
export const MODAL_EXECUTION = Object.freeze({
	syncCapMs: 30 * 60_000,
	durable: "shell-detach" as const,
});
export const MODAL_V1_SANDBOX_ID = type(/^sb-[A-Za-z0-9]{22}$/);
export const MODAL_V2_SANDBOX_ID = type(/^sb-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const MODAL_CONTROL_SANDBOX_ID = type(/^sb-(?:[A-Za-z0-9]{22}|[0-7][0-9A-HJKMNP-TV-Z]{25})$/);

export function modalSandboxId(variant: ModalVariant): ComputeSdkSandboxIdSchema {
	return {
		// A cross-generation id is still a real allocation identity. Retain it as a safe raw
		// boundary so recovery can destroy the allocation before canonical validation rejects it.
		fromVendor: MODAL_CONTROL_SANDBOX_ID,
		canonical: variant === "gvisor" ? MODAL_V2_SANDBOX_ID : MODAL_V1_SANDBOX_ID,
	};
}

export const MODAL_REQUEST_COVERAGE = {
	spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "runtime-verified" },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "mapped",
} as const satisfies ComputeSdkCreateRequestCoverage;

const MODAL_SANDBOX_NOT_FOUND_PATHS = new Set([
	"/modal.client.ModalClient/SandboxGetFromName",
	"/modal.client.ModalClient/SandboxGetFromNameV2",
	"/modal.client.ModalClient/SandboxTerminate",
	"/modal.client.ModalClient/SandboxTerminateV2",
	"/modal.client.ModalClient/SandboxWait",
	"/modal.client.ModalClient/SandboxWaitV2",
]);

function isModalNotFound(caught: unknown): boolean {
	try {
		return (
			caught instanceof ClientError &&
			caught.code === Status.NOT_FOUND &&
			MODAL_SANDBOX_NOT_FOUND_PATHS.has(caught.path)
		);
	} catch {
		return false;
	}
}

/** Native gRPC capacity refusal; transport failures and vendor prose stay terminal. */
export function isModalRetryableCreate(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(link) => link instanceof ClientError && link.code === Status.RESOURCE_EXHAUSTED,
	);
}

/**
 * Modal's high-level fromName catches every nested NOT_FOUND (including AuthTokenGet) and rewrites
 * it to an unqualified NotFoundError. Ownership lookup uses the public control client directly so
 * the originating RPC path survives and only a sandbox lookup can prove absence.
 */
export function modalControlPlane(client: ModalClient): ModalControlPlane {
	return {
		apps: {
			list: async () =>
				(await client.cpClient.appList({ environmentName: client.environmentName() })).apps,
			fromName: async (name) => {
				try {
					return await client.apps.fromName(name, { createIfMissing: false });
				} catch (caught) {
					// Only the SDK's typed absence means "no such App"; an inventory must not create one.
					if (caught instanceof NotFoundError) return undefined;
					throw caught;
				}
			},
		},
		sandboxes: {
			fromId: (id) => client.sandboxes.fromId(id),
			list: (params) => client.sandboxes.list(params),
			experimentalList: (params) => client.sandboxes.experimentalList(params),
			fromName: async (appName, name) => {
				const response = await client.cpClient.sandboxGetFromName({
					appName,
					sandboxName: name,
					environmentName: client.environmentName(),
				});
				return new Sandbox(client, MODAL_V1_SANDBOX_ID.assert(response.sandboxId), {
					isV2: false,
				});
			},
			experimentalFromName: async (appName, name) => {
				const response = await client.cpClient.sandboxGetFromNameV2({
					appName,
					sandboxName: name,
					environmentName: client.environmentName(),
				});
				return new Sandbox(client, MODAL_V2_SANDBOX_ID.assert(response.sandboxId), {
					isV2: true,
				});
			},
		},
	};
}

/**
 * Modal 0.9 declares client timeout/retry constructor fields but does not apply them at runtime.
 * Inject the transaction signal where the SDK's middleware chain actually consumes it. nice-grpc
 * invokes the last-attached custom middleware first, so these options reach Modal's timeout and
 * retry middleware on every control-plane RPC. The outer timer spans multi-RPC loops such as
 * terminate({wait:true}).
 */
export function createModalControlRunner<Control>(
	createControl: (middleware: ClientMiddleware) => Control,
	timeoutMs = MODAL_CONTROL_TIMEOUT_MS,
): ModalControlRunner<Control> {
	const operationSignals = new AsyncLocalStorage<AbortSignal>();
	const deadlineMiddleware: ClientMiddleware = async function* (call, options) {
		const signal = operationSignals.getStore();
		if (signal === undefined) {
			throw new Error("Modal control RPC escaped its bounded operation");
		}
		const nextOptions = {
			...options,
			signal,
			timeoutMs,
			// Modal 0.9's retry middleware drops `signal` entirely when retries is zero, so one
			// bounded retry is what keeps cancellation attached to the real gRPC transport; the
			// operation-wide controller remains the hard ceiling across both attempts.
			//
			// Retrying a non-idempotent SandboxExec is safe here: that middleware stamps one
			// x-idempotency-key per call and replays it on every attempt, so a response lost after
			// the server accepted the exec is deduplicated server-side rather than starting the
			// benchmark command a second time. Stock Modal defaults to three attempts on every unary
			// RPC; one is the conservative setting, not a laxer one.
			retries: 1,
		};
		return yield* call.next(call.request, nextOptions);
	};
	const control = createControl(deadlineMiddleware);
	return {
		run: async (options, operation, onAbort) => {
			options.signal?.throwIfAborted();
			const controller = new AbortController();
			const abort = (reason: unknown) => {
				if (controller.signal.aborted) return;
				controller.abort(reason);
				try {
					onAbort?.();
				} catch {
					// Closing a local transport is best effort; the operation rejection remains primary.
				}
			};
			const forwardAbort = () => abort(options.signal?.reason);
			options.signal?.addEventListener("abort", forwardAbort, { once: true });
			const timer = setTimeout(
				() => abort(new Error(`Modal control operation exceeded ${timeoutMs}ms`)),
				timeoutMs,
			);
			try {
				const result = await operationSignals.run(controller.signal, () => operation(control));
				controller.signal.throwIfAborted();
				return result;
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", forwardAbort);
				if (controller.signal.aborted) {
					try {
						onAbort?.();
					} catch {
						// The operation's cancellation/timeout remains the primary failure.
					}
				}
			}
		},
	};
}

interface ModalTextProcess {
	readonly stdout: { readText(): Promise<unknown> };
	readonly stderr: { readText(): Promise<unknown> };
	wait(): Promise<unknown>;
}

export async function modalProcessResult(
	process: ModalTextProcess,
	onFailure: () => void,
): Promise<{
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}> {
	const settleAfterFailure = async (start: () => Promise<unknown>): Promise<unknown> => {
		try {
			return await Promise.resolve().then(start);
		} catch (caught) {
			try {
				onFailure();
			} catch {
				// Local transport close is best effort; the process failure remains primary.
			}
			throw caught;
		}
	};
	const settled = await Promise.allSettled(
		[() => process.stdout.readText(), () => process.stderr.readText(), () => process.wait()].map(
			settleAfterFailure,
		),
	);
	// Detach can reject one stream before the others finish unwinding. Join every accepted
	// command-router operation before surfacing the first deterministic error so runner.run never
	// releases a transaction with sibling RPCs still active.
	const [stdout, stderr, exitCode] = settled.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
	if (
		typeof stdout !== "string" ||
		typeof stderr !== "string" ||
		typeof exitCode !== "number" ||
		!Number.isSafeInteger(exitCode)
	) {
		throw new Error("Modal process returned a malformed result");
	}
	return { stdout, stderr, exitCode };
}

function modalVariant(provider: ModalProviderId): ModalVariant {
	return provider === "modal-gvisor" ? "gvisor" : "vm";
}

const MODAL_CREATE_OPTIONS = type({
	templateId: "string >= 1",
	name: "string >= 1",
	timeout: "number.integer > 0",
	cpu: "number > 0",
	cpuLimit: "number > 0",
	memoryMiB: "number.integer > 0",
	memoryLimitMiB: "number.integer > 0",
	"envs?": { "[string]": "string" },
	"experimentalOptions?": { vm_runtime: "true" },
});

/** App/image resolution and allocation all run inside the cancellable create transaction. */
export function nativeModalCompute(
	variant: ModalVariant,
	credentials: { readonly tokenId: string; readonly tokenSecret: string },
	clientFactory = (middleware: ClientMiddleware) =>
		new ModalClient({ ...credentials, grpcMiddleware: [middleware] }),
) {
	const runner = createModalControlRunner(clientFactory, 300_000);
	return nativeSdkCompute(
		(options) => MODAL_CREATE_OPTIONS.assert(options),
		(options, operation) =>
			runner.run(operation, async (client) => {
				const app = await client.apps.fromName(MODAL_APP_NAME, { createIfMissing: true });
				const image = client.images.fromRegistry(options.templateId);
				const params = {
					name: options.name,
					timeoutMs: options.timeout,
					cpu: options.cpu,
					cpuLimit: options.cpuLimit,
					memoryMiB: options.memoryMiB,
					memoryLimitMiB: options.memoryLimitMiB,
					...(options.envs === undefined ? {} : { env: options.envs }),
					...(options.experimentalOptions === undefined
						? {}
						: { experimentalOptions: options.experimentalOptions }),
				};
				return variant === "gvisor"
					? client.sandboxes.experimentalCreate(app, image, params)
					: client.sandboxes.create(app, image, params);
			}),
		(native) => ({
			sandboxId: native.sandboxId,
			runCommand: async (command) =>
				modalProcessResult(
					await native.exec(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" }),
					() => native.detach(),
				),
			destroy: () => native.terminate({ wait: true }),
		}),
	);
}

function recoveryName(createOptions: Readonly<Record<string, unknown>>): string {
	const name = createOptions.name;
	if (typeof name !== "string" || !/^benchmark-[0-9a-f-]{36}$/.test(name)) {
		throw new Error("Modal create options contain no stable benchmark name");
	}
	return name;
}

/** Translate the canonical request without letting artifact or resource policy drift by variant. */
export function modalCreateOptions(
	variant: ModalVariant,
	resolvedArtifactRef: string,
): ComputeSdkDriverSpec<ModalCompute>["createOptions"] {
	return {
		coverage: MODAL_REQUEST_COVERAGE,
		map: (request, unsupported) => {
			if (request.artifact.kind !== "image" || request.artifact.ref !== resolvedArtifactRef) {
				unsupported("the request artifact does not match the resolved Modal image");
			}
			return {
				templateId: resolvedArtifactRef,
				name: `benchmark-${randomUUID()}`,
				timeout: MODAL_SANDBOX_LIFETIME_MS,
				// Modal's docs describe physical cores, but live behavior contradicts that reading:
				// cpu=1 exposes nproc=1 and delivered 264 MB hashed/worker/8s versus 512 at cpu=2
				// (2026-07-10). `cpu` is the guest-schedulable vCPU count, so pass it unhalved.
				cpu: request.spec.vcpus,
				cpuLimit: request.spec.vcpus,
				// `memoryMiB` alone is a reservation: a live guest exposed 464 GiB of host RAM,
				// causing PTS STREAM sizing never to converge. The limit makes /proc match spec.
				memoryMiB: request.spec.memoryGb * 1024,
				memoryLimitMiB: request.spec.memoryGb * 1024,
				...(request.env === undefined ? {} : { envs: request.env }),
				// The stable service plus vm_runtime is the VM config validated in #221.
				...(variant === "vm" ? { experimentalOptions: { vm_runtime: true as const } } : {}),
			} satisfies typeof MODAL_CREATE_OPTIONS.infer;
		},
	};
}

function modalSandboxByName(
	control: ModalControlPlane,
	backend: "v1" | "v2",
	name: string,
	appName: string,
): Promise<ModalControlSandbox> {
	return backend === "v2"
		? control.sandboxes.experimentalFromName(appName, name)
		: control.sandboxes.fromName(appName, name);
}

/** Waited, bounded teardown preserves transport failures and confirms terminal state. */
export function modalLifecycle<TCompute extends ComputeSdkLike = ModalCompute>(
	backend: "v1" | "v2",
	runner: ModalControlRunner,
	appName = MODAL_APP_NAME,
): ComputeSdkLifecycle<TCompute> {
	return {
		destroy: async (_sandbox, ref, options, recoveryLocator) => {
			let attached: ModalControlSandbox | undefined;
			try {
				await runner.run(
					options,
					async (control) => {
						if (ref !== undefined) {
							attached = await control.sandboxes.fromId(ref.id);
						} else {
							if (recoveryLocator === undefined) {
								throw new Error("Modal failed-create cleanup has no stable recovery name");
							}
							attached = await modalSandboxByName(control, backend, recoveryLocator.value, appName);
						}
						await attached.terminate({ wait: true });
					},
					() => attached?.detach(),
				);
			} catch (caught) {
				// A canonical-id teardown or a miss after successful name attachment proves
				// convergence. A first miss by recovery name does not: the name index can lag a
				// create that already returned a handle, so ownership must remain retryable.
				if (isModalNotFound(caught) && (ref !== undefined || attached !== undefined)) return;
				throw caught;
			}
		},
	};
}

/** Stable create names let the bridge reconcile an accepted allocation whose response was lost. */
export function modalCreateRecovery<TCompute extends ComputeSdkLike = ModalCompute>(
	backend: "v1" | "v2",
	runner: ModalControlRunner,
	appName = MODAL_APP_NAME,
): ComputeSdkCreateRecovery<TCompute> {
	return {
		absenceConfirmationMs: MODAL_RECOVERY_CONFIRMATION_MS,
		maxAttempts: MODAL_RECOVERY_MAX_ATTEMPTS,
		isRetryableCreate: isModalRetryableCreate,
		locator: (createOptions) => ({ kind: "name", value: recoveryName(createOptions) }),
		cleanup: (_compute, locator, options) => {
			const name = locator.value;
			let active: ModalControlSandbox | undefined;
			return runner.run(
				options,
				async (control) => {
					const lookups =
						backend === "v2"
							? [
									() => control.sandboxes.experimentalFromName(appName, name),
									() => control.sandboxes.fromName(appName, name),
								]
							: [
									() => control.sandboxes.fromName(appName, name),
									() => control.sandboxes.experimentalFromName(appName, name),
								];
					let found = false;
					let destroyed = false;
					for (const lookup of lookups) {
						try {
							active = await lookup();
							found = true;
						} catch (caught) {
							if (isModalNotFound(caught)) continue;
							throw caught;
						}
						try {
							// Once found, the transaction continues through waited teardown. An abort
							// cancels the RPC and fails cleanup; it never reports false convergence.
							await active.terminate({ wait: true });
							destroyed = true;
						} catch (caught) {
							if (!isModalNotFound(caught)) throw caught;
						} finally {
							active.detach();
							active = undefined;
						}
					}
					if (destroyed) return { status: "destroyed" };
					return found
						? { status: "absent", contradictedPriorAbsence: true }
						: { status: "absent" };
				},
				() => active?.detach(),
			);
		},
	};
}

export function modalProbes(
	runner: ModalControlRunner,
): NonNullable<ComputeSdkDriverSpec<ModalCompute>["probes"]> {
	return {
		observe: async (_compute, ref: SandboxRef): Promise<SandboxObservation> => {
			let sandbox: ModalControlSandbox | undefined;
			try {
				const exitCode = await runner.run(
					{},
					async (control) => {
						sandbox = await control.sandboxes.fromId(ref.id);
						try {
							return await sandbox.poll();
						} finally {
							sandbox.detach();
						}
					},
					() => sandbox?.detach(),
				);
				if (exitCode === null) return { state: "running" };
				if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) {
					throw new Error("Modal poll returned a malformed exit code");
				}
				return { state: "terminal" };
			} catch (caught) {
				if (isModalNotFound(caught)) return { state: "absent" };
				throw caught;
			}
		},
	};
}

/** Enumerate both generations across every App; the benchmark App owns both variants. */
export function modalInventory(
	variant: ModalVariant,
	runner: ModalControlRunner,
	appName = MODAL_APP_NAME,
): NonNullable<ComputeSdkDriverSpec<ModalCompute>["inventory"]> {
	return {
		list: (_compute, options) =>
			runner.run(options, async (control) => {
				const collect = async (rows: AsyncIterable<{ readonly sandboxId: string }>) => {
					const ids = new Set<string>();
					for await (const row of rows) ids.add(MODAL_CONTROL_SANDBOX_ID.assert(row.sandboxId));
					return ids;
				};
				const app = await control.apps.fromName(appName);
				const appV1 =
					app === undefined
						? new Set<string>()
						: await collect(control.sandboxes.list({ appId: app.appId }));
				const owned =
					variant === "gvisor"
						? app === undefined
							? new Set<string>()
							: await collect(control.sandboxes.experimentalList({ appId: app.appId }))
						: appV1;
				let foreignCount = 0;
				for (const id of await collect(control.sandboxes.list({}))) {
					if (!appV1.has(id)) foreignCount += 1;
				}
				for (const other of await control.apps.list()) {
					if (other.appId === app?.appId) continue;
					foreignCount += (
						await collect(control.sandboxes.experimentalList({ appId: other.appId }))
					).size;
				}
				return { owned: [...owned], foreignCount };
			}),
	};
}

/** Canonical-id teardown for account recovery; only a sandbox-RPC not-found is convergence. */
export function modalDestroyById(
	runner: ModalControlRunner,
): NonNullable<ComputeSdkDriverSpec<ModalCompute>["destroyById"]> {
	return async (_compute, ref, options) => {
		let attached: ModalControlSandbox | undefined;
		try {
			await runner.run(
				options,
				async (control) => {
					attached = await control.sandboxes.fromId(ref.id);
					await attached.terminate({ wait: true });
				},
				() => attached?.detach(),
			);
		} catch (caught) {
			if (isModalNotFound(caught)) return;
			throw caught;
		}
	};
}

/** Preserve the native process result and join output streams before releasing the command. */
export async function execModalCommand(
	runner: ModalControlRunner,
	_sandbox: ModalSandboxHandle,
	command: string,
	ref: SandboxRef,
	options: ExecOptions = {},
): Promise<unknown> {
	let attached: ModalControlSandbox | undefined;
	let process: ModalTextProcess;
	try {
		process = await runner.run(
			{ signal: options.signal },
			async (control) => {
				attached = await control.sandboxes.fromId(ref.id);
				// Bound attachment and exec-start only; foreground benchmark commands may
				// legitimately run for minutes and own their duration outside this control budget.
				return attached.exec(["sh", "-c", command], {
					stdout: "pipe",
					stderr: "pipe",
				});
			},
			() => attached?.detach(),
		);
	} catch (caught) {
		// A normal exec-start rejection does not pass through the runner's abort callback.
		try {
			attached?.detach();
		} catch {
			// Local transport close is best effort; the exec-start failure remains primary.
		}
		throw caught;
	}
	try {
		return await modalProcessResult(process, () => attached?.detach());
	} finally {
		attached?.detach();
	}
}

/** The same acceptance contract as the harness fallback, projected through Modal's native exec. */
export function modalDetachedCommand(command: string): string {
	return `nohup /bin/sh -lc ${shellQuote(command)} </dev/null >/dev/null 2>&1 & child=$!; finish() { wait "$child"; exit $?; }; sleep 0.05; if ! kill -0 "$child" 2>/dev/null; then finish; fi; if command -v ps >/dev/null 2>&1; then state=$(ps -o state= -p "$child" 2>/dev/null || :); case "$state" in *Z*) finish ;; "") if ! kill -0 "$child" 2>/dev/null; then finish; fi ;; esac; fi; exit 0`;
}

export async function launchModalCommand(
	runner: ModalControlRunner,
	_sandbox: ModalSandboxHandle,
	command: string,
	ref: SandboxRef,
	options: ExecOptions = {},
): Promise<void> {
	let attached: ModalControlSandbox | undefined;
	const { stderr, exitCode } = await runner.run(
		{ signal: options.signal },
		async (control) => {
			attached = await control.sandboxes.fromId(ref.id);
			try {
				const process = await attached.exec(["sh", "-c", modalDetachedCommand(command)], {
					stdout: "pipe",
					stderr: "pipe",
					timeoutMs: MODAL_CONTROL_TIMEOUT_MS,
				});
				return await modalProcessResult(process, () => attached?.detach());
			} finally {
				attached.detach();
			}
		},
		() => attached?.detach(),
	);
	if (exitCode !== 0) throw new Error(`Modal background launch exited ${exitCode}: ${stderr}`);
}

export async function verifyModalDiskCapacity(
	runner: ModalControlRunner,
	_sandbox: ModalSandboxHandle,
	request: CreateRequest,
	options: DriverOperationOptions,
	ref: SandboxRef,
): Promise<ComputeSdkCreatedRequestVerification> {
	const requestedDiskGb = request.spec.diskGb;
	if (requestedDiskGb === undefined) return { status: "honored" };
	let attached: ModalControlSandbox | undefined;
	const { stdout, stderr, exitCode } = await runner.run(
		options,
		async (control) => {
			attached = await control.sandboxes.fromId(ref.id);
			try {
				const process = await attached.exec(["sh", "-c", "df -Pk / | awk 'NR==2 {print $2}'"], {
					stdout: "pipe",
					stderr: "pipe",
					timeoutMs: MODAL_CONTROL_TIMEOUT_MS,
				});
				return await modalProcessResult(process, () => attached?.detach());
			} finally {
				attached.detach();
			}
		},
		() => attached?.detach(),
	);
	if (exitCode !== 0) {
		throw new Error(`Modal disk capacity probe exited ${exitCode}: ${stderr}`);
	}
	const output = stdout.trim();
	if (!/^\d+$/.test(output)) throw new Error("Modal disk capacity probe returned malformed output");
	const capacityKb = Number(output);
	if (!Number.isSafeInteger(capacityKb) || capacityKb <= 0) {
		throw new Error("Modal disk capacity probe returned an invalid capacity");
	}
	const capacityGb = capacityKb / 1024 / 1024;
	return capacityGb >= requestedDiskGb
		? { status: "honored" }
		: {
				status: "unsupported",
				detail: `requested ${requestedDiskGb} GiB but the allocation exposes ${capacityGb.toFixed(2)} GiB`,
			};
}

function modalSpec<P extends ModalProviderId>(
	provider: P,
	{ env, resolvedArtifact }: DriverContext<P>,
) {
	const variant = modalVariant(provider);
	const control = (middleware: ClientMiddleware) =>
		modalControlPlane(
			new ModalClient({
				tokenId: env.MODAL_TOKEN_ID,
				tokenSecret: env.MODAL_TOKEN_SECRET,
				grpcMiddleware: [middleware],
			}),
		);
	const runner = createModalControlRunner(control);
	const inventoryRunner = createModalControlRunner(control, MODAL_INVENTORY_TIMEOUT_MS);
	return computeSdkSpec(
		nativeModalCompute(variant, {
			tokenId: env.MODAL_TOKEN_ID,
			tokenSecret: env.MODAL_TOKEN_SECRET,
		}),
		{
			sandboxId: modalSandboxId(variant),
			createOptions: modalCreateOptions(variant, resolvedArtifact.ref),
			commands: {
				exec: (sandbox, command, options, ref) =>
					execModalCommand(runner, sandbox, command, ref, options),
				launch: (sandbox, command, options, ref) =>
					launchModalCommand(runner, sandbox, command, ref, options),
			},
			lifecycle: modalLifecycle(variant === "gvisor" ? "v2" : "v1", runner),
			createRecovery: modalCreateRecovery(variant === "gvisor" ? "v2" : "v1", runner),
			prepareAndVerifyCreatedRequest: (sandbox, _native, request, options, ref) =>
				verifyModalDiskCapacity(runner, sandbox, request, options, ref),
			// Both variants use the kit's direct-exec filesystem fallback.
			hasWorkingFilesystem: false,
			probes: modalProbes(runner),
			inventory: modalInventory(variant, inventoryRunner),
			destroyById: modalDestroyById(runner),
		},
	);
}

/**
 * Shared object: both Modal isolation variants have exactly one public cost capability.
 * The hook does not invoke the private SandboxGetResourceUsage RPC.
 */
export const modalCostEvidence: ProviderCostEvidenceCapability<ModalProviderId> = {
	sdk: MODAL_COST_SDK_PROVENANCE,
	captureAfterTeardown: async (input) => {
		const subject = {
			kind: "sandbox" as const,
			sandboxId: input.sandboxId,
			appName: MODAL_APP_NAME,
		};
		if (!input.teardown.completed) {
			return {
				kind: "missing",
				cell: input.cell,
				subject,
				capturedAt: new Date().toISOString(),
				sdk: MODAL_COST_SDK_PROVENANCE,
				reason: "sandbox_teardown_unconfirmed",
				detail: "Sandbox teardown was not confirmed; no provider usage was considered.",
			};
		}
		return {
			kind: "missing",
			cell: input.cell,
			subject,
			capturedAt: new Date().toISOString(),
			sdk: MODAL_COST_SDK_PROVENANCE,
			reason: "unsupported_public_api",
			detail:
				"The generated SandboxGetResourceUsage RPC is private and was not invoked; the installed public Modal SDK exposes no trustworthy sandbox-scoped billed usage endpoint.",
		};
	},
};

/** One provider literal selects both identity and backend; invalid cross-pairs are unrepresentable. */
export function defineModalDriver<P extends ModalProviderId>(provider: P) {
	return defineComputeSdkDriver(provider, {
		provenance: MODAL_PROVENANCE,
		readiness: MODAL_READINESS,
		execution: MODAL_EXECUTION,
		costEvidence: modalCostEvidence,
		spec: (context) => modalSpec(provider, context),
	});
}
