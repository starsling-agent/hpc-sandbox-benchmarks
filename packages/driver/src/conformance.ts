// The driver conformance suite (ADR-0008 §3) — one suite, any driver.
//
// The port states behavioral requirements as MUSTs. This module is the thing that checks them, so
// that a claim like "destroy is convergent" is a verified property of a driver rather than a
// sentence in a document. ADR-0008 exists because two behavioral claims were wrong and the repo had
// no way to notice: namespace's hand-written `detachedPoll: false` stranded a 55-minute benchmark,
// and a truthy `UnsupportedFileSystem` stub whose every method threw killed a step after 12 polls.
//
// The inventory below is CLOSED: every row of ADR-0008 §2 appears exactly once, and a row the suite
// cannot observe reports `unverified` rather than being omitted. That distinction is load-bearing —
// §5 admits a provider to the published matrix only when every row is `pass` or `not-applicable`, so
// a silently missing row would read as green.
//
// The module supplies behavior policy and the context supplies inputs; there is deliberately no
// `declared: REGISTRY[id]` capability bag, because capability-by-presence IS the declaration.

import type { ProviderId } from "@sandbox-benchmarks/schema/provider-ids";
import type { DriverContext, DriverModule } from "./lib/define.ts";
import { DriverError, isDriverError, isFailedCreateCleanupError } from "./lib/errors.ts";
import type { ReadinessProbeResult } from "./lib/policy.ts";
import { selectExecutionRoute } from "./lib/policy.ts";
import type {
	CreateRequest,
	DriverOperationOptions,
	ExecResult,
	ResolvedArtifact,
	SandboxDriver,
	SandboxRef,
	SandboxSession,
	TargetSpec,
} from "./lib/port.ts";
import { launchDetached, readTextFile, shellQuote, writeTextFile } from "./lib/shell.ts";

export type { ExecutionRoute } from "./lib/policy.ts";
export { selectExecutionRoute } from "./lib/policy.ts";

/**
 * The closed clause inventory. Adding a behavioral claim to the port means adding an id here, which
 * is a compile error everywhere the suite enumerates clauses — the point being that a new MUST
 * cannot quietly ship without a verifier.
 */
export const CONFORMANCE_CLAUSES = [
	"core-lifecycle",
	"readiness",
	"filesystem",
	"durable-execution",
	"sync-routing",
	"artifact-identity",
	"control-plane-convergence",
	"snapshots",
	"gpu",
	"secret-diagnostics",
] as const;

export type ClauseId = (typeof CONFORMANCE_CLAUSES)[number];

/**
 * ADR-0008 §5. The four statuses are not interchangeable:
 *
 * - `not-applicable` means the contract DEFINES an absent path and the driver took it.
 * - `unverified` means nobody looked. It blocks matrix admission exactly like `fail`, because an
 *   unobserved claim and a false claim are indistinguishable to a published measurement.
 */
export type ClauseStatus = "pass" | "fail" | "not-applicable" | "unverified";

export interface ClauseResult {
	readonly clause: ClauseId;
	readonly status: ClauseStatus;
	/** Why this status, in one line — the bounded diagnostic §5 requires the report to carry. */
	readonly detail: string;
	readonly durationMs: number;
}

export interface ConformanceReport {
	readonly provider: ProviderId;
	/** `kit` runs against fakes with no credentials; `smoke` runs against a real vendor. */
	readonly tier: ConformanceTier;
	readonly clauses: readonly ClauseResult[];
	/** §5: only `pass` and `not-applicable` admit a provider to the published matrix. */
	readonly admissible: boolean;
}

export type ConformanceTier = "kit" | "smoke";

/**
 * An in-guest observation that proves which artifact actually booted.
 *
 * Without one, artifact identity is `unverified`: a driver echoing back the ref it was handed is a
 * restatement of the request, not evidence, and ADR-0007 is explicit that request fallback alone is
 * not an observation.
 */
export interface ArtifactFingerprint {
	/** Artifact this immutable expectation belongs to; it must equal the suite request. */
	readonly artifact: ResolvedArtifact;
	/** Command whose stdout identifies the booted artifact (for example a baked marker file). */
	readonly command: string;
	/** The exact value the guest must report, trimmed before comparison. */
	readonly expect: string;
}

/** Observable diagnostic surfaces for the secret-hygiene conformance row. */
export type SecretDiagnosticsEvidence =
	| { readonly kind: "no-secrets" }
	| {
			readonly kind: "observed";
			/** Actual sensitive values injected for this run; empty input cannot prove redaction. */
			readonly sensitiveValues: readonly string[];
			/** Logs, rendered argv, errors, reports, and snapshots visible to an observer. */
			readonly diagnostics: readonly string[];
			/** Kit-tier proof that the fake execution boundary received its sentinel. */
			readonly executionReceivedSecrets?: boolean;
	  };

export interface ConformanceOptions<P extends ProviderId, Handle> {
	readonly module: DriverModule<P, Handle>;
	readonly context: DriverContext<P>;
	readonly tier: ConformanceTier;
	/** Target spec for the probe sandbox. Defaults to a deliberately small box. */
	readonly spec?: TargetSpec;
	/** Create budget for each probe sandbox. */
	readonly deadlineMs?: number;
	/** Supplying this upgrades artifact identity from `unverified` to a real observation. */
	readonly fingerprint?: ArtifactFingerprint;
	/** Supplying this makes the secret-diagnostics row observable instead of permanently blocked. */
	readonly secretDiagnostics?: () => Promise<SecretDiagnosticsEvidence>;
	/** GPU axis used to exercise the accelerator row. */
	readonly gpu?: { readonly model: string; readonly count: number };
	/**
	 * The driver's cumulative provider-allocation count, if the caller can observe one.
	 *
	 * ADR-0008's GPU row requires that a driver with no accelerator strategy refuse a gpu request
	 * *before* allocating — a refusal that costs nothing. Nothing crossing the port reveals that
	 * ordering: a create that throws looks identical whether or not a sandbox was billed first. So
	 * the observation is supplied by whoever can see it (the kit tier's fake, a live tier wired to a
	 * vendor's own counter), and when nobody can, the row reports `unverified` rather than accepting
	 * the refusal on trust.
	 */
	readonly observeAllocations?: () => number;
	/**
	 * How long to wait for the durable route's done-file, and how often to look.
	 *
	 * Deliberately an option rather than a constant: the honest budget for a real vendor's detached
	 * launch and for an in-memory fake differ by orders of magnitude, and a fixed ceiling would make
	 * the kit tier pay a live-tier wait on every PR.
	 */
	readonly durableBudgetMs?: number;
	readonly durablePollIntervalMs?: number;
}

const DEFAULT_SPEC: TargetSpec = { vcpus: 2, memoryGb: 4 };
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const DONE_FILE = "/tmp/driver-conformance-done";
const PROBE_FILE = "/tmp/driver-conformance-probe";
const DEFAULT_DURABLE_POLL_INTERVAL_MS = 500;
const READINESS_POLL_INTERVAL_MS = 250;
const READINESS_ABORT_GRACE_MS = 1_000;
/** A `create-returns-ready` declaration has no polling budget of its own, but its one verification
 *  exec still needs a hard ceiling so a broken transport cannot strand conformance or a benchmark. */
export const CREATE_RETURNS_READY_PROBE_TIMEOUT_MS = 20_000;

/** Distinguishes "the attempt ran out of time" from any value a probe could legitimately return. */
const TIMED_OUT = Symbol("readiness-attempt-timed-out");

/**
 * Await `work`, giving up after `ms`.
 *
 * A probe that never settles cannot be cancelled — we can only stop waiting on it. That is the
 * point: the suite must not inherit a driver's hang, or the one component whose job is to catch a
 * driver that ignores its declared budgets would be the component unable to enforce one.
 */
async function withAttemptTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const started = performance.now();
	try {
		const settled = await Promise.race([
			work,
			new Promise<typeof TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(TIMED_OUT), ms);
			}),
		]);
		// A race can hand back the work's own result even when it settled at or after the bound, so
		// the elapsed time decides rather than which promise won. Otherwise a probe that answers
		// `ready` one tick late would be honored, and the declared bound would hold only when the
		// event loop happened to order the timer first.
		return performance.now() - started >= ms ? TIMED_OUT : settled;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
const DEFAULT_DURABLE_BUDGET_MS = 120_000;

function detail(error: unknown): string {
	if (isDriverError(error)) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

const conformanceCleanupErrors = new WeakSet<object>();

/**
 * A conformance failure whose sandbox still needs teardown.
 *
 * Returning a report would discard the only live cleanup handle. The error therefore crosses the
 * suite boundary and exposes the standard async-disposal protocol understood by the process owner.
 */
export class ConformanceCleanupError extends SuppressedError implements AsyncDisposable {
	readonly code = "conformance-cleanup-failed" as const;
	readonly provider: ProviderId;
	readonly sandboxRef: SandboxRef;
	readonly #cleanup: (options?: DriverOperationOptions) => Promise<void>;
	#inFlight: Promise<void> | undefined;
	#cleaned = false;

	constructor(
		cleanupError: unknown,
		primaryError: unknown,
		provider: ProviderId,
		session: SandboxSession,
	) {
		super(
			cleanupError,
			primaryError,
			`conformance could not clean up ${provider} sandbox ${session.sandboxRef.id}`,
		);
		this.name = "ConformanceCleanupError";
		conformanceCleanupErrors.add(this);
		this.provider = provider;
		this.sandboxRef = session.sandboxRef;
		this.#cleanup = (options) => session.destroy(options);
	}

	cleanup(options: DriverOperationOptions = {}): Promise<void> {
		if (this.#cleaned) return Promise.resolve();
		if (this.#inFlight !== undefined) return this.#inFlight;
		const attempt = this.#cleanup(options)
			.then(() => {
				this.#cleaned = true;
			})
			.finally(() => {
				this.#inFlight = undefined;
			});
		this.#inFlight = attempt;
		return attempt;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.cleanup();
	}
}

/** A timed-out create whose eventual allocation remains owned until it settles and is destroyed. */
export class ConformanceCreateTimeoutError extends DriverError implements AsyncDisposable {
	readonly #attempt: Promise<SandboxSession>;
	#disposeInFlight: Promise<void> | undefined;
	#cleaned = false;

	constructor(provider: ProviderId, timeoutMs: number, attempt: Promise<SandboxSession>) {
		super(
			"create-failed",
			`conformance create exceeded its declared ${timeoutMs}ms budget; cleanup ownership retained`,
			{ provider },
		);
		this.name = "ConformanceCreateTimeoutError";
		this.#attempt = attempt;
	}

	async cleanup(options: DriverOperationOptions = {}): Promise<void> {
		if (this.#cleaned) return;
		if (this.#disposeInFlight !== undefined) return this.#disposeInFlight;
		const cleanup = (async () => {
			let session: SandboxSession;
			try {
				session = await this.#attempt;
			} catch (error) {
				if (retainsCleanup(error)) {
					const dispose = Reflect.get(error as object, Symbol.asyncDispose) as () => Promise<void>;
					await Reflect.apply(dispose, error, []);
				}
				this.#cleaned = true;
				return;
			}
			await session.destroy(options);
			this.#cleaned = true;
		})();
		this.#disposeInFlight = cleanup.finally(() => {
			this.#disposeInFlight = undefined;
		});
		return this.#disposeInFlight;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.cleanup();
	}
}

function retainsCleanup(error: unknown): boolean {
	if (isFailedCreateCleanupError(error)) return true;
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
	if (conformanceCleanupErrors.has(error)) return true;
	try {
		return typeof Reflect.get(error, Symbol.asyncDispose) === "function";
	} catch {
		return false;
	}
}

/** Collects clause results, guaranteeing each clause is recorded exactly once. */
class ClauseRecorder {
	private readonly results = new Map<ClauseId, ClauseResult>();

	async run(clause: ClauseId, body: () => Promise<ClauseOutcome>): Promise<void> {
		const started = performance.now();
		try {
			const outcome = await body();
			this.record(clause, outcome.status, outcome.detail, started);
		} catch (error) {
			// Cleanup ownership is more important than a complete report. A process-level owner can
			// retain these errors through their standard async-disposal protocol; swallowing one into a
			// clause result would discard the only retryable handle to a billable allocation.
			if (retainsCleanup(error)) throw error;
			// A throw is always a failure of the clause under test, never of the suite: every helper
			// the clauses call reports absence as a value, so reaching here means the driver did it.
			this.record(clause, "fail", detail(error), started);
		}
	}

	status(clause: ClauseId): ClauseStatus | undefined {
		return this.results.get(clause)?.status;
	}

	record(clause: ClauseId, status: ClauseStatus, why: string, started: number): void {
		this.results.set(clause, {
			clause,
			status,
			detail: why,
			durationMs: performance.now() - started,
		});
	}

	/** Emit every clause in inventory order, defaulting anything unreached to `unverified`. */
	finish(): ClauseResult[] {
		return CONFORMANCE_CLAUSES.map(
			(clause) =>
				this.results.get(clause) ?? {
					clause,
					status: "unverified" as const,
					detail: "the suite did not reach this clause",
					durationMs: 0,
				},
		);
	}
}

interface ClauseOutcome {
	readonly status: ClauseStatus;
	readonly detail: string;
}

const pass = (why: string): ClauseOutcome => ({ status: "pass", detail: why });
const fail = (why: string): ClauseOutcome => ({ status: "fail", detail: why });
const notApplicable = (why: string): ClauseOutcome => ({ status: "not-applicable", detail: why });
const unverified = (why: string): ClauseOutcome => ({ status: "unverified", detail: why });

function artifactsEqual(left: ResolvedArtifact, right: ResolvedArtifact): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "none") return true;
	return right.kind !== "none" && left.ref === right.ref;
}

function createRequest(
	options: ConformanceOptions<ProviderId, unknown>,
	artifact: ResolvedArtifact,
): CreateRequest {
	return {
		spec: options.spec ?? DEFAULT_SPEC,
		artifact,
		deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
	};
}

async function createWithinBudget(
	module: DriverModule<ProviderId, unknown>,
	driver: SandboxDriver,
	request: CreateRequest,
): Promise<SandboxSession> {
	const declared = module.createBudget;
	const budgetMs =
		declared?.owner === "driver"
			? Math.min(request.deadlineMs, declared.attemptCeilingMs)
			: Math.min(request.deadlineMs, declared?.timeoutMs ?? request.deadlineMs);
	const control = new AbortController();
	const attempt = driver.create(request, { signal: control.signal });
	const created = await withAttemptTimeout(attempt, budgetMs);
	if (created !== TIMED_OUT) return created;
	control.abort(new Error(`conformance create exceeded ${budgetMs}ms`));
	throw new ConformanceCreateTimeoutError(module.id, budgetMs, attempt);
}

/* --------------------------------- individual clauses --------------------------------- */

/** create → exec 0 → exec 7 → split streams. Destroy is verified by its own clauses. */
async function checkCoreLifecycle(session: SandboxSession): Promise<ClauseOutcome> {
	const ok = await session.exec("sh -c 'exit 0'");
	if (ok.exit.kind !== "exited" || ok.exit.code !== 0) {
		return fail(`exit 0 reported as ${JSON.stringify(ok.exit)}`);
	}
	// The clause that catches a fabricated `?? 1`: the guest's real status must survive the port.
	const seven = await session.exec("sh -c 'exit 7'");
	if (seven.exit.kind !== "exited" || seven.exit.code !== 7) {
		return fail(`exit 7 reported as ${JSON.stringify(seven.exit)}`);
	}
	const streams = await session.exec("sh -c 'echo out; echo err 1>&2'");
	if (!streams.stdout.includes("out")) return fail("stdout did not carry its own output");
	if (!streams.stderr.includes("err")) return fail("stderr did not carry its own output");
	if (streams.stdout.includes("err")) return fail("stderr leaked into stdout");
	return pass("create, exec 0/7 and split streams behaved");
}

/**
 * Readiness is `fail` when absent because every module declares it — the question is only whether
 * the declared shape is true of the driver.
 */
export interface ReadinessVerification {
	readonly status: "pass" | "fail";
	readonly detail: string;
}

/** Caller cancellation plus a test-only override for the kit-owned one-shot verification bound. */
export interface ReadinessVerificationOptions extends DriverOperationOptions {
	readonly createReturnsReadyTimeoutMs?: number;
}

const readinessPass = (detail: string): ReadinessVerification => ({ status: "pass", detail });
const readinessFail = (detail: string): ReadinessVerification => ({ status: "fail", detail });

/** Wall-clock budget the composition root must reserve for the selected module's readiness policy. */
export function driverReadinessBudgetMs<P extends ProviderId, Handle>(
	module: DriverModule<P, Handle>,
): number {
	return module.readiness.startup === "create-returns-ready"
		? CREATE_RETURNS_READY_PROBE_TIMEOUT_MS
		: module.readiness.totalBudgetMs;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Driver readiness verification aborted");
}

/** Forward caller cancellation into an attempt-owned controller without leaking listeners. */
function forwardAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
	if (parent === undefined) return () => {};
	const abort = (): void => child.abort(abortReason(parent));
	parent.addEventListener("abort", abort, { once: true });
	if (parent.aborted) abort();
	return () => parent.removeEventListener("abort", abort);
}

async function settleCancelledReadinessAttempt(
	attempt: Promise<unknown>,
	attemptMs: number,
	detail: string,
): Promise<ReadinessVerification | undefined> {
	const settled = await withAttemptTimeout(
		attempt.then(
			() => true,
			() => true,
		),
		READINESS_ABORT_GRACE_MS,
	);
	return settled === TIMED_OUT
		? readinessFail(
				`${detail} exceeded ${attemptMs}ms and did not settle within ${READINESS_ABORT_GRACE_MS}ms after cancellation`,
			)
		: undefined;
}

/** Drive one module's declared readiness strategy without running any later lifecycle command. */
export async function verifyDriverReadiness<P extends ProviderId, Handle>(
	module: DriverModule<P, Handle>,
	session: SandboxSession<Handle>,
	options: ReadinessVerificationOptions = {},
): Promise<ReadinessVerification> {
	const readiness = module.readiness;
	if (readiness.startup === "create-returns-ready") {
		// The declaration says a resolved create is already usable, so a command must work with no
		// polling of any kind. A driver that needs a grace period fails here, which is the point. This
		// is still an accepted driver operation: bound it, cancel it, and confirm settlement before the
		// caller can begin teardown.
		const attemptMs = options.createReturnsReadyTimeoutMs ?? CREATE_RETURNS_READY_PROBE_TIMEOUT_MS;
		if (!Number.isSafeInteger(attemptMs) || attemptMs <= 0) {
			throw new Error(`create-returns-ready verification timeout must be a positive safe integer`);
		}
		const attemptControl = new AbortController();
		const stopForwarding = forwardAbort(options.signal, attemptControl);
		const attempt = Promise.resolve().then(() => {
			if (attemptControl.signal.aborted) throw abortReason(attemptControl.signal);
			return session.exec("sh -c 'exit 0'", { signal: attemptControl.signal });
		});
		let observed: ExecResult | typeof TIMED_OUT;
		try {
			observed = await withAttemptTimeout(attempt, attemptMs);
		} finally {
			stopForwarding();
		}
		if (observed === TIMED_OUT) {
			attemptControl.abort(
				new Error(`create-returns-ready verification exceeded its ${attemptMs}ms budget`),
			);
			const unsettled = await settleCancelledReadinessAttempt(
				attempt,
				attemptMs,
				"create-returns-ready verification exec",
			);
			return (
				unsettled ??
				readinessFail(`create-returns-ready verification exec exceeded its ${attemptMs}ms budget`)
			);
		}
		const probe = observed;
		return probe.exit.kind === "exited" && probe.exit.code === 0
			? readinessPass("create-returns-ready: exec succeeded with no polling")
			: readinessFail(
					`create-returns-ready but the first exec reported ${JSON.stringify(probe.exit)}`,
				);
	}
	// Both declared bounds are enforced, and neither can be enforced by the loop condition alone: an
	// unbounded `await` on a stalled probe never returns to re-test it. Each attempt is therefore
	// raced against `attemptTimeoutMs`, clamped by whatever remains of `totalBudgetMs`.
	const deadline = performance.now() + readiness.totalBudgetMs;
	let timedOutAttempts = 0;
	while (performance.now() < deadline) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		const remainingMs = deadline - performance.now();
		const attemptMs = Math.max(1, Math.min(readiness.attemptTimeoutMs, remainingMs));
		// The port gives every driver operation a cancellation channel; a suite that abandoned
		// attempts without using it would leave one stalled probe in flight per retry, and a long
		// total budget against a short per-attempt bound turns that into an unbounded pile of
		// concurrent requests aimed at the sandbox under test.
		const attemptControl = new AbortController();
		const stopForwarding = forwardAbort(options.signal, attemptControl);
		const attempt = Promise.resolve().then(() => {
			if (attemptControl.signal.aborted) throw abortReason(attemptControl.signal);
			return readiness.probe(session, { signal: attemptControl.signal });
		});
		let observed: ReadinessProbeResult | typeof TIMED_OUT;
		try {
			observed = await withAttemptTimeout(attempt, attemptMs);
		} finally {
			stopForwarding();
		}
		if (observed === TIMED_OUT) {
			// Retry only after the accepted operation has confirmed termination. Aborting a controller
			// is a request, not evidence that an exec/vendor request stopped; starting a new attempt before
			// settlement is the accumulation bug this branch exists to prevent.
			attemptControl.abort(
				new Error(`readiness attempt exceeded its declared ${attemptMs}ms budget`),
			);
			timedOutAttempts += 1;
			const unsettled = await settleCancelledReadinessAttempt(
				attempt,
				attemptMs,
				`readiness ${readiness.signal} probe`,
			);
			if (unsettled !== undefined) {
				return readinessFail(`${unsettled.detail}; refusing to overlap retries`);
			}
			await Bun.sleep(
				Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, deadline - performance.now())),
			);
			continue;
		}
		if (observed.status === "ready")
			return readinessPass(`create-then-poll reached ready via ${readiness.signal}`);
		if (observed.status === "terminal")
			return readinessFail(`readiness reported terminal: ${observed.detail}`);
		await Bun.sleep(
			Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, deadline - performance.now())),
		);
	}
	const stalled =
		timedOutAttempts === 0
			? ""
			: ` (${timedOutAttempts} attempt(s) exceeded the declared ${readiness.attemptTimeoutMs}ms per-attempt timeout)`;
	return readinessFail(
		`readiness did not reach ready within its declared ${readiness.totalBudgetMs}ms budget${stalled}`,
	);
}

/**
 * Filesystem is never skipped. A driver without `files` selects the kit's exec-based fallback, and
 * the harness leans on that fallback exactly as hard as on a native API, so both are round-tripped.
 */
async function checkFilesystem(session: SandboxSession): Promise<ClauseOutcome> {
	const payload = `conformance-${Math.trunc(performance.now())}`;
	const native = session.files !== undefined;
	await writeTextFile(session, PROBE_FILE, payload);
	const read = await readTextFile(session, PROBE_FILE);
	if (read === null) return fail(`${PROBE_FILE} was unreadable immediately after writing it`);
	if (read.trim() !== payload) return fail(`read back ${JSON.stringify(read.trim())}`);
	if (native && session.files !== undefined) {
		// A present capability must be WORKING in both directions, not merely present — the exact lie
		// the `UnsupportedFileSystem` stub told.
		if (!(await session.files.exists(PROBE_FILE))) {
			return fail("files.exists reported false for a file it had just written");
		}
		// Native read/write agreement can still hide a capability disconnected from the guest seen by
		// exec. Cross the boundary explicitly: write through exec, then read through the native API.
		const execPayload = `exec-${Math.trunc(performance.now())}`;
		const written = await session.exec(
			`sh -c ${shellQuote(`echo ${execPayload} > ${PROBE_FILE}`)}`,
		);
		if (written.exit.kind !== "exited" || written.exit.code !== 0) {
			return fail(`exec-to-native write failed: ${JSON.stringify(written.exit)}`);
		}
		const crossed = await session.files.readFile(PROBE_FILE);
		if (crossed.trim() !== execPayload) {
			return fail(
				`native files could not read the exec-written payload ${JSON.stringify(crossed)}`,
			);
		}
	}
	return pass(
		native
			? "native files round-tripped and read an exec-written file"
			: "kit exec fallback round-tripped",
	);
}

/** The declared durable route must produce observable completion, not merely accept a launch. */
async function checkDurableExecution(
	module: DriverModule<ProviderId, unknown>,
	session: SandboxSession,
	options: ConformanceOptions<ProviderId, unknown>,
): Promise<ClauseOutcome> {
	const execution = module.execution;
	if (execution.durable === "none") {
		// The union makes `{ durable: "none", syncCapMs: number }` unconstructable, so reaching here
		// means the cap is null and there is genuinely no durable boundary to cross.
		return notApplicable("module declares no durable route and no synchronous cap");
	}
	if (execution.durable === "native-launch" && session.launch === undefined) {
		return fail("module declares native-launch but the session exposes no launch member");
	}
	await session.exec(`sh -c ${shellQuote(`rm -f ${DONE_FILE}`)}`);
	await launchDetached(session, `sh -c ${shellQuote(`sleep 1; echo done > ${DONE_FILE}`)}`);
	const budgetMs = options.durableBudgetMs ?? DEFAULT_DURABLE_BUDGET_MS;
	const intervalMs = options.durablePollIntervalMs ?? DEFAULT_DURABLE_POLL_INTERVAL_MS;
	const deadline = performance.now() + budgetMs;
	while (performance.now() < deadline) {
		const observed = await readTextFile(session, DONE_FILE);
		if (observed?.includes("done") === true) {
			return pass(`${execution.durable} reached an observable done-file`);
		}
		await Bun.sleep(intervalMs);
	}
	return fail(`${execution.durable} produced no readable done-file within ${budgetMs}ms`);
}

/**
 * The router must send a step budgeted at the declared cap to the durable path.
 *
 * This is a pure check of the kit's own rule against the module's declaration; the durable
 * consequence at that boundary is proved by {@link checkDurableExecution}.
 */
function checkSyncRouting(module: DriverModule<ProviderId, unknown>): ClauseOutcome {
	const execution = module.execution;
	if (execution.syncCapMs === null) {
		return notApplicable("module declares no synchronous cap, so no boundary exists to route at");
	}
	const atBoundary = selectExecutionRoute(execution, execution.syncCapMs);
	if (atBoundary !== "durable") {
		return fail(`a step budgeted at the ${execution.syncCapMs}ms cap routed to ${atBoundary}`);
	}
	const below = selectExecutionRoute(execution, execution.syncCapMs - 1);
	if (below !== "sync") return fail(`a step below the cap routed to ${below}`);
	return pass(`router selects durable at the ${execution.syncCapMs}ms boundary`);
}

/**
 * A ref echoed back from the request is not an observation.
 *
 * The kit already tears down a session whose reported artifact contradicts the request, so a
 * surviving contradiction is a hard failure. Agreement without an in-guest fingerprint is
 * `unverified`, per ADR-0007's rule that request fallback alone is not vendor-observed.
 */
async function checkArtifactIdentity(
	session: SandboxSession,
	requested: ResolvedArtifact,
	fingerprint: ArtifactFingerprint | undefined,
): Promise<ClauseOutcome> {
	if (requested.kind === "none")
		return notApplicable("provider boots stock; no artifact to attribute");
	const effective = session.artifact;
	if (!artifactsEqual(effective, requested)) {
		return fail(
			`session reports ${JSON.stringify(effective)} for requested ${JSON.stringify(requested)}`,
		);
	}
	if (fingerprint === undefined) {
		return unverified("no guest fingerprint supplied; the reported ref restates the request");
	}
	if (!artifactsEqual(fingerprint.artifact, requested)) {
		return fail(
			`fingerprint expectation is bound to ${JSON.stringify(fingerprint.artifact)}, not requested ${JSON.stringify(requested)}`,
		);
	}
	const observed = await session.exec(fingerprint.command);
	if (observed.exit.kind !== "exited" || observed.exit.code !== 0) {
		return fail(`fingerprint command failed: ${JSON.stringify(observed.exit)}`);
	}
	return observed.stdout.trim() === fingerprint.expect
		? pass(`guest fingerprint matched ${fingerprint.expect}`)
		: fail(`guest reported ${JSON.stringify(observed.stdout.trim())}`);
}

/** Destroy twice, retain cleanup ownership on failure, then verify the convergence postcondition. */
async function checkConvergence(
	provider: ProviderId,
	driver: SandboxDriver,
	session: SandboxSession,
): Promise<ClauseOutcome> {
	let violation: string | undefined;
	try {
		await session.destroy();
	} catch (primaryError) {
		violation = `first destroy failed: ${detail(primaryError)}`;
		try {
			await session.destroy();
		} catch (cleanupError) {
			throw new ConformanceCleanupError(cleanupError, primaryError, provider, session);
		}
	}
	try {
		await session.destroy();
	} catch (error) {
		violation ??= `second destroy failed: ${detail(error)}`;
	}

	const probes = driver.probes;
	if (probes === undefined) {
		return violation === undefined
			? unverified("driver exposes no probes, so destroy convergence cannot be observed")
			: fail(`${violation}; convergence is also unobservable because the driver exposes no probes`);
	}
	const observed = await probes.observe(session.sandboxRef);
	if (observed.state === "running") {
		const primaryError = new DriverError(
			"destroy-failed",
			"destroy resolved while the control plane still reported the sandbox running",
			{ provider, ref: session.sandboxRef },
		);
		try {
			await session.destroy();
		} catch (cleanupError) {
			throw new ConformanceCleanupError(cleanupError, primaryError, provider, session);
		}
		const retried = await probes.observe(session.sandboxRef);
		if (retried.state === "running") {
			throw new ConformanceCleanupError(
				new DriverError("destroy-failed", "sandbox still running after cleanup retry", {
					provider,
					ref: session.sandboxRef,
				}),
				primaryError,
				provider,
				session,
			);
		}
		return fail(`destroy resolved before convergence; cleanup retry reached ${retried.state}`);
	}
	return violation === undefined
		? pass(`control plane reports ${observed.state} after destroy`)
		: fail(`${violation}; cleanup nevertheless converged to ${observed.state}`);
}

/** Snapshots are optional; when present they must round-trip and clean up. */
async function checkSnapshots(
	driver: SandboxDriver,
	session: SandboxSession,
): Promise<ClauseOutcome> {
	const snapshots = driver.snapshots;
	if (snapshots === undefined) return notApplicable("driver exposes no snapshot capability");
	const created = await snapshots.create(session);
	if (typeof created.snapshotId !== "string" || created.snapshotId.length === 0) {
		return fail("snapshot create returned no usable id");
	}
	try {
		await snapshots.delete(created.snapshotId);
	} catch (error) {
		return fail(`snapshot ${created.snapshotId} could not be deleted: ${detail(error)}`);
	}
	return pass(`snapshot ${created.snapshotId} created and deleted`);
}

async function checkSecretDiagnostics(
	tier: ConformanceTier,
	observe: ConformanceOptions<ProviderId, unknown>["secretDiagnostics"],
): Promise<ClauseOutcome> {
	if (observe === undefined) {
		return unverified("no diagnostic-surface observer was supplied for this tier");
	}
	const evidence = await observe();
	if (evidence.kind === "no-secrets") {
		return notApplicable("the selected provider declares no secret-sourced inputs");
	}
	const secrets = evidence.sensitiveValues.filter((value) => value.length > 0);
	if (secrets.length === 0) {
		return fail("secret diagnostics evidence contained no non-empty sensitive values");
	}
	for (const [index, diagnostic] of evidence.diagnostics.entries()) {
		if (secrets.some((secret) => diagnostic.includes(secret))) {
			return fail(`secret value leaked into diagnostic surface ${index}`);
		}
	}
	if (tier === "kit" && evidence.executionReceivedSecrets !== true) {
		return unverified(
			"kit evidence did not prove that execution received the sentinel values being redacted",
		);
	}
	return pass(
		tier === "kit"
			? "execution received sentinel secrets and every observed diagnostic surface was redacted"
			: "every live observable diagnostic surface was free of supplied secret values",
	);
}

/**
 * A GPU request must be honored or refused before allocation — never silently downgraded to CPU.
 *
 * The allocation counter is the half that matters for a refusal: a driver that creates a sandbox and
 * *then* rejects has already started billing, so the row demands the rejection precede allocation.
 */
async function checkGpu(
	module: DriverModule<ProviderId, unknown>,
	driver: SandboxDriver,
	options: ConformanceOptions<ProviderId, unknown>,
	artifact: ResolvedArtifact,
): Promise<ClauseOutcome> {
	const gpu = options.gpu;
	if (gpu === undefined) {
		return unverified("no gpu axis supplied, so neither honoring nor refusal was exercised");
	}
	const accelerator = module.accelerator;
	const request: CreateRequest = { ...createRequest(options, artifact), gpu };
	const allocationsBefore = options.observeAllocations?.();
	let session: SandboxSession | undefined;
	try {
		session = await createWithinBudget(module, driver, request);
	} catch (error) {
		if (isFailedCreateCleanupError(error)) throw error;
		if (accelerator !== undefined)
			return fail(`accelerator declared but create failed: ${detail(error)}`);
		if (!(isDriverError(error) && error.code === "invalid-create-request")) {
			return fail(`expected a typed invalid-create-request refusal, got ${detail(error)}`);
		}
		if (allocationsBefore === undefined) {
			return unverified(
				"the gpu request was refused, but nothing here can confirm the refusal preceded allocation",
			);
		}
		const allocated = (options.observeAllocations?.() ?? allocationsBefore) - allocationsBefore;
		return allocated === 0
			? pass("no accelerator strategy; the gpu request was refused before allocation")
			: fail(`the gpu request was refused, but ${allocated} allocation(s) happened first`);
	}
	let operationError: unknown;
	let outcome: ClauseOutcome;
	try {
		if (accelerator === undefined) {
			outcome = fail("driver returned a session for a gpu request without an accelerator strategy");
		} else {
			const readiness = await verifyDriverReadiness(module, session);
			if (readiness.status !== "pass") {
				outcome = fail(`gpu sandbox was not ready: ${readiness.detail}`);
			} else {
				const probe = await session.exec(accelerator.command);
				if (probe.exit.kind !== "exited" || probe.exit.code !== 0) {
					outcome = fail(`accelerator probe failed: ${JSON.stringify(probe.exit)}`);
				} else {
					const observed = accelerator.parse(probe.stdout);
					outcome = accelerator.matches(gpu, observed)
						? pass(`${accelerator.family} reported ${observed.count}x ${observed.model}`)
						: fail(
								`requested ${gpu.count}x ${gpu.model}, guest reported ${observed.count}x ${observed.model}`,
							);
				}
			}
		}
	} catch (error) {
		operationError = error;
		outcome = fail(`gpu verification failed: ${detail(error)}`);
	}
	try {
		await session.destroy();
	} catch (firstDestroyError) {
		try {
			await session.destroy();
		} catch (cleanupError) {
			const primaryError =
				operationError === undefined
					? firstDestroyError
					: new SuppressedError(
							firstDestroyError,
							operationError,
							"gpu verification and its first cleanup attempt both failed",
						);
			throw new ConformanceCleanupError(cleanupError, primaryError, module.id, session);
		}
		return fail(
			`${outcome.detail}; gpu cleanup required a retry after ${detail(firstDestroyError)}`,
		);
	}
	return outcome;
}

/* ------------------------------------ the suite runner ------------------------------------ */

/**
 * Run the closed inventory against one driver module and return a parseable report.
 *
 * The caller supplies the module and its already-built context, so this same function serves the
 * credential-free kit tier (fakes) and the live smoke tier (a real vendor) without knowing which it
 * is running — the tier is recorded, not inferred.
 */
export async function runConformance<P extends ProviderId, Handle>(
	options: ConformanceOptions<P, Handle>,
): Promise<ConformanceReport> {
	const widened = options as unknown as ConformanceOptions<ProviderId, unknown>;
	const module = widened.module;
	const recorder = new ClauseRecorder();
	const artifact = widened.context.resolvedArtifact as ResolvedArtifact;
	const driver = module.driver(widened.context as never) as SandboxDriver;

	await recorder.run("secret-diagnostics", () =>
		checkSecretDiagnostics(widened.tier, widened.secretDiagnostics),
	);

	const routing = checkSyncRouting(module);
	recorder.record("sync-routing", routing.status, routing.detail, performance.now());

	let session: SandboxSession;
	const createStarted = performance.now();
	try {
		session = await createWithinBudget(module, driver, createRequest(widened, artifact));
	} catch (error) {
		if (retainsCleanup(error)) throw error;
		// Without a session every remaining row is unobservable; `finish()` reports them `unverified`
		// rather than inventing results, and admission stays blocked.
		recorder.record("core-lifecycle", "fail", `create failed: ${detail(error)}`, createStarted);
		return report(widened, recorder);
	}

	await recorder.run("readiness", () => verifyDriverReadiness(module, session));
	if (recorder.status("readiness") === "pass") {
		await recorder.run("core-lifecycle", () => checkCoreLifecycle(session));
		await recorder.run("filesystem", () => checkFilesystem(session));
		await recorder.run("durable-execution", () => checkDurableExecution(module, session, widened));
		await recorder.run("artifact-identity", () =>
			checkArtifactIdentity(session, artifact, widened.fingerprint),
		);
		await recorder.run("snapshots", () => checkSnapshots(driver, session));
	} else {
		recorder.record(
			"core-lifecycle",
			"fail",
			"readiness failed before lifecycle commands could run safely",
			performance.now(),
		);
	}

	await recorder.run("control-plane-convergence", () =>
		checkConvergence(module.id, driver, session),
	);

	if (recorder.status("readiness") === "pass") {
		await recorder.run("gpu", () => checkGpu(module, driver, widened, artifact));
	}
	return report(widened, recorder);
}

function report(
	options: ConformanceOptions<ProviderId, unknown>,
	recorder: ClauseRecorder,
): ConformanceReport {
	const clauses = recorder.finish();
	return {
		provider: options.module.id,
		tier: options.tier,
		clauses,
		admissible: clauses.every(
			(clause) => clause.status === "pass" || clause.status === "not-applicable",
		),
	};
}

/** The clauses blocking matrix admission, for a caller that needs to say why (§5). */
export function admissionFailures(report: ConformanceReport): readonly ClauseResult[] {
	return report.clauses.filter(
		(clause) => clause.status !== "pass" && clause.status !== "not-applicable",
	);
}

/** Render a report as one line per clause, for CI logs and the eventual committed artifact. */
export function formatConformanceReport(report: ConformanceReport): string {
	const rows = report.clauses.map(
		(clause) => `  ${clause.status.padEnd(15)} ${clause.clause.padEnd(26)} ${clause.detail}`,
	);
	const verdict = report.admissible ? "admissible" : "BLOCKED";
	return [`${report.provider} (${report.tier} tier): ${verdict}`, ...rows].join("\n");
}
