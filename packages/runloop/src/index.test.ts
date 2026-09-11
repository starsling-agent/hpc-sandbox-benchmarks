import { describe, expect, test } from "bun:test";
import type { Runloop } from "@runloop/api-client";
import { AuthenticationError, NotFoundError, RateLimitError } from "@runloop/api-client";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { sandboxRef } from "@sandbox-benchmarks/driver";
import { driverFromComputeSpec } from "@sandbox-benchmarks/driver/computesdk";
import type { RunloopClient } from "./index.ts";
import runloopDriver, {
	RUNLOOP_ATTEMPT_METADATA_KEY,
	RUNLOOP_CREATE_TIMEOUT_MS,
	RUNLOOP_EXECUTION,
	RUNLOOP_KEEP_ALIVE_SECONDS,
	RUNLOOP_OWNER_METADATA_KEY,
	RUNLOOP_PROVENANCE,
	RUNLOOP_READINESS,
	RUNLOOP_SANDBOX_ID,
	runloopSpec,
} from "./index.ts";

type DevboxView = Runloop.Devboxes.DevboxView;

const context = {
	env: { RUNLOOP_API_KEY: "rl_test-key" },
	artifact: { kind: "baked" },
	resolvedArtifact: { kind: "baked", ref: "sandbox-benchmarks-toolchain-v8" },
} as const;

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: context.resolvedArtifact,
	deadlineMs: RUNLOOP_CREATE_TIMEOUT_MS,
};

function devbox(overrides: Partial<DevboxView> = {}): DevboxView {
	return {
		id: "dbx_abc123",
		status: "running",
		create_time_ms: 1_700_000_000_000,
		end_time_ms: null,
		capabilities: [],
		launch_parameters: {},
		metadata: {},
		state_transitions: [],
		...overrides,
	} as DevboxView;
}

/** A Stainless page promise: awaitable for one page, async-iterable across the whole cursor. */
function page(rows: readonly DevboxView[]) {
	return Object.assign(Promise.resolve({ getPaginatedItems: () => [...rows] }), {
		[Symbol.asyncIterator]: async function* () {
			yield* rows;
		},
	});
}

interface FakeState {
	rows: DevboxView[];
	created: unknown[];
	awaited: unknown[];
	shutdown: unknown[];
	commands: string[];
	async: string[];
	written: Array<{ path: string; contents: string }>;
	awaitRunningFailure?: Error;
	shutdownFailure?: Error;
	diskCapacityGb: number;
	exec?: (command: string) => Runloop.Devboxes.DevboxAsyncExecutionDetailView;
}

function fakeClient(overrides: Partial<FakeState> = {}) {
	const state: FakeState = {
		rows: [],
		created: [],
		awaited: [],
		shutdown: [],
		commands: [],
		async: [],
		written: [],
		diskCapacityGb: 39.6,
		...overrides,
	};
	const completed = (
		exit_status: number | null,
		stdout: string,
		extra: Partial<Runloop.Devboxes.DevboxAsyncExecutionDetailView> = {},
	): Runloop.Devboxes.DevboxAsyncExecutionDetailView => ({
		devbox_id: "dbx_abc123",
		execution_id: "exe_1",
		status: "completed",
		exit_status,
		stdout,
		stderr: "",
		...extra,
	});
	const client = {
		api: {
			devboxes: {
				create: async (params: unknown) => {
					state.created.push(params);
					return devbox({ status: "provisioning" });
				},
				awaitRunning: async (id: string, options: unknown) => {
					state.awaited.push([id, options]);
					if (state.awaitRunningFailure) throw state.awaitRunningFailure;
					return devbox({ status: "running" });
				},
				retrieve: async (id: string) => {
					const row = state.rows.find((entry) => entry.id === id);
					if (!row) throw new NotFoundError(404, undefined, "devbox not found", {});
					return row;
				},
				list: () => page(state.rows),
				shutdown: async (id: string, params: unknown) => {
					state.shutdown.push([id, params]);
					if (state.shutdownFailure) throw state.shutdownFailure;
					return devbox({ id, status: "shutdown" });
				},
				executeAndAwaitCompletion: async (_id: string, params: { command: string }) => {
					state.commands.push(params.command);
					if (state.exec) return state.exec(params.command);
					if (params.command.startsWith("df -Pk"))
						return completed(0, `${Math.round(state.diskCapacityGb * 1024 * 1024)}\n`);
					if (params.command.startsWith("test -e")) return completed(0, "");
					return completed(0, `ran: ${params.command}`);
				},
				executeAsync: async (_id: string, params: { command: string }) => {
					state.async.push(params.command);
					return { devbox_id: "dbx_abc123", execution_id: "exe_bg", status: "running" };
				},
				readFileContents: async (_id: string, params: { file_path: string }) =>
					`contents of ${params.file_path}`,
				writeFileContents: async (_id: string, params: { file_path: string; contents: string }) => {
					state.written.push({ path: params.file_path, contents: params.contents });
					return { devbox_id: "dbx_abc123", exit_status: 0, stdout: "", stderr: "" };
				},
			},
		},
	} as unknown as RunloopClient;
	return { client, state };
}

function driverWith(overrides: Partial<FakeState> = {}) {
	const { client, state } = fakeClient(overrides);
	const spec = runloopSpec(context, () => client);
	return {
		state,
		spec,
		driver: driverFromComputeSpec("runloop", spec, context.resolvedArtifact, ["rl_test-key"]),
	};
}

describe("Runloop module policy", () => {
	test("declares its native SDK provenance, ready-on-create readiness, and a harness-owned budget", () => {
		expect(runloopDriver.id).toBe("runloop");
		expect(runloopDriver.provenance).toEqual(RUNLOOP_PROVENANCE);
		expect(RUNLOOP_PROVENANCE.packageName).toBe("@runloop/api-client");
		expect(runloopDriver.readiness).toEqual(RUNLOOP_READINESS);
		expect(runloopDriver.execution).toEqual(RUNLOOP_EXECUTION);
		expect(runloopDriver.createBudget).toEqual({
			owner: "harness",
			timeoutMs: RUNLOOP_CREATE_TIMEOUT_MS,
		});
		expect(RUNLOOP_SANDBOX_ID.assert("dbx_abc123")).toBe("dbx_abc123");
		expect(() => RUNLOOP_SANDBOX_ID.assert("sb-abc")).toThrow();
	});
});

describe("Runloop create", () => {
	test("boots the resolved Blueprint at the target size with an ownership marker and awaits running", async () => {
		const { driver, state } = driverWith();
		const session = await driver.create(request);
		expect(session.sandboxRef).toEqual(sandboxRef("runloop", "dbx_abc123"));
		expect(state.created).toHaveLength(1);
		const created = state.created[0] as Record<string, unknown>;
		expect(created).toMatchObject({
			blueprint_name: context.resolvedArtifact.ref,
			launch_parameters: {
				resource_size_request: "CUSTOM_SIZE",
				custom_cpu_cores: 4,
				custom_gb_memory: 8,
				custom_disk_size: 40,
				keep_alive_time_seconds: RUNLOOP_KEEP_ALIVE_SECONDS,
			},
		});
		expect(created.name).toMatch(/^benchmark-[0-9a-f-]{36}$/);
		expect(created.metadata).toEqual({
			[RUNLOOP_OWNER_METADATA_KEY]: "runloop",
			[RUNLOOP_ATTEMPT_METADATA_KEY]: created.name,
		});
		expect(state.awaited).toEqual([
			[
				"dbx_abc123",
				expect.objectContaining({ longPoll: { timeoutMs: RUNLOOP_CREATE_TIMEOUT_MS } }),
			],
		]);
		// The credential never enters the create request the guest could observe.
		expect(JSON.stringify(created)).not.toContain("rl_test-key");
		// Disk was verified in-guest after allocation, with the filesystem overhead allowance.
		expect(state.commands.some((command) => command.startsWith("df -Pk"))).toBe(true);
		await session.destroy();
		expect(state.shutdown).toEqual([["dbx_abc123", { force: "true" }]]);
	});

	test("rejects artifact, hardware, accelerator, and environment drift before allocation", async () => {
		const { driver, state } = driverWith();
		for (const invalid of [
			{ ...request, artifact: { kind: "baked" as const, ref: "some-other-blueprint" } },
			{ ...request, gpu: { model: "H100", count: 1 } },
			{ ...request, env: { X: "1" } },
		]) {
			const error = await driver.create(invalid).catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "invalid-create-request", provider: "runloop" });
		}
		expect(state.created).toHaveLength(0);
	});

	test("tears down an allocation whose root filesystem is smaller than requested", async () => {
		const { driver, state } = driverWith({ diskCapacityGb: 30 });
		const error = await driver.create(request).catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			code: "invalid-create-request",
			provider: "runloop",
			ref: { provider: "runloop", id: "dbx_abc123" },
		});
		expect(state.shutdown).toEqual([["dbx_abc123", { force: "true" }]]);
	});

	test("shuts down an accepted Devbox that never reaches running and reports the create failure", async () => {
		const { driver, state } = driverWith({ awaitRunningFailure: new Error("boot failed") });
		const error = await driver.create(request).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "runloop" });
		expect(state.shutdown).toEqual([["dbx_abc123", { force: "true" }]]);
	});

	test("classifies typed refusals and never regexes vendor prose", () => {
		const { spec } = driverWith();
		const recovery = spec.createRecovery;
		if (!recovery) throw new Error("missing create recovery");
		expect(recovery.isDefinitive?.(new AuthenticationError(401, undefined, "bad key", {}))).toBe(
			true,
		);
		expect(recovery.isRetryableCreate?.(new RateLimitError(429, undefined, "slow", {}))).toBe(true);
		expect(recovery.isDefinitive?.(new Error("HTTP 429 rate limit"))).toBe(false);
		expect(recovery.isRetryableCreate?.(new Error("capacity"))).toBe(false);
		expect(recovery.locator({ name: "benchmark-x", blueprint_name: "b" })).toEqual({
			kind: "marker",
			key: RUNLOOP_ATTEMPT_METADATA_KEY,
			value: "benchmark-x",
		});
	});

	test("recovers an ambiguous create only by its exact attempt marker", async () => {
		const marker = "benchmark-00000000-0000-4000-8000-000000000000";
		const { spec, state } = driverWith({
			rows: [
				devbox({ id: "dbx_mine", metadata: { [RUNLOOP_ATTEMPT_METADATA_KEY]: marker } }),
				devbox({ id: "dbx_other", metadata: { [RUNLOOP_ATTEMPT_METADATA_KEY]: "benchmark-z" } }),
				devbox({
					id: "dbx_gone",
					status: "shutdown",
					metadata: { [RUNLOOP_ATTEMPT_METADATA_KEY]: marker },
				}),
			],
		});
		const locator = { kind: "marker", key: RUNLOOP_ATTEMPT_METADATA_KEY, value: marker } as const;
		expect(await spec.createRecovery?.cleanup(spec.compute, locator, {})).toEqual({
			status: "destroyed",
		});
		expect(state.shutdown).toEqual([["dbx_mine", { force: "true" }]]);
		state.rows = state.rows.filter((row) => row.id !== "dbx_mine");
		expect(await spec.createRecovery?.cleanup(spec.compute, locator, {})).toEqual({
			status: "absent",
		});
	});
});

describe("Runloop commands and files", () => {
	test("runs synchronous commands to completion and keeps a withheld exit status as evidence", async () => {
		const { driver, state } = driverWith();
		const session = await driver.create(request);
		expect(await session.exec("echo hi")).toMatchObject({
			exit: { kind: "exited", code: 0 },
			stdout: "ran: echo hi",
		});
		state.exec = () => ({
			devbox_id: "dbx_abc123",
			execution_id: "exe_2",
			status: "completed",
			exit_status: null,
			stdout: "",
			stderr: "",
		});
		expect((await session.exec("true")).exit.kind).toBe("unknown");
		state.exec = () => ({
			devbox_id: "dbx_abc123",
			execution_id: "exe_3",
			status: "completed",
			exit_status: 0,
			stdout: "cut",
			stderr: "",
			stdout_truncated: true,
		});
		await expect(session.exec("cat big")).rejects.toMatchObject({ code: "exec-failed" });
		state.exec = () => ({
			devbox_id: "dbx_abc123",
			execution_id: "exe_4",
			status: "running",
		});
		await expect(session.exec("sleep")).rejects.toMatchObject({ code: "exec-failed" });
	});

	test("launches background work through the native async execution and exposes files", async () => {
		const { driver, state } = driverWith();
		const session = await driver.create(request);
		await session.launch?.("nohup sleep 60 &");
		expect(state.async).toEqual(["nohup sleep 60 &"]);
		expect(await session.files?.readFile("/tmp/x")).toBe("contents of /tmp/x");
		expect(await session.files?.exists("/tmp/x")).toBe(true);
		await session.files?.writeText("/tmp/y", "payload");
		expect(state.written).toEqual([{ path: "/tmp/y", contents: "payload" }]);
	});
});

describe("Runloop account inventory and recovery", () => {
	test("owns by either metadata key, skips terminal records, and counts the rest as foreign", async () => {
		const { driver } = driverWith({
			rows: [
				devbox({ id: "dbx_owned1", metadata: { [RUNLOOP_OWNER_METADATA_KEY]: "runloop" } }),
				devbox({
					id: "dbx_owned2",
					status: "suspended",
					metadata: { [RUNLOOP_ATTEMPT_METADATA_KEY]: "benchmark-legacy" },
				}),
				devbox({ id: "dbx_failed", status: "failure", metadata: {} }),
				devbox({ id: "dbx_foreign", metadata: {} }),
				devbox({
					id: "dbx_gone",
					status: "shutdown",
					metadata: { [RUNLOOP_OWNER_METADATA_KEY]: "runloop" },
				}),
			],
		});
		expect(await driver.inventory?.list()).toEqual({
			owned: [sandboxRef("runloop", "dbx_owned1"), sandboxRef("runloop", "dbx_owned2")],
			foreignCount: 1,
		});
	});

	test("observes live, terminal, and absent Devboxes", async () => {
		const { driver } = driverWith({
			rows: [
				devbox({ id: "dbx_live", status: "running" }),
				devbox({ id: "dbx_failed", status: "failure" }),
				devbox({ id: "dbx_down", status: "shutdown" }),
			],
		});
		expect(await driver.probes?.observe(sandboxRef("runloop", "dbx_live"))).toEqual({
			state: "running",
		});
		expect(await driver.probes?.observe(sandboxRef("runloop", "dbx_failed"))).toEqual({
			state: "terminal",
		});
		expect(await driver.probes?.observe(sandboxRef("runloop", "dbx_down"))).toEqual({
			state: "absent",
		});
		expect(await driver.probes?.observe(sandboxRef("runloop", "dbx_missing"))).toEqual({
			state: "absent",
		});
	});

	test("destroys by id with a forced shutdown and converges only on the SDK's not-found", async () => {
		const { driver, state } = driverWith();
		await driver.destroyById?.(sandboxRef("runloop", "dbx_leftover"));
		expect(state.shutdown).toEqual([["dbx_leftover", { force: "true" }]]);
		state.shutdownFailure = new NotFoundError(404, undefined, "gone", {});
		await driver.destroyById?.(sandboxRef("runloop", "dbx_leftover"));
		state.shutdownFailure = new Error("control plane unavailable");
		await expect(driver.destroyById?.(sandboxRef("runloop", "dbx_leftover"))).rejects.toMatchObject(
			{ code: "destroy-failed", provider: "runloop" },
		);
		await expect(driver.destroyById?.(sandboxRef("e2b", "dbx_leftover"))).rejects.toMatchObject({
			code: "invalid-sandbox-ref",
		});
	});
});
