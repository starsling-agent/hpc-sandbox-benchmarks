/**
 * Process-level ownership for provider sandboxes.
 *
 * Every harness create goes through {@link createOwnedSandbox}. The returned handle keeps the
 * provider's surface, but its destroy is idempotent and removes it from the process registry only
 * after the provider confirms teardown. While anything is pending or live, SIGINT/SIGTERM drain the
 * registry before exiting. Ordinary CLI exits use the same bounded drain, `beforeExit` covers a
 * natural fallthrough, and a second signal preserves the usual "force quit now" escape hatch.
 */

import type { EventEmitter } from "node:events";

interface DestroyableSandbox {
	readonly sandboxId?: string;
	readonly sandboxRef?: { readonly id: string };
	destroy(): Promise<unknown>;
}

export interface OwnedOperationOptions {
	readonly signal?: AbortSignal;
}

export interface OwnedSandboxOptions {
	/** Cancellation bridge over the captured original destroy method (never the owner wrapper). */
	readonly destroy?: (
		providerDestroy: (options?: OwnedOperationOptions) => Promise<unknown>,
		options: OwnedOperationOptions,
	) => Promise<unknown>;
}

interface OwnedEntry<T extends DestroyableSandbox> {
	promise: Promise<T>;
	destroy?: (options?: OwnedOperationOptions) => Promise<unknown>;
	abortCreate?: (reason: unknown) => void;
	sandboxId?: string;
	handle?: object;
}

export interface SandboxCleanupOptions {
	/** Total cleanup attempts. Defaults to 3. */
	attempts?: number;
	/** Total wall-clock cleanup budget. Defaults to 15 seconds. */
	timeoutMs?: number;
	/** Delay between attempts. Defaults to 250ms. */
	retryDelayMs?: number;
}

const owned = new Set<OwnedEntry<DestroyableSandbox>>();
const entriesByHandle = new WeakMap<object, OwnedEntry<DestroyableSandbox>>();
const signals = ["SIGINT", "SIGTERM"] as const;
// Bun 1.4 adds a memoryPressure-only Process.off overload that hides EventEmitter.off.
const processEvents = process as EventEmitter;
const DEFAULT_CLEANUP_ATTEMPTS = 3;
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_RETRY_MS = 250;

let handlersInstalled = false;
let stopping = false;
let signalCleanup: Promise<void> | undefined;
let beforeExitCleanup: Promise<void> | undefined;

function signalExitCode(signal: (typeof signals)[number]): number {
	return signal === "SIGINT" ? 130 : 143;
}

function uninstallProcessHandlers(): void {
	if (!handlersInstalled) return;
	for (const signal of signals) processEvents.off(signal, onSignal);
	processEvents.off("beforeExit", onBeforeExit);
	handlersInstalled = false;
}

function release(entry: OwnedEntry<DestroyableSandbox>): void {
	owned.delete(entry);
	if (entry.handle !== undefined) entriesByHandle.delete(entry.handle);
	entry.handle = undefined;
	if (owned.size === 0) uninstallProcessHandlers();
}

function trackHandle<T extends DestroyableSandbox>(entry: OwnedEntry<T>, handle: T): T {
	entry.handle = handle;
	entriesByHandle.set(handle, entry as OwnedEntry<DestroyableSandbox>);
	return handle;
}

/**
 * Hand a successfully created sandbox out of process ownership without destroying it.
 *
 * This escape hatch is intentionally explicit: ordinary callers should keep the owner registered
 * until destroy succeeds, while commands such as `driver-check --keep` need to transfer lifecycle
 * responsibility to the operator before the process exit drain runs.
 */
export function releaseOwnedSandbox(sandbox: object): boolean {
	const entry = entriesByHandle.get(sandbox);
	if (entry === undefined) return false;
	release(entry);
	return true;
}

async function destroyEntry(
	entry: OwnedEntry<DestroyableSandbox>,
	options: OwnedOperationOptions,
): Promise<void> {
	try {
		await entry.promise;
	} catch {
		// A failed create can still own an allocation when its rollback also failed. Its rejection
		// installs a retryable cleanup record below; an ordinary rejection has already been released.
	}
	await entry.destroy?.(options);
}

interface FailedCreateCleanup {
	dispose(): Promise<void>;
	cleanup?(options?: OwnedOperationOptions): Promise<void>;
}

function failedCreateCleanup(error: unknown): FailedCreateCleanup | undefined {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return;
	try {
		const dispose = Reflect.get(error, Symbol.asyncDispose);
		if (typeof dispose !== "function") return;
		const cleanup = Reflect.get(error, "cleanup");
		return {
			dispose: () => Reflect.apply(dispose, error, []),
			...(typeof cleanup === "function"
				? {
						cleanup: (options?: OwnedOperationOptions) => Reflect.apply(cleanup, error, [options]),
					}
				: {}),
		};
	} catch {
		// Inspecting an arbitrary provider error must never replace the create failure itself.
		return;
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withinDeadline(
	entry: OwnedEntry<DestroyableSandbox>,
	deadline: number,
): Promise<void> {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) {
		throw new Error(`Sandbox cleanup timed out${entry.sandboxId ? ` (${entry.sandboxId})` : ""}`);
	}

	const cancellation = new AbortController();
	const cancellationReason = new Error(
		`Sandbox process ownership cleanup requested${entry.sandboxId ? ` (${entry.sandboxId})` : " during creation"}`,
	);
	entry.abortCreate?.(cancellationReason);
	// Reserve a short tail of the existing budget for cancellation-aware runners to kill and reap
	// their subprocess group before the hard observational deadline fires.
	const settleGraceMs = Math.min(250, Math.max(1, Math.floor(remainingMs / 4)));
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		abortTimer = setTimeout(
			() => cancellation.abort(cancellationReason),
			Math.max(0, remainingMs - settleGraceMs),
		);
		await Promise.race([
			destroyEntry(entry, { signal: cancellation.signal }),
			new Promise<never>((_resolve, reject) => {
				deadlineTimer = setTimeout(
					() =>
						reject(
							new Error(
								`Sandbox cleanup timed out${entry.sandboxId ? ` (${entry.sandboxId})` : " during creation"}`,
							),
						),
					remainingMs,
				);
			}),
		]);
	} finally {
		if (abortTimer !== undefined) clearTimeout(abortTimer);
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
	}
}

/** Destroy every pending/live sandbox currently owned by this process, with bounded retries. */
export async function cleanupOwnedSandboxes(
	options: SandboxCleanupOptions = {},
): Promise<unknown[]> {
	const attempts = positiveInteger(options.attempts, DEFAULT_CLEANUP_ATTEMPTS);
	const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
	const retryDelayMs = positiveInteger(options.retryDelayMs, DEFAULT_CLEANUP_RETRY_MS);
	const deadline = Date.now() + timeoutMs;
	let failures: unknown[] = [];

	for (let attempt = 1; attempt <= attempts && owned.size > 0; attempt++) {
		failures = [];
		await Promise.all(
			[...owned].map(async (entry) => {
				try {
					await withinDeadline(entry, deadline);
				} catch (error) {
					failures.push(error);
				}
			}),
		);
		if (owned.size === 0) return [];

		const remainingMs = deadline - Date.now();
		if (attempt < attempts && remainingMs > 0) {
			await delay(Math.min(retryDelayMs, remainingMs));
		}
	}

	if (owned.size > 0 && failures.length === 0) {
		failures.push(new Error(`Could not clean up ${owned.size} owned sandbox(es)`));
	}
	return failures;
}

function logCleanupFailures(context: string, failures: readonly unknown[]): void {
	for (const failure of failures) {
		console.error(
			`[cleanup] destroy failed during ${context}: ${
				failure instanceof Error ? failure.message : String(failure)
			}`,
		);
	}
}

/** Stop new creates and drain all owned sandboxes before an ordinary CLI exit. */
export async function shutdownOwnedSandboxes(context = "process exit"): Promise<unknown[]> {
	stopping = true;
	const failures = await cleanupOwnedSandboxes();
	logCleanupFailures(context, failures);
	return failures;
}

/** Exit only after the process has made its bounded cleanup attempts. */
export async function exitAfterSandboxCleanup(exitCode: number): Promise<never> {
	const failures = await shutdownOwnedSandboxes();
	process.exit(exitCode === 0 && failures.length > 0 ? 1 : exitCode);
}

function onSignal(signal: (typeof signals)[number]): void {
	const exitCode = signalExitCode(signal);
	if (signalCleanup !== undefined) {
		process.exit(exitCode);
	}

	stopping = true;
	console.error(`[cleanup] ${signal} received; destroying ${owned.size} sandbox(es)...`);
	signalCleanup = shutdownOwnedSandboxes(signal).then(() => {
		uninstallProcessHandlers();
		process.exit(exitCode);
	});
}

function onBeforeExit(): void {
	if (owned.size === 0 || beforeExitCleanup !== undefined) return;
	console.error(`[cleanup] process exiting; destroying ${owned.size} sandbox(es)...`);
	beforeExitCleanup = shutdownOwnedSandboxes("process exit").then((failures) => {
		if (failures.length > 0) process.exitCode = 1;
		uninstallProcessHandlers();
	});
}

function installProcessHandlers(): void {
	if (handlersInstalled) return;
	for (const signal of signals) process.on(signal, onSignal);
	process.on("beforeExit", onBeforeExit);
	handlersInstalled = true;
}

/**
 * Create a sandbox owned by this process. Registration happens before `create` is invoked, so a
 * signal during provisioning waits for the handle and tears it down. Provider methods are bound to
 * the original SDK object (several SDKs use private fields); only `destroy` is replaced.
 */
export function createOwnedSandbox<T extends DestroyableSandbox>(
	create: (signal: AbortSignal) => Promise<T>,
	options: OwnedSandboxOptions = {},
): Promise<T> {
	if (stopping) return Promise.reject(new Error("Sandbox creation refused during shutdown"));

	installProcessHandlers();
	const entry = {} as OwnedEntry<T>;
	const createCancellation = new AbortController();
	entry.abortCreate = (reason) => createCancellation.abort(reason);
	owned.add(entry as OwnedEntry<DestroyableSandbox>);

	entry.promise = Promise.resolve()
		.then(() => create(createCancellation.signal))
		.then(
			(sandbox) => {
				entry.sandboxId = sandbox.sandboxRef?.id ?? sandbox.sandboxId;
				const originalDestroy = sandbox.destroy;
				const providerDestroy = (operationOptions?: OwnedOperationOptions): Promise<unknown> =>
					Reflect.apply(
						originalDestroy,
						sandbox,
						operationOptions === undefined ? [] : [operationOptions],
					);
				let destroying: Promise<unknown> | undefined;
				let destroyCancellation: AbortController | undefined;
				let unlinkDestroySignal: (() => void) | undefined;
				const forwardDestroyCancellation = (signal: AbortSignal | undefined): void => {
					const controller = destroyCancellation;
					if (signal === undefined || controller === undefined) return;
					const abort = () => controller.abort(signal.reason);
					signal.addEventListener("abort", abort, { once: true });
					const previous = unlinkDestroySignal;
					unlinkDestroySignal = () => {
						previous?.();
						signal.removeEventListener("abort", abort);
					};
					if (signal.aborted) abort();
				};
				const destroy = (operationOptions: OwnedOperationOptions = {}): Promise<unknown> => {
					if (destroying !== undefined) {
						forwardDestroyCancellation(operationOptions.signal);
						return destroying;
					}
					destroyCancellation = new AbortController();
					forwardDestroyCancellation(operationOptions.signal);
					destroying = Promise.resolve()
						.then(() =>
							options.destroy === undefined
								? providerDestroy()
								: options.destroy(providerDestroy, { signal: destroyCancellation?.signal }),
						)
						.then(
							(value) => {
								release(entry as OwnedEntry<DestroyableSandbox>);
								return value;
							},
							(error) => {
								destroying = undefined;
								throw error;
							},
						)
						.finally(() => {
							unlinkDestroySignal?.();
							unlinkDestroySignal = undefined;
							destroyCancellation = undefined;
						});
					return destroying;
				};
				entry.destroy = destroy;

				// Keep object identity intact: callers may compare the returned SDK handle, and replacing one
				// method on the instance leaves every private-field-backed provider method on its real receiver.
				try {
					Object.defineProperty(sandbox, "destroy", {
						configurable: true,
						value: destroy,
					});
					return trackHandle(entry, sandbox);
				} catch {
					// Defensive fallback for an SDK that freezes its handles. Bind methods back to the real
					// object so JavaScript private fields remain valid through the proxy.
					return trackHandle(
						entry,
						new Proxy(sandbox, {
							get(target, property) {
								if (property === "destroy") return destroy;
								const value = Reflect.get(target, property, target);
								return typeof value === "function" ? value.bind(target) : value;
							},
						}),
					);
				}
			},
			(error) => {
				const recoverable = failedCreateCleanup(error);
				if (recoverable === undefined) {
					release(entry as OwnedEntry<DestroyableSandbox>);
				} else {
					let cleanupInFlight: Promise<unknown> | undefined;
					entry.destroy = (operationOptions: OwnedOperationOptions = {}) => {
						if (cleanupInFlight !== undefined) {
							return recoverable.cleanup === undefined
								? cleanupInFlight
								: recoverable.cleanup(operationOptions);
						}
						cleanupInFlight = Promise.resolve()
							.then(() =>
								recoverable.cleanup === undefined
									? recoverable.dispose()
									: recoverable.cleanup(operationOptions),
							)
							.then(
								(value) => {
									release(entry as OwnedEntry<DestroyableSandbox>);
									return value;
								},
								(caught) => {
									cleanupInFlight = undefined;
									throw caught;
								},
							);
						return cleanupInFlight;
					};
				}
				throw error;
			},
		);

	return entry.promise;
}

/** Run cleanup without letting its failure hide an earlier operation failure. */
export async function withCleanupPreservingPrimaryError<T>(
	operation: () => Promise<T>,
	cleanup: () => Promise<unknown>,
	onSuppressedCleanupError: (error: unknown) => void,
): Promise<T> {
	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, value: await operation() };
	} catch (error) {
		outcome = { ok: false, error };
	}

	try {
		await cleanup();
	} catch (error) {
		if (outcome.ok) throw error;
		onSuppressedCleanupError(error);
	}

	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

/**
 * Create one process-owned sandbox, run a callback, and always tear the sandbox down. If the callback
 * fails, preserve that primary error while the process registry retains any sandbox whose teardown
 * also failed for the bounded exit drain to retry.
 */
export async function withOwnedSandbox<T extends DestroyableSandbox, R>(
	create: (signal: AbortSignal) => Promise<T>,
	fn: (sandbox: T) => Promise<R>,
	label = "sandbox",
	ownerOptions: OwnedSandboxOptions = {},
): Promise<R> {
	const sandbox = await createOwnedSandbox(create, ownerOptions);
	return withCleanupPreservingPrimaryError(
		() => fn(sandbox),
		() => sandbox.destroy(),
		(error) => console.error(`${label}: teardown failed after the operation failed:`, error),
	);
}
