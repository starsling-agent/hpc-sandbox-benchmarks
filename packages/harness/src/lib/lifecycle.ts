import type { CreateRequest, SandboxDriver, SandboxSession } from "@sandbox-benchmarks/driver";
import { succeeded } from "@sandbox-benchmarks/driver";
/**
 * Lifecycle & control-plane measurement — the harness-measured Dimensions PTS cannot see.
 *
 * A PTS profile times work done INSIDE an already-running sandbox; it is blind to how fast a provider
 * spawns, execs, snapshots, and tears a sandbox down, and to how quickly its control-plane API answers.
 * This module times those provider SDK calls directly and labels each timing with the matching
 * {@link HARNESS_METRIC_IDS} id, so a {@link RawRun}'s `operation` is a catalogued Metric id by
 * construction — the harness-side analogue of the PTS `<Result>`→id mapping.
 *
 * {@link measureLifecycle} drives ONE cold-start cycle (spawn → readiness probe → exec → control-plane
 * probes → payload exec → snapshot → teardown) against a structural {@link LifecycleCompute}, so it is
 * unit-testable against a fake with no real SDK. `spawn` times only create-resolve (the handle is not
 * yet usable); a readiness loop then retries a trivial exec until it succeeds, yielding the HONEST cold
 * start (`lifecycle_cold_start_ms`, t0→first success) and the readiness gap (`time_to_first_exec_ms`,
 * create→first success) — the latency `spawn` alone cannot see. Spawn is the bookend that must succeed
 * (a failure has nothing to tear down, so it rejects); every middle step is best-effort (a flaky
 * exec/probe records a FAILED gap, never losing the spawn/teardown samples); teardown always runs in
 * `finally` and never throws out of it. Repeat the cycle for a cold-start distribution — that is what
 * {@link benchmarkLifecycle} (in index.ts) does.
 */
import type {
	Aggregates,
	GapCause,
	HarnessMetricId,
	RawRun,
	ResultGap,
} from "@sandbox-benchmarks/schema";
import { aggregate, HARNESS_METRIC_IDS } from "@sandbox-benchmarks/schema";
import { gapCauseOf } from "./gap-cause.ts";
import { now as defaultNow, time } from "./internal.ts";
import { neverReadyReason, waitForReadiness } from "./readiness.ts";
import { createOwnedSandbox } from "./sandbox-owner.ts";

/**
 * Per-probe ceiling for THIS driver's readiness loop, deliberately far tighter than the suite path's.
 *
 * The two callers want opposite things. The suite path must absorb a cold multi-GiB image pull, so it
 * accepts a long per-probe wait. Here, how long readiness takes IS the measurement, over
 * `readinessMaxAttempts` (40) × `readinessRetryDelayMs` (250ms) ≈ a 10s window — and this driver runs
 * once per cold-start iteration (5 by default). Inheriting the readiness module's generous default
 * would let an all-hanging probe run turn one iteration into ~13.5 minutes and a default benchmark into
 * over an hour before producing any result. A healthy probe answers in tens of ms, so 2s is slack
 * enough to be sure the sandbox isn't up while keeping the pathological case ~90s per iteration.
 */
const READINESS_PROBE_TIMEOUT_MS = 2_000;
/**
 * Reasons an operation produced no Sample by DECISION rather than by outage — the `skip` arm's wording.
 * Named because two paths file them now (the live chain and the never-ready bail-out), and a probe
 * filed under the wrong arm, or under drifted wording, is exactly the misreport the skip/fail split
 * exists to prevent.
 */
const PAYLOAD_DISABLED = "64KiB payload exec disabled for this run";
// Scoped to the integration under measurement — a leftover ComputeSDK adapter or a DriverModule
// projection — never to the vendor SDK as a whole. Two different integrations of one provider can
// expose different control-plane calls, and this benchmark only ever observes the one it was handed;
// "the vendor has no such API" is a claim about the vendor that the absent method is no evidence for.
const NO_LIST_OP = "the provider integration under measurement exposes no sandbox list operation";
const NO_INFO_OP = "the provider integration under measurement exposes no sandbox info operation";
const SNAPSHOT_DISABLED = "snapshot measurement disabled for this run";
const NO_SNAPSHOT_OP = "the provider integration under measurement exposes no snapshot operation";
/**
 * A measurement this RUN turned off. Deliberately not `unsupported-operation`: the provider can do it,
 * we chose not to time it, and publishing a config toggle as a missing capability would be a claim
 * about the provider we have no evidence for.
 */
const DISABLED_CAUSE = { kind: "measurement-disabled" } as const satisfies GapCause;
/** The measured integration exposes no such call — a capability statement, unlike {@link DISABLED_CAUSE}. */
const NO_LIST_CAUSE = {
	kind: "unsupported-operation",
	detail: NO_LIST_OP,
} as const satisfies GapCause;
const NO_INFO_CAUSE = {
	kind: "unsupported-operation",
	detail: NO_INFO_OP,
} as const satisfies GapCause;
const NO_SNAPSHOT_CAUSE = {
	kind: "unsupported-operation",
	detail: NO_SNAPSHOT_OP,
} as const satisfies GapCause;
/** Writes exactly 64KiB (65536 bytes) to stdout — exec overhead including output streaming. Uses `tr`
 *  rather than `base64` so the stream is exactly 64KiB, matching the metric's name (base64 expands the
 *  input ~33%, overstating the payload). */
const PAYLOAD_CMD = "head -c 65536 /dev/zero | tr '\\0' 'a'";
/** Real wall-clock delay between readiness retries; swapped for a no-op in tests. */
const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The slice of a computesdk sandbox the lifecycle driver times (its `Sandbox` satisfies this). */
export interface LifecycleSandbox {
	readonly sandboxId: string;
	runCommand(command: string, options?: { background?: boolean }): Promise<{ exitCode: number }>;
	/** Present when the provider exposes a control-plane info/describe/observe call. */
	getInfo?(): Promise<unknown>;
	destroy(): Promise<unknown>;
}

/** The slice of a computesdk snapshot manager the driver times (its `ProviderSnapshotManager` satisfies this). */
export interface LifecycleSnapshots {
	create(sandboxId: string, options?: { name?: string }): Promise<{ id: string }>;
	delete(snapshotId: string): Promise<unknown>;
}

/** The slice of a computesdk provider the driver needs (its `DirectProvider` satisfies this). */
export interface LifecycleCompute {
	sandbox: {
		create(options?: unknown): Promise<LifecycleSandbox>;
		/** Present on providers whose SDK can enumerate sandboxes — the control-plane list probe. */
		list?(): Promise<unknown[]>;
	};
	/** Present on providers whose SDK exposes snapshots — the lifecycle snapshot probe. */
	snapshot?: LifecycleSnapshots;
}

export interface MeasureLifecycleOptions {
	/** Provider id stamped onto every emitted {@link RawRun}. */
	provider: string;
	/** Create-time options forwarded verbatim to `sandbox.create` (the pinned spec/image). */
	createOptions?: unknown;
	/** Trivial command timed for the exec round-trip floor. Default `"true"`. */
	execCommand?: string;
	/** How many times to probe each control-plane read within the one sandbox. Default `1`. */
	controlPlaneSamples?: number;
	/** Attempt a snapshot (recorded as a skipped gap when the SDK exposes none, or when false). Default `true`. */
	snapshot?: boolean;
	/** Readiness probes (`echo ok`) per cold start before giving up. Default `40`. */
	readinessMaxAttempts?: number;
	/** Delay between failed readiness probes, in ms. Default `250`. */
	readinessRetryDelayMs?: number;
	/** Time a 64KiB-stdout exec (recorded as the payload control-plane Metric). Default `true`. */
	payload?: boolean;
	/** Injectable monotonic clock (ms) for cold-start timestamps. Default the harness internal clock. */
	now?: () => number;
	/** Injectable readiness-retry delay; tests pass a no-op so they never really sleep. Default real `setTimeout`. */
	delay?: (ms: number) => Promise<void>;
}

/** One cold-start cycle's output: a timing Sample per measured op, a gap per op that produced none. */
export interface LifecycleMeasurement {
	samples: RawRun[];
	/** Operation-scoped gaps — `skipped` (not attempted) or `failed` (attempted, errored). */
	gaps: ResultGap[];
}

/** A measured operation's distribution, keyed by the catalogued Metric id its Samples belong to. */
export interface LifecycleAggregate {
	metricId: HarnessMetricId;
	aggregates: Aggregates;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Measure one full lifecycle cycle against `compute`, returning a timing Sample per op and a gap per op
 * that produced none — `skipped` when it was never attempted (disabled, or the SDK has no such call),
 * `failed` when it was attempted and threw. See the module header for the spawn-rejects /
 * middle-best-effort / teardown-always-runs contract.
 */
export async function measureLifecycle(
	compute: LifecycleCompute,
	options: MeasureLifecycleOptions,
): Promise<LifecycleMeasurement> {
	const snapshots = compute.snapshot;
	return measureCycle(
		{
			create: () => compute.sandbox.create(options.createOptions),
			exec: (sandbox, command) => sandbox.runCommand(command),
			ready: async (sandbox) => (await sandbox.runCommand("echo ok")).exitCode === 0,
			info: (sandbox) => sandbox.getInfo?.bind(sandbox),
			list: compute.sandbox.list?.bind(compute.sandbox),
			snapshot:
				snapshots === undefined
					? undefined
					: {
							create: async (sandbox) => (await snapshots.create(sandbox.sandboxId)).id,
							delete: snapshots.delete.bind(snapshots),
						},
		},
		options,
	);
}

/** Measure a session directly without changing timing boundaries or sample eligibility. */
export function measureDriverLifecycle(
	driver: SandboxDriver,
	request: CreateRequest,
	options: Omit<MeasureLifecycleOptions, "createOptions">,
): Promise<LifecycleMeasurement> {
	const probes = driver.probes;
	const info = (probes?.describe ?? probes?.observe)?.bind(probes);
	const snapshots = driver.snapshots;
	const list = probes?.list?.bind(probes);
	return measureCycle<SandboxSession>(
		{
			create: (signal) => driver.create(request, { signal }),
			exec: (session, command) => session.exec(command),
			ready: async (session) => succeeded((await session.exec("echo ok")).exit),
			info: (session) => (info === undefined ? undefined : () => info(session.sandboxRef)),
			list:
				list === undefined
					? undefined
					: async () => {
							const result = await list();
							if (!Array.isArray(result))
								throw new Error("driver probes.list returned a non-array result");
							return result;
						},
			snapshot:
				snapshots === undefined
					? undefined
					: {
							create: async (session) => (await snapshots.create(session)).snapshotId,
							delete: (id) => snapshots.delete(id),
						},
		},
		options,
	);
}

interface CycleOperations<Session extends { destroy(): Promise<unknown> }> {
	create(signal: AbortSignal): Promise<Session>;
	exec(session: Session, command: string): Promise<unknown>;
	ready(session: Session): Promise<boolean>;
	info(session: Session): (() => Promise<unknown>) | undefined;
	list: (() => Promise<unknown>) | undefined;
	snapshot:
		| { create(session: Session): Promise<string>; delete(id: string): Promise<unknown> }
		| undefined;
}

async function measureCycle<Session extends { destroy(): Promise<unknown> }>(
	operations: CycleOperations<Session>,
	options: Omit<MeasureLifecycleOptions, "createOptions">,
): Promise<LifecycleMeasurement> {
	const { provider } = options;
	const execCommand = options.execCommand ?? "true";
	// `?? 1` only catches undefined; a NaN/Infinity slipping through would make `i < samples` never
	// run (or never stop), so a non-finite value falls back to a single probe.
	const rawSamples = options.controlPlaneSamples ?? 1;
	const controlPlaneSamples = Number.isFinite(rawSamples) ? Math.max(1, Math.floor(rawSamples)) : 1;
	const wantSnapshot = options.snapshot ?? true;
	const wantPayload = options.payload ?? true;
	// Same non-finite guard as controlPlaneSamples: a NaN bound would make the readiness loop never run.
	const rawAttempts = options.readinessMaxAttempts ?? 40;
	const readinessMaxAttempts = Number.isFinite(rawAttempts)
		? Math.max(1, Math.floor(rawAttempts))
		: 40;
	// Same non-finite guard as readinessMaxAttempts; also clamp negatives (a negative delay is meaningless).
	const rawDelayMs = options.readinessRetryDelayMs ?? 250;
	const readinessRetryDelayMs = Number.isFinite(rawDelayMs) ? Math.max(0, rawDelayMs) : 250;
	const clock = options.now ?? defaultNow;
	const delay = options.delay ?? realDelay;

	const samples: RawRun[] = [];
	const gaps: ResultGap[] = [];
	const sample = (operation: HarnessMetricId, ms: number): void => {
		samples.push({ provider, operation, durationMs: ms });
	};
	// An operation-scoped gap: the Metric id names what produced no Sample, and `outcome` says why.
	//
	// The two arms are NOT interchangeable, and this is the layer that knows which is which. `skip` is a
	// decision — the run turned the probe off, or the provider's SDK has no such call — and says nothing
	// about reliability. `fail` is an outage: the call was made and it threw. Recording a throw as a skip
	// (as this did while both shared one helper) publishes a provider's control-plane failure as though
	// we had chosen not to measure it, which is precisely backwards.
	const skip = (operation: HarnessMetricId, reason: string, cause?: GapCause): void => {
		gaps.push({
			scope: "operation",
			id: operation,
			outcome: "skipped",
			reason,
			...(cause ? { cause } : {}),
		});
	};
	const fail = (operation: HarnessMetricId, reason: string, cause?: GapCause): void => {
		gaps.push({
			scope: "operation",
			id: operation,
			outcome: "failed",
			reason,
			...(cause ? { cause } : {}),
		});
	};
	// A timed step that records a Sample on success and a FAILED gap (never a throw) on error.
	const step = async (operation: HarnessMetricId, run: () => Promise<unknown>): Promise<void> => {
		try {
			sample(operation, (await time(run)).ms);
		} catch (err) {
			fail(operation, reasonOf(err), gapCauseOf(err));
		}
	};

	// Floor cold-start deltas to a strictly-positive duration (the rawRunSchema contract `time()` also
	// upholds): a sub-tick op can read two equal clock values, and durationMs must be > 0.
	const floor = (ms: number): number => Math.max(ms, Number.EPSILON);

	// Spawn: the opening bookend, timed create-resolve ONLY — the returned handle is not necessarily
	// usable yet (the readiness loop below measures when it becomes so). A failure has no sandbox to tear
	// down, so it rejects and the caller records the failed cold-start cycle.
	const t0 = clock();
	const sandbox = await createOwnedSandbox(operations.create, {
		destroy: (destroy, options) => destroy(options),
	});
	const createdAt = clock();
	sample(HARNESS_METRIC_IDS.spawn, floor(createdAt - t0));

	try {
		// Readiness: retry a trivial exec until it returns exitCode 0 — the FIRST success marks a usable
		// sandbox. cold_start (t0→ready) is the honest cold start spawn alone can't see; first_exec
		// (create→ready) isolates the readiness wait. A probe that throws counts as not-ready and retries.
		const readiness = await waitForReadiness(() => operations.ready(sandbox), {
			maxAttempts: readinessMaxAttempts,
			retryDelayMs: readinessRetryDelayMs,
			probeTimeoutMs: READINESS_PROBE_TIMEOUT_MS,
			delay,
		});
		const readyAt = readiness.ready ? clock() : undefined;
		if (readyAt === undefined) {
			// Never went ready: record both readiness Metrics as FAILURES rather than fabricate a timing.
			// The sandbox was spawned and probed to exhaustion and never came up — that is the loudest
			// reliability signal this harness can produce, and calling it a "skip" would file it as a
			// deliberate omission.
			const reason = neverReadyReason(readiness.attempts);
			fail(HARNESS_METRIC_IDS.firstExec, reason);
			fail(HARNESS_METRIC_IDS.coldStart, reason);
			// Stop here. Every probe below execs against this sandbox, and those calls are UNBOUNDED — on a
			// sandbox that never answered, the first of them can hang indefinitely and undo the bounded gate
			// above. Bail out, but keep the accounting honest: a Metric this abandons gets a FAILED gap
			// naming the readiness outage, because the alternative (no Sample, no gap) reads downstream as
			// "never scheduled" rather than "the sandbox never came up". `finally` still tears down and
			// still samples teardown — the returned arrays are the same references it appends to.
			//
			// Crucially, only for what this configuration WOULD have attempted. A disabled payload, an SDK
			// with no list, an absent snapshot manager: those are the same decisions they always were, and
			// the readiness outage doesn't turn them into provider failures. Blanket-failing them would
			// publish a control-plane outage for calls that were never going to happen — the exact
			// skip/fail inversion the two helpers above exist to prevent.
			fail(HARNESS_METRIC_IDS.exec, reason);
			// One gap, not `controlPlaneSamples` of them: the live path records a gap per failed probe, but
			// no probe ran here and N copies of one fact is noise, not fidelity.
			if (operations.info(sandbox)) fail(HARNESS_METRIC_IDS.controlPlaneInfo, reason);
			else skip(HARNESS_METRIC_IDS.controlPlaneInfo, NO_INFO_OP, NO_INFO_CAUSE);
			if (wantPayload) fail(HARNESS_METRIC_IDS.execPayload64k, reason);
			else skip(HARNESS_METRIC_IDS.execPayload64k, PAYLOAD_DISABLED, DISABLED_CAUSE);
			if (operations.list) fail(HARNESS_METRIC_IDS.controlPlaneList, reason);
			else skip(HARNESS_METRIC_IDS.controlPlaneList, NO_LIST_OP, NO_LIST_CAUSE);
			if (!wantSnapshot) skip(HARNESS_METRIC_IDS.snapshot, SNAPSHOT_DISABLED, DISABLED_CAUSE);
			else if (!operations.snapshot)
				skip(HARNESS_METRIC_IDS.snapshot, NO_SNAPSHOT_OP, NO_SNAPSHOT_CAUSE);
			else fail(HARNESS_METRIC_IDS.snapshot, reason);
			return { samples, gaps };
		} else {
			sample(HARNESS_METRIC_IDS.firstExec, floor(readyAt - createdAt));
			sample(HARNESS_METRIC_IDS.coldStart, floor(readyAt - t0));
		}

		// Exec: a trivial command round-trip — the exec-path latency floor, independent of the work done.
		await step(HARNESS_METRIC_IDS.exec, () => operations.exec(sandbox, execCommand));

		// Payload: a 64KiB-stdout exec — exec overhead including output streaming, above the trivial floor.
		if (wantPayload) {
			await step(HARNESS_METRIC_IDS.execPayload64k, () => operations.exec(sandbox, PAYLOAD_CMD));
		} else {
			skip(HARNESS_METRIC_IDS.execPayload64k, PAYLOAD_DISABLED, DISABLED_CAUSE);
		}

		// Control-plane read: getInfo, sampled within this one (cheap) sandbox to build a distribution
		// without paying a fresh spawn/teardown per Sample. Absent on a DriverModule that only exposes
		// observe/list/snapshot through optional port members — skip rather than invent a probe.
		const getInfo = operations.info(sandbox);
		if (getInfo) {
			for (let i = 0; i < controlPlaneSamples; i++) {
				await step(HARNESS_METRIC_IDS.controlPlaneInfo, () => getInfo());
			}
		} else {
			skip(HARNESS_METRIC_IDS.controlPlaneInfo, NO_INFO_OP, NO_INFO_CAUSE);
		}

		// Control-plane enumeration: list, when the SDK exposes it. Bind `this` so the captured method
		// keeps its receiver, and narrow on a const (property narrowing wouldn't survive the closure).
		const listSandboxes = operations.list;
		if (listSandboxes) {
			// Sampled `controlPlaneSamples` times like getInfo — list is a control-plane read too, so the
			// configured probe depth governs both reads, not just info.
			for (let i = 0; i < controlPlaneSamples; i++) {
				await step(HARNESS_METRIC_IDS.controlPlaneList, () => listSandboxes());
			}
		} else {
			skip(HARNESS_METRIC_IDS.controlPlaneList, NO_LIST_OP, NO_LIST_CAUSE);
		}

		// Snapshot: when requested and the SDK exposes a snapshot manager. Best-effort delete afterwards
		// so a measured snapshot never leaks into the account.
		const snapshots = operations.snapshot;
		if (!wantSnapshot) {
			skip(HARNESS_METRIC_IDS.snapshot, SNAPSHOT_DISABLED, DISABLED_CAUSE);
		} else if (!snapshots) {
			skip(HARNESS_METRIC_IDS.snapshot, NO_SNAPSHOT_OP, NO_SNAPSHOT_CAUSE);
		} else {
			try {
				const snap = await time(() => snapshots.create(sandbox));
				sample(HARNESS_METRIC_IDS.snapshot, snap.ms);
				// Best-effort cleanup: a failed delete shouldn't fail the cycle, but it can leak a snapshot,
				// so surface it (mirrors the destroy-failure warning) instead of swallowing it silently.
				await snapshots.delete(snap.value).catch((err) => {
					console.warn(`[lifecycle] snapshot cleanup failed (${snap.value}): ${reasonOf(err)}`);
				});
			} catch (err) {
				fail(HARNESS_METRIC_IDS.snapshot, reasonOf(err));
			}
		}
	} finally {
		// Teardown: the closing bookend — always attempted. A throw out of `finally` would mask an
		// in-flight error, so a failed destroy is recorded as a failed gap, not rethrown; the leak is the
		// caller's to notice.
		try {
			sample(HARNESS_METRIC_IDS.teardown, (await time(() => sandbox.destroy())).ms);
		} catch (err) {
			fail(HARNESS_METRIC_IDS.teardown, reasonOf(err));
		}
	}

	return { samples, gaps };
}

/**
 * Group {@link RawRun} Samples by their Metric id and aggregate each into the canonical distribution,
 * in {@link HARNESS_METRIC_IDS} declaration order. Operations with no Samples (all skipped) are omitted
 * rather than aggregated — `aggregate()` requires at least one Sample.
 */
export function aggregateLifecycle(samples: readonly RawRun[]): LifecycleAggregate[] {
	const out: LifecycleAggregate[] = [];
	for (const metricId of Object.values(HARNESS_METRIC_IDS)) {
		const durations = samples.filter((s) => s.operation === metricId).map((s) => s.durationMs);
		if (durations.length > 0) out.push({ metricId, aggregates: aggregate(durations) });
	}
	return out;
}
