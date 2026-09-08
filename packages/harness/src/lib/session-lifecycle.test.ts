import { describe, expect, test } from "bun:test";
import type {
	CreateRequest,
	ExecResult,
	SandboxDriver,
	SandboxSession,
} from "@sandbox-benchmarks/driver";
import { HARNESS_METRIC_IDS, TARGET_SPEC } from "@sandbox-benchmarks/schema";
import { measureDriverLifecycle } from "./lifecycle.ts";

const request: CreateRequest = { spec: TARGET_SPEC, artifact: { kind: "none" }, deadlineMs: 1000 };
const exited = (code: number): ExecResult => ({
	exit: { kind: "exited", code },
	stdout: "",
	stderr: "",
	durationMs: 1,
	truncated: false,
});

describe("native lifecycle measurements", () => {
	test("preserves measurement boundaries, resolved failures, binding and snapshot ownership", async () => {
		const order: string[] = [];
		let clock = 0;
		const session: SandboxSession = {
			sandboxRef: { provider: "e2b", id: "itest" },
			artifact: request.artifact,
			native: {},
			exec: async (command) => {
				order.push(command);
				return exited(command === "echo ok" ? 0 : 7);
			},
			destroy: async () => {
				order.push("destroy");
			},
		};
		const driver: SandboxDriver = {
			async create(input, options) {
				expect(input).toBe(request);
				expect(options?.signal).toBeInstanceOf(AbortSignal);
				order.push("create");
				return session;
			},
			probes: {
				async observe() {
					throw new Error("describe should take precedence");
				},
				async describe(ref) {
					expect(driver.probes).toBe(this);
					expect(ref).toEqual(session.sandboxRef);
					order.push("describe");
				},
				async list() {
					expect(driver.probes).toBe(this);
					order.push("list");
					return [];
				},
			},
			snapshots: {
				async create(owned) {
					expect(owned.sandboxRef).toEqual(session.sandboxRef);
					order.push("snapshot");
					return { snapshotId: "snapshot-1" };
				},
				async delete(id) {
					expect(id).toBe("snapshot-1");
					order.push("delete snapshot");
				},
			},
		};
		const measurement = await measureDriverLifecycle(driver, request, {
			provider: "e2b",
			controlPlaneSamples: 2,
			now: () => ++clock,
		});
		expect(measurement.gaps).toEqual([]);
		expect(measurement.samples).toHaveLength(11);
		expect(
			measurement.samples.find((s) => s.operation === HARNESS_METRIC_IDS.spawn)?.durationMs,
		).toBe(1);
		expect(
			measurement.samples.find((s) => s.operation === HARNESS_METRIC_IDS.coldStart)?.durationMs,
		).toBe(2);
		expect(order).toEqual([
			"create",
			"echo ok",
			"true",
			"head -c 65536 /dev/zero | tr '\\0' 'a'",
			"describe",
			"describe",
			"list",
			"list",
			"snapshot",
			"delete snapshot",
			"destroy",
		]);
	});

	test("unknown readiness creates failed readiness gaps and preserves disabled/absent gaps", async () => {
		let destroyed = false;
		const driver: SandboxDriver = {
			create: async () => ({
				sandboxRef: { provider: "e2b", id: "itest" },
				artifact: request.artifact,
				native: {},
				exec: async () => ({ ...exited(0), exit: { kind: "unknown", detail: "lost status" } }),
				destroy: async () => {
					destroyed = true;
				},
			}),
		};
		const measurement = await measureDriverLifecycle(driver, request, {
			provider: "e2b",
			readinessMaxAttempts: 1,
			payload: false,
			snapshot: false,
		});
		expect(measurement.samples.map((s) => s.operation)).toEqual([
			HARNESS_METRIC_IDS.spawn,
			HARNESS_METRIC_IDS.teardown,
		]);
		expect(measurement.gaps.find((g) => g.id === HARNESS_METRIC_IDS.coldStart)?.outcome).toBe(
			"failed",
		);
		expect(measurement.gaps.find((g) => g.id === HARNESS_METRIC_IDS.execPayload64k)?.outcome).toBe(
			"skipped",
		);
		expect(destroyed).toBe(true);
	});

	test("uses truthful observe fallback and rejects malformed list responses", async () => {
		let observed = 0;
		const driver: SandboxDriver = {
			create: async () => ({
				sandboxRef: { provider: "e2b", id: "itest" },
				artifact: request.artifact,
				native: {},
				exec: async () => exited(0),
				destroy: async () => {},
			}),
			probes: {
				async observe() {
					expect(driver.probes).toBe(this);
					observed++;
					return { state: "running" };
				},
				async list() {
					return { items: [] };
				},
			},
		};
		const measurement = await measureDriverLifecycle(driver, request, {
			provider: "e2b",
			controlPlaneSamples: 2,
		});
		expect(observed).toBe(2);
		expect(
			measurement.gaps.filter((g) => g.id === HARNESS_METRIC_IDS.controlPlaneList),
		).toHaveLength(2);
		expect(
			measurement.samples.filter((s) => s.operation === HARNESS_METRIC_IDS.controlPlaneList),
		).toHaveLength(0);
	});
});
