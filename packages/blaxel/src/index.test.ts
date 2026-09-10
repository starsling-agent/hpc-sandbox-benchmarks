import { describe, expect, spyOn, test } from "bun:test";
import { SandboxInstance } from "@blaxel/core";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { sandboxRef } from "@sandbox-benchmarks/driver";
import blaxelDriver, {
	BLAXEL_ATTEMPT_LABEL,
	BLAXEL_EXECUTION,
	BLAXEL_IMAGE,
	BLAXEL_KEEPALIVE_PROCESS,
	BLAXEL_OWNER_LABEL,
	BLAXEL_PROVENANCE,
	BLAXEL_PTS_DATA_DIR,
	BLAXEL_READINESS,
	BLAXEL_REGION,
	BLAXEL_REQUEST_COVERAGE,
	BLAXEL_SANDBOX_ID,
	BLAXEL_VOLUME_HEADROOM_MB,
	blaxelSpec,
	execBlaxelCommand,
	isBlaxelNotFound,
} from "./index.ts";

const context = {
	env: { BL_API_KEY: "bl_test-key", BL_WORKSPACE: "test-workspace" },
	artifact: { kind: "none" },
	resolvedArtifact: { kind: "none" },
} as const;

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: { kind: "none" },
	deadlineMs: 300_000,
};

interface ProcessCall {
	readonly command: string;
	readonly name?: string;
	readonly keepAlive?: boolean;
	readonly waitForCompletion?: boolean;
	readonly timeout?: number;
}

function fakeInstance(
	name: string,
	options: {
		readonly volumeCapacityGb?: number;
		readonly memory?: number;
		readonly status?: string;
		readonly labels?: Record<string, string>;
		readonly keepaliveStatus?: string;
	} = {},
) {
	const processCalls: ProcessCall[] = [];
	const deletes: string[] = [];
	const instance = {
		metadata: { name, labels: options.labels ?? {} },
		spec: {
			runtime: { memory: options.memory ?? 8192, image: BLAXEL_IMAGE },
			region: BLAXEL_REGION,
		},
		status: options.status ?? "DEPLOYED",
		process: {
			exec: async (call: ProcessCall) => {
				processCalls.push(call);
				const base = { pid: "1234", name: call.name ?? "cmd", logs: "", stderr: "" };
				if (call.command.startsWith("df -Pk")) {
					return {
						...base,
						status: "completed",
						exitCode: 0,
						stdout: `${(options.volumeCapacityGb ?? 44) * 1024 * 1024}\n`,
					};
				}
				if (call.waitForCompletion === false) {
					return {
						...base,
						status: options.keepaliveStatus ?? "running",
						exitCode: 0,
						stdout: "",
					};
				}
				return { ...base, status: "completed", exitCode: 0, stdout: "ok" };
			},
		},
		fs: {
			read: async (path: string) => {
				if (path.endsWith("/missing")) {
					throw Object.assign(new Error("not found"), { response: { status: 404 } });
				}
				return "content";
			},
			write: async () => ({ message: "ok" }),
		},
		delete: async () => {
			deletes.push(name);
			return {};
		},
	};
	return { instance: instance as unknown as SandboxInstance, processCalls, deletes };
}

function fakePage(instances: readonly SandboxInstance[]) {
	return {
		data: instances.slice(0, 2),
		async *[Symbol.asyncIterator]() {
			yield* instances;
		},
	} as unknown as Awaited<ReturnType<typeof SandboxInstance.list>>;
}

describe("Blaxel module policy", () => {
	test("declares integration, readiness, native durable execution, and honest coverage", () => {
		expect(blaxelDriver.id).toBe("blaxel");
		expect(blaxelDriver.provenance).toEqual(BLAXEL_PROVENANCE);
		expect(BLAXEL_PROVENANCE.packageName).toBe("@blaxel/core");
		expect(blaxelDriver.readiness).toEqual(BLAXEL_READINESS);
		expect(blaxelDriver.execution).toEqual(BLAXEL_EXECUTION);
		expect(blaxelDriver.createBudget).toBeUndefined();
		const spec = blaxelSpec(context);
		expect(spec.createOptions.coverage).toEqual(BLAXEL_REQUEST_COVERAGE);
		expect(spec.hasWorkingFilesystem).toBe(true);
		expect(spec.inventory).toBeDefined();
		expect(spec.destroyById).toBeDefined();
		expect(spec.probes).toBeDefined();
		expect(BLAXEL_SANDBOX_ID.assert("benchmark-abc-123")).toBe("benchmark-abc-123");
		expect(() => BLAXEL_SANDBOX_ID.assert("Benchmark_1")).toThrow();
	});

	test("maps the request onto Blaxel's memory-coupled shape with a labelled name and volume", () => {
		const spec = blaxelSpec(context);
		const mapped = spec.createOptions.map(request, (detail) => {
			throw new Error(detail);
		});
		expect(mapped).toMatchObject({
			image: BLAXEL_IMAGE,
			memory: 8192,
			region: BLAXEL_REGION,
			ttl: "10800s",
			volumes: [
				expect.objectContaining({
					sizeMb: 40 * 1024 + BLAXEL_VOLUME_HEADROOM_MB,
					type: "ephemeral",
				}),
			],
		});
		const name = mapped.name;
		if (typeof name !== "string") throw new Error("mapped request has no sandbox name");
		expect(name).toMatch(/^benchmark-[0-9a-f-]{36}$/);
		expect(mapped.labels).toEqual({ [BLAXEL_OWNER_LABEL]: "blaxel", [BLAXEL_ATTEMPT_LABEL]: name });
		expect(spec.createRecovery?.locator(mapped)).toEqual({ kind: "name", value: name });
		for (const invalid of [
			{ ...request, spec: { ...request.spec, memoryGb: 16 } },
			{ ...request, spec: { ...request.spec, vcpus: 2 } },
			{ ...request, artifact: { kind: "image", ref: "ghcr.io/x/y:1" } },
		] as const) {
			expect(() =>
				spec.createOptions.map(invalid, (detail) => {
					throw new Error(detail);
				}),
			).toThrow();
		}
	});
});

describe("Blaxel lifecycle", () => {
	test("creates with the ephemeral volume, starts the keepalive, verifies the mount, and tears down by name", async () => {
		const fake = fakeInstance("benchmark-11111111-1111-4111-8111-111111111111");
		const create = spyOn(SandboxInstance, "create").mockResolvedValue(fake.instance);
		const remove = spyOn(SandboxInstance, "delete").mockResolvedValue({} as never);
		try {
			const driver = blaxelDriver.driver(context);
			const session = await driver.create(request);
			expect(session.sandboxRef).toEqual(sandboxRef("blaxel", fake.instance.metadata.name));
			expect(create).toHaveBeenCalledTimes(1);
			expect(create.mock.calls[0]?.[0]).toMatchObject({
				memory: 8192,
				region: BLAXEL_REGION,
				volumes: [
					{
						mountPath: BLAXEL_PTS_DATA_DIR,
						type: "ephemeral",
						sizeMb: 40 * 1024 + BLAXEL_VOLUME_HEADROOM_MB,
					},
				],
			});
			expect(fake.processCalls[0]).toMatchObject({
				name: BLAXEL_KEEPALIVE_PROCESS,
				command: "sleep infinity",
				keepAlive: true,
				timeout: 0,
				waitForCompletion: false,
			});
			expect(fake.processCalls[1]?.command).toContain("df -Pk");
			const result = await session.exec("echo hi");
			expect(result.exit).toEqual({ kind: "exited", code: 0 });
			expect(result.stdout).toBe("ok");
			await session.destroy();
			expect(remove).toHaveBeenCalledWith(fake.instance.metadata.name);
		} finally {
			create.mockRestore();
			remove.mockRestore();
		}
	});

	test("tears down an allocation whose volume is too small or whose keepalive never ran", async () => {
		for (const options of [{ volumeCapacityGb: 5 }, { keepaliveStatus: "failed" }] as const) {
			const fake = fakeInstance("benchmark-22222222-2222-4222-8222-222222222222", options);
			const create = spyOn(SandboxInstance, "create").mockResolvedValue(fake.instance);
			const remove = spyOn(SandboxInstance, "delete").mockResolvedValue({} as never);
			try {
				const error = await blaxelDriver
					.driver(context)
					.create(request)
					.catch((caught: unknown) => caught);
				expect(error).toMatchObject({ provider: "blaxel" });
				expect(remove).toHaveBeenCalledWith(fake.instance.metadata.name);
			} finally {
				create.mockRestore();
				remove.mockRestore();
			}
		}
	});

	test("withholds an exit code the sandbox never reported", async () => {
		const killed = {
			process: {
				exec: async () => ({ status: "killed", exitCode: 0, stdout: "partial", stderr: "" }),
			},
		} as unknown as SandboxInstance;
		expect(await execBlaxelCommand(killed, "sleep 1")).toEqual({
			stdout: "partial",
			stderr: "",
		});
	});

	test("recovers an ambiguous create by name and classifies structured refusals", async () => {
		const spec = blaxelSpec(context);
		if (!spec.createRecovery) throw new Error("missing create recovery");
		const get = spyOn(SandboxInstance, "get").mockRejectedValueOnce({ code: 404, error: "nope" });
		const remove = spyOn(SandboxInstance, "delete").mockResolvedValue({} as never);
		try {
			const locator = { kind: "name", value: "benchmark-x" } as const;
			expect(await spec.createRecovery.cleanup(spec.compute, locator, {})).toEqual({
				status: "absent",
			});
			get.mockResolvedValueOnce(fakeInstance("benchmark-x").instance);
			expect(await spec.createRecovery.cleanup(spec.compute, locator, {})).toEqual({
				status: "destroyed",
			});
			expect(remove).toHaveBeenCalledWith("benchmark-x");
			get.mockResolvedValueOnce(fakeInstance("benchmark-other").instance);
			await expect(spec.createRecovery.cleanup(spec.compute, locator, {})).rejects.toThrow(
				/unrelated sandbox/,
			);
		} finally {
			get.mockRestore();
			remove.mockRestore();
		}
		expect(spec.createRecovery.isDefinitive?.({ code: 401 })).toBe(true);
		expect(spec.createRecovery.isDefinitive?.(new Error("socket hang up"))).toBe(false);
		expect(spec.createRecovery.isRetryableCreate?.({ code: 429 })).toBe(true);
		expect(spec.createRecovery.isRetryableCreate?.({ code: 500 })).toBe(false);
		expect(isBlaxelNotFound({ code: 404 })).toBe(true);
		expect(isBlaxelNotFound(new Error("404 not found"))).toBe(false);
	});
});

describe("Blaxel account inventory and recovery", () => {
	test("drains the listing, owns by label or name, and skips sandboxes on their way out", async () => {
		const labelled = fakeInstance("custom-name", { labels: { [BLAXEL_OWNER_LABEL]: "blaxel" } });
		const named = fakeInstance("benchmark-33333333-3333-4333-8333-333333333333");
		const foreign = fakeInstance("someones-dev-box");
		const dying = fakeInstance("benchmark-44444444-4444-4444-8444-444444444444", {
			status: "DELETING",
		});
		const list = spyOn(SandboxInstance, "list").mockResolvedValue(
			fakePage([labelled.instance, named.instance, foreign.instance, dying.instance]),
		);
		try {
			const driver = blaxelDriver.driver(context);
			expect(await driver.inventory?.list()).toEqual({
				owned: [
					sandboxRef("blaxel", "custom-name"),
					sandboxRef("blaxel", named.instance.metadata.name),
				],
				foreignCount: 1,
			});
			expect(list).toHaveBeenCalledWith({ limit: 100, showTerminated: false });
		} finally {
			list.mockRestore();
		}
	});

	test("destroys by id and converges only on the control plane's own 404", async () => {
		const remove = spyOn(SandboxInstance, "delete").mockResolvedValue({} as never);
		try {
			const driver = blaxelDriver.driver(context);
			await driver.destroyById?.(sandboxRef("blaxel", "benchmark-leftover"));
			expect(remove).toHaveBeenCalledWith("benchmark-leftover");
			remove.mockRejectedValueOnce({ code: 404, error: "gone" });
			await driver.destroyById?.(sandboxRef("blaxel", "benchmark-leftover"));
			remove.mockRejectedValueOnce({ code: 500, error: "control plane unavailable" });
			await expect(
				driver.destroyById?.(sandboxRef("blaxel", "benchmark-leftover")),
			).rejects.toMatchObject({ code: "destroy-failed", provider: "blaxel" });
		} finally {
			remove.mockRestore();
		}
	});

	test("observes running, terminal, and absent sandboxes through the control plane", async () => {
		const get = spyOn(SandboxInstance, "get")
			.mockResolvedValueOnce(fakeInstance("benchmark-a").instance)
			.mockResolvedValueOnce(fakeInstance("benchmark-a", { status: "TERMINATED" }).instance)
			.mockRejectedValueOnce({ code: 404, error: "gone" });
		try {
			const probes = blaxelDriver.driver(context).probes;
			const ref = sandboxRef("blaxel", "benchmark-a");
			expect(await probes?.observe(ref)).toEqual({ state: "running" });
			expect(await probes?.observe(ref)).toEqual({ state: "terminal" });
			expect(await probes?.observe(ref)).toEqual({ state: "absent" });
		} finally {
			get.mockRestore();
		}
	});
});
