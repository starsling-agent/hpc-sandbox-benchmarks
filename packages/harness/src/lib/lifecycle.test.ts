import { afterEach, describe, expect, it } from "bun:test";
import type { GapCause, RawRun, ResultGap } from "@sandbox-benchmarks/schema";
import { HARNESS_METRIC_IDS } from "@sandbox-benchmarks/schema";
import { GapError } from "./gap-cause.ts";
import type { LifecycleCompute, LifecycleSandbox } from "./lifecycle.ts";
import { aggregateLifecycle, measureLifecycle } from "./lifecycle.ts";
import { cleanupOwnedSandboxes } from "./sandbox-owner.ts";

interface FakeCalls {
	order: string[];
	deletedSnapshots: string[];
}

interface FakeOptions {
	withSnapshot?: boolean;
	withList?: boolean;
	failCreate?: boolean;
	failExec?: boolean;
	/** Make the measured exec throw a CLASSIFIED error, to check the cause survives the throw. */
	failExecWithCause?: GapCause;
	failInfo?: boolean;
	failDestroy?: boolean;
	failSnapshotCreate?: boolean;
	/** Number of leading `runCommand` calls that report exitCode 1 (not-ready) before succeeding. */
	notReadyFor?: number;
}

/**
 * Test injection: a monotonic clock that ticks one ms per read, and a delay that never really sleeps.
 * The driver's readiness loop retries `echo ok`, so without a no-op delay a not-ready path would block
 * the test for `readinessMaxAttempts × readinessRetryDelayMs` of real time.
 */
function fastClock(): () => number {
	let t = 0;
	return () => ++t;
}
const noDelay = async (): Promise<void> => {};

/** A fake compute that records its call order, so the driver's chain is checkable without a real SDK. */
function fakeCompute(opts: FakeOptions = {}): { compute: LifecycleCompute; calls: FakeCalls } {
	const calls: FakeCalls = { order: [], deletedSnapshots: [] };
	let readinessProbes = 0;
	let remainingDestroyFailures = opts.failDestroy ? 1 : 0;
	const sandbox: LifecycleSandbox = {
		sandboxId: "sb-1",
		async runCommand(command) {
			calls.order.push(`exec:${command}`);
			// Readiness is resolved BEFORE failExec so the two are independently controllable: the driver
			// now stops at an unready sandbox, so "ready, but the measured exec throws" (failExec) and
			// "never became ready" (notReadyFor) are different scenarios and a fake that conflated them
			// could not express the first at all.
			if (command === "echo ok") {
				readinessProbes += 1;
				return {
					exitCode: opts.notReadyFor && readinessProbes <= opts.notReadyFor ? 1 : 0,
				};
			}
			if (opts.failExecWithCause) {
				throw new GapError("exec boom", opts.failExecWithCause);
			}
			if (opts.failExec) throw new Error("exec boom");
			return { exitCode: 0 };
		},
		async getInfo() {
			calls.order.push("getInfo");
			if (opts.failInfo) throw new Error("info boom");
			return { status: "running" };
		},
		async destroy() {
			calls.order.push("destroy");
			if (remainingDestroyFailures > 0) {
				remainingDestroyFailures--;
				throw new Error("destroy boom");
			}
			return undefined;
		},
	};
	const sandboxManager: LifecycleCompute["sandbox"] = {
		async create() {
			calls.order.push("create");
			if (opts.failCreate) throw new Error("create boom");
			return sandbox;
		},
	};
	if (opts.withList) {
		sandboxManager.list = async () => {
			calls.order.push("list");
			return [sandbox];
		};
	}
	const compute: LifecycleCompute = { sandbox: sandboxManager };
	if (opts.withSnapshot) {
		compute.snapshot = {
			async create(sandboxId) {
				calls.order.push(`snapshot:${sandboxId}`);
				if (opts.failSnapshotCreate) throw new Error("snapshot boom");
				return { id: "snap-1" };
			},
			async delete(snapshotId) {
				calls.deletedSnapshots.push(snapshotId);
				return undefined;
			},
		};
	}
	return { compute, calls };
}

afterEach(async () => {
	expect(await cleanupOwnedSandboxes()).toEqual([]);
});

/** Map of Metric id → number of Samples that carry it. */
function countByOp(samples: RawRun[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const s of samples) counts[s.operation] = (counts[s.operation] ?? 0) + 1;
	return counts;
}

// A lifecycle gap is operation-scoped: `id` is the Metric id that produced no Sample.
const gapFor = (gaps: ResultGap[], op: string): ResultGap | undefined =>
	gaps.find((g) => g.id === op);
const reasonFor = (gaps: ResultGap[], op: string): string | undefined => gapFor(gaps, op)?.reason;
const outcomeFor = (gaps: ResultGap[], op: string): string | undefined => gapFor(gaps, op)?.outcome;
const causeFor = (gaps: ResultGap[], op: string): GapCause | undefined => gapFor(gaps, op)?.cause;

describe("measureLifecycle", () => {
	it("times the full spawn→readiness→exec→payload→info→list→snapshot→teardown chain in order", async () => {
		const { compute, calls } = fakeCompute({ withSnapshot: true, withList: true });
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			controlPlaneSamples: 2,
			now: fastClock(),
			delay: noDelay,
		});

		expect(calls.order).toEqual([
			"create",
			"exec:echo ok", // readiness probe — first success marks the sandbox usable
			"exec:true", // exec round-trip floor
			"exec:head -c 65536 /dev/zero | tr '\\0' 'a'", // 64KiB payload exec
			"getInfo",
			"getInfo",
			"list",
			"list",
			"snapshot:sb-1",
			"destroy",
		]);
		// controlPlaneSamples:2 governs BOTH control-plane reads — getInfo and list each probed twice.
		expect(countByOp(samples)).toEqual({
			[HARNESS_METRIC_IDS.spawn]: 1,
			[HARNESS_METRIC_IDS.coldStart]: 1,
			[HARNESS_METRIC_IDS.firstExec]: 1,
			[HARNESS_METRIC_IDS.exec]: 1,
			[HARNESS_METRIC_IDS.execPayload64k]: 1,
			[HARNESS_METRIC_IDS.controlPlaneInfo]: 2,
			[HARNESS_METRIC_IDS.controlPlaneList]: 2,
			[HARNESS_METRIC_IDS.snapshot]: 1,
			[HARNESS_METRIC_IDS.teardown]: 1,
		});
		// Every Sample carries the provider and a strictly-positive duration (the RawRun contract).
		expect(samples.every((s) => s.provider === "e2b" && s.durationMs > 0)).toBe(true);
		expect(gaps).toEqual([]);
		// The measured snapshot is cleaned up, never leaked.
		expect(calls.deletedSnapshots).toEqual(["snap-1"]);
	});

	it("retries the readiness probe until the first success, then records cold-start honestly", async () => {
		// Two not-ready probes (exitCode 1) then success: cold_start spans t0→3rd probe, first_exec
		// create→3rd probe — both bigger than the create-resolve spawn delta alone.
		const { compute, calls } = fakeCompute({ notReadyFor: 2 });
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			now: fastClock(),
			delay: noDelay,
		});
		// create, three echo-ok probes (two not-ready + one ready), then exec floor + payload.
		expect(calls.order.slice(0, 4)).toEqual([
			"create",
			"exec:echo ok",
			"exec:echo ok",
			"exec:echo ok",
		]);
		const ops = countByOp(samples);
		expect(ops[HARNESS_METRIC_IDS.coldStart]).toBe(1);
		expect(ops[HARNESS_METRIC_IDS.firstExec]).toBe(1);
		// cold_start (t0→ready) strictly exceeds first_exec (create→ready) — it also carries create.
		const cold = samples.find((s) => s.operation === HARNESS_METRIC_IDS.coldStart);
		const first = samples.find((s) => s.operation === HARNESS_METRIC_IDS.firstExec);
		expect(cold?.durationMs).toBeGreaterThan(first?.durationMs ?? 0);
		// A recovered readiness is NOT a gap (only the unsupported snapshot/list ops on this bare fake).
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.coldStart)).toBeUndefined();
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.firstExec)).toBeUndefined();
	});

	it("fails both readiness Metrics when the sandbox never goes ready, capped at readinessMaxAttempts", async () => {
		// notReadyFor exceeds the attempt cap → never ready; the loop must stop at the cap, not spin.
		const { compute, calls } = fakeCompute({ notReadyFor: 10 });
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			readinessMaxAttempts: 3,
			now: fastClock(),
			delay: noDelay,
		});
		expect(calls.order.filter((c) => c === "exec:echo ok").length).toBe(3);
		expect(countByOp(samples)[HARNESS_METRIC_IDS.coldStart]).toBeUndefined();
		expect(countByOp(samples)[HARNESS_METRIC_IDS.firstExec]).toBeUndefined();
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.coldStart)).toMatch(/never ready/);
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.firstExec)).toMatch(/never ready/);
		// The sandbox was spawned and probed to exhaustion: an outage, never a deliberate omission.
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.coldStart)).toBe("failed");
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.firstExec)).toBe("failed");
		// Spawn and teardown still measured around the unusable sandbox.
		expect(countByOp(samples)[HARNESS_METRIC_IDS.spawn]).toBe(1);
		expect(countByOp(samples)[HARNESS_METRIC_IDS.teardown]).toBe(1);
	});

	it("records a skip when the 64KiB payload exec is disabled, without calling it", async () => {
		const { compute, calls } = fakeCompute();
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			payload: false,
			now: fastClock(),
			delay: noDelay,
		});
		expect(calls.order.some((c) => c.includes("/dev/zero | tr"))).toBe(false);
		expect(countByOp(samples)[HARNESS_METRIC_IDS.execPayload64k]).toBeUndefined();
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.execPayload64k)).toMatch(/disabled/);
		// Never attempted (the run turned it off) — a decision, not a reliability fact. The cause says so
		// in data: `measurement-disabled`, never `unsupported-operation`, which would publish a config
		// toggle as a capability e2b lacks.
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.execPayload64k)).toBe("skipped");
		expect(causeFor(gaps, HARNESS_METRIC_IDS.execPayload64k)).toEqual({
			kind: "measurement-disabled",
		});
	});

	it("honors a custom exec command", async () => {
		const { compute, calls } = fakeCompute();
		await measureLifecycle(compute, {
			provider: "e2b",
			execCommand: "uname -a",
			now: fastClock(),
			delay: noDelay,
		});
		expect(calls.order).toContain("exec:uname -a");
	});

	it("records a skip (not a sample) when the integration exposes no snapshot or list operation", async () => {
		const { compute } = fakeCompute(); // no snapshot manager, no list
		const { samples, gaps } = await measureLifecycle(compute, { provider: "modal" });

		const ops = countByOp(samples);
		expect(ops[HARNESS_METRIC_IDS.snapshot]).toBeUndefined();
		expect(ops[HARNESS_METRIC_IDS.controlPlaneList]).toBeUndefined();
		// Spawn/exec/info/teardown still measured.
		expect(ops[HARNESS_METRIC_IDS.spawn]).toBe(1);
		expect(ops[HARNESS_METRIC_IDS.teardown]).toBe(1);
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.snapshot)).toMatch(/no snapshot operation/);
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.controlPlaneList)).toMatch(
			/no sandbox list operation/,
		);
		// The integration exposes no such call, so neither was attempted — a skip, not an outage. And the
		// cause is `unsupported-operation`: a statement about the PROVIDER, the opposite half of the
		// distinction `measurement-disabled` carries.
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.snapshot)).toBe("skipped");
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.controlPlaneList)).toBe("skipped");
		expect(causeFor(gaps, HARNESS_METRIC_IDS.snapshot)).toEqual({
			kind: "unsupported-operation",
			detail: "the provider integration under measurement exposes no snapshot operation",
		});
		expect(causeFor(gaps, HARNESS_METRIC_IDS.controlPlaneList)).toEqual({
			kind: "unsupported-operation",
			detail: "the provider integration under measurement exposes no sandbox list operation",
		});
	});

	it("records a skip when snapshot measurement is disabled, without calling the SDK", async () => {
		const { compute, calls } = fakeCompute({ withSnapshot: true });
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			snapshot: false,
		});
		expect(calls.order.some((c) => c.startsWith("snapshot:"))).toBe(false);
		expect(countByOp(samples)[HARNESS_METRIC_IDS.snapshot]).toBeUndefined();
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.snapshot)).toMatch(/disabled/);
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.snapshot)).toBe("skipped");
		// The SDK HAS a snapshot manager here — only the run turned it off, so the cause must not claim
		// the provider cannot do it.
		expect(causeFor(gaps, HARNESS_METRIC_IDS.snapshot)).toEqual({ kind: "measurement-disabled" });
	});

	it("turns a mid-chain exec failure into a failed gap and still tears down", async () => {
		// A READY sandbox whose measured exec throws — the mid-chain best-effort contract. (A sandbox that
		// never goes ready is the separate case below; the driver stops there rather than probing on.)
		const { compute, calls } = fakeCompute({ failExec: true });
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			now: fastClock(),
			delay: noDelay,
		});
		// exec was attempted and threw → no exec sample, but a FAILED gap carrying the error message.
		expect(countByOp(samples)[HARNESS_METRIC_IDS.exec]).toBeUndefined();
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.exec)).toBe("exec boom");
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.exec)).toBe("failed");
		// A provider SDK's own error carries no classification, and none is invented from its message —
		// guessing a kind from prose is the coupling the taxonomy exists to remove.
		expect(causeFor(gaps, HARNESS_METRIC_IDS.exec)).toBeUndefined();
		// Readiness succeeded here, so the cold-start Metrics are real Samples, not gaps.
		expect(countByOp(samples)[HARNESS_METRIC_IDS.coldStart]).toBe(1);
		// Teardown still ran and was sampled.
		expect(calls.order).toContain("destroy");
		expect(countByOp(samples)[HARNESS_METRIC_IDS.teardown]).toBe(1);
	});

	it("stops probing an unready sandbox, but still fails every abandoned Metric and tears down", async () => {
		// Every probe below readiness execs against the sandbox and those calls are unbounded, so on a
		// sandbox that never answered the first of them can hang forever — undoing the bounded readiness
		// gate. The driver must bail out instead. Accounting still has to be complete: an abandoned Metric
		// with no Sample AND no gap reads downstream as "never scheduled", not "the sandbox never came up".
		// Snapshot + list present and payload on by default, so every abandoned op is one this config
		// WOULD have attempted — the all-failed case. The skip-preserving case is the test below.
		const { compute, calls } = fakeCompute({ notReadyFor: 99, withSnapshot: true, withList: true });
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			readinessMaxAttempts: 2,
			now: fastClock(),
			delay: noDelay,
		});
		// Bailed out: only the readiness probes ran — no exec, no getInfo, no list, no snapshot.
		expect(calls.order.filter((c) => c === "exec:echo ok").length).toBe(2);
		expect(calls.order.some((c) => c === "getInfo" || c === "list")).toBe(false);
		expect(calls.order.some((c) => c.startsWith("snapshot:"))).toBe(false);
		// ...yet every Metric it abandoned carries a FAILED gap naming the readiness outage.
		for (const metricId of [
			HARNESS_METRIC_IDS.coldStart,
			HARNESS_METRIC_IDS.firstExec,
			HARNESS_METRIC_IDS.exec,
			HARNESS_METRIC_IDS.execPayload64k,
			HARNESS_METRIC_IDS.controlPlaneInfo,
			HARNESS_METRIC_IDS.controlPlaneList,
			HARNESS_METRIC_IDS.snapshot,
		]) {
			expect(outcomeFor(gaps, metricId)).toBe("failed");
			expect(reasonFor(gaps, metricId)).toMatch(/never ready/);
		}
		// The bookends survive the early return: spawn was sampled before it, teardown by the `finally`.
		expect(countByOp(samples)[HARNESS_METRIC_IDS.spawn]).toBe(1);
		expect(calls.order).toContain("destroy");
		expect(countByOp(samples)[HARNESS_METRIC_IDS.teardown]).toBe(1);
	});

	it("carries a classified throw from a measured step onto its gap", async () => {
		// The `step()` error path is the one place a gap's cause comes from the ERROR rather than from a
		// constant beside the call. An unclassified throw must stay unclassified (the test above pins
		// that), and a classified one must arrive intact — otherwise `GapError` buys nothing here and the
		// classification silently dies at the frame that catches it.
		const cause: GapCause = { kind: "step-timeout", step: "exec", timeoutSeconds: 30 };
		const { compute } = fakeCompute({ failExecWithCause: cause });
		const { gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			now: fastClock(),
			delay: noDelay,
		});
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.exec)).toBe("failed");
		expect(causeFor(gaps, HARNESS_METRIC_IDS.exec)).toEqual(cause);
	});

	it("keeps disabled and unsupported operations SKIPPED on a never-ready sandbox", async () => {
		// A readiness outage must not relabel decisions as provider failures. Payload is off, and this fake
		// exposes neither list nor snapshot — none of those calls was ever going to happen, so reporting
		// them as failures would publish a control-plane outage that did not occur, and the leaderboard
		// would read it as provider unreliability.
		const { compute } = fakeCompute({ notReadyFor: 99 });
		const { gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			payload: false,
			snapshot: false,
			readinessMaxAttempts: 2,
			now: fastClock(),
			delay: noDelay,
		});
		for (const [metricId, pattern, kind] of [
			[HARNESS_METRIC_IDS.execPayload64k, /disabled/, "measurement-disabled"],
			[HARNESS_METRIC_IDS.controlPlaneList, /no sandbox list operation/, "unsupported-operation"],
			[HARNESS_METRIC_IDS.snapshot, /disabled/, "measurement-disabled"],
		] as const) {
			expect(outcomeFor(gaps, metricId)).toBe("skipped");
			expect(reasonFor(gaps, metricId)).toMatch(pattern);
			// The classification has to survive the outage too — this is the path where a skip is most
			// easily relabelled, and a swapped kind here is exactly the regression prose cannot catch.
			expect(causeFor(gaps, metricId)?.kind).toBe(kind);
		}
		// The genuinely-prevented ops are still failures — the outage is not swallowed either.
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.exec)).toBe("failed");
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.controlPlaneInfo)).toBe("failed");
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.coldStart)).toBe("failed");
	});

	it("fails every failed control-plane probe but keeps measuring", async () => {
		const { compute } = fakeCompute({ failInfo: true });
		const { samples, gaps } = await measureLifecycle(compute, {
			provider: "e2b",
			controlPlaneSamples: 3,
		});
		expect(countByOp(samples)[HARNESS_METRIC_IDS.controlPlaneInfo]).toBeUndefined();
		// Each failed probe records its own failed gap.
		const infoGaps = gaps.filter((g) => g.id === HARNESS_METRIC_IDS.controlPlaneInfo);
		expect(infoGaps.length).toBe(3);
		expect(infoGaps.every((g) => g.outcome === "failed")).toBe(true);
		expect(countByOp(samples)[HARNESS_METRIC_IDS.spawn]).toBe(1);
	});

	it("rejects when spawn fails — there is no sandbox to tear down", async () => {
		const { compute, calls } = fakeCompute({ failCreate: true });
		await expect(measureLifecycle(compute, { provider: "e2b" })).rejects.toThrow("create boom");
		expect(calls.order).toEqual(["create"]);
	});

	it("records a teardown failure as a failed gap rather than throwing out of finally", async () => {
		const { compute } = fakeCompute({ failDestroy: true });
		const { samples, gaps } = await measureLifecycle(compute, { provider: "e2b" });
		expect(countByOp(samples)[HARNESS_METRIC_IDS.spawn]).toBe(1);
		expect(countByOp(samples)[HARNESS_METRIC_IDS.teardown]).toBeUndefined();
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.teardown)).toBe("destroy boom");
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.teardown)).toBe("failed");
	});

	it("records a snapshot-create failure as a failed gap", async () => {
		const { compute } = fakeCompute({ withSnapshot: true, failSnapshotCreate: true });
		const { samples, gaps } = await measureLifecycle(compute, { provider: "e2b" });
		expect(countByOp(samples)[HARNESS_METRIC_IDS.snapshot]).toBeUndefined();
		expect(reasonFor(gaps, HARNESS_METRIC_IDS.snapshot)).toBe("snapshot boom");
		expect(outcomeFor(gaps, HARNESS_METRIC_IDS.snapshot)).toBe("failed");
	});
});

describe("aggregateLifecycle", () => {
	const raw = (operation: string, durationMs: number): RawRun => ({
		provider: "e2b",
		operation,
		durationMs,
	});

	it("groups Samples by Metric id and aggregates, in HARNESS_METRIC_IDS order", () => {
		const aggregates = aggregateLifecycle([
			raw(HARNESS_METRIC_IDS.controlPlaneInfo, 10),
			raw(HARNESS_METRIC_IDS.spawn, 200),
			raw(HARNESS_METRIC_IDS.controlPlaneInfo, 20),
			raw(HARNESS_METRIC_IDS.spawn, 100),
			raw(HARNESS_METRIC_IDS.controlPlaneInfo, 30),
		]);
		// spawn precedes control-plane info (declaration order), regardless of Sample order.
		expect(aggregates.map((a) => a.metricId)).toEqual([
			HARNESS_METRIC_IDS.spawn,
			HARNESS_METRIC_IDS.controlPlaneInfo,
		]);
		const spawn = aggregates[0];
		const info = aggregates[1];
		expect(spawn?.aggregates.n).toBe(2);
		expect(spawn?.aggregates.p50).toBe(150);
		expect(info?.aggregates.n).toBe(3);
		expect(info?.aggregates.p50).toBe(20);
	});

	it("omits operations with no Samples", () => {
		const aggregates = aggregateLifecycle([raw(HARNESS_METRIC_IDS.teardown, 5)]);
		expect(aggregates.map((a) => a.metricId)).toEqual([HARNESS_METRIC_IDS.teardown]);
	});

	it("returns an empty list for no Samples", () => {
		expect(aggregateLifecycle([])).toEqual([]);
	});
});
