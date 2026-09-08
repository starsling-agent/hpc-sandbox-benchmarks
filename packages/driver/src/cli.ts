// cliDriver (ADR-0007 §5): the generic driver for CLI-only vendors. A provider whose control
// plane is `spawn()` on a binary becomes a declarative table of argv templates and parsers.
// The generic driver owns spawn, secret redaction and not-found matching ONCE; vendor stdout
// is a trust boundary, so the table's `parse` fields are arktype pipelines and a vendor
// changing its output shape produces a path-bearing report, not an `undefined` threading
// through readiness logic.
//
// The compiled shape is a MethodTable whose handle is the PARSED READINESS ROW — so every
// generated member is unit-testable as a pure function and `session.native` is the vendor's
// own typed record, not an opaque id string. Readiness polling, output capping and the
// use-after-destroy guard belong to the kit layer (poll.ts, table.ts); this file supplies only
// the vendor-specific argv and parsers.

import { randomUUID } from "node:crypto";
import type { ProviderId } from "@sandbox-benchmarks/schema/providers";
import type { Out, Type } from "arktype";
import { type } from "arktype";
import type {
	CreateRequest,
	DriverContext,
	DriverModule,
	DriverOperationOptions,
	DriverPolicy,
	ExecResult,
	SandboxDriver,
	SandboxRef,
} from "./index.ts";
import { defineDriver, driverFromTable, sandboxRef } from "./index.ts";
import {
	DriverError,
	FailedCreateCleanupError,
	isDriverError,
	markRetryableDriverCreate,
} from "./lib/errors.ts";
import { pollUntilReady } from "./lib/poll.ts";
import type { MethodTable } from "./lib/table.ts";

export interface CliRunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

export interface CliRunOptions {
	/** Hard subprocess budget. Runners MUST terminate the child before rejecting on timeout. */
	readonly timeoutMs: number;
	/** Cooperative process-owner cancellation; runners must terminate before rejecting. */
	readonly signal?: AbortSignal;
}

/** A runnable command always contains at least one argument after the selected binary. */
export type CliArgv = readonly [string, ...string[]];

/** Runs the vendor binary. Injectable so cliDriver tables are testable without a real CLI. */
export type CliRunner = (
	binary: string,
	args: readonly string[],
	options: CliRunOptions,
) => Promise<CliRunResult>;

/** An actual arktype schema whose callable output is the provider's parsed readiness rows. */
export type CliRowsSchema<Row> = Type<(In: string) => Out<readonly Row[]>>;

export type CliFailedCreateCleanup<Row> =
	| {
			/** Direct name-addressed delete for CLIs that genuinely support it. */
			readonly kind: "command";
			readonly command: (name: string) => CliArgv;
			readonly absenceConfirmationMs: number;
	  }
	| {
			/** Resolve the generated name through the parsed list, then delete its validated id. */
			readonly kind: "lookup";
			readonly select: (rows: readonly Row[], name: string) => Row | null;
			readonly absenceConfirmationMs: number;
	  };

/** Provider classification of one selected readiness row; the kit owns the resulting control flow. */
export type CliReadinessStatus = "ready" | "pending" | { readonly terminal: string };

function sanitizedCliCallbackCause(): Error {
	// Author callbacks close over provider credentials that need not appear in any argv. Never retain
	// their arbitrary thrown value or prose: error serializers may traverse custom fields and nested
	// causes, while the outer DriverError already identifies the exact failing callback boundary.
	return new Error("provider callback failed; original diagnostic omitted to protect credentials");
}

function invokeCliProviderCallback<T>(
	provider: ProviderId,
	boundary: string,
	callback: () => T,
	ref?: SandboxRef,
): T {
	try {
		return callback();
	} catch {
		throw new DriverError(
			"vendor-contract-violation",
			`${provider} CLI ${boundary} callback failed`,
			{
				provider,
				...(ref === undefined ? {} : { ref }),
				cause: sanitizedCliCallbackCause(),
			},
		);
	}
}

function runtimeNumberLabel(value: unknown): string {
	return typeof value === "number" ? `${value}` : "a non-number value";
}

function normalizeCliArgv(
	provider: ProviderId,
	boundary: string,
	value: unknown,
	ref?: SandboxRef,
): CliArgv {
	try {
		if (!Array.isArray(value)) throw new Error("non-array argv");
		const length: unknown = Reflect.get(value, "length");
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1) {
			throw new Error("empty argv");
		}
		const args: string[] = [];
		for (let index = 0; index < length; index += 1) {
			const arg: unknown = Reflect.get(value, index);
			if (typeof arg !== "string") throw new Error("non-string argv member");
			if (index === 0 && arg.trim() === "") throw new Error("empty command name");
			args.push(arg);
		}
		return args as unknown as CliArgv;
	} catch {
		throw new DriverError(
			"vendor-contract-violation",
			`${provider} CLI ${boundary} must be a nonempty string argv`,
			{
				provider,
				...(ref === undefined ? {} : { ref }),
				cause: sanitizedCliCallbackCause(),
			},
		);
	}
}

function normalizeCliStringList(
	provider: ProviderId,
	boundary: string,
	value: unknown,
): readonly string[] {
	try {
		if (!Array.isArray(value)) throw new Error("not an array");
		const length: unknown = Reflect.get(value, "length");
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
			throw new Error("invalid array length");
		}
		const entries: string[] = [];
		for (let index = 0; index < length; index += 1) {
			const entry: unknown = Reflect.get(value, index);
			if (typeof entry !== "string") throw new Error("non-string member");
			entries.push(entry);
		}
		return entries;
	} catch {
		throw new DriverError(
			"vendor-contract-violation",
			`${provider} CLI ${boundary} must be a string array`,
			{ provider, cause: sanitizedCliCallbackCause() },
		);
	}
}

function snapshotCliCoverage(value: unknown): CliCreateRequestCoverage {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		throw new Error("request coverage is not an object");
	}
	const defineOwn = (target: Record<string, unknown>, key: string, entry: unknown): void => {
		Object.defineProperty(target, key, {
			value: entry,
			enumerable: true,
			writable: false,
			configurable: false,
		});
	};
	const copyRecord = (candidate: unknown, copyDispositions = false): Record<string, unknown> => {
		if (
			(typeof candidate !== "object" && typeof candidate !== "function") ||
			candidate === null ||
			Array.isArray(candidate)
		) {
			throw new Error("request coverage member is not an object");
		}
		const copy = Object.create(null) as Record<string, unknown>;
		for (const [key, entry] of Object.entries(candidate)) {
			const copied =
				copyDispositions &&
				(typeof entry === "object" || typeof entry === "function") &&
				entry !== null &&
				!Array.isArray(entry)
					? copyRecord(entry)
					: entry;
			defineOwn(copy, key, copied);
		}
		return copy;
	};
	const outer = Object.create(null) as Record<string, unknown>;
	let spec: unknown;
	let gpu: unknown;
	let hasSpec = false;
	let hasGpu = false;
	for (const [key, entry] of Object.entries(value)) {
		if (key === "spec") {
			spec = entry;
			hasSpec = true;
		} else if (key === "gpu") {
			gpu = entry;
			hasGpu = true;
		} else {
			defineOwn(outer, key, entry);
		}
	}
	if (!hasSpec || !hasGpu) throw new Error("request coverage is missing a required member");
	defineOwn(outer, "spec", copyRecord(spec, true));
	defineOwn(outer, "gpu", copyRecord(gpu));
	return outer as unknown as CliCreateRequestCoverage;
}

function snapshotCliSpec<Row>(provider: ProviderId, spec: CliSpec<Row>): CliSpec<Row> {
	return invokeCliProviderCallback(provider, "spec normalization", () => {
		const objectMember = (value: unknown): object => {
			if ((typeof value !== "object" && typeof value !== "function") || value === null) {
				throw new Error("CLI spec member is not an object");
			}
			return value;
		};
		const ready = objectMember(Reflect.get(spec, "ready"));
		const sandboxId = objectMember(Reflect.get(spec, "sandboxId"));
		const cleanupCreated = objectMember(Reflect.get(spec, "cleanupCreated"));
		const prepare: unknown = Reflect.get(spec, "prepare");
		const prepared = prepare === undefined ? undefined : objectMember(prepare);
		const cleanupKind: unknown = Reflect.get(cleanupCreated, "kind");
		const absenceConfirmationMs: unknown = Reflect.get(cleanupCreated, "absenceConfirmationMs");
		let normalizedCleanup: CliFailedCreateCleanup<Row>;
		if (cleanupKind === "command") {
			const command: unknown = Reflect.get(cleanupCreated, "command");
			if (typeof command !== "function") throw new Error("cleanup command is not callable");
			normalizedCleanup = {
				kind: "command",
				command: command as (name: string) => CliArgv,
				absenceConfirmationMs: absenceConfirmationMs as number,
			};
		} else if (cleanupKind === "lookup") {
			const select: unknown = Reflect.get(cleanupCreated, "select");
			if (typeof select !== "function") throw new Error("cleanup selector is not callable");
			normalizedCleanup = {
				kind: "lookup",
				select: select as (rows: readonly Row[], name: string) => Row | null,
				absenceConfirmationMs: absenceConfirmationMs as number,
			};
		} else {
			throw new Error("cleanup kind is invalid");
		}
		const isRetryableCreate: unknown = Reflect.get(spec, "isRetryableCreate");
		if (isRetryableCreate !== undefined && typeof isRetryableCreate !== "function") {
			throw new Error("isRetryableCreate is not callable");
		}
		return {
			binary: Reflect.get(spec, "binary"),
			secretFlags: Reflect.get(spec, "secretFlags"),
			commandTimeoutMs: Reflect.get(spec, "commandTimeoutMs"),
			createCommandTimeoutMs: Reflect.get(spec, "createCommandTimeoutMs"),
			requestCoverage: snapshotCliCoverage(Reflect.get(spec, "requestCoverage")),
			create: Reflect.get(spec, "create"),
			...(prepared === undefined
				? {}
				: {
						prepare: {
							probe: Reflect.get(prepared, "probe"),
							fallback: Reflect.get(prepared, "fallback"),
						},
					}),
			cleanupCreated: normalizedCleanup,
			ready: {
				poll: Reflect.get(ready, "poll"),
				parse: Reflect.get(ready, "parse"),
				select: Reflect.get(ready, "select"),
				classify: Reflect.get(ready, "classify"),
				pollIntervalMs: Reflect.get(ready, "pollIntervalMs"),
			},
			sandboxId: {
				fromRow: Reflect.get(sandboxId, "fromRow"),
				parse: Reflect.get(sandboxId, "parse"),
			},
			exec: Reflect.get(spec, "exec"),
			destroy: Reflect.get(spec, "destroy"),
			notFound: Reflect.get(spec, "notFound"),
			...(typeof isRetryableCreate === "function"
				? { isRetryableCreate: isRetryableCreate as (error: DriverError) => boolean }
				: {}),
		} as CliSpec<Row>;
	});
}

function normalizeCliRows<Row>(provider: ProviderId, value: unknown): readonly Row[] {
	try {
		if (!Array.isArray(value)) throw new Error("non-array rows");
		const length: unknown = Reflect.get(value, "length");
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
			throw new Error("invalid rows length");
		}
		const rows: Row[] = [];
		for (let index = 0; index < length; index += 1) {
			rows.push(Reflect.get(value, index) as Row);
		}
		return rows;
	} catch {
		throw new DriverError(
			"vendor-contract-violation",
			`${provider} CLI readiness parser returned an unreadable row array`,
			{ provider, cause: sanitizedCliCallbackCause() },
		);
	}
}

function arkErrorsResult(
	provider: ProviderId,
	boundary: string,
	value: unknown,
	ref?: SandboxRef,
): value is type.errors {
	try {
		return value instanceof type.errors;
	} catch {
		throw new DriverError(
			"vendor-contract-violation",
			`${provider} CLI ${boundary} returned an unreadable schema result`,
			{
				provider,
				...(ref === undefined ? {} : { ref }),
				cause: sanitizedCliCallbackCause(),
			},
		);
	}
}

function arkErrorSummary(
	provider: ProviderId,
	boundary: string,
	errors: type.errors,
	ref?: SandboxRef,
): string {
	try {
		const summary: unknown = Reflect.get(errors, "summary");
		if (typeof summary === "string") return summary;
	} catch {
		// The generic contract failure below intentionally omits the hostile thrown value.
	}
	throw new DriverError(
		"vendor-contract-violation",
		`${provider} CLI ${boundary} returned unreadable schema diagnostics`,
		{
			provider,
			...(ref === undefined ? {} : { ref }),
			cause: sanitizedCliCallbackCause(),
		},
	);
}

function normalizeCliReadinessStatus(
	provider: ProviderId,
	value: unknown,
	redact: (detail: string) => string,
	ref?: SandboxRef,
): CliReadinessStatus {
	if (value === "ready" || value === "pending") return value;
	if ((typeof value === "object" || typeof value === "function") && value !== null) {
		let terminal: unknown;
		try {
			terminal = Reflect.get(value, "terminal");
		} catch {
			throw new DriverError(
				"vendor-contract-violation",
				`${provider} CLI readiness classifier returned an unreadable terminal result`,
				{
					provider,
					...(ref === undefined ? {} : { ref }),
					cause: sanitizedCliCallbackCause(),
				},
			);
		}
		if (typeof terminal === "string" && terminal.trim() !== "") {
			return { terminal: redact(terminal.trim()) };
		}
	}
	throw new DriverError(
		"vendor-contract-violation",
		`${provider} CLI readiness classifier must return ready, pending, or a nonempty terminal detail`,
		{ provider, ...(ref === undefined ? {} : { ref }) },
	);
}

export type CliResourceAxisDisposition =
	| "mapped"
	| "unsupported"
	| { readonly artifact: number }
	| { readonly capacityAtLeast: number };
export type CliOptionalAxisDisposition = "mapped" | "unsupported";

/**
 * Compile-time proof that a CLI author considered every canonical create axis. Resource axes can be
 * translated into argv, fixed by an artifact, satisfied by a declared minimum capacity, or rejected.
 * Adding a CreateRequest field breaks every CLI spec until the new axis receives an explicit policy.
 */
export type CliCreateRequestCoverage = {
	readonly spec: {
		readonly [Axis in keyof CreateRequest["spec"]]-?: CliResourceAxisDisposition;
	};
	readonly artifact: "context";
	readonly deadlineMs: "driver";
	readonly gpu: {
		readonly [Axis in keyof NonNullable<CreateRequest["gpu"]>]-?: CliOptionalAxisDisposition;
	};
} & {
	readonly [Axis in Exclude<
		keyof CreateRequest,
		"spec" | "artifact" | "deadlineMs" | "gpu"
	>]-?: CliOptionalAxisDisposition;
};

const CLI_TARGET_COVERAGE_AXES = {
	vcpus: true,
	memoryGb: true,
	diskGb: true,
} as const satisfies Record<keyof CreateRequest["spec"], true>;

const CLI_GPU_COVERAGE_AXES = {
	model: true,
	count: true,
} as const satisfies Record<keyof NonNullable<CreateRequest["gpu"]>, true>;

const CLI_REQUEST_COVERAGE_AXES = {
	spec: true,
	artifact: true,
	deadlineMs: true,
	gpu: true,
	env: true,
} as const satisfies Record<keyof CliCreateRequestCoverage, true>;

export interface CliSpec<Row> {
	/** Resolved binary path or name (the caller applies any env override). */
	readonly binary: string;
	/** Flags whose FOLLOWING argv value is a secret: redacted from every diagnostic. */
	readonly secretFlags: readonly string[];
	/** Kill budget for short control-plane calls: prepare, poll, exec, and destroy. */
	readonly commandTimeoutMs: number;
	/** Optional longer kill budget for the create subprocess; defaults to commandTimeoutMs. */
	readonly createCommandTimeoutMs?: number;
	/** Exhaustive, pre-allocation disposition of every canonical request axis. */
	readonly requestCoverage: CliCreateRequestCoverage;
	/** argv to create a sandbox named `name` for `request`. */
	readonly create: (request: CreateRequest, name: string) => CliArgv;
	/** Optional pre-create probe with a fallback action (for profile-based CLI authentication). */
	readonly prepare?: {
		/** Must exit zero and parse through the readiness-row schema to count as prepared. */
		readonly probe: CliArgv;
		/** Checked fallback command, commonly `login --token …`; secret flags still redact it. */
		readonly fallback: CliArgv;
	};
	/** Rollback/reconciliation used when no session handle can be returned. */
	readonly cleanupCreated: CliFailedCreateCleanup<Row>;
	readonly ready: {
		/** argv that lists/inspects sandboxes; polled until `select` finds the row. */
		readonly poll: CliArgv;
		/** Trust boundary: raw stdout → rows, as an arktype pipeline (path-bearing errors). */
		readonly parse: CliRowsSchema<Row>;
		/** The created row for `name`, or null while it is not visible. */
		readonly select: (rows: readonly Row[], name: string) => Row | null;
		/** Typed vendor-state policy. The kit handles terminal errors, deadline, and cleanup. */
		readonly classify: (row: Row) => CliReadinessStatus;
		readonly pollIntervalMs?: number;
	};
	/** Trust boundary: the selected provider module extracts and validates its sandbox-id format. */
	readonly sandboxId: {
		readonly fromRow: (row: Row) => unknown;
		readonly parse: Type<string>;
	};
	readonly exec: (id: string, command: string) => CliArgv;
	readonly destroy: (id: string) => CliArgv;
	/** Vendor prose meaning "already gone" — destroy-of-missing MUST succeed (ADR-0008). */
	readonly notFound: RegExp;
	/**
	 * Optional module-owned create-retry classifier. Called only after failed-create reconciliation
	 * has confirmed the generated name is gone. True marks the `create-failed` {@link DriverError}
	 * for the harness; a throw or any other value leaves it terminal.
	 *
	 * This hook is the CLI lane's ONLY create-retry channel. The shared rule's other arm reads
	 * `vendorExitCode === 429`, but on this lane that field is the child's PROCESS exit status, which
	 * POSIX truncates to 0-255 — a CLI cannot exit 429, so nothing arrives that way. A module with no
	 * typed signal to classify (a CLI whose only capacity evidence is stderr prose) leaves this unset
	 * and its creates stay terminal: guessing from wording is the drift ADR-0008 exists to end.
	 */
	readonly isRetryableCreate?: (error: DriverError) => boolean;
}

export type CliSpecFields<Row> = Omit<CliSpec<Row>, "ready"> & {
	readonly ready: Omit<CliSpec<Row>["ready"], "parse">;
};

/**
 * Bind a CLI's arktype rows parser before contextual-typing the rest of its table.
 *
 * Keeping the parser in the first argument lets TypeScript infer `Row` once and then type every
 * `select`/`fromRow` callback without a handwritten row alias or annotation.
 */
export function defineCliSpec<Row>(
	parse: CliRowsSchema<Row>,
	spec: CliSpecFields<NoInfer<Row>>,
): CliSpec<Row> {
	return { ...spec, ready: { ...spec.ready, parse } };
}

export interface CliDriverOptions {
	/** Override the spawn runner (tests). Defaults to Bun.spawn on the spec's binary. */
	readonly run?: CliRunner;
	/** Joined-module ceiling. Internal/test seam; provider authors use defineCliDriver. */
	readonly createAttemptCeilingMs?: number;
}

interface CliPreparationInFlight {
	readonly cancellation: AbortController;
	readonly waiters: Set<symbol>;
	readonly promise: Promise<void>;
}

/** Per-driver state: successful profile preparation is shared; failed attempts clear for retry. */
export interface CliDriverContext {
	prepare?: true | CliPreparationInFlight;
}

/** One joined CLI-provider module; the helper derives CLI-owned readiness and create budgeting. */
export interface CliDriverModuleSpec<P extends ProviderId, Row> {
	readonly provenance: DriverPolicy<P, Row>["provenance"];
	/** CLI sessions have no native launch handle; durable work uses the kit's shell fallback. */
	readonly execution:
		| { readonly syncCapMs: null; readonly durable: "shell-detach" | "none" }
		| { readonly syncCapMs: number; readonly durable: "shell-detach" };
	readonly accelerator?: DriverPolicy<P, Row>["accelerator"];
	readonly costEvidence?: DriverPolicy<P, Row>["costEvidence"];
	/** Hard ceiling until success or a retryable failed-create cleanup record is returned. */
	readonly createAttemptCeilingMs: number;
	/** Builds the small declarative CLI table from this provider's exact environment slice. */
	readonly spec: (context: DriverContext<P>) => CliSpec<Row>;
}

const cliRunTimeoutErrors = new WeakSet<object>();
const cliRunnerContractErrors = new WeakSet<object>();

class CliRunTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`CLI process exceeded its ${timeoutMs}ms timeout`);
		cliRunTimeoutErrors.add(this);
		this.name = "CliRunTimeoutError";
	}
}

class CliRunAbortedError extends Error {
	constructor(readonly reason: unknown) {
		super("CLI process was aborted", { cause: reason });
		this.name = "CliRunAbortedError";
	}
}

class CliRunnerContractError extends DriverError {
	constructor(...args: ConstructorParameters<typeof DriverError>) {
		super(...args);
		cliRunnerContractErrors.add(this);
	}
}

function isCliRunTimeoutError(value: unknown): value is CliRunTimeoutError {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		cliRunTimeoutErrors.has(value)
	);
}

function isCliRunnerContractError(value: unknown): value is CliRunnerContractError {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		cliRunnerContractErrors.has(value)
	);
}

function normalizeCliRunResult(provider: ProviderId, value: unknown): CliRunResult {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		throw new CliRunnerContractError(
			"vendor-contract-violation",
			`${provider} CLI runner returned a non-object result`,
			{ provider, cause: sanitizedCliCallbackCause() },
		);
	}
	let stdout: unknown;
	let stderr: unknown;
	let code: unknown;
	try {
		stdout = Reflect.get(value, "stdout");
		stderr = Reflect.get(value, "stderr");
		code = Reflect.get(value, "code");
	} catch {
		throw new CliRunnerContractError(
			"vendor-contract-violation",
			`${provider} CLI runner returned an unreadable result`,
			{ provider, cause: sanitizedCliCallbackCause() },
		);
	}
	if (
		typeof stdout !== "string" ||
		typeof stderr !== "string" ||
		typeof code !== "number" ||
		!Number.isSafeInteger(code)
	) {
		throw new CliRunnerContractError(
			"vendor-contract-violation",
			`${provider} CLI runner returned malformed stdout, stderr, or exit code`,
			{ provider, cause: sanitizedCliCallbackCause() },
		);
	}
	return { stdout, stderr, code };
}

function subscribeToAbort(signal: AbortSignal | undefined, listener: () => void): () => void {
	if (signal === undefined) return () => {};
	signal.addEventListener("abort", listener, { once: true });
	// Abort can win between a caller's pre-check and listener registration. Re-check only after the
	// listener is installed so that edge cannot strand a subprocess or a reconciliation sleep.
	if (signal.aborted) {
		signal.removeEventListener("abort", listener);
		listener();
		return () => {};
	}
	return () => signal.removeEventListener("abort", listener);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new CliRunAbortedError(signal.reason));
	return new Promise((resolve, reject) => {
		let unsubscribe = () => {};
		const timer = setTimeout(done, ms);
		function done(): void {
			unsubscribe();
			resolve();
		}
		function aborted(): void {
			clearTimeout(timer);
			unsubscribe();
			reject(new CliRunAbortedError(signal?.reason));
		}
		unsubscribe = subscribeToAbort(signal, aborted);
	});
}

function readTextStream(stream: ReadableStream<Uint8Array>): {
	readonly text: Promise<string>;
	cancel(): void;
} {
	const reader = stream.getReader();
	const text = (async () => {
		const decoder = new TextDecoder();
		let output = "";
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			output += decoder.decode(next.value, { stream: true });
		}
		return output + decoder.decode();
	})();
	return {
		text,
		cancel() {
			// Cancellation releases this process's side of inherited pipes even if a descendant
			// escaped the process group. The read promise is already observed by `completed`.
			void reader.cancel().catch(() => undefined);
		},
	};
}

const defaultRunner: CliRunner = async (binary, args, options) => {
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
		throw new DriverError(
			"vendor-contract-violation",
			`CLI timeout must be a positive safe integer, received ${runtimeNumberLabel(options.timeoutMs)}`,
		);
	}
	if (options.signal?.aborted) throw new CliRunAbortedError(options.signal.reason);
	const child = Bun.spawn([binary, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		// A separate process group lets timeout cleanup kill helpers that inherited our pipes.
		detached: process.platform !== "win32",
	});
	const stdout = readTextStream(child.stdout);
	const stderr = readTextStream(child.stderr);
	const completed = Promise.all([child.exited, stdout.text, stderr.text]).then(
		([code, stdout, stderr]) => ({ kind: "completed" as const, code, stdout, stderr }),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timeout" }), options.timeoutMs);
	});
	let abortListener = () => {};
	const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
		abortListener = subscribeToAbort(options.signal, () => resolve({ kind: "aborted" }));
	});
	let outcome:
		| {
				readonly kind: "completed";
				readonly code: number;
				readonly stdout: string;
				readonly stderr: string;
		  }
		| { readonly kind: "timeout" }
		| { readonly kind: "aborted" };
	try {
		outcome = await Promise.race([completed, timeout, aborted]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		abortListener();
	}
	if (outcome.kind !== "completed") {
		stdout.cancel();
		stderr.cancel();
		if (process.platform === "win32") {
			child.kill("SIGKILL");
		} else {
			try {
				// `detached` makes the child the group leader. The negative pid reaches descendants
				// even if the CLI parent already exited while a helper kept stdout/stderr open.
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}
		await child.exited;
		if (outcome.kind === "timeout") throw new CliRunTimeoutError(options.timeoutMs);
		throw new CliRunAbortedError(options.signal?.reason);
	}
	return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code };
};

/** Redact secret values from an argv for diagnostics: the value AFTER a secret flag becomes ***. */
export function redactArgs(args: readonly string[], secretFlags: readonly string[]): string[] {
	const redacted: string[] = [];
	let hide = false;
	for (const arg of args) {
		if (hide) {
			redacted.push("***");
			hide = false;
		} else {
			redacted.push(arg);
			hide = secretFlags.includes(arg);
		}
	}
	return redacted;
}

/** Redact secret argv values if a vendor echoes its invocation into stdout/stderr. */
export function redactDiagnostic(
	text: string,
	args: readonly string[],
	secretFlags: readonly string[],
): string {
	return redactDiagnostics(text, [args], secretFlags);
}

function redactDiagnostics(
	text: string,
	commands: readonly (readonly string[])[],
	secretFlags: readonly string[],
): string {
	const secrets: string[] = [];
	for (const args of commands) {
		let takeSecret = false;
		for (const arg of args) {
			if (takeSecret) {
				if (arg !== "") secrets.push(arg);
				takeSecret = false;
			} else {
				takeSecret = secretFlags.includes(arg);
			}
		}
	}
	// Replace longer overlapping credentials first, or a short prefix can leave a secret suffix.
	secrets.sort((left, right) => right.length - left.length);
	return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "***"), text);
}

function invalidCliCreateRequest(provider: ProviderId, detail: string): never {
	throw new DriverError(
		"invalid-create-request",
		`${provider} CLI cannot honor the requested sandbox shape: ${detail}`,
		{ provider },
	);
}

function invalidCliCoverage(provider: ProviderId, detail: string): never {
	throw new DriverError("vendor-contract-violation", `CLI request coverage is invalid: ${detail}`, {
		provider,
	});
}

function requireExactCliCoverageAxes(
	provider: ProviderId,
	label: string,
	coverage: Readonly<Record<string, unknown>>,
	expected: Readonly<Record<string, true>>,
): void {
	for (const axis of Object.keys(expected)) {
		if (!Object.hasOwn(coverage, axis)) {
			invalidCliCoverage(provider, `${label} is missing canonical axis ${axis}`);
		}
	}
	for (const axis of Object.keys(coverage)) {
		if (!Object.hasOwn(expected, axis)) {
			invalidCliCoverage(provider, `${label} declares unknown axis ${axis}`);
		}
	}
}

function validateCliCoverage(provider: ProviderId, coverage: CliCreateRequestCoverage): void {
	requireExactCliCoverageAxes(
		provider,
		"request coverage",
		coverage as Readonly<Record<string, unknown>>,
		CLI_REQUEST_COVERAGE_AXES,
	);
	requireExactCliCoverageAxes(provider, "target coverage", coverage.spec, CLI_TARGET_COVERAGE_AXES);
	requireExactCliCoverageAxes(provider, "GPU coverage", coverage.gpu, CLI_GPU_COVERAGE_AXES);
	if (coverage.artifact !== "context") {
		invalidCliCoverage(provider, "artifact must be owned by the resolved driver context");
	}
	if (coverage.deadlineMs !== "driver") {
		invalidCliCoverage(provider, "deadlineMs must be owned by the CLI driver");
	}
	for (const [axis, disposition] of Object.entries(coverage.spec)) {
		if (disposition === "mapped" || disposition === "unsupported") continue;
		if (disposition === null || typeof disposition !== "object" || Array.isArray(disposition)) {
			invalidCliCoverage(provider, `target axis ${axis} has an unknown disposition`);
		}
		const entries = Object.entries(disposition);
		if (
			entries.length !== 1 ||
			(entries[0]?.[0] !== "artifact" && entries[0]?.[0] !== "capacityAtLeast")
		) {
			invalidCliCoverage(provider, `target axis ${axis} must declare exactly one numeric bound`);
		}
		const value = entries[0]?.[1];
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			invalidCliCoverage(
				provider,
				`target axis ${axis} numeric bound must be positive and finite, received ${runtimeNumberLabel(value)}`,
			);
		}
	}
	for (const [axis, disposition] of Object.entries(coverage.gpu)) {
		if (disposition !== "mapped" && disposition !== "unsupported") {
			invalidCliCoverage(provider, `GPU axis ${axis} has an unknown disposition`);
		}
	}
	for (const [axis, disposition] of Object.entries(coverage)) {
		if (axis === "spec" || axis === "gpu" || axis === "artifact" || axis === "deadlineMs") continue;
		if (disposition !== "mapped" && disposition !== "unsupported") {
			invalidCliCoverage(provider, `request axis ${axis} has an unknown disposition`);
		}
	}
}

function validateCliCreateRequest(
	provider: ProviderId,
	coverage: CliCreateRequestCoverage,
	request: CreateRequest,
): void {
	for (const [axis, disposition] of Object.entries(coverage.spec)) {
		const value = request.spec[axis as keyof CreateRequest["spec"]];
		if (value === undefined) continue;
		if (disposition === "unsupported") {
			invalidCliCreateRequest(provider, `target axis ${axis} is unsupported`);
		}
		if (typeof disposition === "object" && "artifact" in disposition) {
			if (value !== disposition.artifact) {
				invalidCliCreateRequest(
					provider,
					`target axis ${axis} must equal the artifact-pinned value ${disposition.artifact}`,
				);
			}
		}
		if (typeof disposition === "object" && "capacityAtLeast" in disposition) {
			if (value > disposition.capacityAtLeast) {
				invalidCliCreateRequest(
					provider,
					`target axis ${axis} exceeds the declared capacity ${disposition.capacityAtLeast}`,
				);
			}
		}
	}
	if (request.gpu !== undefined) {
		const gpu = request.gpu as unknown as Readonly<Record<string, unknown>>;
		for (const [axis, disposition] of Object.entries(coverage.gpu)) {
			if (disposition === "unsupported" && gpu[axis] !== undefined) {
				invalidCliCreateRequest(
					provider,
					`GPU ${request.gpu.model} x${request.gpu.count} is unsupported (axis ${axis})`,
				);
			}
		}
	}
	const requestRecord = request as unknown as Readonly<Record<string, unknown>>;
	for (const [axis, disposition] of Object.entries(coverage)) {
		if (axis === "spec" || axis === "artifact" || axis === "deadlineMs" || axis === "gpu") {
			continue;
		}
		const value = requestRecord[axis];
		const emptyEnvironment =
			axis === "env" &&
			value !== null &&
			typeof value === "object" &&
			Object.keys(value).length === 0;
		if (disposition === "unsupported" && value !== undefined && !emptyEnvironment) {
			invalidCliCreateRequest(
				provider,
				axis === "env"
					? "guest environment injection is unsupported"
					: `request axis ${axis} is unsupported`,
			);
		}
	}
}

/** Compile a CLI spec down to a method table (handle = the parsed readiness row). */
export function cliMethodTable<Row>(
	provider: ProviderId,
	spec: CliSpec<Row>,
	options: CliDriverOptions = {},
): MethodTable<Row, CliDriverContext> {
	const normalizedOptions = invokeCliProviderCallback(provider, "options normalization", () => ({
		run: Reflect.get(options, "run") as unknown,
		createAttemptCeilingMs: Reflect.get(options, "createAttemptCeilingMs") as unknown,
	}));
	if (normalizedOptions.run !== undefined && typeof normalizedOptions.run !== "function") {
		throw new DriverError("vendor-contract-violation", "CLI runner must be callable", {
			provider,
		});
	}
	const run = (normalizedOptions.run as CliRunner | undefined) ?? defaultRunner;
	const createAttemptCeilingMs = normalizedOptions.createAttemptCeilingMs;
	const compiled = snapshotCliSpec(provider, spec);
	validateCliCoverage(provider, compiled.requestCoverage);
	if (typeof compiled.binary !== "string" || compiled.binary.trim() === "") {
		throw new DriverError("vendor-contract-violation", `${provider} CLI binary must be nonempty`, {
			provider,
		});
	}
	const binary = compiled.binary;
	const commandTimeoutMs = compiled.commandTimeoutMs;
	const createCommandTimeoutMs = compiled.createCommandTimeoutMs;
	const requestCoverage = compiled.requestCoverage;
	const createArgv = compiled.create;
	const cleanupCreated = compiled.cleanupCreated;
	const ready = compiled.ready;
	const sandboxId = compiled.sandboxId;
	const execArgv = compiled.exec;
	const destroyArgv = compiled.destroy;
	const isRetryableCreate = compiled.isRetryableCreate;
	const secretFlags = normalizeCliStringList(provider, "secretFlags", compiled.secretFlags);
	const readyPoll = normalizeCliArgv(provider, "ready.poll", ready.poll);
	const prepare =
		compiled.prepare === undefined
			? undefined
			: {
					probe: normalizeCliArgv(provider, "prepare.probe", compiled.prepare.probe),
					fallback: normalizeCliArgv(provider, "prepare.fallback", compiled.prepare.fallback),
				};
	let notFoundSource: string;
	let notFoundFlags: string;
	try {
		const source: unknown = Reflect.get(compiled.notFound, "source");
		const flags: unknown = Reflect.get(compiled.notFound, "flags");
		if (typeof source !== "string" || typeof flags !== "string") throw new Error("invalid regexp");
		// Compile once now to reject invalid flag/source combinations before any allocation.
		new RegExp(source, flags);
		notFoundSource = source;
		notFoundFlags = flags;
	} catch {
		throw new DriverError(
			"vendor-contract-violation",
			`${provider} CLI notFound must be a readable regular expression`,
			{ provider, cause: sanitizedCliCallbackCause() },
		);
	}
	if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
		throw new DriverError(
			"vendor-contract-violation",
			`commandTimeoutMs must be a positive safe integer, received ${runtimeNumberLabel(commandTimeoutMs)}`,
			{ provider },
		);
	}
	if (
		createCommandTimeoutMs !== undefined &&
		(!Number.isSafeInteger(createCommandTimeoutMs) || createCommandTimeoutMs <= 0)
	) {
		throw new DriverError(
			"vendor-contract-violation",
			`createCommandTimeoutMs must be a positive safe integer, received ${runtimeNumberLabel(createCommandTimeoutMs)}`,
			{ provider },
		);
	}
	if (
		createAttemptCeilingMs !== undefined &&
		(!Number.isSafeInteger(createAttemptCeilingMs) || (createAttemptCeilingMs as number) <= 0)
	) {
		throw new DriverError(
			"vendor-contract-violation",
			`createAttemptCeilingMs must be a positive safe integer, received ${runtimeNumberLabel(createAttemptCeilingMs)}`,
			{ provider },
		);
	}
	if (
		ready.pollIntervalMs !== undefined &&
		(!Number.isSafeInteger(ready.pollIntervalMs) || ready.pollIntervalMs <= 0)
	) {
		throw new DriverError(
			"vendor-contract-violation",
			`ready.pollIntervalMs must be a positive safe integer, received ${runtimeNumberLabel(ready.pollIntervalMs)}`,
			{ provider },
		);
	}
	if (
		!Number.isSafeInteger(cleanupCreated.absenceConfirmationMs) ||
		cleanupCreated.absenceConfirmationMs <= 0
	) {
		throw new DriverError(
			"vendor-contract-violation",
			`cleanupCreated.absenceConfirmationMs must be a positive safe integer, received ${runtimeNumberLabel(cleanupCreated.absenceConfirmationMs)}`,
			{ provider },
		);
	}
	const call = async (
		args: CliArgv,
		timeoutMs = commandTimeoutMs,
		signal?: AbortSignal,
	): Promise<CliRunResult> => {
		const boundedTimeoutMs = Math.floor(timeoutMs);
		if (boundedTimeoutMs <= 0) throw new CliRunTimeoutError(timeoutMs);
		const result: unknown = await run(binary, args, {
			timeoutMs: boundedTimeoutMs,
			...(signal === undefined ? {} : { signal }),
		});
		return normalizeCliRunResult(provider, result);
	};
	const redactKnownDiagnostic = (text: string, args: readonly (readonly string[])[]): string => {
		const allArgs = prepare === undefined ? args : [...args, prepare.probe, prepare.fallback];
		return redactDiagnostics(text, allArgs, secretFlags);
	};
	const providerCallback = <T>(boundary: string, callback: () => T, ref?: SandboxRef): T =>
		invokeCliProviderCallback(provider, boundary, callback, ref);
	// Vendor failures carry structured fields (the child's exit status + its vendor diagnostic), and
	// the message redacts secret argv for humans. Retry is decided by isRetryableDriverCreate, from a
	// mark this lane sets only through CliSpec.isRetryableCreate — never by regexing either string.
	const vendorFailed = (
		code: "create-failed" | "destroy-failed" | "probe-failed",
		args: CliArgv,
		result: CliRunResult,
		ref?: SandboxRef,
		diagnosticArgs: readonly (readonly string[])[] = [args],
	): DriverError => {
		const vendorDiagnostic = result.stderr.trim() || result.stdout.trim();
		return new DriverError(
			code,
			`${binary} ${redactArgs(args, secretFlags).join(" ")}: exit ${result.code}`,
			{
				provider,
				vendorExitCode: result.code,
				vendorMessage: redactKnownDiagnostic(vendorDiagnostic, diagnosticArgs),
				...(ref ? { ref } : {}),
			},
		);
	};

	const runnerFailed = (
		code: "create-failed" | "exec-failed" | "destroy-failed" | "probe-failed",
		args: CliArgv,
		caught: unknown,
		ref?: SandboxRef,
		_diagnosticArgs: readonly (readonly string[])[] = [args],
	): DriverError => {
		if (isCliRunnerContractError(caught)) return caught;
		const detail = "CLI runner failed; original diagnostic omitted to protect credentials";
		return new DriverError(
			code,
			`${binary} ${redactArgs(args, secretFlags).join(" ")}: ${detail}`,
			{
				provider,
				vendorMessage: detail,
				...(ref ? { ref } : {}),
			},
		);
	};

	const parseRows = (
		result: CliRunResult,
		diagnosticArgs: readonly (readonly string[])[],
	): readonly Row[] => {
		const rows: unknown = providerCallback("readiness parser", () => ready.parse(result.stdout));
		// CliRowsSchema's output side is readonly Row[]. ArkType's internal distillation cannot
		// prove that equality for an arbitrary generic Row, even though the public schema type does.
		if (!arkErrorsResult(provider, "readiness parser", rows)) {
			if (Array.isArray(rows)) return normalizeCliRows<Row>(provider, rows);
			throw new DriverError(
				"vendor-contract-violation",
				`${provider} CLI readiness parser must return a row array or schema errors`,
				{ provider, cause: sanitizedCliCallbackCause() },
			);
		}
		const summary = redactKnownDiagnostic(
			arkErrorSummary(provider, "readiness parser", rows),
			diagnosticArgs,
		);
		throw new DriverError("vendor-output-unparseable", `${binary} output: ${summary}`, {
			provider,
			vendorMessage: summary,
		});
	};

	const createDeadlineError = (deadlineMs: number): DriverError =>
		new DriverError("readiness-timeout", `${provider} sandbox not ready within ${deadlineMs}ms`, {
			provider,
		});

	const ensurePrepared = async (
		remaining: () => number,
		deadlineMs: number,
		signal?: AbortSignal,
	): Promise<void> => {
		if (prepare === undefined) return;
		const probeBudget = remaining();
		if (probeBudget < 1) throw createDeadlineError(deadlineMs);
		let probed: CliRunResult;
		try {
			probed = await call(prepare.probe, Math.min(probeBudget, commandTimeoutMs), signal);
		} catch (caught) {
			if (isCliRunTimeoutError(caught) && probeBudget <= commandTimeoutMs) {
				throw createDeadlineError(deadlineMs);
			}
			// A transport, cancellation, timeout, or runner-contract failure says nothing about the
			// profile. Only a completed nonzero probe may authorize the state-changing fallback.
			throw runnerFailed("create-failed", prepare.probe, caught);
		}
		if (probed.code === 0) {
			// Exit zero already proves authentication. Schema drift is not repaired by overwriting a
			// developer's working profile, so surface it through the normal trust-boundary error.
			parseRows(probed, [prepare.probe]);
			return;
		}

		const fallbackBudget = remaining();
		if (fallbackBudget < 1) throw createDeadlineError(deadlineMs);
		let fallback: CliRunResult;
		try {
			fallback = await call(prepare.fallback, Math.min(fallbackBudget, commandTimeoutMs), signal);
		} catch (caught) {
			if (isCliRunTimeoutError(caught) && fallbackBudget <= commandTimeoutMs) {
				throw createDeadlineError(deadlineMs);
			}
			throw runnerFailed("create-failed", prepare.fallback, caught);
		}
		if (fallback.code !== 0) {
			throw vendorFailed("create-failed", prepare.fallback, fallback);
		}

		// A successful login proves only that the profile write worked. Re-run the typed probe before
		// allocation so schema drift cannot make both readiness and failed-create recovery unusable.
		const verificationBudget = remaining();
		if (verificationBudget < 1) throw createDeadlineError(deadlineMs);
		let verified: CliRunResult;
		try {
			verified = await call(prepare.probe, Math.min(verificationBudget, commandTimeoutMs), signal);
		} catch (caught) {
			if (isCliRunTimeoutError(caught) && verificationBudget <= commandTimeoutMs) {
				throw createDeadlineError(deadlineMs);
			}
			throw runnerFailed("create-failed", prepare.probe, caught);
		}
		if (verified.code !== 0) {
			throw vendorFailed("create-failed", prepare.probe, verified);
		}
		parseRows(verified, [prepare.probe]);
	};
	const ensurePreparedOnce = (
		context: CliDriverContext,
		remaining: () => number,
		deadlineMs: number,
		signal?: AbortSignal,
	): Promise<void> => {
		if (prepare === undefined) return Promise.resolve();
		if (context.prepare === true) {
			if (signal?.aborted) return Promise.reject(new CliRunAbortedError(signal.reason));
			return remaining() < 1 ? Promise.reject(createDeadlineError(deadlineMs)) : Promise.resolve();
		}
		const budgetMs = remaining();
		if (budgetMs < 1) return Promise.reject(createDeadlineError(deadlineMs));
		let preparation = context.prepare;
		if (preparation === undefined) {
			// Preparation is driver-owned, not owned by whichever create happened to arrive first. Each
			// control command retains its own hard bound; callers race the shared task below against their
			// individual request budgets and cancellation signals.
			const sharedBudgetMs = Math.min(Number.MAX_SAFE_INTEGER, commandTimeoutMs * 3);
			const sharedDeadline = performance.now() + sharedBudgetMs;
			const cancellation = new AbortController();
			const waiters = new Set<symbol>();
			let state!: CliPreparationInFlight;
			state = {
				cancellation,
				waiters,
				promise: ensurePrepared(
					() => Math.max(0, sharedDeadline - performance.now()),
					sharedBudgetMs,
					cancellation.signal,
				).then(
					() => {
						if (context.prepare === state) context.prepare = true;
					},
					(caught: unknown) => {
						if (context.prepare === state) context.prepare = undefined;
						throw caught;
					},
				),
			};
			context.prepare = state;
			preparation = state;
		}
		if (preparation.cancellation.signal.aborted) {
			// The previous last owner has canceled this task and is waiting for its runner to kill/reap.
			// A new owner waits for that bounded drain under ITS budget, then transparently starts or
			// joins the successor instead of inheriting the retired task's cancellation error.
			let retirementTimer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribeRetirementAbort = () => {};
			const retirementDeadline = new Promise<never>((_resolve, reject) => {
				retirementTimer = setTimeout(() => reject(createDeadlineError(deadlineMs)), budgetMs);
			});
			const retirementAbort = new Promise<never>((_resolve, reject) => {
				unsubscribeRetirementAbort = subscribeToAbort(signal, () =>
					reject(new CliRunAbortedError(signal?.reason)),
				);
			});
			const retired = preparation.promise.then(
				() => undefined,
				() => undefined,
			);
			return Promise.race([retired, retirementDeadline, retirementAbort])
				.finally(() => {
					if (retirementTimer !== undefined) clearTimeout(retirementTimer);
					unsubscribeRetirementAbort();
				})
				.then(() => ensurePreparedOnce(context, remaining, deadlineMs, signal));
		}

		const waiter = Symbol("cli-prepare-waiter");
		preparation.waiters.add(waiter);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribeAbort = () => {};
		const ownDeadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(createDeadlineError(deadlineMs)), budgetMs);
		});
		const ownAbort = new Promise<never>((_resolve, reject) => {
			unsubscribeAbort = subscribeToAbort(signal, () =>
				reject(new CliRunAbortedError(signal?.reason)),
			);
		});
		return Promise.race([preparation.promise, ownDeadline, ownAbort])
			.then(() => {
				// Like readiness polling, do not accept a completion that landed after its budget but
				// before the timer callback got a turn.
				if (signal?.aborted) throw new CliRunAbortedError(signal.reason);
				if (remaining() < 1) throw createDeadlineError(deadlineMs);
			})
			.finally(() => {
				if (timer !== undefined) clearTimeout(timer);
				unsubscribeAbort();
				preparation.waiters.delete(waiter);
				if (preparation.waiters.size === 0 && context.prepare === preparation) {
					preparation.cancellation.abort(
						new Error(`${provider} CLI preparation has no remaining create owner`),
					);
					// The last owner does not return until the runner honors cancellation and has reaped
					// its subprocess. `finally` preserves the caller's own timeout/abort error afterward.
					return preparation.promise.then(
						() => undefined,
						() => undefined,
					);
				}
			});
	};

	const matchesNotFound = (text: string): boolean =>
		new RegExp(notFoundSource, notFoundFlags).test(text);

	const parseSandboxId = (
		raw: unknown,
		ref?: SandboxRef,
		diagnosticArgs: readonly (readonly string[])[] = [],
	): string => {
		const id: unknown = providerCallback("sandbox-id parser", () => sandboxId.parse(raw), ref);
		if (arkErrorsResult(provider, "sandbox-id parser", id, ref)) {
			const summary = redactKnownDiagnostic(
				arkErrorSummary(provider, "sandbox-id parser", id, ref),
				diagnosticArgs,
			);
			throw new DriverError(
				"invalid-sandbox-ref",
				`${provider} CLI returned an invalid sandbox id: ${summary}`,
				{ provider, ...(ref ? { ref } : {}) },
			);
		}
		if (typeof id !== "string" || id.length === 0) {
			throw new DriverError(
				"vendor-contract-violation",
				`${provider} CLI sandbox-id parser must return a nonempty string or schema errors`,
				{
					provider,
					...(ref === undefined ? {} : { ref }),
					cause: sanitizedCliCallbackCause(),
				},
			);
		}
		return id;
	};
	const sandboxIdOf = (
		row: Row,
		diagnosticArgs: readonly (readonly string[])[] = [],
		ref?: SandboxRef,
	): string =>
		parseSandboxId(
			providerCallback("sandbox-id extractor", () => sandboxId.fromRow(row), ref),
			ref,
			diagnosticArgs,
		);
	const sandboxIdFromRef = (ref: SandboxRef): string => {
		if (ref.provider !== provider) {
			throw new DriverError(
				"invalid-sandbox-ref",
				`${provider} driver cannot destroy a ${ref.provider} sandbox ref`,
				{ provider, ref },
			);
		}
		return parseSandboxId(ref.id, ref);
	};

	const destroyByArgs = async (
		args: CliArgv,
		options: {
			readonly ref?: SandboxRef;
			readonly timeoutMs?: number;
			readonly diagnosticArgs?: readonly (readonly string[])[];
			readonly signal?: AbortSignal;
		} = {},
	): Promise<
		| { readonly status: "destroyed" }
		| { readonly status: "not-found"; readonly result: CliRunResult }
	> => {
		const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
		let result: CliRunResult;
		try {
			result = await call(args, timeoutMs, options.signal);
		} catch (caught) {
			throw runnerFailed("destroy-failed", args, caught, options.ref, options.diagnosticArgs);
		}
		const notFound = matchesNotFound(result.stderr) || matchesNotFound(result.stdout);
		if (notFound) return { status: "not-found", result };
		if (result.code !== 0) {
			throw vendorFailed("destroy-failed", args, result, options.ref, options.diagnosticArgs);
		}
		return { status: "destroyed" };
	};

	return {
		async create(context, request, operationOptions) {
			const signal = operationOptions?.signal;
			const name = `bench-${randomUUID()}`;
			const deadlineMs = Math.min(
				request.deadlineMs,
				(createAttemptCeilingMs as number | undefined) ?? request.deadlineMs,
			);
			const boundedRequest =
				deadlineMs === request.deadlineMs ? request : { ...request, deadlineMs };
			validateCliCreateRequest(provider, requestCoverage, boundedRequest);
			const deadline = performance.now() + deadlineMs;
			const remaining = (): number => Math.max(0, deadline - performance.now());
			// Compile every argv that rollback may need before the first external side effect. A
			// declarative callback bug is then allocation-safe and cannot discard the only locator.
			let createArgs: CliArgv;
			let cleanupArgs: CliArgv | undefined;
			if (cleanupCreated.kind === "command") {
				cleanupArgs = normalizeCliArgv(
					provider,
					"cleanup argv builder",
					providerCallback("cleanup argv builder", () =>
						cleanupCreated.kind === "command" ? cleanupCreated.command(name) : ["unreachable"],
					),
				);
			}
			createArgs = normalizeCliArgv(
				provider,
				"create argv builder",
				providerCallback("create argv builder", () => createArgv(boundedRequest, name)),
			);
			const attemptArgs: readonly (readonly string[])[] =
				cleanupArgs === undefined ? [createArgs, readyPoll] : [createArgs, readyPoll, cleanupArgs];
			await ensurePreparedOnce(context, remaining, deadlineMs, signal);
			try {
				const createBudget = remaining();
				if (createBudget < 1) throw createDeadlineError(deadlineMs);
				const createTimeoutMs = createCommandTimeoutMs ?? commandTimeoutMs;
				let created: CliRunResult;
				try {
					created = await call(createArgs, Math.min(createBudget, createTimeoutMs), signal);
				} catch (caught) {
					if (isCliRunTimeoutError(caught) && createBudget <= createTimeoutMs) {
						throw createDeadlineError(deadlineMs);
					}
					throw runnerFailed("create-failed", createArgs, caught, undefined, attemptArgs);
				}
				if (created.code !== 0) {
					throw vendorFailed("create-failed", createArgs, created, undefined, attemptArgs);
				}

				const pollBudget = remaining();
				if (pollBudget < 1) throw createDeadlineError(deadlineMs);
				// Reserve the tail of the attempt ceiling for failed-create reconciliation. Readiness polling
				// would otherwise spend the entire budget, so a create that was remotely accepted but never
				// became ready would skip its only in-line cleanup attempt and hand a possibly-billable
				// allocation to the process-level owner. Never reserve more than half, so readiness keeps a
				// usable window on short deadlines.
				const reconciliationReserveMs = Math.min(commandTimeoutMs, Math.floor(pollBudget / 2));
				const readinessBudget = pollBudget - reconciliationReserveMs;
				const readinessDeadline = performance.now() + readinessBudget;
				const remainingReadiness = (): number => Math.max(0, readinessDeadline - performance.now());
				let row: Row;
				let activePoll: Promise<CliRunResult> | undefined;
				try {
					row = await pollUntilReady({
						provider,
						deadlineMs: readinessBudget,
						intervalMs: ready.pollIntervalMs ?? 1_000,
						signal,
						poll: async () => {
							const probeBudget = remainingReadiness();
							if (probeBudget < 1) throw createDeadlineError(deadlineMs);
							let polled: CliRunResult;
							try {
								const running = call(readyPoll, Math.min(probeBudget, commandTimeoutMs), signal);
								activePoll = running;
								try {
									polled = await running;
								} finally {
									if (activePoll === running) activePoll = undefined;
								}
							} catch (caught) {
								if (isCliRunTimeoutError(caught) && probeBudget <= commandTimeoutMs) {
									throw createDeadlineError(deadlineMs);
								}
								throw runnerFailed("create-failed", readyPoll, caught, undefined, attemptArgs);
							}
							if (polled.code !== 0) {
								throw vendorFailed("create-failed", readyPoll, polled, undefined, attemptArgs);
							}
							const rows = parseRows(polled, attemptArgs);
							const row = providerCallback("readiness selector", () => ready.select(rows, name));
							if (row === null) return null;
							const classified: unknown = providerCallback("readiness classifier", () =>
								ready.classify(row),
							);
							const status = normalizeCliReadinessStatus(provider, classified, (detail) =>
								redactKnownDiagnostic(detail, attemptArgs),
							);
							if (status === "ready") return row;
							if (status === "pending") return null;
							const detail = status.terminal;
							throw new DriverError(
								"create-failed",
								`${provider} sandbox entered a terminal state: ${detail}`,
								{ provider, vendorMessage: detail },
							);
						},
					});
				} catch (caught) {
					// pollUntilReady owns the request deadline, but the CLI runner owns subprocess
					// termination. Never begin failed-create reconciliation until an active poll has
					// honored cancellation/timeout and reaped its child.
					const drainingPoll = activePoll;
					if (drainingPoll !== undefined) {
						await drainingPoll.then(
							() => undefined,
							() => undefined,
						);
					}
					if (isDriverError(caught) && caught.code === "readiness-timeout") {
						throw createDeadlineError(deadlineMs);
					}
					throw caught;
				}
				return {
					handle: row,
					sandboxRef: sandboxRef(provider, sandboxIdOf(row, attemptArgs)),
				};
			} catch (primary) {
				// A CLI can submit the allocation and still exit nonzero during a client-side
				// post-check. Reconcile by the generated name after every failed create outcome;
				// not-found tolerance makes this safe when nothing was allocated.
				// An immediate not-found is ambiguous here: the create may have been remotely accepted but
				// not reached the name index yet. Keep the generated name owned and retryable instead of
				// treating transient absence as proof that no billable allocation exists.
				let firstMissingAt: number | undefined;
				type CleanupObservation =
					| { readonly status: "destroyed" }
					| {
							readonly status: "absent";
							readonly result: CliRunResult;
							readonly args: CliArgv;
							readonly diagnosticArgs: readonly (readonly string[])[];
					  };
				const observeCleanup = async (
					timeoutMs: number,
					signal?: AbortSignal,
				): Promise<CleanupObservation> => {
					const observationDeadline = performance.now() + timeoutMs;
					const remainingObservation = (): number =>
						Math.max(0, observationDeadline - performance.now());
					if (cleanupCreated.kind === "command") {
						if (cleanupArgs === undefined) {
							throw new DriverError(
								"vendor-contract-violation",
								`${provider} CLI cleanup command was not preflighted`,
								{ provider },
							);
						}
						const outcome = await destroyByArgs(cleanupArgs, {
							timeoutMs: remainingObservation(),
							diagnosticArgs: attemptArgs,
							signal,
						});
						return outcome.status === "destroyed"
							? outcome
							: {
									status: "absent",
									result: outcome.result,
									args: cleanupArgs,
									diagnosticArgs: attemptArgs,
								};
					}

					let listed: CliRunResult;
					try {
						listed = await call(readyPoll, remainingObservation(), signal);
					} catch (caught) {
						throw runnerFailed("destroy-failed", readyPoll, caught, undefined, attemptArgs);
					}
					if (listed.code !== 0) {
						throw vendorFailed("destroy-failed", readyPoll, listed, undefined, attemptArgs);
					}
					const rows = parseRows(listed, attemptArgs);
					const row = providerCallback("failed-create lookup selector", () =>
						cleanupCreated.kind === "lookup" ? cleanupCreated.select(rows, name) : null,
					);
					if (row === null) {
						return {
							status: "absent",
							result: listed,
							args: readyPoll,
							diagnosticArgs: attemptArgs,
						};
					}
					// A positive name lookup contradicts every older absence observation. If the
					// following id-addressed delete reports not-found, it starts a fresh horizon.
					firstMissingAt = undefined;

					const id = sandboxIdOf(row, attemptArgs);
					const destroyArgs = normalizeCliArgv(
						provider,
						"destroy argv builder",
						providerCallback("destroy argv builder", () => destroyArgv(id)),
					);
					const destroyBudget = remainingObservation();
					if (destroyBudget < 1) {
						throw new DriverError(
							"destroy-failed",
							`${provider} failed-create lookup spent its cleanup attempt budget`,
							{ provider },
						);
					}
					const destroyDiagnosticArgs = [...attemptArgs, destroyArgs];
					const destroyed = await destroyByArgs(destroyArgs, {
						timeoutMs: destroyBudget,
						diagnosticArgs: destroyDiagnosticArgs,
						signal,
					});
					return destroyed.status === "destroyed"
						? destroyed
						: {
								status: "absent",
								result: destroyed.result,
								args: destroyArgs,
								diagnosticArgs: destroyDiagnosticArgs,
							};
				};
				const retryCleanup = async (
					timeoutMs = commandTimeoutMs,
					signal?: AbortSignal,
				): Promise<void> => {
					if (signal?.aborted) throw new CliRunAbortedError(signal.reason);
					const attemptDeadline = performance.now() + timeoutMs;
					const remainingAttempt = (): number => Math.max(0, attemptDeadline - performance.now());
					const initialBudget = remainingAttempt();
					if (initialBudget < 1) {
						throw new DriverError(
							"destroy-failed",
							`${provider} failed-create cleanup attempt budget was exhausted`,
							{ provider },
						);
					}
					let outcome = await observeCleanup(initialBudget, signal);
					if (outcome.status === "destroyed") return;

					const observedAt = performance.now();
					if (
						firstMissingAt !== undefined &&
						observedAt - firstMissingAt >= cleanupCreated.absenceConfirmationMs
					) {
						return;
					}
					firstMissingAt ??= observedAt;

					// The first absence can be an indexing race after remote acceptance. Re-observe
					// only after the provider-declared convergence horizon; if this attempt cannot
					// afford that wait, retain ownership for the process-level cleanup owner.
					const confirmationAt = firstMissingAt + cleanupCreated.absenceConfirmationMs;
					const waitMs = Math.max(0, confirmationAt - performance.now());
					const waitDurationMs = Math.ceil(waitMs);
					if (remainingAttempt() <= waitDurationMs) {
						throw vendorFailed(
							"destroy-failed",
							outcome.args,
							outcome.result,
							undefined,
							outcome.diagnosticArgs,
						);
					}
					if (waitDurationMs > 0) await abortableDelay(waitDurationMs, signal);

					const confirmationBudget = remainingAttempt();
					if (confirmationBudget < 1) {
						throw vendorFailed(
							"destroy-failed",
							outcome.args,
							outcome.result,
							undefined,
							outcome.diagnosticArgs,
						);
					}
					outcome = await observeCleanup(confirmationBudget, signal);
					if (outcome.status === "destroyed") return;
					if (performance.now() - firstMissingAt >= cleanupCreated.absenceConfirmationMs) return;
					throw vendorFailed(
						"destroy-failed",
						outcome.args,
						outcome.result,
						undefined,
						outcome.diagnosticArgs,
					);
				};
				let cleanupError: unknown;
				const cleanupBudget = remaining();
				if (signal?.aborted) {
					cleanupError = new DriverError(
						"destroy-failed",
						`${provider} failed-create cleanup was handed to the process owner after cancellation`,
						{ provider },
					);
				} else if (cleanupBudget < 1) {
					cleanupError = new DriverError(
						"destroy-failed",
						`${provider} failed-create cleanup was deferred because the request deadline was exhausted`,
						{ provider },
					);
				} else {
					try {
						await retryCleanup(Math.min(cleanupBudget, commandTimeoutMs), signal);
					} catch (caught) {
						cleanupError = caught;
					}
				}
				if (cleanupError !== undefined) {
					throw new FailedCreateCleanupError(cleanupError, primary, {
						provider,
						locator: { kind: "name", value: name },
						cleanup: (cleanupOptions: DriverOperationOptions = {}) =>
							retryCleanup(commandTimeoutMs, cleanupOptions.signal),
					});
				}
				// Reconciliation above proved the generated name is gone, so the module may now classify
				// the refusal. Same boundary as every other spec-owned callback on this lane; a throwing
				// classifier leaves the create terminal rather than failing it a second way.
				if (isDriverError(primary) && primary.code === "create-failed") {
					try {
						const retryable = providerCallback("retryable-create classifier", () =>
							isRetryableCreate?.(primary),
						);
						if (retryable === true) markRetryableDriverCreate(primary);
					} catch {
						// The boundary already redacted the classifier's own failure; the create failure
						// below is the one the caller needs.
					}
				}
				throw primary;
			}
		},
		async exec(_ctx, row, command, execOptions): Promise<ExecResult> {
			const started = Date.now();
			const id = sandboxIdOf(row);
			const args = normalizeCliArgv(
				provider,
				"exec argv builder",
				providerCallback("exec argv builder", () => execArgv(id, command)),
			);
			let result: CliRunResult;
			try {
				result = await call(args, commandTimeoutMs, execOptions?.signal);
			} catch (caught) {
				throw runnerFailed("exec-failed", args, caught);
			}
			return {
				exit: { kind: "exited", code: result.code },
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: Date.now() - started,
				truncated: false, // the kit applies caps centrally (table.ts / output.ts)
			};
		},
		destroy: async (_ctx, row, operationOptions) => {
			const id = sandboxIdOf(row);
			const args = normalizeCliArgv(
				provider,
				"destroy argv builder",
				providerCallback("destroy argv builder", () => destroyArgv(id)),
			);
			await destroyByArgs(args, {
				signal: operationOptions?.signal,
			});
		},
		// CLI vendors get bare-ref reaping for free: the destroy argv only needs the id, and
		// notFound tolerance already makes it idempotent.
		destroyById: async (_ctx, ref, operationOptions) => {
			const id = sandboxIdFromRef(ref);
			const args = normalizeCliArgv(
				provider,
				"destroy argv builder",
				providerCallback("destroy argv builder", () => destroyArgv(id), ref),
				ref,
			);
			await destroyByArgs(args, {
				ref,
				signal: operationOptions?.signal,
			});
		},
		probes: {
			observe: async (_ctx, ref) => {
				const expectedId = sandboxIdFromRef(ref);
				let result: CliRunResult;
				try {
					result = await call(readyPoll);
				} catch (caught) {
					throw runnerFailed("probe-failed", readyPoll, caught, ref);
				}
				if (result.code !== 0) {
					throw vendorFailed("probe-failed", readyPoll, result, ref);
				}
				const rows = parseRows(result, [readyPoll]);
				const row = rows.find(
					(candidate) => sandboxIdOf(candidate, [readyPoll], ref) === expectedId,
				);
				if (row === undefined) return { state: "absent" as const };
				const classified: unknown = providerCallback(
					"readiness classifier",
					() => ready.classify(row),
					ref,
				);
				const status = normalizeCliReadinessStatus(
					provider,
					classified,
					(detail) => redactKnownDiagnostic(detail, [readyPoll]),
					ref,
				);
				return status === "ready" || status === "pending"
					? { state: "running" as const }
					: { state: "terminal" as const };
			},
		},
		// No files, no launch: absent, not stubbed — the harness fallbacks (shell.ts) cover both.
	};
}

function cliDriver<Row>(
	provider: ProviderId,
	spec: CliSpec<Row>,
	options: CliDriverOptions = {},
): SandboxDriver<Row> {
	return driverFromTable(cliMethodTable(provider, spec, options), async () => ({}));
}

/**
 * Define one CLI-only provider from its registry id and declarative table.
 *
 * Unlike assembling `defineDriver` and a generic driver by hand, this makes both load-bearing
 * invariants structural: the provider id has one literal source, and CLI creates always retain
 * ownership through their driver-controlled attempt ceiling.
 */
export function defineCliDriver<P extends ProviderId, Row>(
	id: P,
	module: CliDriverModuleSpec<NoInfer<P>, Row>,
): DriverModule<P, Row> {
	const normalized = invokeCliProviderCallback(id, "module normalization", () => ({
		provenance: Reflect.get(module, "provenance") as unknown,
		execution: Reflect.get(module, "execution") as unknown,
		accelerator: Reflect.get(module, "accelerator") as unknown,
		costEvidence: Reflect.get(module, "costEvidence") as unknown,
		createAttemptCeilingMs: Reflect.get(module, "createAttemptCeilingMs") as unknown,
		spec: Reflect.get(module, "spec") as unknown,
	}));
	const createAttemptCeilingMs = normalized.createAttemptCeilingMs;
	if (!Number.isSafeInteger(createAttemptCeilingMs) || (createAttemptCeilingMs as number) <= 0) {
		throw new DriverError(
			"vendor-contract-violation",
			`createAttemptCeilingMs must be a positive safe integer, received ${runtimeNumberLabel(createAttemptCeilingMs)}`,
			{ provider: id },
		);
	}
	if (typeof normalized.spec !== "function") {
		throw new DriverError("vendor-contract-violation", "CLI module spec must be callable", {
			provider: id,
		});
	}
	const specFactory = normalized.spec as CliDriverModuleSpec<NoInfer<P>, Row>["spec"];
	const ownedCreateAttemptCeilingMs = createAttemptCeilingMs as number;
	const createBudget = Object.freeze({
		owner: "driver" as const,
		attemptCeilingMs: ownedCreateAttemptCeilingMs,
	});
	return defineDriver(id, {
		provenance: normalized.provenance as DriverPolicy<P, Row>["provenance"],
		createBudget,
		// A CliSpec's ready table is consumed inside cliDriver.create. Resolving create therefore
		// proves readiness at the module boundary; there is no second policy fact for authors to
		// declare or accidentally contradict.
		readiness: { startup: "create-returns-ready" },
		execution: normalized.execution as CliDriverModuleSpec<P, Row>["execution"],
		...(normalized.accelerator === undefined
			? {}
			: { accelerator: normalized.accelerator as DriverPolicy<P, Row>["accelerator"] }),
		...(normalized.costEvidence === undefined
			? {}
			: { costEvidence: normalized.costEvidence as DriverPolicy<P, Row>["costEvidence"] }),
		driver: (context) =>
			invokeCliProviderCallback(id, "module spec factory", () =>
				cliDriver(id, specFactory(context), {
					createAttemptCeilingMs: ownedCreateAttemptCeilingMs,
				}),
			),
	});
}
