// The method-table layer (ADR-0007 §2): driver authors write a flat table of pure functions
// over a typed native handle — trivially unit-testable, extraction-safe (`satisfies
// MethodTable<…>` on a named const), and patchable by ordinary composition. The kit assembles
// the harness-facing SandboxSession from it — and, because every generic driver flows through
// here, this is the ONE place the session-lifecycle invariants live: output capping (§2 below),
// the use-after-destroy guard, artifact reconciliation, and the lazy-context memo. A driver that
// bypassed this layer would have to re-implement all four; none do.

import { DriverError, FailedCreateCleanupError } from "./errors.ts";
import { capExecOutput, validateMaxOutputBytes } from "./output.ts";
import type {
	ControlPlaneProbes,
	CreateRequest,
	DriverOperationOptions,
	ExecOptions,
	ExecResult,
	InventorySnapshot,
	ResolvedArtifact,
	SandboxDriver,
	SandboxObservation,
	SandboxRef,
	SandboxSession,
	SnapshotCapability,
} from "./port.ts";

type SameType<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
			? true
			: false
		: false;

export type MethodTableCreateResult<Handle, Native = Handle> = {
	readonly handle: Handle;
	readonly sandboxRef: SandboxRef;
	readonly artifact?: ResolvedArtifact;
} & (SameType<Handle, Native> extends true
	? { readonly native?: Native }
	: { readonly native: Native });

export interface MethodTable<Handle, Ctx, Native = Handle> {
	/** Bounded wait for accepted operations; expiry fails destroy so teardown never races the handle. */
	readonly operationDrainTimeoutMs?: number;
	/**
	 * Boot a sandbox. `artifact`, when returned, is the artifact the driver ACTUALLY booted (for
	 * "built" artifacts, the ctx factory's product); the kit fails create on a contradiction
	 * with the request so a measurement is never attributed to the wrong artifact.
	 */
	create(
		ctx: Ctx,
		request: CreateRequest,
		options?: DriverOperationOptions,
	): Promise<MethodTableCreateResult<Handle, Native>>;
	/** Run a command. Options are forwarded unchanged; the kit still enforces output caps. */
	exec(ctx: Ctx, handle: Handle, command: string, options?: ExecOptions): Promise<ExecResult>;
	destroy(ctx: Ctx, handle: Handle, options?: DriverOperationOptions): Promise<void>;
	destroyById?(ctx: Ctx, ref: SandboxRef, options?: DriverOperationOptions): Promise<void>;
	launch?(ctx: Ctx, handle: Handle, command: string, options?: ExecOptions): Promise<void>;
	readonly files?: {
		readFile(ctx: Ctx, handle: Handle, path: string): Promise<string>;
		exists(ctx: Ctx, handle: Handle, path: string): Promise<boolean>;
		writeText(ctx: Ctx, handle: Handle, path: string, text: string): Promise<void>;
	};
	/** Optional measurement capabilities, carried so a driver never bypasses this layer for them. */
	readonly probes?: {
		observe(ctx: Ctx, ref: SandboxRef): Promise<SandboxObservation>;
		list?(ctx: Ctx): Promise<unknown>;
		describe?(ctx: Ctx, ref: SandboxRef): Promise<unknown>;
	};
	readonly snapshots?: {
		create(ctx: Ctx, session: SandboxSession<Native>): Promise<{ readonly snapshotId: string }>;
		delete(ctx: Ctx, snapshotId: string): Promise<void>;
	};
	readonly inventory?: {
		list(ctx: Ctx, options?: DriverOperationOptions): Promise<InventorySnapshot>;
	};
}

function artifactsEqual(left: ResolvedArtifact, right: ResolvedArtifact): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind === "none" || (right.kind !== "none" && left.ref === right.ref);
}

function artifactLabel(artifact: ResolvedArtifact): string {
	return artifact.kind === "none" ? "none" : `${artifact.kind}:${artifact.ref}`;
}

async function drainWithin(
	drain: Promise<void>,
	timeoutMs: number,
	timeoutError: () => Error,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			drain,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(timeoutError()), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * A bounded destroy call timed out waiting for accepted work, while safe provider teardown remains
 * scheduled behind that work. `completion` exposes the eventual provider result; async disposal
 * retries the session if that deferred attempt fails. This lets one-shot callers hand ownership to
 * a generic cleanup registry without racing the native handle or erasing a later teardown failure.
 */
export class DeferredTeardownError extends DriverError implements AsyncDisposable {
	readonly completion: Promise<void>;
	deferredFailure: unknown | undefined;
	readonly #retry: () => Promise<void>;
	#disposeInFlight: Promise<void> | undefined;
	#cleaned = false;

	constructor(
		ref: SandboxRef,
		timeoutMs: number,
		completion: Promise<void>,
		retry: () => Promise<void>,
	) {
		super(
			"destroy-failed",
			`sandbox ${ref.id} still has an accepted operation after ${timeoutMs}ms; safe teardown remains scheduled`,
			{ ref },
		);
		this.name = "DeferredTeardownError";
		this.completion = completion;
		this.#retry = retry;
		void completion.catch((error: unknown) => {
			this.deferredFailure = error;
		});
	}

	[Symbol.asyncDispose](): Promise<void> {
		if (this.#cleaned) return Promise.resolve();
		if (this.#disposeInFlight !== undefined) return this.#disposeInFlight;

		const attempt = this.completion
			.catch(() => this.#retry())
			.then(() => {
				this.#cleaned = true;
			})
			.finally(() => {
				this.#disposeInFlight = undefined;
			});
		this.#disposeInFlight = attempt;
		return attempt;
	}
}

/**
 * Assemble a SandboxDriver from a method table and a lazy context factory.
 *
 * The context is vendor plumbing that is async and built once on demand (clients, apps, built
 * images, volumes). A failed load CLEARS the memo, so one transient plumbing failure does not
 * brick the driver for the process lifetime; concurrent callers share the in-flight attempt
 * (ADR-0007 §9).
 */
export function driverFromTable<Handle, Ctx, Native = Handle>(
	table: MethodTable<Handle, Ctx, Native>,
	loadCtx: () => Promise<Ctx>,
): SandboxDriver<Native> {
	const operationDrainTimeoutMs = table.operationDrainTimeoutMs ?? 1_000;
	if (!Number.isSafeInteger(operationDrainTimeoutMs) || operationDrainTimeoutMs <= 0) {
		throw new DriverError(
			"vendor-contract-violation",
			`operationDrainTimeoutMs must be a positive safe integer, received ${String(operationDrainTimeoutMs)}`,
		);
	}
	let memo: Promise<Ctx> | undefined;
	const ctx = () =>
		(memo ??= loadCtx().then(
			(value) => value,
			(error: unknown) => {
				memo = undefined;
				throw error;
			},
		));
	const files = table.files;
	const launch = table.launch;
	const destroyById = table.destroyById;
	const tableProbes = table.probes;
	const probeList = tableProbes?.list;
	const probeDescribe = tableProbes?.describe;
	const tableSnapshots = table.snapshots;
	const inventory = table.inventory;
	return {
		...(inventory
			? {
					inventory: {
						list: async (options?: DriverOperationOptions) => inventory.list(await ctx(), options),
					},
				}
			: {}),
		async create(request, operationOptions) {
			const resolved = await ctx();
			const created = await table.create(resolved, request, operationOptions);
			const artifact = created.artifact ?? request.artifact;
			if (!artifactsEqual(artifact, request.artifact)) {
				const mismatch = new DriverError(
					"artifact-mismatch",
					`artifact mismatch: request says ${artifactLabel(request.artifact)}, driver booted ${artifactLabel(artifact)}`,
					{ ref: created.sandboxRef },
				);
				// Tear the orphan down before failing — but never let a teardown failure hide the
				// mismatch (the primary, and the one naming the wrong-artifact boot). Same double-fault
				// shape as withSessionTeardown.
				try {
					await table.destroy(resolved, created.handle, operationOptions);
				} catch (teardown) {
					throw new FailedCreateCleanupError(teardown, mismatch, {
						provider: created.sandboxRef.provider,
						locator: { kind: "id", value: created.sandboxRef.id },
						cleanup: (options = {}) => table.destroy(resolved, created.handle, options),
					});
				}
				throw mismatch;
			}
			const handle = created.handle;
			// Presence, not truthiness, selects the explicitly projected native value. `undefined` can be
			// a wrapper's honest getInstance() result and must not silently turn back into the table handle.
			const native = (
				"native" in created ? created.native : (handle as unknown as Native)
			) as Native;
			const ref = created.sandboxRef;
			let state: "alive" | "destroying" | "destroyed" = "alive";
			let destroyInFlight: Promise<void> | undefined;
			let teardownInFlight: Promise<void> | undefined;
			let teardownDrain: Promise<void> | undefined;
			let teardownCancellation: AbortController | undefined;
			let teardownAbortUnlinks: Array<() => void> = [];
			let activeOperations = 0;
			let operationsDrained: Promise<void> | undefined;
			let resolveOperationsDrained: (() => void) | undefined;
			const alive = <T>(operation: () => Promise<T>): Promise<T> => {
				if (state !== "alive") {
					// Calling a dead sandbox would surface as a confusing vendor error the harness
					// would misclassify; make the invalid state a typed, unmistakable one instead.
					return Promise.reject(
						new DriverError(
							"use-after-destroy",
							`sandbox ${ref.id} was used during/after destroy`,
							{
								ref,
							},
						),
					);
				}
				if (activeOperations === 0) {
					operationsDrained = new Promise<void>((resolve) => {
						resolveOperationsDrained = resolve;
					});
				}
				activeOperations += 1;
				let result: Promise<T>;
				try {
					result = operation();
				} catch (caught) {
					result = Promise.reject(caught);
				}
				return Promise.resolve(result).finally(() => {
					activeOperations -= 1;
					if (activeOperations === 0) {
						resolveOperationsDrained?.();
						resolveOperationsDrained = undefined;
						operationsDrained = undefined;
					}
				});
			};
			const invokeDestroy = (options?: DriverOperationOptions): Promise<void> => {
				try {
					return Promise.resolve(table.destroy(resolved, handle, options));
				} catch (caught) {
					return Promise.reject(caught);
				}
			};
			const forwardTeardownCancellation = (signal: AbortSignal | undefined): void => {
				const controller = teardownCancellation;
				if (signal === undefined || controller === undefined) return;
				const abort = () => controller.abort(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				teardownAbortUnlinks.push(() => signal.removeEventListener("abort", abort));
				// Register before re-checking so an abort cannot win the check/listen edge.
				if (signal.aborted) abort();
			};
			const beginTeardown = (options?: DriverOperationOptions): Promise<void> => {
				if (teardownInFlight !== undefined) {
					forwardTeardownCancellation(options?.signal);
					return teardownInFlight;
				}

				state = "destroying";
				teardownDrain = operationsDrained;
				teardownCancellation = new AbortController();
				forwardTeardownCancellation(options?.signal);
				const providerOptions = { signal: teardownCancellation.signal };
				const destroying =
					teardownDrain === undefined
						? invokeDestroy(providerOptions)
						: teardownDrain.then(() => invokeDestroy(providerOptions));
				const teardown = destroying
					.then(
						() => {
							state = "destroyed";
						},
						(error: unknown) => {
							state = "alive";
							throw error;
						},
					)
					.finally(() => {
						for (const unlink of teardownAbortUnlinks) unlink();
						teardownAbortUnlinks = [];
						teardownCancellation = undefined;
						teardownInFlight = undefined;
						teardownDrain = undefined;
					});
				teardownInFlight = teardown;
				return teardown;
			};
			const session: SandboxSession<Native> = {
				sandboxRef: ref,
				artifact,
				native,
				exec: (command, options?: ExecOptions) =>
					alive(() => {
						// Read the cap before provider code sees the original options object. Readonly is a
						// compile-time contract; a hostile callback must not mutate away kit-owned enforcement.
						const maxOutputBytes = options?.maxOutputBytes;
						validateMaxOutputBytes(maxOutputBytes);
						return table
							.exec(resolved, handle, command, options)
							.then((result) => capExecOutput(result, maxOutputBytes));
					}),
				async destroy(options?: DriverOperationOptions) {
					if (state === "destroyed") return;
					if (destroyInFlight !== undefined) {
						forwardTeardownCancellation(options?.signal);
						return destroyInFlight;
					}

					const teardown = beginTeardown(options);
					const drain = teardownDrain;
					const bounded =
						drain === undefined
							? teardown
							: drainWithin(
									drain,
									operationDrainTimeoutMs,
									() =>
										new DeferredTeardownError(ref, operationDrainTimeoutMs, teardown, () =>
											session.destroy(),
										),
								).then(() => teardown);
					const attempt = bounded.finally(() => {
						destroyInFlight = undefined;
					});
					destroyInFlight = attempt;
					return attempt;
				},
				...(launch
					? {
							launch: (command: string, options?: ExecOptions) =>
								alive(() => launch(resolved, handle, command, options)),
						}
					: {}),
				...(files
					? {
							files: {
								readFile: (path: string) => alive(() => files.readFile(resolved, handle, path)),
								exists: (path: string) => alive(() => files.exists(resolved, handle, path)),
								writeText: (path: string, text: string) =>
									alive(() => files.writeText(resolved, handle, path, text)),
							},
						}
					: {}),
			};
			return session;
		},
		...(destroyById
			? {
					destroyById: async (ref: SandboxRef, options?: DriverOperationOptions) =>
						destroyById(await ctx(), ref, options),
				}
			: {}),
		...(tableProbes
			? {
					probes: {
						observe: async (ref: SandboxRef) => tableProbes.observe(await ctx(), ref),
						...(probeList ? { list: async () => probeList(await ctx()) } : {}),
						...(probeDescribe
							? { describe: async (ref: SandboxRef) => probeDescribe(await ctx(), ref) }
							: {}),
					} satisfies ControlPlaneProbes,
				}
			: {}),
		...(tableSnapshots
			? {
					snapshots: {
						create: async (session: SandboxSession<Native>) =>
							tableSnapshots.create(await ctx(), session),
						delete: async (snapshotId: string) => tableSnapshots.delete(await ctx(), snapshotId),
					} satisfies SnapshotCapability<Native>,
				}
			: {}),
	};
}
