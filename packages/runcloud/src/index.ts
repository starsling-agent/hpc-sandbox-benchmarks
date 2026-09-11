// run.cloud is a native SDK module. Four vendor facts shape everything below, each reproduced live:
// create returns as soon as the control plane accepts the sandbox while the OCI pull/boot continues
// asynchronously (`building_image`, exec 4409 until `running`); an overloaded create STALLS rather
// than answering 429 (matrix run 30960125032); an ambiguous create leaks a sandbox that never
// auto-pauses; and the API keeps `destroyed` tombstones in every listing. So every control-plane
// call is individually bounded, the create name is a recovery handle chosen before the request, a
// lost response is reconciled by READING (never by replaying the create), readiness is owned here,
// and nothing is ever reported as gone until the control plane has said so.

import { randomUUID } from "node:crypto";
import type { CreateSandboxOptions, Sandbox } from "@run-cloud/sdk";
import { Client, RunCloudError } from "@run-cloud/sdk";
import type { CreateRequest, DriverContext, SandboxObservation } from "@sandbox-benchmarks/driver";
import type {
	ComputeSdkCreatedRequestVerification,
	ComputeSdkCreateRequestCoverage,
} from "@sandbox-benchmarks/driver/computesdk";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import { runcloudCostEvidence } from "./cost.ts";
import { RUNCLOUD_PROVENANCE } from "./provenance.ts";

export { RUNCLOUD_PROVENANCE };

/** Poll cadence while a create sits in `building_image`/`starting`. */
export const RUNCLOUD_READY_POLL_MS = 2_000;
/** Cold pulls of the ~1.5 GiB toolchain image on a first-use host can take several minutes. */
export const RUNCLOUD_READY_TIMEOUT_MS = 20 * 60_000;
/** A destroy can fail transiently after allocation succeeded; retry it here, because the kit has no
 *  handle (and so no generic cleanup path) until create resolves. */
export const RUNCLOUD_CLEANUP_ATTEMPTS = 5;
export const RUNCLOUD_CLEANUP_RETRY_MS = 2_000;
/** Bound each REST control-plane call independently: a fetch that never settles must not suspend a
 *  deadline check or a failed-create cleanup. */
export const RUNCLOUD_CONTROL_TIMEOUT_MS = 30_000;
/** An allocation can take a moment to become visible to `list()`; an ambiguous create polls before
 *  concluding nothing was allocated. Guessing "absent" too early is what leaks a sandbox. */
export const RUNCLOUD_RECONCILE_ATTEMPTS = 5;
export const RUNCLOUD_RECONCILE_RETRY_MS = 2_000;
/**
 * The caller-owned name stamped on every create. Chosen locally BEFORE the request, so a create
 * whose response is lost still leaves an allocation the control plane can be queried for by name;
 * it also makes every benchmark sandbox identifiable to the account inventory.
 */
export const RUNCLOUD_RECOVERY_NAME_PREFIX = "sandbox-benchmarks";
/** Lifetime and idle-pause window, both above the longest suite so a detached benchmark is never
 *  paused while the harness polls its done file. */
export const RUNCLOUD_SANDBOX_LIFETIME_SECS = 3 * 60 * 60;
export const RUNCLOUD_SANDBOX_ID = type(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
/**
 * run.cloud honours the requested disk as a block-device quota and formats it; the guest's
 * filesystem then reports the device minus its own metadata (measured live: a 40 GiB request
 * exposes 39.30 GiB, 1.75 %). Verification allows that formatting overhead and nothing more — a
 * genuinely smaller allocation still fails the request.
 */
export const RUNCLOUD_DISK_FILESYSTEM_OVERHEAD = 0.03;
export const RUNCLOUD_READINESS = Object.freeze({ startup: "create-returns-ready" as const });
/** The registry declares detached polling; the SDK has no truthful background launch, so the durable
 *  route is the kit's shell detach over the same exec channel. */
export const RUNCLOUD_EXECUTION = Object.freeze({
	syncCapMs: 60_000,
	durable: "shell-detach" as const,
});

/**
 * Worst-case wall time ONE create can spend before it settles, summed over every bound this module
 * enforces on its longest path: the create POST, reconciling an ambiguous response, the readiness
 * wait, and destroying an allocation that failed readiness. Derived from the constants so tightening
 * any one tightens this in the same edit. A CEILING, not an expectation: the observed create is
 * seconds.
 *
 * The legacy adapter turned the harness's per-attempt race OFF and handed this ceiling over as the
 * attempt bound, so an in-flight cleanup was never abandoned. A ComputeSDK module can only declare a
 * harness-owned budget, so the ceiling IS that budget: every internal bound settles strictly inside
 * it, which means the harness race can only fire after this module has already finished (including
 * its cleanup) — it never abandons a teardown mid-flight — while the retry loop still knows what one
 * attempt can cost.
 */
export const RUNCLOUD_CREATE_CEILING_MS =
	RUNCLOUD_CONTROL_TIMEOUT_MS +
	RUNCLOUD_RECONCILE_ATTEMPTS * RUNCLOUD_CONTROL_TIMEOUT_MS +
	(RUNCLOUD_RECONCILE_ATTEMPTS - 1) * RUNCLOUD_RECONCILE_RETRY_MS +
	RUNCLOUD_READY_TIMEOUT_MS +
	RUNCLOUD_CONTROL_TIMEOUT_MS +
	RUNCLOUD_READY_POLL_MS +
	RUNCLOUD_CLEANUP_ATTEMPTS * (RUNCLOUD_CLEANUP_ATTEMPTS + 2) * RUNCLOUD_CONTROL_TIMEOUT_MS +
	RUNCLOUD_CLEANUP_ATTEMPTS * (RUNCLOUD_CLEANUP_ATTEMPTS - 1) * RUNCLOUD_CLEANUP_RETRY_MS +
	(RUNCLOUD_CLEANUP_ATTEMPTS - 1) * RUNCLOUD_CLEANUP_RETRY_MS;
export const RUNCLOUD_CREATE_BUDGET = Object.freeze({
	owner: "harness" as const,
	timeoutMs: RUNCLOUD_CREATE_CEILING_MS,
});

export const RUNCLOUD_REQUEST_COVERAGE = {
	spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies ComputeSdkCreateRequestCoverage;

type RuncloudCreateOptions = CreateSandboxOptions & { name: string };
const inventoryRows = type({
	id: "string >= 1",
	state: "string",
	"name?": "string | null",
}).array();

type RuncloudSandboxClient = Pick<
	Client["sandboxes"],
	"create" | "get" | "list" | "destroy" | "exec"
>;

/** Test seams; production keeps the defaults and constructs the SDK client from the registry env. */
export interface RuncloudSpecOptions {
	readonly client?: RuncloudSandboxClient;
	readonly readyPollMs?: number;
	readonly readyTimeoutMs?: number;
	readonly cleanupAttempts?: number;
	readonly cleanupRetryMs?: number;
	readonly controlPlaneTimeoutMs?: number;
	readonly reconcileAttempts?: number;
	readonly reconcileRetryMs?: number;
	readonly recoveryAbsenceConfirmationMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

interface Timing {
	readonly readyPollMs: number;
	readonly readyTimeoutMs: number;
	readonly cleanupAttempts: number;
	readonly cleanupRetryMs: number;
	readonly controlPlaneTimeoutMs: number;
	readonly reconcileAttempts: number;
	readonly reconcileRetryMs: number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
}

function timingOf(options: RuncloudSpecOptions): Timing {
	return {
		readyPollMs: options.readyPollMs ?? RUNCLOUD_READY_POLL_MS,
		readyTimeoutMs: options.readyTimeoutMs ?? RUNCLOUD_READY_TIMEOUT_MS,
		cleanupAttempts: Math.max(1, Math.floor(options.cleanupAttempts ?? RUNCLOUD_CLEANUP_ATTEMPTS)),
		cleanupRetryMs: Math.max(0, options.cleanupRetryMs ?? RUNCLOUD_CLEANUP_RETRY_MS),
		controlPlaneTimeoutMs: Math.max(
			1,
			Math.floor(options.controlPlaneTimeoutMs ?? RUNCLOUD_CONTROL_TIMEOUT_MS),
		),
		reconcileAttempts: Math.max(
			1,
			Math.floor(options.reconcileAttempts ?? RUNCLOUD_RECONCILE_ATTEMPTS),
		),
		reconcileRetryMs: Math.max(0, options.reconcileRetryMs ?? RUNCLOUD_RECONCILE_RETRY_MS),
		sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
		now: options.now ?? Date.now,
	};
}

/** A native call that did not settle within its bound. Only the CREATE call's stall is a capacity
 *  signal worth retrying (run.cloud reports saturation by not answering); a readiness or destroy
 *  stall proves nothing about the host. */
export class RuncloudCallTimeoutError extends Error {
	constructor(
		readonly operation: string,
		readonly timeoutMs: number,
	) {
		super(`run.cloud ${operation} did not settle within ${timeoutMs}ms`);
		this.name = "RuncloudCallTimeoutError";
	}
}

/**
 * Readiness ended in a terminal state. `hostGaveUp` marks the states worth re-issuing: run.cloud
 * rebuilds the image into an ext4 rootfs per sandbox and that build corrupts non-deterministically
 * under a concurrent burst (27 failed boots of run 33712242440, the same pinned image failing at a
 * different path every time), so a fresh create lands on a fresh build. `teardownConfirmed` is the
 * other half of any retry mark: the control plane has said the allocation is going away.
 */
export class RuncloudBootFailureError extends Error {
	constructor(
		readonly sandboxId: string,
		readonly state: string,
		readonly hostGaveUp: boolean,
		readonly teardownConfirmed: boolean,
	) {
		super(`run.cloud sandbox ${sandboxId} entered terminal state "${state}" while booting`);
		this.name = "RuncloudBootFailureError";
	}
}

/** The create failed ambiguously AND no reconciliation lookup ever answered, so absence was never
 *  established; the recovery name is what an operator or account sweep needs to find the sandbox. */
export class RuncloudAmbiguousCreateError extends AggregateError {
	constructor(
		readonly recoveryName: string,
		createError: unknown,
		lookupError: unknown,
	) {
		super(
			[createError, lookupError],
			`run.cloud create failed ambiguously (${errorMessage(createError)}) and every reconciliation ` +
				`lookup also failed (${errorMessage(lookupError)}), so it is unknown whether a sandbox was ` +
				`allocated; if one was it carries the name ${recoveryName} and manual cleanup may be required`,
		);
		this.name = "RuncloudAmbiguousCreateError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return error instanceof RunCloudError && error.status === 404;
}

/**
 * A non-timeout 4xx is a definitive rejection: the create endpoint itself said no allocation was
 * accepted. 409 is excluded because a conflict asserts the OPPOSITE of absence — something already
 * exists under this request's identity — so it gets the full reconciliation window.
 */
export function isRuncloudDefinitiveCreateRejection(error: unknown): boolean {
	return (
		error instanceof RunCloudError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 408 &&
		error.status !== 409
	);
}

/** Terminal boot states where the HOST gave up, so re-issuing the create is worth it. */
function hostGaveUp(state: string): boolean {
	return ["failed", "interrupted", "destroyed", "destroying"].includes(state);
}

/** `stopped` also ends the wait, but says nothing about the host giving up, so it is never retried. */
function isTerminalBootState(state: string): boolean {
	return state === "stopped" || hostGaveUp(state);
}

function isTombstone(state: string): boolean {
	return state === "destroyed" || state === "destroying";
}

/** Race one native call with a local deadline (and the caller's signal). Production's fetch signal
 *  also cancels the socket; the race remains necessary for injected clients and runtimes whose
 *  fetch ignores abort. */
async function bounded<T>(
	operation: string,
	call: () => Promise<T>,
	timing: Timing,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe = () => {};
	try {
		return await Promise.race([
			Promise.resolve().then(call),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new RuncloudCallTimeoutError(operation, timing.controlPlaneTimeoutMs)),
					timing.controlPlaneTimeoutMs,
				);
				if (signal !== undefined) {
					const abort = () => reject(signal.reason ?? new Error("run.cloud operation aborted"));
					signal.addEventListener("abort", abort, { once: true });
					unsubscribe = () => signal.removeEventListener("abort", abort);
				}
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		unsubscribe();
	}
}

function createdAt(value: string | undefined): number {
	if (!value) return 0;
	const parsed = new Date(value).getTime();
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** Poll until the sandbox can accept execs; returns the freshest record, never the stale create
 *  response. A terminal state throws the internal boot verdict for the create path to classify. */
class BootTerminalState extends Error {
	constructor(
		readonly sandboxId: string,
		readonly state: string,
	) {
		super(`run.cloud sandbox ${sandboxId} entered terminal state "${state}" while booting`);
	}
}

async function waitUntilRunning(
	sdk: RuncloudSandboxClient,
	sandboxId: string,
	timing: Timing,
	signal?: AbortSignal,
): Promise<Sandbox> {
	const deadline = timing.now() + timing.readyTimeoutMs;
	let last: Sandbox | undefined;
	while (timing.now() < deadline) {
		last = await bounded(
			`readiness get for sandbox ${sandboxId}`,
			() => sdk.get(sandboxId),
			timing,
			signal,
		);
		if (last.state === "running") return last;
		if (isTerminalBootState(last.state)) throw new BootTerminalState(sandboxId, last.state);
		await timing.sleep(timing.readyPollMs);
		signal?.throwIfAborted();
	}
	throw new Error(
		`run.cloud sandbox ${sandboxId} not running after ${timing.readyTimeoutMs}ms (last state: ${last?.state ?? "unknown"})`,
	);
}

async function destroySandbox(
	sdk: RuncloudSandboxClient,
	sandboxId: string,
	timing: Timing,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await bounded(`destroy sandbox ${sandboxId}`, () => sdk.destroy(sandboxId), timing, signal);
	} catch (error) {
		if (isNotFound(error)) return;
		throw error;
	}
	for (let attempt = 0; attempt < timing.cleanupAttempts; attempt++) {
		try {
			const current = await bounded(
				`observe destroy ${sandboxId}`,
				() => sdk.get(sandboxId),
				timing,
				signal,
			);
			if (runcloudObservation(current.state).state !== "running") return;
		} catch (error) {
			if (isNotFound(error)) return;
			throw error;
		}
		if (attempt + 1 < timing.cleanupAttempts) await timing.sleep(timing.cleanupRetryMs);
	}
	throw new Error(`run.cloud sandbox ${sandboxId} is still running after destroy`);
}

/**
 * Has the control plane confirmed this sandbox is gone, or committed to removing it? `destroying`
 * counts: the control plane owns the teardown from there. A read that cannot answer returns false;
 * the caller then does NOT claim the allocation is released.
 */
async function teardownConfirmed(
	sdk: RuncloudSandboxClient,
	sandboxId: string,
	timing: Timing,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const current = await bounded(
			`confirm teardown for sandbox ${sandboxId}`,
			() => sdk.get(sandboxId),
			timing,
			signal,
		);
		return isTombstone(current.state);
	} catch (error) {
		return isNotFound(error);
	}
}

/** Tear down an allocation whose readiness wait failed. A rejected destroy is ambiguous (the request
 *  may have landed before the response was lost), so confirm through get() before retrying. */
async function cleanupFailedCreate(
	sdk: RuncloudSandboxClient,
	sandboxId: string,
	timing: Timing,
	signal?: AbortSignal,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= timing.cleanupAttempts; attempt++) {
		try {
			await destroySandbox(sdk, sandboxId, timing, signal);
			return;
		} catch (error) {
			lastError = error;
			if (await teardownConfirmed(sdk, sandboxId, timing, signal)) return;
			if (attempt < timing.cleanupAttempts) await timing.sleep(timing.cleanupRetryMs);
		}
	}
	throw lastError;
}

/** One exact-name lookup: never a prefix/fuzzy match, never a tombstone. */
async function liveSandboxesNamed(
	sdk: RuncloudSandboxClient,
	name: string,
	timing: Timing,
	signal?: AbortSignal,
): Promise<Sandbox[]> {
	const rows = await bounded(`reconcile create ${name}`, () => sdk.list({ name }), timing, signal);
	if (!Array.isArray(rows)) throw new Error("run.cloud list returned a non-array result");
	return rows
		.filter((sandbox) => sandbox.name === name && !isTombstone(sandbox.state))
		.sort((a, b) => createdAt(a.createdAt) - createdAt(b.createdAt));
}

type ReconcileOutcome =
	| { readonly status: "adopted"; readonly sandbox: Sandbox }
	| { readonly status: "absent" }
	| { readonly status: "unanswered"; readonly lastError: unknown };

/**
 * Resolve what a failed create actually DID by querying the control plane for the name stamped on
 * the request. A lookup that itself fails is not proof of absence, so it costs an attempt rather than
 * ending the search: "nothing was allocated" has to be earned by a lookup that answered. The overload
 * that makes a create ambiguous is the same overload that takes `list` down, so an unanswered window
 * is reported as such instead of collapsing into absence.
 */
async function reconcileAmbiguousCreate(
	sdk: RuncloudSandboxClient,
	name: string,
	timing: Timing,
	attempts: number,
	signal?: AbortSignal,
): Promise<ReconcileOutcome> {
	let answered = false;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const [oldest] = await liveSandboxesNamed(sdk, name, timing, signal);
			answered = true;
			// One unique name per create, so a second match means the server allocated twice; adopting
			// the oldest keeps the original from being orphaned.
			if (oldest) return { status: "adopted", sandbox: oldest };
		} catch (error) {
			lastError = error;
		}
		if (attempt < attempts) await timing.sleep(timing.reconcileRetryMs);
	}
	return answered ? { status: "absent" } : { status: "unanswered", lastError };
}

async function allocate(
	sdk: RuncloudSandboxClient,
	options: RuncloudCreateOptions,
	timing: Timing,
	signal?: AbortSignal,
): Promise<Sandbox> {
	const input = { ...options, idempotencyKey: options.name };
	let created: Sandbox;
	try {
		created = await bounded("create", () => sdk.create(input), timing, signal);
	} catch (error) {
		// Ask what the request actually did rather than assuming. A definitive 4xx says no allocation
		// was accepted, so one confirming pass is enough — but never zero, because even a rejection
		// can sit on top of a real allocation. A 409 gets the full window.
		const definitive = isRuncloudDefinitiveCreateRejection(error);
		const reconciled = await reconcileAmbiguousCreate(
			sdk,
			options.name,
			timing,
			definitive ? 1 : timing.reconcileAttempts,
			signal,
		);
		// Nothing carries this name, so nothing leaked: the original error is the whole truth. (A
		// stalled create that allocated nothing is retryable; the bridge marks it after its own lookup.)
		if (reconciled.status === "absent") throw error;
		if (reconciled.status === "unanswered") {
			// A definitive rejection supplied its own verdict; an unanswered confirming lookup does not
			// put it back in doubt. Anything else stays honestly unknown.
			if (definitive) throw error;
			throw new RuncloudAmbiguousCreateError(options.name, error, reconciled.lastError);
		}
		// The create SUCCEEDED and only its response was lost. Adopt it: destroying a healthy
		// sandbox to honour a lost HTTP response would throw away a slow cold pull for no reason.
		created = reconciled.sandbox;
	}
	// Do not return until the guest can accept commands — exec during `building_image` fails 4409.
	try {
		return await waitUntilRunning(sdk, created.id, timing, signal);
	} catch (error) {
		// Allocation already succeeded, but the kit has no handle until create resolves. Own the
		// cleanup (with transient-destroy retries) rather than leaving a billable sandbox behind.
		try {
			await cleanupFailedCreate(sdk, created.id, timing, signal);
		} catch (destroyError) {
			throw new AggregateError(
				[error, destroyError],
				`run.cloud sandbox ${created.id} failed readiness (${errorMessage(error)}) and could not ` +
					`be destroyed after retries (${errorMessage(destroyError)}); manual cleanup may be required`,
			);
		}
		if (!(error instanceof BootTerminalState)) throw error;
		// A resolved destroy is a request accepted, not a microVM removed (~800 ms vs ~4 s live). Ask
		// the control plane before letting the verdict carry the "nothing remains allocated" half.
		throw new RuncloudBootFailureError(
			created.id,
			error.state,
			hostGaveUp(error.state),
			await teardownConfirmed(sdk, created.id, timing, signal),
		);
	}
}

async function execCommand(
	sdk: RuncloudSandboxClient,
	sandboxId: string,
	command: string,
	signal?: AbortSignal,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	signal?.throwIfAborted();
	// A string command runs via `/bin/sh -c`; the signal closes the command's WebSocket on abort.
	const result = await sdk.exec(sandboxId, command, signal === undefined ? {} : { signal });
	return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Control-plane state → port observation. `destroyed` is ABSENT, not terminal: the API keeps that
 * row as a tombstone forever, and account recovery waits for absence after a destroy — reading the
 * tombstone as a live terminal allocation would block admission on every leftover it removed.
 */
export function runcloudObservation(state: string): SandboxObservation {
	if (state === "destroyed") return { state: "absent" };
	if (
		state === "destroying" ||
		state === "stopped" ||
		state === "failed" ||
		state === "interrupted"
	)
		return { state: "terminal" };
	return { state: "running" };
}

function controlPlaneFetch(timeoutMs: number): typeof fetch {
	return Object.assign(
		(...args: Parameters<typeof fetch>) =>
			fetch(args[0], { ...args[1], signal: AbortSignal.timeout(timeoutMs) }),
		{ preconnect: fetch.preconnect },
	);
}

export function runcloudSpec(
	{ env, resolvedArtifact }: DriverContext<"runcloud">,
	options: RuncloudSpecOptions = {},
) {
	const timing = timingOf(options);
	let cached: RuncloudSandboxClient | undefined;
	// Lazy: importing the fleet must never construct a vendor client or need credentials.
	const sdk = (): RuncloudSandboxClient => {
		cached ??=
			options.client ??
			new Client({
				apiKey: env.RUN_CLOUD_API_KEY,
				fetch: controlPlaneFetch(timing.controlPlaneTimeoutMs),
			}).sandboxes;
		return cached;
	};
	const compute = nativeSdkCompute(
		(createOptions: RuncloudCreateOptions, operation) =>
			allocate(sdk(), createOptions, timing, operation.signal),
		(native) => ({
			sandboxId: native.id,
			runCommand: (command, commandOptions) =>
				execCommand(sdk(), native.id, command, commandOptions?.signal),
			destroy: () => destroySandbox(sdk(), native.id, timing),
		}),
	);
	return computeSdkSpec(compute, {
		sandboxId: RUNCLOUD_SANDBOX_ID,
		createOptions: {
			coverage: RUNCLOUD_REQUEST_COVERAGE,
			map: (request, unsupported) => {
				if (request.artifact.kind !== "image" || request.artifact.ref !== resolvedArtifact.ref) {
					unsupported("the request artifact does not match the resolved run.cloud image");
				}
				return {
					name: `${RUNCLOUD_RECOVERY_NAME_PREFIX}-${randomUUID()}`,
					image: resolvedArtifact.ref,
					cpu: request.spec.vcpus,
					memory: request.spec.memoryGb * 1024,
					...(request.spec.diskGb === undefined ? {} : { disk: request.spec.diskGb }),
					idlePauseSeconds: RUNCLOUD_SANDBOX_LIFETIME_SECS,
					timeoutSeconds: RUNCLOUD_SANDBOX_LIFETIME_SECS,
				} satisfies RuncloudCreateOptions;
			},
		},
		lifecycle: {
			destroy: async (sandbox, ref, operation) =>
				destroySandbox(sdk(), ref?.id ?? sandbox.getInstance().id, timing, operation.signal),
		},
		createRecovery: {
			absenceConfirmationMs: options.recoveryAbsenceConfirmationMs ?? 2_000,
			maxAttempts: 4,
			locator: (createOptions) => ({
				kind: "name",
				value: createOptions.name,
			}),
			isDefinitive: (error) =>
				isRuncloudDefinitiveCreateRejection(error) ||
				(error instanceof RuncloudBootFailureError && error.teardownConfirmed),
			isRetryableCreate: (error) =>
				(error instanceof RuncloudCallTimeoutError && error.operation === "create") ||
				(error instanceof RunCloudError && error.status === 429) ||
				(error instanceof RuncloudBootFailureError && error.hostGaveUp && error.teardownConfirmed),
			cleanup: async (_compute, locator, operation) => {
				const matches = await liveSandboxesNamed(sdk(), locator.value, timing, operation.signal);
				if (matches.length === 0) return { status: "absent" };
				for (const match of matches) {
					await destroySandbox(sdk(), match.id, timing, operation.signal);
				}
				for (const match of matches) {
					if (!(await teardownConfirmed(sdk(), match.id, timing, operation.signal))) {
						throw new Error(
							`run.cloud sandbox ${match.id} has not confirmed teardown after create recovery`,
						);
					}
				}
				return { status: "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: async (_sandbox, native, request, operation) =>
			verifyRuncloudAllocation(sdk(), native, request, operation.signal),
		// The SDK's readFile/writeFile exist, but the harness never needed a filesystem here; the kit's
		// direct-exec fallback keeps one fewer vendor surface in the measurement path.
		hasWorkingFilesystem: false,
		probes: {
			observe: async (_compute, ref) => {
				try {
					const current = await bounded(`get sandbox ${ref.id}`, () => sdk().get(ref.id), timing);
					return runcloudObservation(current.state);
				} catch (error) {
					if (isNotFound(error)) return { state: "absent" };
					throw error;
				}
			},
			describe: (_compute, ref) =>
				bounded(`get sandbox ${ref.id}`, () => sdk().get(ref.id), timing),
			list: () => bounded("list sandboxes", () => sdk().list(), timing),
		},
		inventory: {
			list: async (_compute, operation) => {
				// No pagination exists on this API: the array is the vendor's whole answer, and only a
				// non-array (or unreadable rows) is a contract violation rather than an empty account.
				const rows = inventoryRows.assert(
					await bounded("list sandboxes", () => sdk().list(), timing, operation.signal),
				);
				const owned: string[] = [];
				let foreignCount = 0;
				for (const row of rows) {
					if (isTombstone(row.state)) continue;
					if (row.name?.startsWith(`${RUNCLOUD_RECOVERY_NAME_PREFIX}-`)) owned.push(row.id);
					else foreignCount += 1;
				}
				return { owned, foreignCount };
			},
		},
		destroyById: (_compute, ref, operation) =>
			destroySandbox(sdk(), ref.id, timing, operation.signal),
	});
}

/** The control plane reports the allocated CPU/RAM on the record; disk is a quota the guest must
 *  prove, so read it back the same way the harness's own disk gate does. */
async function verifyRuncloudAllocation(
	sdk: RuncloudSandboxClient,
	native: Sandbox,
	request: CreateRequest,
	signal?: AbortSignal,
): Promise<ComputeSdkCreatedRequestVerification> {
	if (typeof native.milliCpu === "number" && native.milliCpu < request.spec.vcpus * 1000) {
		return {
			status: "unsupported",
			detail: `requested ${request.spec.vcpus} vCPU but the allocation reports ${native.milliCpu / 1000}`,
		};
	}
	if (typeof native.memMb === "number" && native.memMb < request.spec.memoryGb * 1024) {
		return {
			status: "unsupported",
			detail: `requested ${request.spec.memoryGb} GiB but the allocation reports ${native.memMb} MiB`,
		};
	}
	if (request.spec.diskGb === undefined) return { status: "honored" };
	const result = await execCommand(sdk, native.id, "df -Pk / | awk 'NR==2 {print $2}'", signal);
	if (result.exitCode !== 0) {
		throw new Error(`run.cloud disk capacity probe exited ${result.exitCode}`);
	}
	const output = result.stdout.trim();
	if (!/^\d+$/.test(output))
		throw new Error("run.cloud disk capacity probe returned malformed output");
	const capacityGb = Number(output) / 1024 / 1024;
	if (!Number.isFinite(capacityGb) || capacityGb <= 0) {
		throw new Error("run.cloud disk capacity probe returned an invalid capacity");
	}
	return capacityGb >= request.spec.diskGb * (1 - RUNCLOUD_DISK_FILESYSTEM_OVERHEAD)
		? { status: "honored" }
		: {
				status: "unsupported",
				detail: `requested ${request.spec.diskGb} GiB but the allocation exposes ${capacityGb.toFixed(2)} GiB`,
			};
}

export default defineComputeSdkDriver("runcloud", {
	provenance: RUNCLOUD_PROVENANCE,
	readiness: RUNCLOUD_READINESS,
	execution: RUNCLOUD_EXECUTION,
	createBudget: RUNCLOUD_CREATE_BUDGET,
	costEvidence: runcloudCostEvidence,
	spec: (context) => runcloudSpec(context),
});
