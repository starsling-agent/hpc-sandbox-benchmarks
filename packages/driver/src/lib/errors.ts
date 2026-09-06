// One typed error family for the kit (ADR-0008 §1: "create failures MUST be classifiable … error
// semantics defined by what the caller is entitled to do next"; ADR-0007 §9: "string-matching
// error prose is how the UnsupportedFileSystem workaround started"). Every kit throw carries a
// literal `code` the harness switches on, plus structured context — so the retry-vs-terminal and
// invalid-input-vs-vendor decisions read a field, never a regex over a formatted message.

import type { ProviderId } from "@sandbox-benchmarks/schema/provider-ids";
import type { DriverOperationOptions, SandboxRef } from "./port.ts";

// `instanceof` is not a safe predicate at a public error boundary: a rejected Proxy can trap
// [[GetPrototypeOf]] and make the predicate itself throw, bypassing normalization. Brand the two
// errors the kit must recognize instead. WeakSet.has does not invoke user code and preserves the
// nominal "created by this kit instance" guarantee that a structural code/name check would lose.
const driverErrors = new WeakSet<object>();
const failedCreateCleanupErrors = new WeakSet<object>();
/** Create-failed errors whose driver established that nothing remains allocated and a retry is useful. */
const retryableCreates = new WeakSet<object>();

/**
 * What went wrong, in terms of what the caller may do next:
 *
 *   - `invalid-sandbox-ref` / `invalid-create-request` / `missing-credentials` — the input or
 *     config is wrong. Terminal; fix the input, do not retry.
 *   - `artifact-mismatch` / `use-after-destroy` / `vendor-contract-violation` — a kit or driver
 *     invariant was broken. Terminal; a bug, not a transient condition.
 *   - `create-failed` — the vendor refused create. The harness decides retry-vs-terminal with
 *     {@link isRetryableDriverCreate}: the error code plus an explicit {@link DriverError.retryable}
 *     mark and/or a structured {@link DriverError.vendorExitCode} of 429. {@link DriverError.vendorMessage}
 *     is diagnostic only — never regexed as the classifier.
 *   - `readiness-timeout` — create was accepted but the sandbox never became ready in budget.
 *   - `vendor-output-unparseable` — the vendor's control-plane output drifted from its schema.
 *   - `exec-failed` — a kit-owned shell fallback failed before it could satisfy its contract.
 *   - `filesystem-failed` / `probe-failed` / `snapshot-failed` — an explicitly declared optional
 *     capability failed while talking to the selected provider.
 *   - `invalid-exec-options` — a caller supplied an impossible output-cap value.
 *   - `destroy-failed` — teardown could not converge.
 */
export type DriverErrorCode =
	| "invalid-sandbox-ref"
	| "invalid-create-request"
	| "missing-credentials"
	| "artifact-mismatch"
	| "use-after-destroy"
	| "vendor-contract-violation"
	| "create-failed"
	| "readiness-timeout"
	| "vendor-output-unparseable"
	| "exec-failed"
	| "filesystem-failed"
	| "probe-failed"
	| "snapshot-failed"
	| "invalid-exec-options"
	| "destroy-failed";

export interface DriverErrorFields {
	readonly provider?: ProviderId;
	readonly ref?: SandboxRef;
	/** Raw vendor diagnostic/detail. Logged and retained; never regexed to decide retry-vs-fail. */
	readonly vendorMessage?: string;
	readonly vendorExitCode?: number;
	/**
	 * True only when this `create-failed` error is safe to retry: the driver established that
	 * nothing remains allocated. Ignored for every other {@link DriverErrorCode}. A `vendorExitCode`
	 * of 429 is the other structured retry signal; see {@link isRetryableDriverCreate}.
	 */
	readonly retryable?: boolean;
	readonly cause?: unknown;
}

/** A retained recovery locator for an allocation whose create failed before a session returned. */
export interface FailedCreateRecovery {
	readonly provider: ProviderId;
	readonly locator:
		| {
				readonly kind: "name" | "id";
				readonly value: string;
		  }
		| {
				/** A provider-owned unique allocation marker, such as metadata or an external id. */
				readonly kind: "marker";
				readonly key: string;
				readonly value: string;
		  }
		| {
				/** The wrapper returned no stable id, so cleanup retains its native object in-process. */
				readonly kind: "native-handle";
		  }
		| {
				/** The source locator was unreadable; only the retained cleanup callback is trustworthy. */
				readonly kind: "cleanup-callback";
		  };
}

export interface FailedCreateCleanupErrorOptions extends FailedCreateRecovery {
	/** Idempotent, convergent retry for the allocation named by {@link locator}. */
	readonly cleanup: (options?: DriverOperationOptions) => Promise<void>;
}

function snapshotRecoveryLocator(locator: unknown): FailedCreateRecovery["locator"] {
	try {
		if ((typeof locator !== "object" && typeof locator !== "function") || locator === null) {
			throw new Error("invalid locator");
		}
		const kind: unknown = Reflect.get(locator, "kind");
		if (kind === "native-handle" || kind === "cleanup-callback") {
			return Object.freeze({ kind });
		}
		const value: unknown = Reflect.get(locator, "value");
		if (typeof value !== "string" || value.length === 0) throw new Error("invalid locator");
		if (kind === "name" || kind === "id") return Object.freeze({ kind, value });
		if (kind === "marker") {
			const key: unknown = Reflect.get(locator, "key");
			if (typeof key !== "string" || key.length === 0) throw new Error("invalid locator");
			return Object.freeze({ kind, key, value });
		}
	} catch {
		// Cleanup ownership is more important than malformed locator diagnostics. The callback remains
		// retryable even when hostile accessors make the source locator impossible to retain safely.
	}
	return Object.freeze({ kind: "cleanup-callback" });
}

/**
 * A create/rollback double fault that still owns a retryable cleanup record.
 *
 * `SuppressedError` preserves both failures in the same order as `await using`: `error` is the
 * cleanup failure and `suppressed` is the original create failure. Implementing the standard
 * async-disposal protocol lets a process-level owner retain this rejected create without taking a
 * dependency on a particular driver implementation. Cleanup is shared, retryable after failure,
 * and becomes an idempotent no-op after the first confirmed success.
 */
export class FailedCreateCleanupError extends SuppressedError implements AsyncDisposable {
	readonly code = "failed-create-cleanup" as const;
	readonly provider: ProviderId;
	readonly locator: FailedCreateRecovery["locator"];
	readonly #cleanup: (options?: DriverOperationOptions) => Promise<void>;
	#cleanupInFlight: Promise<void> | undefined;
	#cleanupAbort: AbortController | undefined;
	#abortUnlinks: Array<() => void> = [];
	#cleaned = false;

	constructor(
		cleanupError: unknown,
		createError: unknown,
		options: FailedCreateCleanupErrorOptions,
	) {
		const locator = snapshotRecoveryLocator(options.locator);
		const locatorLabel =
			locator.kind === "native-handle"
				? "through its retained native handle"
				: locator.kind === "cleanup-callback"
					? "through its retained cleanup callback"
					: locator.kind === "marker"
						? `by marker ${locator.key}=${locator.value}`
						: `by ${locator.kind} ${locator.value}`;
		super(
			cleanupError,
			createError,
			`failed to clean up ${options.provider} sandbox ${locatorLabel} after create failure`,
		);
		this.name = "FailedCreateCleanupError";
		failedCreateCleanupErrors.add(this);
		this.provider = options.provider;
		this.locator = locator;
		this.#cleanup = options.cleanup;
	}

	cleanup(options: DriverOperationOptions = {}): Promise<void> {
		if (this.#cleaned) return Promise.resolve();
		if (this.#cleanupInFlight !== undefined) {
			this.#forwardAbort(options.signal);
			return this.#cleanupInFlight;
		}

		this.#cleanupAbort = new AbortController();
		this.#forwardAbort(options.signal);
		const attempt = Promise.resolve()
			.then(() => this.#cleanup({ signal: this.#cleanupAbort?.signal }))
			.then(() => {
				this.#cleaned = true;
			})
			.finally(() => {
				for (const unlink of this.#abortUnlinks) unlink();
				this.#abortUnlinks = [];
				this.#cleanupAbort = undefined;
				this.#cleanupInFlight = undefined;
			});
		this.#cleanupInFlight = attempt;
		return attempt;
	}

	#forwardAbort(signal: AbortSignal | undefined): void {
		const controller = this.#cleanupAbort;
		if (signal === undefined || controller === undefined) return;
		const abort = () => controller.abort(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		this.#abortUnlinks.push(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.cleanup();
	}
}

export class DriverError extends Error {
	readonly code: DriverErrorCode;
	readonly provider: ProviderId | undefined;
	readonly ref: SandboxRef | undefined;
	readonly vendorMessage: string | undefined;
	readonly vendorExitCode: number | undefined;

	constructor(code: DriverErrorCode, message: string, fields: DriverErrorFields = {}) {
		super(message, fields.cause !== undefined ? { cause: fields.cause } : undefined);
		driverErrors.add(this);
		this.name = "DriverError";
		this.code = code;
		this.provider = fields.provider;
		this.ref = fields.ref;
		this.vendorMessage = fields.vendorMessage;
		this.vendorExitCode = fields.vendorExitCode;
		if (code === "create-failed" && fields.retryable === true) {
			retryableCreates.add(this);
		}
	}

	/**
	 * Whether this create failure is an explicit retry mark. Independent of
	 * {@link DriverError.vendorExitCode} 429; {@link isRetryableDriverCreate} is the harness rule.
	 */
	get retryable(): boolean {
		return this.code === "create-failed" && retryableCreates.has(this);
	}
}

/**
 * Mark a `create-failed` {@link DriverError} as safe to retry. Non-create codes and non-DriverError
 * values are returned untouched — inventing a wrapper would lose the identity callers match on.
 */
export function markRetryableDriverCreate<E>(error: E): E {
	if (isDriverError(error) && error.code === "create-failed") {
		retryableCreates.add(error);
	}
	return error;
}

/**
 * Typed create-retry classifier for the driver lane. True only for a branded `create-failed`
 * {@link DriverError} that carries an explicit retry mark or a structured vendor exit of 429.
 * Unclassified prose (including a formatted message that happens to mention quota/429) is false.
 * A {@link FailedCreateCleanupError} is never retryable: cleanup did not prove the allocation is gone.
 */
export function isRetryableDriverCreate(error: unknown): boolean {
	if (!isDriverError(error) || error.code !== "create-failed") return false;
	try {
		return error.retryable || error.vendorExitCode === 429;
	} catch {
		return false;
	}
}

export const isDriverError = (value: unknown): value is DriverError =>
	(typeof value === "object" || typeof value === "function") &&
	value !== null &&
	driverErrors.has(value);

export const isFailedCreateCleanupError = (value: unknown): value is FailedCreateCleanupError =>
	(typeof value === "object" || typeof value === "function") &&
	value !== null &&
	failedCreateCleanupErrors.has(value);
