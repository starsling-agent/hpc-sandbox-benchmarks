// The ComputeSDK bridge (ADR-0007 §6): computesdk keeps all its real value — maintained vendor
// translations — as ONE driver among several. Native SDK modules reuse this structural session
// machinery through _native.ts, preserving their own native handle and typed errors.
//
// The bridge is a MethodTable, not a hand-assembled driver, so it flows through the same
// assembly layer as every other driver (table.ts) and inherits its session invariants for free:
// central output capping, the use-after-destroy guard, and artifact reconciliation. It is also
// deliberately STRUCTURAL: this private bridge declares the shape it consumes instead of importing
// computesdk itself. Two rules from ADR-0007 are load-bearing:
//
//   - `hasWorkingFilesystem` is EXPLICIT, because computesdk's UnsupportedFileSystem is a
//     truthy stub whose every method throws — the sentinel that killed a namespace step. The
//     stub is filtered here and never reaches a consumer.
//   - `native` is the WRAPPER's getInstance() value, typed by the wrapper's own vendored SDK —
//     never cast to this repo's copy of a vendor SDK. Wrappers vendor their own builds; the
//     classes are nominally different. Code that needs the repo's SDK types is code that
//     should be a native driver.

import type {
	CreateBudget,
	CreateRequest,
	DriverContext,
	DriverErrorCode,
	DriverModule,
	DriverOperationOptions,
	DriverPolicy,
	ExecOptions,
	MethodTable,
	ProviderId,
	ResolvedArtifact,
	SandboxObservation,
	SandboxRef,
	SandboxSession,
} from "@sandbox-benchmarks/driver";
import {
	DriverError,
	defineDriver,
	driverFromTable,
	FailedCreateCleanupError,
	isDriverError,
	isFailedCreateCleanupError,
	isRetryableDriverCreate,
	markRetryableDriverCreate,
	sandboxRef,
} from "@sandbox-benchmarks/driver";
import { sensitiveEnvValuesFor } from "@sandbox-benchmarks/driver/env";
import type { Out, Type } from "arktype";
import { type } from "arktype";

/** The structural slice of a computesdk provider instance this bridge consumes. */
export interface ComputeSdkLike<TSandbox extends ComputeSdkSandboxLike = ComputeSdkSandboxLike> {
	readonly sandbox: {
		create(
			options?: Record<string, unknown>,
			operationOptions?: DriverOperationOptions,
		): Promise<TSandbox>;
		list?(): Promise<unknown>;
	};
}

export interface ComputeSdkSandboxLike<TNative = unknown> {
	readonly sandboxId?: string;
	/** The wrapper's vendored native SDK instance; this becomes SandboxSession.native. */
	getInstance(): TNative;
	runCommand(
		command: string,
		options?: { readonly background?: boolean; readonly signal?: AbortSignal },
	): Promise<{ readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string }>;
	destroy(): Promise<unknown>;
	readonly filesystem?: {
		readFile(path: string): Promise<string>;
		exists(path: string): Promise<boolean>;
		writeFile(path: string, content: string): Promise<void>;
	};
}

export type ComputeSdkNativeOf<TSandbox extends ComputeSdkSandboxLike> = ReturnType<
	TSandbox["getInstance"]
>;

export type ComputeSdkSandboxOf<TCompute extends ComputeSdkLike> = Awaited<
	ReturnType<TCompute["sandbox"]["create"]>
>;

/**
 * An optional execution projection for wrappers whose universal runCommand surface omits a
 * load-bearing native option (for example E2B's root user). The callback receives the wrapper's
 * exact inferred sandbox type. Its result stays unknown until the bridge validates the external
 * command envelope, so malformed vendor values cannot be blessed by an author-side assertion.
 */
export interface ComputeSdkCommands<TCompute extends ComputeSdkLike> {
	exec(
		sandbox: ComputeSdkSandboxOf<TCompute>,
		command: string,
		options: ExecOptions | undefined,
		ref: SandboxRef,
	): Promise<unknown>;
	/** Resolves only after the provider has returned a genuine background acceptance handle. */
	launch(
		sandbox: ComputeSdkSandboxOf<TCompute>,
		command: string,
		options: ExecOptions | undefined,
		ref: SandboxRef,
	): Promise<void>;
}

export type ComputeSdkRecoveryLocator =
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "marker"; readonly key: string; readonly value: string };

export interface ComputeSdkLifecycle<TCompute extends ComputeSdkLike> {
	/**
	 * Idempotent teardown that must surface transport/auth failures instead of swallowing them.
	 * `ref` is the bridge-validated canonical identity when validation reached that boundary. When
	 * it is absent, teardown may use the retained native handle or the bridge-snapshotted recovery
	 * locator, but must never reread a raw wrapper id or wrapper-visible create options.
	 */
	destroy(
		sandbox: ComputeSdkSandboxOf<TCompute>,
		ref: SandboxRef | undefined,
		options: DriverOperationOptions,
		recoveryLocator?: ComputeSdkRecoveryLocator,
	): Promise<void>;
}

export type ComputeSdkCreateRecoveryObservation =
	| { readonly status: "destroyed" }
	| { readonly status: "absent"; readonly contradictedPriorAbsence?: boolean };

/** Reconcile a create whose remote acceptance is unknown because no wrapper handle was returned. */
export interface ComputeSdkCreateRecovery<TCompute extends ComputeSdkLike> {
	readonly absenceConfirmationMs: number;
	/** Transaction-wide ceiling, including observations that contradict an earlier absence. */
	readonly maxAttempts: number;
	/** Stable owner-visible locator derived from the already-mapped create options. */
	locator(createOptions: Readonly<Record<string, unknown>>): ComputeSdkRecoveryLocator;
	/**
	 * One bounded observation/removal attempt. The bridge owns the confirmed-absence horizon and
	 * passes the locator it snapshotted before invoking the wrapper. Cleanup must never reread the
	 * wrapper-visible create-options object after a create attempt.
	 */
	cleanup(
		compute: TCompute,
		locator: ComputeSdkRecoveryLocator,
		options: DriverOperationOptions,
	): Promise<ComputeSdkCreateRecoveryObservation>;
	/**
	 * True only when this create failure PROVES no allocation can exist — a request the control
	 * plane refused before it could allocate, such as an authentication or argument rejection.
	 * Definitive failures skip reconciliation and keep their original create-failed
	 * classification instead of being reported as a cleanup double fault. Anything unproven —
	 * transport loss, timeouts, an unrecognized error — must stay ambiguous: one redundant
	 * lookup is far cheaper than a leaked billable sandbox.
	 */
	isDefinitive?(error: unknown): boolean;
	/**
	 * True when the vendor error is a transient capacity/rate-limit refusal the harness may retry.
	 * The bridge copies that answer onto {@link DriverError.retryable}; it never regexes vendor prose.
	 *
	 * The mark also asserts that nothing remains allocated, and either proof satisfies that: the
	 * reconciliation lookup this bridge runs, or an {@link isDefinitive} rejection — which is the
	 * stronger proof, since the control plane refused before allocating. So classifying one refusal
	 * as both is not a contradiction and does not cost the retry; answer each question on its own.
	 */
	isRetryableCreate?(error: unknown): boolean;
}

type ComputeSdkSandboxIdParser = Type<string> | Type<(In: string) => Out<string>>;

/**
 * A simple provider id schema is inherently stable because its input and output are the same
 * string grammar. Providers that decode a vendor id into a different canonical form must declare
 * both boundaries: the raw wrapper parser and the grammar accepted everywhere after create.
 */
export type ComputeSdkSandboxIdSchema =
	| Type<string>
	| {
			readonly fromVendor: ComputeSdkSandboxIdParser;
			readonly canonical: Type<string>;
	  };

interface ComputeSdkSandboxIdBoundary {
	readonly fromVendor: ComputeSdkSandboxIdParser;
	readonly canonical: Type<string>;
	readonly transformed: boolean;
}

type ComputeSdkTargetAxisDisposition =
	| "mapped"
	| "unsupported"
	| "runtime-verified"
	| { readonly artifact: number }
	| { readonly capacityAtLeast: number };
type ComputeSdkOptionalAxisDisposition = "mapped" | "unsupported";

/**
 * Compile-time proof that a provider author considered every canonical request axis. TargetSpec
 * fields are listed individually, so adding (for example) a disk or accelerator field breaks every
 * mapper until the provider declares whether it maps, artifact-pins, or cannot control that axis.
 * Artifact selection and attempt deadline are kit/composition concerns, but remain explicit here
 * so adding any top-level CreateRequest field is also a compiler-forced review event.
 */
export type ComputeSdkCreateRequestCoverage = {
	readonly spec: {
		readonly [Axis in keyof CreateRequest["spec"]]-?: ComputeSdkTargetAxisDisposition;
	};
	/** Resolved once by the composition root; never reinterpreted as a wrapper timeout/lifetime. */
	readonly artifact: "context";
	/** The harness owns this attempt budget; wrappers must not confuse it with sandbox lifetime. */
	readonly deadlineMs: "harness";
	readonly gpu: {
		readonly [Axis in keyof NonNullable<CreateRequest["gpu"]>]-?: ComputeSdkOptionalAxisDisposition;
	};
} & {
	readonly [Axis in Exclude<
		keyof CreateRequest,
		"spec" | "artifact" | "deadlineMs" | "gpu"
	>]-?: ComputeSdkOptionalAxisDisposition;
};

const COMPUTE_SDK_TARGET_COVERAGE_AXES = {
	vcpus: true,
	memoryGb: true,
	diskGb: true,
} as const satisfies Record<keyof CreateRequest["spec"], true>;

const COMPUTE_SDK_GPU_COVERAGE_AXES = {
	model: true,
	count: true,
} as const satisfies Record<keyof NonNullable<CreateRequest["gpu"]>, true>;

const COMPUTE_SDK_REQUEST_COVERAGE_AXES = {
	spec: true,
	artifact: true,
	deadlineMs: true,
	gpu: true,
	env: true,
} as const satisfies Record<keyof ComputeSdkCreateRequestCoverage, true>;

export interface ComputeSdkCreateRequestMapper {
	readonly coverage: ComputeSdkCreateRequestCoverage;
	readonly map: (
		request: CreateRequest,
		unsupported: (detail: string) => never,
	) => Readonly<Record<string, unknown>>;
}

export type ComputeSdkCreatedRequestVerification =
	| { readonly status: "honored" }
	| { readonly status: "unsupported"; readonly detail: string };

export interface ComputeSdkDriverSpec<TCompute extends ComputeSdkLike> {
	/** Construct the wrapper lazily from this provider module's exact env/artifact context. */
	readonly compute: TCompute;
	/** Module-owned trust boundary for the wrapper's vendor-specific sandbox id. */
	readonly sandboxId: ComputeSdkSandboxIdSchema;
	/**
	 * Declare the disposition of every canonical request axis, then validate and translate the
	 * request into wrapper options (including the `snapshotId`/`templateId` conventions the bake
	 * path relies on). The returned options stay open because the port does not model every vendor's
	 * create surface, while `coverage` makes additions to CreateRequest a compile-time review event.
	 * Call `unsupported(detail)` for cross-field combinations this provider cannot honor.
	 *
	 * Artifact refs are resolved in DriverContext before this spec is built; provider files never
	 * read ambient process configuration or decide candidate-versus-version lanes.
	 */
	readonly createOptions: ComputeSdkCreateRequestMapper;
	/**
	 * Establish provider-required post-allocation invariants and prove request axes the create API
	 * cannot control or report up front. The bridge passes the exact native handle it extracted for
	 * the session, so preparation never rereads a mutable wrapper accessor. Throwing or returning
	 * unsupported makes the bridge tear the accepted handle down and retain cleanup on a double fault.
	 */
	readonly prepareAndVerifyCreatedRequest?: (
		sandbox: ComputeSdkSandboxOf<TCompute>,
		native: ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>,
		request: CreateRequest,
		options: DriverOperationOptions,
		ref: SandboxRef,
	) => Promise<ComputeSdkCreatedRequestVerification>;
	/**
	 * Ordinary function composition for a provider-specific command projection. Omit this when the
	 * wrapper's runCommand is truthful; provide it instead of mutating a wrapper's private method
	 * table when a native option is required.
	 */
	readonly commands?: ComputeSdkCommands<TCompute>;
	/** Truthful teardown projection for wrappers whose destroy path is lossy or over-tolerant. */
	readonly lifecycle?: ComputeSdkLifecycle<TCompute>;
	/** Optional recovery protocol for remotely ambiguous create failures without a returned handle. */
	readonly createRecovery?: ComputeSdkCreateRecovery<TCompute>;
	/**
	 * Whether the wrapper's filesystem actually works. Explicit, because the wrapper cannot be
	 * asked: UnsupportedFileSystem is truthy and throws. ADR-0008's smoke conformance verifies
	 * the answer against the live vendor.
	 */
	readonly hasWorkingFilesystem: boolean;
	/** Honest lifecycle probes supplied only when this wrapper/provider can implement them. */
	readonly probes?: {
		observe(compute: TCompute, ref: SandboxRef): Promise<SandboxObservation>;
		list?(compute: TCompute): Promise<unknown>;
		describe?(compute: TCompute, ref: SandboxRef): Promise<unknown>;
	};
	/** Honest snapshot projection; omission records an unsupported capability instead of a stub. */
	readonly snapshots?: {
		create(
			compute: TCompute,
			session: SandboxSession<ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>>,
		): Promise<{ readonly snapshotId: string }>;
		delete(compute: TCompute, snapshotId: string): Promise<void>;
	};
}

/**
 * Preserve the installed wrapper's complete type while contextually typing capability callbacks.
 * TypeScript cannot infer one object property's type and use it to type a sibling callback in the
 * same literal, so the compute value is deliberately the first argument to this tiny authoring
 * helper rather than being widened to the bridge's structural minimum.
 */
export function computeSdkSpec<TCompute extends ComputeSdkLike>(
	compute: TCompute,
	spec: Omit<ComputeSdkDriverSpec<TCompute>, "compute">,
): ComputeSdkDriverSpec<TCompute> {
	return { ...spec, compute };
}

/** One registry-joined ComputeSDK provider module. The id exists only in defineComputeSdkDriver. */
export interface ComputeSdkDriverModuleSpec<P extends ProviderId, TCompute extends ComputeSdkLike> {
	readonly provenance: DriverPolicy<
		P,
		ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
	>["provenance"];
	readonly readiness: DriverPolicy<
		P,
		ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
	>["readiness"];
	readonly execution: DriverPolicy<
		P,
		ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
	>["execution"];
	readonly accelerator?: DriverPolicy<
		P,
		ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
	>["accelerator"];
	readonly costEvidence?: DriverPolicy<
		P,
		ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
	>["costEvidence"];
	/** ComputeSDK exposes no cancellable hard ceiling, so only the harness may own this budget. */
	readonly createBudget?: Extract<CreateBudget, { readonly owner: "harness" }>;
	/** Builds the wrapper binding from exactly this provider's resolved input slice. */
	readonly spec: (context: DriverContext<P>) => ComputeSdkDriverSpec<TCompute>;
}

type BoundComputeSdkDriverSpec<TCompute extends ComputeSdkLike> = Omit<
	ComputeSdkDriverSpec<TCompute>,
	"compute"
> & {
	readonly resolvedArtifact: ResolvedArtifact;
	/** Registry-resolved provider inputs are credentials until proven otherwise. */
	readonly sensitiveValues: readonly string[];
};

/** Private brands let bridge-authored errors survive without invoking hostile `instanceof` traps. */
const computeSdkContractErrors = new WeakSet<object>();
const unsupportedComputeSdkRequests = new WeakSet<object>();

class ComputeSdkContractError extends DriverError {
	constructor(...args: ConstructorParameters<typeof DriverError>) {
		super(...args);
		computeSdkContractErrors.add(this);
	}
}

function isComputeSdkContractError(value: unknown): value is ComputeSdkContractError {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		computeSdkContractErrors.has(value)
	);
}

function sanitizedComputeSdkCallbackCause(): Error {
	return new Error("provider callback failed; original diagnostic omitted to protect credentials");
}

function providerCallbackFailure(
	provider: ProviderId,
	operation: string,
	options: {
		readonly code?: Extract<
			DriverErrorCode,
			| "vendor-contract-violation"
			| "create-failed"
			| "exec-failed"
			| "destroy-failed"
			| "probe-failed"
			| "snapshot-failed"
		>;
		readonly ref?: SandboxRef;
	} = {},
): DriverError {
	const code = options.code ?? "vendor-contract-violation";
	const ErrorType = code === "vendor-contract-violation" ? ComputeSdkContractError : DriverError;
	return new ErrorType(code, `${provider} ComputeSDK ${operation} callback failed`, {
		provider,
		...(options.ref === undefined ? {} : { ref: options.ref }),
		cause: sanitizedComputeSdkCallbackCause(),
	});
}

function invokeComputeSdkProviderCallback<T>(
	provider: ProviderId,
	operation: string,
	callback: () => T,
	options?: Parameters<typeof providerCallbackFailure>[2],
): T {
	try {
		return callback();
	} catch {
		throw providerCallbackFailure(provider, operation, options);
	}
}

async function invokeComputeSdkProviderCallbackAsync<T>(
	provider: ProviderId,
	operation: string,
	callback: () => Promise<T>,
	options?: Parameters<typeof providerCallbackFailure>[2],
): Promise<T> {
	try {
		return await callback();
	} catch {
		throw providerCallbackFailure(provider, operation, options);
	}
}

function runtimeNumberLabel(value: unknown): string {
	return typeof value === "number" ? `${value}` : "a non-number value";
}

function safeThrownMessage(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		return undefined;
	}
	try {
		const message: unknown = Reflect.get(value, "message");
		return typeof message === "string" ? message : undefined;
	} catch {
		return undefined;
	}
}

function isNonArrayObject(value: unknown): value is object {
	if (typeof value !== "object" || value === null) return false;
	try {
		return !Array.isArray(value);
	} catch {
		return false;
	}
}

function vendorContractFailure(
	provider: ProviderId,
	operation: string,
	detail: string,
	sensitiveValues: readonly string[],
	ref?: SandboxRef,
): ComputeSdkContractError {
	const redacted = redactKnownDiagnostic(detail, sensitiveValues);
	return new ComputeSdkContractError(
		"vendor-contract-violation",
		`computesdk ${operation} violated its wrapper contract: ${redacted}`,
		{
			provider,
			...(ref === undefined ? {} : { ref }),
			cause: new Error(redacted),
		},
	);
}

function wrapperFailure(
	code: Extract<
		DriverErrorCode,
		| "create-failed"
		| "exec-failed"
		| "destroy-failed"
		| "filesystem-failed"
		| "probe-failed"
		| "snapshot-failed"
	>,
	provider: ProviderId,
	operation: string,
	caught: unknown,
	ref?: SandboxRef,
	sensitiveValues: readonly string[] = [],
): DriverError | FailedCreateCleanupError {
	// A retained cleanup capability may cross this boundary only on the create channel that owns it.
	// Normalizing every other case drops the foreign/destructive callback just like it drops a
	// foreign DriverError ref below.
	if (
		isFailedCreateCleanupError(caught) &&
		code === "create-failed" &&
		caught.provider === provider
	) {
		return caught;
	}
	if (isComputeSdkContractError(caught)) return caught;
	const redact = (detail: string) => redactKnownDiagnostic(detail, sensitiveValues);
	if (isDriverError(caught)) {
		const message = redact(safeThrownMessage(caught) ?? "driver failure diagnostic omitted");
		let vendorMessage: unknown;
		let vendorExitCode: unknown;
		let vendorHttpStatus: unknown;
		try {
			vendorMessage = Reflect.get(caught, "vendorMessage");
			vendorExitCode = Reflect.get(caught, "vendorExitCode");
			vendorHttpStatus = Reflect.get(caught, "vendorHttpStatus");
		} catch {
			vendorMessage = undefined;
			vendorExitCode = undefined;
			vendorHttpStatus = undefined;
		}
		return new DriverError(code, message, {
			provider,
			...(ref ? { ref } : {}),
			...(typeof vendorMessage === "string" ? { vendorMessage: redact(vendorMessage) } : {}),
			...(typeof vendorExitCode === "number" && Number.isSafeInteger(vendorExitCode)
				? { vendorExitCode }
				: {}),
			...(typeof vendorHttpStatus === "number" && Number.isSafeInteger(vendorHttpStatus)
				? { vendorHttpStatus }
				: {}),
			...(code === "create-failed" && isRetryableDriverCreate(caught) ? { retryable: true } : {}),
			cause: new Error(message),
		});
	}
	const detail = redact(
		safeThrownMessage(caught) ?? "original diagnostic omitted to protect credentials",
	);
	return new DriverError(code, `computesdk ${operation} failed: ${detail}`, {
		provider,
		vendorMessage: detail,
		cause: new Error(detail),
		...(ref ? { ref } : {}),
	});
}

async function wrapperCapability<T>(
	code: Extract<DriverErrorCode, "filesystem-failed" | "probe-failed" | "snapshot-failed">,
	provider: ProviderId,
	operation: string,
	sensitiveValues: readonly string[],
	run: () => Promise<T>,
	ref?: SandboxRef,
): Promise<T> {
	try {
		return await run();
	} catch (caught) {
		throw wrapperFailure(code, provider, operation, caught, ref, sensitiveValues);
	}
}

function invalidComputeSdkCoverage(provider: ProviderId, detail: string): never {
	throw new DriverError(
		"vendor-contract-violation",
		`computesdk request coverage is invalid: ${detail}`,
		{ provider },
	);
}

function requireExactComputeSdkCoverageAxes(
	provider: ProviderId,
	label: string,
	coverage: Readonly<Record<string, unknown>>,
	expected: Readonly<Record<string, true>>,
): void {
	for (const axis of Object.keys(expected)) {
		if (!Object.hasOwn(coverage, axis)) {
			invalidComputeSdkCoverage(provider, `${label} is missing canonical axis ${axis}`);
		}
	}
	for (const axis of Object.keys(coverage)) {
		if (!Object.hasOwn(expected, axis)) {
			invalidComputeSdkCoverage(provider, `${label} declares unknown axis ${axis}`);
		}
	}
}

function validateComputeSdkCoverage(
	provider: ProviderId,
	coverage: ComputeSdkCreateRequestCoverage,
	hasRuntimeVerifier: boolean,
): void {
	requireExactComputeSdkCoverageAxes(
		provider,
		"request coverage",
		coverage as Readonly<Record<string, unknown>>,
		COMPUTE_SDK_REQUEST_COVERAGE_AXES,
	);
	requireExactComputeSdkCoverageAxes(
		provider,
		"target coverage",
		coverage.spec,
		COMPUTE_SDK_TARGET_COVERAGE_AXES,
	);
	requireExactComputeSdkCoverageAxes(
		provider,
		"GPU coverage",
		coverage.gpu,
		COMPUTE_SDK_GPU_COVERAGE_AXES,
	);
	if (coverage.artifact !== "context") {
		invalidComputeSdkCoverage(provider, "artifact must be owned by the resolved driver context");
	}
	if (coverage.deadlineMs !== "harness") {
		invalidComputeSdkCoverage(provider, "deadlineMs must be owned by the harness");
	}
	let needsRuntimeVerifier = false;
	for (const [axis, disposition] of Object.entries(coverage.spec)) {
		if (disposition === "mapped" || disposition === "unsupported") continue;
		if (disposition === "runtime-verified") {
			needsRuntimeVerifier = true;
			continue;
		}
		if (disposition === null || typeof disposition !== "object" || Array.isArray(disposition)) {
			invalidComputeSdkCoverage(provider, `target axis ${axis} has an unknown disposition`);
		}
		const entries = Object.entries(disposition);
		if (
			entries.length !== 1 ||
			(entries[0]?.[0] !== "artifact" && entries[0]?.[0] !== "capacityAtLeast")
		) {
			invalidComputeSdkCoverage(
				provider,
				`target axis ${axis} must declare exactly one numeric bound`,
			);
		}
		const value = entries[0]?.[1];
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			invalidComputeSdkCoverage(
				provider,
				`target axis ${axis} numeric bound must be positive and finite, received ${runtimeNumberLabel(value)}`,
			);
		}
	}
	if (needsRuntimeVerifier && !hasRuntimeVerifier) {
		invalidComputeSdkCoverage(
			provider,
			"a runtime-verified target axis requires prepareAndVerifyCreatedRequest",
		);
	}
	for (const [axis, disposition] of Object.entries(coverage.gpu)) {
		if (disposition !== "mapped" && disposition !== "unsupported") {
			invalidComputeSdkCoverage(provider, `GPU axis ${axis} has an unknown disposition`);
		}
	}
	for (const [axis, disposition] of Object.entries(coverage)) {
		if (axis === "spec" || axis === "gpu" || axis === "artifact" || axis === "deadlineMs") continue;
		if (disposition !== "mapped" && disposition !== "unsupported") {
			invalidComputeSdkCoverage(provider, `request axis ${axis} has an unknown disposition`);
		}
	}
}

async function prepareAndVerifyComputeSdkCreatedRequest<TCompute extends ComputeSdkLike>(
	provider: ProviderId,
	sandbox: ComputeSdkSandboxOf<TCompute>,
	native: ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>,
	request: CreateRequest,
	operationOptions: DriverOperationOptions | undefined,
	prepareAndVerify: NonNullable<ComputeSdkDriverSpec<TCompute>["prepareAndVerifyCreatedRequest"]>,
	sensitiveValues: readonly string[],
	ref: SandboxRef,
): Promise<void> {
	const result: unknown = await invokeComputeSdkProviderCallbackAsync(
		provider,
		"created-request preparation and verification",
		() => prepareAndVerify(sandbox, native, request, operationOptions ?? {}, ref),
		{ code: "create-failed", ref },
	);
	if (!isNonArrayObject(result)) {
		throw vendorContractFailure(
			provider,
			"created-request preparation and verification",
			"post-create hook returned a non-object result",
			sensitiveValues,
			ref,
		);
	}
	let status: unknown;
	let detail: unknown;
	try {
		status = Reflect.get(result, "status");
		detail = Reflect.get(result, "detail");
	} catch {
		throw vendorContractFailure(
			provider,
			"created-request preparation and verification",
			"post-create hook returned an unreadable result",
			sensitiveValues,
			ref,
		);
	}
	if (status === "honored" && detail === undefined) return;
	if (status === "unsupported" && typeof detail === "string" && detail.length > 0) {
		throw new DriverError(
			"invalid-create-request",
			`${provider} cannot honor the requested sandbox shape: ${redactKnownDiagnostic(detail, sensitiveValues)}`,
			{ provider, ref },
		);
	}
	throw vendorContractFailure(
		provider,
		"created-request preparation and verification",
		"post-create hook returned an invalid result",
		sensitiveValues,
		ref,
	);
}

function snapshotComputeSdkCoverage(value: unknown): ComputeSdkCreateRequestCoverage {
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
	return outer as unknown as ComputeSdkCreateRequestCoverage;
}

function normalizeComputeSdkObservation(
	provider: ProviderId,
	value: unknown,
	ref: SandboxRef,
): SandboxObservation {
	let state: unknown;
	try {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) {
			throw new Error("non-object observation");
		}
		state = Reflect.get(value, "state");
	} catch {
		throw providerCallbackFailure(provider, "probe observe result", {
			code: "probe-failed",
			ref,
		});
	}
	if (state === "running" || state === "terminal" || state === "absent") return { state };
	throw providerCallbackFailure(provider, "probe observe result", {
		code: "probe-failed",
		ref,
	});
}

function normalizeComputeSdkSnapshot(
	provider: ProviderId,
	value: unknown,
	ref: SandboxRef,
): { readonly snapshotId: string } {
	let snapshotId: unknown;
	try {
		if ((typeof value !== "object" && typeof value !== "function") || value === null) {
			throw new Error("non-object snapshot result");
		}
		snapshotId = Reflect.get(value, "snapshotId");
	} catch {
		throw providerCallbackFailure(provider, "snapshot create result", {
			code: "snapshot-failed",
			ref,
		});
	}
	if (typeof snapshotId === "string" && snapshotId.length > 0) return { snapshotId };
	throw providerCallbackFailure(provider, "snapshot create result", {
		code: "snapshot-failed",
		ref,
	});
}

/** Compile a computesdk provider instance to a method table. */
function computeSdkMethodTable<TCompute extends ComputeSdkLike>(
	provider: ProviderId,
	options: BoundComputeSdkDriverSpec<TCompute>,
): MethodTable<
	ComputeSdkSandboxOf<TCompute>,
	TCompute,
	ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
> {
	const wantsFiles = options.hasWorkingFilesystem;
	const rawProbes = options.probes;
	const probes =
		rawProbes === undefined
			? undefined
			: {
					observe: rawProbes.observe,
					list: rawProbes.list,
					describe: rawProbes.describe,
				};
	const probeList = probes?.list;
	const probeDescribe = probes?.describe;
	const rawSnapshots = options.snapshots;
	const snapshots =
		rawSnapshots === undefined
			? undefined
			: { create: rawSnapshots.create, delete: rawSnapshots.delete };
	const rawCommands = options.commands;
	const commands =
		rawCommands === undefined ? undefined : { exec: rawCommands.exec, launch: rawCommands.launch };
	const rawLifecycle = options.lifecycle;
	const lifecycle = rawLifecycle === undefined ? undefined : { destroy: rawLifecycle.destroy };
	const rawCreateRecovery = options.createRecovery;
	const createRecovery =
		rawCreateRecovery === undefined
			? undefined
			: {
					absenceConfirmationMs: rawCreateRecovery.absenceConfirmationMs,
					maxAttempts: rawCreateRecovery.maxAttempts,
					locator: rawCreateRecovery.locator,
					cleanup: rawCreateRecovery.cleanup,
					isDefinitive: rawCreateRecovery.isDefinitive,
					isRetryableCreate: rawCreateRecovery.isRetryableCreate,
				};
	const createRequestMapper: ComputeSdkCreateRequestMapper = {
		coverage: snapshotComputeSdkCoverage(options.createOptions.coverage),
		map: options.createOptions.map,
	};
	const prepareAndVerifyCreatedRequest = options.prepareAndVerifyCreatedRequest;
	const sensitiveValuesDefault = options.sensitiveValues;
	const resolvedArtifact = options.resolvedArtifact;
	validateComputeSdkCoverage(
		provider,
		createRequestMapper.coverage,
		prepareAndVerifyCreatedRequest !== undefined,
	);
	if (
		createRecovery !== undefined &&
		(!Number.isSafeInteger(createRecovery.absenceConfirmationMs) ||
			createRecovery.absenceConfirmationMs <= 0)
	) {
		throw new DriverError(
			"vendor-contract-violation",
			`computesdk createRecovery.absenceConfirmationMs must be a positive safe integer, received ${runtimeNumberLabel(createRecovery.absenceConfirmationMs)}`,
			{ provider },
		);
	}
	if (
		createRecovery !== undefined &&
		(!Number.isSafeInteger(createRecovery.maxAttempts) || createRecovery.maxAttempts < 2)
	) {
		throw new DriverError(
			"vendor-contract-violation",
			`computesdk createRecovery.maxAttempts must be a safe integer of at least 2, received ${runtimeNumberLabel(createRecovery.maxAttempts)}`,
			{ provider },
		);
	}
	const sandboxIds = sandboxIdBoundary(options.sandboxId);
	const handleSensitiveValues = new WeakMap<object, readonly string[]>();
	const handleRefIds = new WeakMap<object, string>();
	const refSensitiveValues = new Map<string, readonly string[]>();
	const sensitiveFor = (sandbox: ComputeSdkSandboxOf<TCompute>): readonly string[] =>
		handleSensitiveValues.get(sandbox) ?? sensitiveValuesDefault;
	const sensitiveForRef = (ref: SandboxRef): readonly string[] =>
		refSensitiveValues.get(ref.id) ?? sensitiveValuesDefault;
	const refFor = (sandbox: ComputeSdkSandboxOf<TCompute>): SandboxRef | undefined => {
		const id = handleRefIds.get(sandbox);
		return id === undefined ? undefined : sandboxRef(provider, id);
	};
	const destroySandbox = async (
		sandbox: ComputeSdkSandboxOf<TCompute>,
		ref: SandboxRef | undefined,
		operationOptions: DriverOperationOptions = {},
		recoveryLocator?: ComputeSdkRecoveryLocator,
	): Promise<unknown> => {
		if (lifecycle === undefined) return sandbox.destroy();
		return invokeComputeSdkProviderCallbackAsync(
			provider,
			"lifecycle destroy",
			() => lifecycle.destroy(sandbox, ref, operationOptions, recoveryLocator),
			{ code: "destroy-failed", ...(ref === undefined ? {} : { ref }) },
		);
	};
	return {
		async create(compute, request: CreateRequest, operationOptions?: DriverOperationOptions) {
			if (operationOptions?.signal?.aborted) {
				throw wrapperAborted(provider, operationOptions.signal.reason);
			}
			const sensitiveValues = sensitiveValuesDefault;
			const createOptions = mapCreateRequest(
				provider,
				createRequestMapper,
				request,
				sensitiveValues,
			);
			const recoveryLocator =
				createRecovery === undefined
					? undefined
					: readRecoveryLocator(provider, createRecovery, createOptions, sensitiveValues);
			const rejectWithRecovery = async (primary: unknown): Promise<never> => {
				if (
					isFailedCreateCleanupError(primary) ||
					createRecovery === undefined ||
					recoveryLocator === undefined
				) {
					throw primary;
				}
				const retryCleanup = (cleanupOptions?: DriverOperationOptions) =>
					reconcileAmbiguousCreate(
						provider,
						compute,
						recoveryLocator,
						createRecovery,
						cleanupOptions,
						sensitiveValues,
					);
				try {
					await retryCleanup(operationOptions);
				} catch (cleanupError) {
					throw new FailedCreateCleanupError(cleanupError, primary, {
						provider,
						locator: recoveryLocator,
						cleanup: retryCleanup,
					});
				}
				throw primary;
			};
			let created: ComputeSdkSandboxOf<TCompute>;
			try {
				created = (await compute.sandbox.create(
					createOptions,
					operationOptions,
				)) as ComputeSdkSandboxOf<TCompute>;
			} catch (caught) {
				const primary = wrapperFailure(
					"create-failed",
					provider,
					"create",
					caught,
					undefined,
					sensitiveValues,
				);
				// The retry mark asserts two things: the refusal is transient, and nothing remains
				// allocated. Reconciliation is one way to establish the second; a DEFINITIVE rejection is
				// the other and the stronger one — the control plane refused before allocating. So a
				// module that classifies a refusal as both keeps its retry here, rather than having the
				// cheaper proof of "nothing was allocated" cost it the retry. (The mark is a no-op on a
				// FailedCreateCleanupError, which is the only other thing `primary` can be.)
				if (classifiesCreateRejection(provider, createRecovery, "isRetryableCreate", caught)) {
					markRetryableDriverCreate(primary);
				}
				// A create the control plane refused outright owns nothing to reconcile. Polling for it
				// would burn the caller's budget and, when the same rejection also fails the lookup,
				// relabel a plain credential error as a cleanup double fault over a sandbox that never was.
				if (classifiesCreateRejection(provider, createRecovery, "isDefinitive", caught)) {
					throw primary;
				}
				return rejectWithRecovery(primary);
			}
			if ((typeof created !== "object" && typeof created !== "function") || created === null) {
				return rejectWithRecovery(
					new DriverError(
						"vendor-contract-violation",
						"computesdk wrapper returned a non-object sandbox handle",
						{ provider },
					),
				);
			}
			handleSensitiveValues.set(created, sensitiveValues);

			let parsedId: string | undefined;
			try {
				if (operationOptions?.signal?.aborted) {
					throw wrapperAborted(provider, operationOptions.signal.reason);
				}
				const id = readSandboxId(created, provider, sensitiveValues);
				if (typeof id !== "string" || id.length === 0) {
					throw vendorContractFailure(
						provider,
						"sandbox identity",
						"wrapper returned a sandbox without a nonempty string sandboxId",
						sensitiveValues,
					);
				}
				parsedId = parseVendorSandboxId(provider, sandboxIds, id, sensitiveValues);
				const ref = sandboxRef(provider, parsedId);
				handleRefIds.set(created, parsedId);
				refSensitiveValues.set(parsedId, sensitiveValues);
				if (wantsFiles) requireFilesystem(created, provider, sensitiveValues, ref);
				let native: ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>;
				try {
					native = created.getInstance() as ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>;
				} catch {
					throw vendorContractFailure(
						provider,
						"getInstance",
						"wrapper getInstance threw; original diagnostic omitted to protect credentials",
						sensitiveValues,
						ref,
					);
				}
				if (prepareAndVerifyCreatedRequest !== undefined) {
					await prepareAndVerifyComputeSdkCreatedRequest(
						provider,
						created,
						native,
						request,
						operationOptions,
						prepareAndVerifyCreatedRequest,
						sensitiveValues,
						ref,
					);
				}
				if (operationOptions?.signal?.aborted) {
					throw wrapperAborted(provider, operationOptions.signal.reason);
				}
				return {
					handle: created,
					native,
					sandboxRef: ref,
					artifact: resolvedArtifact,
				};
			} catch (primary) {
				const retryCleanup = async (cleanupOptions?: DriverOperationOptions) => {
					if (cleanupOptions?.signal?.aborted) {
						throw wrapperAborted(
							provider,
							cleanupOptions.signal.reason,
							"failed-create cleanup",
							"destroy-failed",
						);
					}
					try {
						if (
							parsedId === undefined &&
							createRecovery !== undefined &&
							recoveryLocator !== undefined
						) {
							// A returned handle proves that an allocation existed, but an invalid wrapper id
							// cannot identify it safely. Reconcile by the preallocated locator so an eventually
							// consistent first name miss cannot release ownership and leak the allocation.
							await reconcileAmbiguousCreate(
								provider,
								compute,
								recoveryLocator,
								createRecovery,
								cleanupOptions,
								sensitiveValues,
							);
						} else {
							await destroySandbox(
								created,
								parsedId === undefined ? undefined : sandboxRef(provider, parsedId),
								cleanupOptions,
								recoveryLocator,
							);
						}
						handleSensitiveValues.delete(created);
						handleRefIds.delete(created);
						if (parsedId !== undefined) refSensitiveValues.delete(parsedId);
					} catch (caught) {
						throw wrapperFailure(
							"destroy-failed",
							provider,
							"failed-create cleanup",
							caught,
							undefined,
							sensitiveValues,
						);
					}
				};
				try {
					await retryCleanup();
				} catch (cleanupError) {
					throw new FailedCreateCleanupError(cleanupError, primary, {
						provider,
						locator:
							parsedId === undefined
								? (recoveryLocator ?? { kind: "native-handle" })
								: { kind: "id", value: parsedId },
						cleanup: retryCleanup,
					});
				}
				throw primary;
			}
		},
		async exec(_compute, sandbox, command, execOptions) {
			const started = Date.now();
			const ref = refFor(sandbox);
			let result: NormalizedComputeSdkCommandResult;
			try {
				let rawResult: unknown;
				if (commands === undefined) {
					rawResult = await sandbox.runCommand(command, {
						background: false,
						...(execOptions?.signal === undefined ? {} : { signal: execOptions.signal }),
					});
				} else {
					if (ref === undefined) throw new Error("canonical sandbox identity is unavailable");
					rawResult = await invokeComputeSdkProviderCallbackAsync(
						provider,
						"command exec",
						() => commands.exec(sandbox, command, execOptions, ref),
						{ code: "exec-failed", ref },
					);
				}
				result = normalizeCommandResult(
					provider,
					"exec",
					rawResult,
					sensitiveFor(sandbox),
					refFor(sandbox),
				);
			} catch (caught) {
				throw wrapperFailure(
					"exec-failed",
					provider,
					"exec",
					caught,
					refFor(sandbox),
					sensitiveFor(sandbox),
				);
			}
			return {
				// No forged `?? 1`: a wrapper that withholds the exit code yields the representable
				// `unknown` arm instead of a fake failure.
				exit:
					result.exitCode === undefined
						? { kind: "unknown" as const, detail: "computesdk adapter reported no exit code" }
						: { kind: "exited" as const, code: result.exitCode },
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				durationMs: Date.now() - started,
				truncated: false, // the kit applies caps centrally (table.ts / output.ts)
			};
		},
		async destroy(_compute, sandbox, operationOptions) {
			const ref = refFor(sandbox);
			if (operationOptions?.signal?.aborted) {
				throw wrapperAborted(provider, operationOptions.signal.reason, "destroy", "destroy-failed");
			}
			try {
				await destroySandbox(sandbox, ref, operationOptions);
			} catch (caught) {
				throw wrapperFailure(
					"destroy-failed",
					provider,
					"destroy",
					caught,
					ref,
					sensitiveFor(sandbox),
				);
			}
			handleSensitiveValues.delete(sandbox);
			const refId = handleRefIds.get(sandbox);
			handleRefIds.delete(sandbox);
			if (refId !== undefined) refSensitiveValues.delete(refId);
		},
		async launch(_compute, sandbox, command, execOptions) {
			if (commands !== undefined) {
				const ref = refFor(sandbox);
				try {
					if (ref === undefined) throw new Error("canonical sandbox identity is unavailable");
					await invokeComputeSdkProviderCallbackAsync(
						provider,
						"command launch",
						() => commands.launch(sandbox, command, execOptions, ref),
						{
							code: "exec-failed",
							...(refFor(sandbox) === undefined ? {} : { ref: refFor(sandbox) }),
						},
					);
					return;
				} catch (caught) {
					throw wrapperFailure(
						"exec-failed",
						provider,
						"background launch",
						caught,
						refFor(sandbox),
						sensitiveFor(sandbox),
					);
				}
			}
			let result: NormalizedComputeSdkCommandResult;
			try {
				result = normalizeCommandResult(
					provider,
					"background launch",
					await sandbox.runCommand(command, {
						background: true,
						...(execOptions?.signal === undefined ? {} : { signal: execOptions.signal }),
					}),
					sensitiveFor(sandbox),
					refFor(sandbox),
				);
			} catch (caught) {
				throw wrapperFailure(
					"exec-failed",
					provider,
					"background launch",
					caught,
					refFor(sandbox),
					sensitiveFor(sandbox),
				);
			}
			const diagnostic =
				result.stderr?.trim() ||
				result.stdout?.trim() ||
				(result.exitCode === undefined
					? "missing exit status"
					: `exit ${result.exitCode} with no diagnostic`);
			if (result.exitCode === undefined) {
				throw new DriverError(
					"exec-failed",
					"computesdk background launch returned no acceptance status",
					{
						provider,
						vendorMessage: redactKnownDiagnostic(diagnostic, sensitiveFor(sandbox)),
					},
				);
			}
			if (result.exitCode !== 0) {
				throw new DriverError(
					"exec-failed",
					`computesdk background launch exited with code ${result.exitCode}`,
					{
						provider,
						vendorExitCode: result.exitCode,
						vendorMessage: redactKnownDiagnostic(diagnostic, sensitiveFor(sandbox)),
					},
				);
			}
		},
		// The stub never escapes: create verifies that a declared filesystem is present, and the
		// per-operation guards catch a wrapper that later withdraws the capability.
		...(wantsFiles
			? {
					files: {
						readFile: (_compute, sandbox, path) => {
							const filesystem = requireFilesystem(
								sandbox,
								provider,
								sensitiveFor(sandbox),
								refFor(sandbox),
							);
							return wrapperCapability(
								"filesystem-failed",
								provider,
								"filesystem read",
								sensitiveFor(sandbox),
								() => filesystem.readFile(path),
								refFor(sandbox),
							);
						},
						exists: (_compute, sandbox, path) => {
							const filesystem = requireFilesystem(
								sandbox,
								provider,
								sensitiveFor(sandbox),
								refFor(sandbox),
							);
							return wrapperCapability(
								"filesystem-failed",
								provider,
								"filesystem exists",
								sensitiveFor(sandbox),
								() => filesystem.exists(path),
								refFor(sandbox),
							);
						},
						writeText: (_compute, sandbox, path, text) => {
							const filesystem = requireFilesystem(
								sandbox,
								provider,
								sensitiveFor(sandbox),
								refFor(sandbox),
							);
							return wrapperCapability(
								"filesystem-failed",
								provider,
								"filesystem write",
								sensitiveFor(sandbox),
								() => filesystem.writeFile(path, text),
								refFor(sandbox),
							);
						},
					},
				}
			: {}),
		...(probes === undefined
			? {}
			: {
					probes: {
						observe: async (compute, ref) => {
							const canonical = validateRef(
								provider,
								sandboxIds.canonical,
								ref,
								sensitiveForRef(ref),
							);
							return normalizeComputeSdkObservation(
								provider,
								await invokeComputeSdkProviderCallbackAsync(
									provider,
									"probe observe",
									() => probes.observe(compute, canonical),
									{ code: "probe-failed", ref: canonical },
								),
								canonical,
							);
						},
						...(probeList === undefined
							? {}
							: {
									list: (compute: TCompute) =>
										invokeComputeSdkProviderCallbackAsync(
											provider,
											"probe list",
											() => probeList(compute),
											{ code: "probe-failed" },
										),
								}),
						...(probeDescribe === undefined
							? {}
							: {
									describe: (compute: TCompute, ref: SandboxRef) => {
										const canonical = validateRef(
											provider,
											sandboxIds.canonical,
											ref,
											sensitiveForRef(ref),
										);
										return invokeComputeSdkProviderCallbackAsync(
											provider,
											"probe describe",
											() => probeDescribe(compute, canonical),
											{ code: "probe-failed", ref: canonical },
										);
									},
								}),
					},
				}),
		...(snapshots === undefined
			? {}
			: {
					snapshots: {
						create: async (
							compute: TCompute,
							session: SandboxSession<ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>>,
						) => {
							const canonical = validateRef(
								provider,
								sandboxIds.canonical,
								session.sandboxRef,
								sensitiveForRef(session.sandboxRef),
							);
							return normalizeComputeSdkSnapshot(
								provider,
								await invokeComputeSdkProviderCallbackAsync(
									provider,
									"snapshot create",
									() => snapshots.create(compute, { ...session, sandboxRef: canonical }),
									{ code: "snapshot-failed", ref: canonical },
								),
								canonical,
							);
						},
						delete: (compute: TCompute, snapshotId: string) =>
							invokeComputeSdkProviderCallbackAsync(
								provider,
								"snapshot delete",
								() => snapshots.delete(compute, snapshotId),
								{ code: "snapshot-failed" },
							),
					},
				}),
	};
}

function mapCreateRequest(
	provider: ProviderId,
	mapper: ComputeSdkCreateRequestMapper,
	request: CreateRequest,
	sensitiveValues: readonly string[],
): Readonly<Record<string, unknown>> {
	const redact = (detail: string) => redactKnownDiagnostic(detail, sensitiveValues);
	let mapped: Readonly<Record<string, unknown>>;
	try {
		for (const [axis, disposition] of Object.entries(mapper.coverage.spec)) {
			const value = request.spec[axis as keyof CreateRequest["spec"]];
			if (value === undefined) continue;
			if (disposition === "unsupported") {
				throw new UnsupportedComputeSdkRequest(`target axis ${axis} is unsupported`);
			}
			if (typeof disposition === "object" && "artifact" in disposition) {
				if (value !== disposition.artifact) {
					throw new UnsupportedComputeSdkRequest(
						`target axis ${axis} must equal the artifact-pinned value ${disposition.artifact}`,
					);
				}
			}
			if (typeof disposition === "object" && "capacityAtLeast" in disposition) {
				if (value > disposition.capacityAtLeast) {
					throw new UnsupportedComputeSdkRequest(
						`target axis ${axis} exceeds the declared capacity ${disposition.capacityAtLeast}`,
					);
				}
			}
		}
		if (request.gpu !== undefined) {
			const gpu = request.gpu as unknown as Readonly<Record<string, unknown>>;
			for (const [axis, disposition] of Object.entries(mapper.coverage.gpu)) {
				if (disposition === "unsupported" && gpu[axis] !== undefined) {
					throw new UnsupportedComputeSdkRequest(
						`GPU ${request.gpu.model} x${request.gpu.count} is unsupported (axis ${axis})`,
					);
				}
			}
		}
		const requestRecord = request as unknown as Readonly<Record<string, unknown>>;
		for (const [axis, disposition] of Object.entries(mapper.coverage)) {
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
				throw new UnsupportedComputeSdkRequest(
					axis === "env"
						? "guest environment injection is unsupported"
						: `request axis ${axis} is unsupported`,
				);
			}
		}
		mapped = mapper.map(request, (detail) => {
			throw new UnsupportedComputeSdkRequest(detail);
		});
	} catch (caught) {
		if (isUnsupportedComputeSdkRequest(caught)) {
			const detail = redact(
				safeThrownMessage(caught) ?? "provider supplied no unsupported-request detail",
			);
			throw new DriverError(
				"invalid-create-request",
				`${provider} cannot honor the requested sandbox shape: ${detail}`,
				{ provider },
			);
		}
		throw providerCallbackFailure(provider, "create-request mapper");
	}
	if (!isNonArrayObject(mapped)) {
		throw new DriverError(
			"vendor-contract-violation",
			`${provider} create-request mapper must return an options object`,
			{ provider },
		);
	}
	return mapped;
}

function readRecoveryLocator<TCompute extends ComputeSdkLike>(
	provider: ProviderId,
	recovery: ComputeSdkCreateRecovery<TCompute>,
	createOptions: Readonly<Record<string, unknown>>,
	sensitiveValues: readonly string[],
): ComputeSdkRecoveryLocator {
	const locator: unknown = invokeComputeSdkProviderCallback(
		provider,
		"failed-create recovery locator",
		() => recovery.locator(createOptions),
	);
	try {
		if ((typeof locator !== "object" && typeof locator !== "function") || locator === null) {
			throw new Error("invalid locator");
		}
		const kind: unknown = Reflect.get(locator, "kind");
		const value: unknown = Reflect.get(locator, "value");
		if (typeof value !== "string" || value.length === 0) {
			throw new Error("invalid locator");
		}
		if (locatorExposesSensitiveValue(value, sensitiveValues)) throw new Error("invalid locator");
		if (kind === "name") return Object.freeze({ kind, value });
		if (kind === "marker") {
			const key: unknown = Reflect.get(locator, "key");
			if (typeof key !== "string" || key.length === 0) throw new Error("invalid locator");
			if (locatorExposesSensitiveValue(key, sensitiveValues)) throw new Error("invalid locator");
			return Object.freeze({ kind, key, value });
		}
		throw new Error("invalid locator");
	} catch {
		throw vendorContractFailure(
			provider,
			"failed-create recovery locator",
			"recovery locator must be a readable nonempty name or keyed marker",
			sensitiveValues,
		);
	}
}

/** The two independent questions a module may answer about its own create rejection. */
type ComputeSdkCreateClassifier = "isDefinitive" | "isRetryableCreate";

const CREATE_CLASSIFIER_BOUNDARIES = {
	isDefinitive: "failed-create ambiguity classification",
	isRetryableCreate: "retryable-create classification",
} as const satisfies Record<ComputeSdkCreateClassifier, string>;

/**
 * Ask one of a module's create-rejection classifiers, treating anything but an explicit `true` as no.
 *
 * A classifier that throws, or answers with anything else, has proven nothing: for `isDefinitive`
 * that means reconciling rather than assuming nothing was billed, and for `isRetryableCreate` it
 * means leaving the failure terminal. The two are asked separately and neither answer constrains
 * the other — see {@link ComputeSdkCreateRecovery.isRetryableCreate}.
 */
function classifiesCreateRejection(
	provider: ProviderId,
	recovery: Partial<Record<ComputeSdkCreateClassifier, (error: unknown) => boolean>> | undefined,
	classifier: ComputeSdkCreateClassifier,
	caught: unknown,
): boolean {
	const classify = recovery?.[classifier];
	if (classify === undefined) return false;
	try {
		return (
			invokeComputeSdkProviderCallback(provider, CREATE_CLASSIFIER_BOUNDARIES[classifier], () =>
				classify.call(recovery, caught),
			) === true
		);
	} catch {
		return false;
	}
}

function locatorExposesSensitiveValue(
	candidate: string,
	sensitiveValues: readonly string[],
): boolean {
	return sensitiveValues.some((sensitive) => sensitive.length > 0 && candidate.includes(sensitive));
}

async function reconcileAmbiguousCreate<TCompute extends ComputeSdkLike>(
	provider: ProviderId,
	compute: TCompute,
	locator: ComputeSdkRecoveryLocator,
	recovery: ComputeSdkCreateRecovery<TCompute>,
	operationOptions: DriverOperationOptions = {},
	sensitiveValues: readonly string[],
): Promise<void> {
	let firstAbsentAt: number | undefined;
	let attempts = 0;
	while (attempts < recovery.maxAttempts) {
		attempts += 1;
		if (operationOptions.signal?.aborted) {
			throw wrapperAborted(
				provider,
				operationOptions.signal.reason,
				"failed-create reconciliation",
				"destroy-failed",
			);
		}
		let observation: ComputeSdkCreateRecoveryObservation;
		try {
			observation = normalizeRecoveryObservation(
				provider,
				await invokeComputeSdkProviderCallbackAsync(
					provider,
					"failed-create recovery cleanup",
					() => recovery.cleanup(compute, locator, operationOptions),
					{ code: "destroy-failed" },
				),
				sensitiveValues,
			);
		} catch (caught) {
			throw wrapperFailure(
				"destroy-failed",
				provider,
				"failed-create reconciliation",
				caught,
				undefined,
				sensitiveValues,
			);
		}
		if (observation.status === "destroyed") return;

		const observedAt = performance.now();
		if (observation.contradictedPriorAbsence || firstAbsentAt === undefined) {
			firstAbsentAt = observedAt;
		}
		const confirmationAt = firstAbsentAt + recovery.absenceConfirmationMs;
		if (observedAt >= confirmationAt) return;
		if (attempts >= recovery.maxAttempts) break;
		try {
			await abortableComputeSdkDelay(
				Math.ceil(confirmationAt - observedAt),
				operationOptions.signal,
			);
		} catch (caught) {
			throw wrapperAborted(provider, caught, "failed-create reconciliation", "destroy-failed");
		}
	}
	throw new DriverError(
		"destroy-failed",
		`computesdk failed-create reconciliation did not converge after ${recovery.maxAttempts} attempts`,
		{ provider },
	);
}

function normalizeRecoveryObservation(
	provider: ProviderId,
	value: unknown,
	sensitiveValues: readonly string[],
): ComputeSdkCreateRecoveryObservation {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		throw vendorContractFailure(
			provider,
			"failed-create reconciliation",
			"cleanup returned a non-object observation",
			sensitiveValues,
		);
	}
	let status: unknown;
	let contradictedPriorAbsence: unknown;
	try {
		status = Reflect.get(value, "status");
		contradictedPriorAbsence = Reflect.get(value, "contradictedPriorAbsence");
	} catch {
		throw vendorContractFailure(
			provider,
			"failed-create reconciliation",
			"cleanup returned an unreadable observation",
			sensitiveValues,
		);
	}
	if (status === "destroyed" && contradictedPriorAbsence === undefined) {
		return { status: "destroyed" };
	}
	if (status !== "absent") {
		throw vendorContractFailure(
			provider,
			"failed-create reconciliation",
			"cleanup returned an invalid observation status",
			sensitiveValues,
		);
	}
	if (contradictedPriorAbsence !== undefined && typeof contradictedPriorAbsence !== "boolean") {
		throw vendorContractFailure(
			provider,
			"failed-create reconciliation",
			"cleanup returned an invalid contradictedPriorAbsence flag",
			sensitiveValues,
		);
	}
	return {
		status: "absent",
		...(contradictedPriorAbsence === true ? { contradictedPriorAbsence: true } : {}),
	};
}

function abortableComputeSdkDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			signal?.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			reject(signal?.reason);
		}
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) aborted();
	});
}

function redactKnownDiagnostic(detail: string, sensitiveValues: readonly string[]): string {
	let redacted = detail;
	const unique = [...new Set(sensitiveValues.filter((value) => value.length > 0))].sort(
		(left, right) => right.length - left.length,
	);
	for (const value of unique) redacted = redacted.replaceAll(value, "[REDACTED]");
	return redacted;
}

class UnsupportedComputeSdkRequest extends Error {
	constructor(detail: string) {
		super(detail);
		unsupportedComputeSdkRequests.add(this);
		this.name = "UnsupportedComputeSdkRequest";
	}
}

function isUnsupportedComputeSdkRequest(value: unknown): value is UnsupportedComputeSdkRequest {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		unsupportedComputeSdkRequests.has(value)
	);
}

function sandboxIdBoundary(schema: ComputeSdkSandboxIdSchema): ComputeSdkSandboxIdBoundary {
	return typeof schema === "function"
		? { fromVendor: schema, canonical: schema, transformed: false }
		: { ...schema, transformed: true };
}

function parseSandboxId(
	provider: ProviderId,
	schema: ComputeSdkSandboxIdParser,
	value: string,
	sensitiveValues: readonly string[],
	boundary: "wrapper" | "canonical",
): string {
	const redact = (detail: string) => redactKnownDiagnostic(detail, sensitiveValues);
	const parsed: unknown = invokeComputeSdkProviderCallback(
		provider,
		`${boundary} sandbox-id validator`,
		() => schema(value),
	);
	let isErrors: boolean;
	try {
		isErrors = parsed instanceof type.errors;
	} catch {
		throw vendorContractFailure(
			provider,
			`${boundary} sandbox-id validator`,
			"validator returned an unreadable schema result",
			sensitiveValues,
		);
	}
	if (isErrors) {
		let summary: unknown;
		try {
			summary = Reflect.get(parsed as object, "summary");
		} catch {
			throw vendorContractFailure(
				provider,
				`${boundary} sandbox-id validator`,
				"validator returned unreadable schema diagnostics",
				sensitiveValues,
			);
		}
		if (typeof summary !== "string") {
			throw vendorContractFailure(
				provider,
				`${boundary} sandbox-id validator`,
				"validator returned non-string schema diagnostics",
				sensitiveValues,
			);
		}
		const detail = redact(summary);
		throw new DriverError("invalid-sandbox-ref", `${provider} sandbox id ${detail}`, {
			provider,
			cause: new Error(detail),
		});
	}
	if (typeof parsed !== "string") {
		throw new ComputeSdkContractError(
			"vendor-contract-violation",
			`${provider} ${boundary} sandbox-id validator returned a non-string canonical id`,
			{ provider },
		);
	}
	if (parsed.length === 0) {
		throw new DriverError(
			"invalid-sandbox-ref",
			`${provider} ${boundary} sandbox-id validator returned an empty canonical id`,
			{ provider },
		);
	}
	return parsed;
}

function parseVendorSandboxId(
	provider: ProviderId,
	boundary: ComputeSdkSandboxIdBoundary,
	rawId: string,
	sensitiveValues: readonly string[],
): string {
	const decoded = parseSandboxId(provider, boundary.fromVendor, rawId, sensitiveValues, "wrapper");
	return boundary.transformed
		? parseSandboxId(provider, boundary.canonical, decoded, sensitiveValues, "canonical")
		: decoded;
}

function validateRef(
	provider: ProviderId,
	schema: Type<string>,
	ref: SandboxRef,
	sensitiveValues: readonly string[],
): SandboxRef {
	if (ref.provider !== provider) {
		throw new DriverError(
			"invalid-sandbox-ref",
			`expected ${provider} sandbox ref, received ${ref.provider}`,
			{ provider },
		);
	}
	const parsed = parseSandboxId(provider, schema, ref.id, sensitiveValues, "canonical");
	return sandboxRef(provider, parsed);
}

function wrapperAborted(
	provider: ProviderId,
	reason: unknown,
	operation = "create",
	code: Extract<DriverErrorCode, "create-failed" | "destroy-failed"> = "create-failed",
): DriverError {
	return new DriverError(code, `computesdk ${operation} for ${provider} was aborted`, {
		provider,
		cause: new Error(
			reason === undefined ? "operation aborted" : "abort reason omitted to protect credentials",
		),
	});
}

interface NormalizedComputeSdkCommandResult {
	readonly exitCode?: number;
	readonly stdout: string;
	readonly stderr: string;
}

function normalizeCommandResult(
	provider: ProviderId,
	operation: string,
	result: unknown,
	sensitiveValues: readonly string[],
	ref?: SandboxRef,
): NormalizedComputeSdkCommandResult {
	if (!isNonArrayObject(result)) {
		throw vendorContractFailure(
			provider,
			operation,
			"wrapper returned a non-object command result",
			sensitiveValues,
			ref,
		);
	}
	let exitCode: unknown;
	let stdout: unknown;
	let stderr: unknown;
	try {
		exitCode = Reflect.get(result, "exitCode");
		stdout = Reflect.get(result, "stdout");
		stderr = Reflect.get(result, "stderr");
	} catch {
		throw vendorContractFailure(
			provider,
			operation,
			"wrapper returned an unreadable command result",
			sensitiveValues,
			ref,
		);
	}
	if (
		(exitCode !== undefined &&
			(typeof exitCode !== "number" ||
				!Number.isInteger(exitCode) ||
				!Number.isFinite(exitCode))) ||
		(stdout !== undefined && typeof stdout !== "string") ||
		(stderr !== undefined && typeof stderr !== "string")
	) {
		throw vendorContractFailure(
			provider,
			operation,
			"wrapper returned an invalid command-result field",
			sensitiveValues,
			ref,
		);
	}
	return {
		...(exitCode === undefined ? {} : { exitCode }),
		stdout: stdout ?? "",
		stderr: stderr ?? "",
	};
}

function readSandboxId(
	sandbox: ComputeSdkSandboxLike,
	provider: ProviderId,
	sensitiveValues: readonly string[],
): unknown {
	try {
		return (sandbox as unknown as { readonly sandboxId?: unknown }).sandboxId;
	} catch {
		throw vendorContractFailure(
			provider,
			"sandbox identity",
			"wrapper returned an unreadable sandboxId",
			sensitiveValues,
		);
	}
}

function requireFilesystem<TSandbox extends ComputeSdkSandboxLike>(
	sandbox: TSandbox,
	provider: ProviderId,
	sensitiveValues: readonly string[],
	ref?: SandboxRef,
): NonNullable<TSandbox["filesystem"]> {
	let filesystem: TSandbox["filesystem"];
	let readFile: unknown;
	let exists: unknown;
	let writeFile: unknown;
	try {
		filesystem = sandbox.filesystem;
		readFile = filesystem?.readFile;
		exists = filesystem?.exists;
		writeFile = filesystem?.writeFile;
	} catch {
		throw vendorContractFailure(
			provider,
			"filesystem accessor",
			"wrapper returned an unreadable filesystem",
			sensitiveValues,
			ref,
		);
	}
	if (
		!filesystem ||
		typeof readFile !== "function" ||
		typeof exists !== "function" ||
		typeof writeFile !== "function"
	) {
		throw vendorContractFailure(
			provider,
			"filesystem accessor",
			"wrapper declared a filesystem without every required callable method",
			sensitiveValues,
			ref,
		);
	}
	return filesystem;
}

/**
 * Define a ComputeSDK-backed provider from one registry id.
 *
 * The raw bridge is intentionally private: exposing a separate `provider` option would let a copied
 * module compile with two disagreeing ids. This joined helper is the only authoring surface.
 */
export function defineComputeSdkDriver<P extends ProviderId, TCompute extends ComputeSdkLike>(
	id: P,
	module: ComputeSdkDriverModuleSpec<NoInfer<P>, TCompute>,
): DriverModule<P, ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>> {
	const normalized = invokeComputeSdkProviderCallback(id, "module normalization", () => {
		const provenance: unknown = Reflect.get(module, "provenance");
		const readiness: unknown = Reflect.get(module, "readiness");
		const execution: unknown = Reflect.get(module, "execution");
		const accelerator: unknown = Reflect.get(module, "accelerator");
		const costEvidence: unknown = Reflect.get(module, "costEvidence");
		const rawBudget: unknown = Reflect.get(module, "createBudget");
		const spec: unknown = Reflect.get(module, "spec");
		const policy = { provenance, readiness, execution, accelerator, costEvidence };
		if (rawBudget === undefined) return { ...policy, createBudget: undefined, spec };
		if (typeof rawBudget !== "object" || rawBudget === null || Array.isArray(rawBudget)) {
			throw new Error("create budget is not an object");
		}
		const createBudget = Object.create(null) as Record<string, unknown>;
		for (const [key, value] of Object.entries(rawBudget)) {
			Object.defineProperty(createBudget, key, {
				value,
				enumerable: true,
				writable: false,
				configurable: false,
			});
		}
		Object.freeze(createBudget);
		return { ...policy, createBudget, spec };
	});
	if (typeof normalized.spec !== "function") {
		throw new DriverError("vendor-contract-violation", "ComputeSDK module spec must be callable", {
			provider: id,
		});
	}
	const specFactory = normalized.spec as ComputeSdkDriverModuleSpec<NoInfer<P>, TCompute>["spec"];
	const budgetRecord = normalized.createBudget;
	if (budgetRecord !== undefined) {
		for (const key of Object.keys(budgetRecord)) {
			if (key !== "owner" && key !== "timeoutMs") {
				throw new DriverError(
					"vendor-contract-violation",
					`ComputeSDK create budget declares unknown field ${key}`,
					{ provider: id },
				);
			}
		}
	}
	if (budgetRecord !== undefined && budgetRecord.owner !== "harness") {
		throw new DriverError(
			"vendor-contract-violation",
			"ComputeSDK create budgets must be owned by the harness",
			{ provider: id },
		);
	}
	if (
		budgetRecord !== undefined &&
		budgetRecord.timeoutMs !== undefined &&
		(!Number.isSafeInteger(budgetRecord.timeoutMs) || (budgetRecord.timeoutMs as number) <= 0)
	) {
		throw new DriverError(
			"vendor-contract-violation",
			`ComputeSDK create budget timeoutMs must be a positive safe integer, received ${runtimeNumberLabel(budgetRecord.timeoutMs)}`,
			{ provider: id },
		);
	}
	const createBudget = budgetRecord as
		| Extract<CreateBudget, { readonly owner: "harness" }>
		| undefined;
	let joined: DriverModule<P, ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>>;
	joined = defineDriver(id, {
		provenance: normalized.provenance as DriverPolicy<
			P,
			ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
		>["provenance"],
		...(createBudget === undefined ? {} : { createBudget }),
		readiness: normalized.readiness as DriverPolicy<
			P,
			ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
		>["readiness"],
		execution: normalized.execution as DriverPolicy<
			P,
			ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
		>["execution"],
		...(normalized.accelerator === undefined
			? {}
			: {
					accelerator: normalized.accelerator as DriverPolicy<
						P,
						ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
					>["accelerator"],
				}),
		...(normalized.costEvidence === undefined
			? {}
			: {
					costEvidence: normalized.costEvidence as DriverPolicy<
						P,
						ComputeSdkNativeOf<ComputeSdkSandboxOf<TCompute>>
					>["costEvidence"],
				}),
		driver: (context) => {
			const sensitiveValues = sensitiveEnvValuesFor(id, context.env);
			return invokeComputeSdkProviderCallback(id, "module spec factory", () => {
				const { compute, ...spec } = specFactory(context);
				if (
					joined.execution.durable === "native-launch" &&
					typeof spec.commands?.launch !== "function"
				) {
					throw new DriverError(
						"vendor-contract-violation",
						"native-launch execution requires a ComputeSDK launch command",
						{ provider: id },
					);
				}
				return driverFromTable(
					computeSdkMethodTable<TCompute>(id, {
						...spec,
						resolvedArtifact: context.resolvedArtifact,
						sensitiveValues,
					}),
					() => Promise.resolve(compute),
				);
			});
		},
	});
	return joined;
}

/** Bind an explicitly prepared artifact without inventing a registry artifact for custom work. */
export function driverFromComputeSpec<TCompute extends ComputeSdkLike>(
	id: ProviderId,
	binding: ComputeSdkDriverSpec<TCompute>,
	resolvedArtifact: ResolvedArtifact,
	sensitiveValues: readonly string[],
) {
	const { compute, ...spec } = binding;
	return driverFromTable(
		computeSdkMethodTable<TCompute>(id, { ...spec, resolvedArtifact, sensitiveValues }),
		() => Promise.resolve(compute),
	);
}
