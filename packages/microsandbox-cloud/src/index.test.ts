import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { sandboxRef } from "@sandbox-benchmarks/driver";
import {
	InvalidConfigError,
	IoError,
	Sandbox as MsbSandbox,
	SandboxFsOpsError,
	SandboxNotFoundError,
} from "microsandbox";
import microsandboxCloud, {
	isMicrosandboxOwned,
	MICROSANDBOX_CREATE_BUDGET,
	MICROSANDBOX_CREATE_TIMEOUT_MS,
	MICROSANDBOX_EXECUTION,
	MICROSANDBOX_LABEL_MARKER,
	MICROSANDBOX_PROVENANCE,
	MICROSANDBOX_READINESS,
	MICROSANDBOX_SANDBOX_ID,
	MICROSANDBOX_SANDBOX_LIFETIME_MS,
	microsandboxCloudSpec,
} from "./index.ts";

const context = {
	env: { MSB_API_KEY: "msb_test-key" },
	artifact: { kind: "image" },
	resolvedArtifact: { kind: "image", ref: "ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8" },
} as const;

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: context.resolvedArtifact,
	deadlineMs: 300_000,
};

const OWNED_A = "bench-cloud-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNED_B = "bench-cloud-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Restorable = { mockRestore(): void };
let restores: Restorable[] = [];
function restore<T extends Restorable>(spy: T): T {
	restores.push(spy);
	return spy;
}
afterEach(() => {
	for (const spy of restores.reverse()) spy.mockRestore();
	restores = [];
});

/** A native sandbox whose config reports the given root disk (in the live-sandbox shape the SDK
 *  returns for a created sandbox) and whose exec echoes its script. */
function fakeNative(name: string, diskSizeMib = 40960) {
	const execs: string[] = [];
	const files = new Map<string, string>();
	const native = {
		name,
		config: async () => ({
			resources: { cpus: 4, memoryMib: 8192, maxCpus: 4, maxMemoryMib: 8192 },
			image: { Oci: { reference: "ref", rootDisk: { kind: "managed", sizeMib: diskSizeMib } } },
		}),
		execWith: async (_cmd: string, configure: (b: unknown) => unknown) => {
			let script = "";
			const builder = {
				args: (args: string[]) => {
					script = args[1] ?? "";
					return builder;
				},
			};
			configure(builder);
			execs.push(script);
			return {
				code: script.startsWith("exit ") ? Number(script.slice(5)) : 0,
				stdout: () => `ran:${script}`,
				stderr: () => "",
			};
		},
		fs: () => ({
			readToString: async (path: string) => {
				const content = files.get(path);
				if (content === undefined) throw new SandboxFsOpsError("no such file or directory");
				return content;
			},
			exists: async (path: string) => files.has(path),
			write: async (path: string, content: string) => {
				files.set(path, content);
			},
		}),
	};
	return { native: native as unknown as MsbSandbox, execs, files };
}

/** A builder Proxy that records every setter call and resolves `create` to the given native. */
function fakeBuilder(create: () => Promise<unknown>) {
	const calls: Array<[string, unknown[]]> = [];
	let builder: Record<PropertyKey, unknown>;
	builder = new Proxy(
		{},
		{
			get: (_target, property) =>
				property === "create"
					? create
					: (...args: unknown[]) => {
							calls.push([String(property), args]);
							return builder;
						},
		},
	);
	return { builder: builder as unknown as ReturnType<typeof MsbSandbox.builder>, calls };
}

function fakeHandle(name: string, status = "running") {
	const events: string[] = [];
	const handle = {
		name,
		status,
		configJson: JSON.stringify({ labels: { [MICROSANDBOX_LABEL_MARKER]: "microsandbox-cloud" } }),
		createdAt: new Date("2026-09-10T00:00:00Z"),
		requestStop: async () => {
			events.push("requestStop");
		},
		waitUntilStopped: async () => {
			events.push("waitUntilStopped");
			return { name, status: "stopped" };
		},
		connect: async () => {
			events.push("connect");
			return fakeNative(name).native;
		},
	};
	return { handle: handle as unknown as Awaited<ReturnType<typeof MsbSandbox.get>>, events };
}

describe("Microsandbox Cloud module policy", () => {
	test("declares integration, readiness, shell-detach execution, and a pull-sized create budget", () => {
		expect(microsandboxCloud.id).toBe("microsandbox-cloud");
		expect(microsandboxCloud.provenance).toEqual(MICROSANDBOX_PROVENANCE);
		expect(MICROSANDBOX_PROVENANCE.packageName).toBe("microsandbox");
		expect(microsandboxCloud.readiness).toEqual(MICROSANDBOX_READINESS);
		expect(microsandboxCloud.execution).toEqual(MICROSANDBOX_EXECUTION);
		expect(microsandboxCloud.createBudget).toEqual(MICROSANDBOX_CREATE_BUDGET);
		expect(MICROSANDBOX_CREATE_TIMEOUT_MS).toBe(20 * 60_000);
	});

	test("maps the pinned request to a named, labelled, size-limited ephemeral create", () => {
		const spec = microsandboxCloudSpec(context);
		const mapped = spec.createOptions.map(request, (detail) => {
			throw new Error(detail);
		});
		expect(mapped).toMatchObject({
			image: context.resolvedArtifact.ref,
			spec: request.spec,
		});
		const name = String(mapped.name);
		expect(MICROSANDBOX_SANDBOX_ID.assert(name)).toBe(name);
		expect(spec.createRecovery?.locator(mapped)).toEqual({ kind: "name", value: name });
		expect(spec.hasWorkingFilesystem).toBe(true);
		expect(spec.probes).toBeDefined();
		expect(spec.inventory).toBeDefined();
		expect(spec.destroyById).toBeDefined();
		const unsupported = (detail: string): never => {
			throw new Error(detail);
		};
		expect(() =>
			spec.createOptions.map(
				{ ...request, artifact: { kind: "image", ref: "other" } },
				unsupported,
			),
		).toThrow(/does not match/);
		expect(() =>
			spec.createOptions.map({ ...request, gpu: { model: "H100", count: 1 } }, unsupported),
		).toThrow(/accelerators/);
		expect(() =>
			spec.createOptions.map({ ...request, spec: { vcpus: 4, memoryGb: 8 } }, unsupported),
		).toThrow(/root disk/);
	});

	test("owns exactly the name shape the benchmark generates", () => {
		expect(isMicrosandboxOwned(OWNED_A)).toBe(true);
		expect(isMicrosandboxOwned("bench-cloud-not-a-uuid")).toBe(false);
		expect(isMicrosandboxOwned("somebody-else")).toBe(false);
	});
});

describe("Microsandbox Cloud lifecycle through the bridge", () => {
	test("creates through the SDK builder, verifies disk, and tears down stop-before-remove", async () => {
		const created = fakeNative("pending");
		const { builder, calls } = fakeBuilder(async () => created.native);
		let builtName = "";
		restore(
			spyOn(MsbSandbox, "builder").mockImplementation((name: string) => {
				builtName = name;
				(created.native as { name: string }).name = name;
				return builder;
			}),
		);
		const stopped = fakeHandle("", "running");
		restore(
			spyOn(MsbSandbox, "get").mockImplementation(async (name: string) => {
				(stopped.handle as { name: string }).name = name;
				return stopped.handle;
			}),
		);
		const removed: string[] = [];
		restore(
			spyOn(MsbSandbox, "remove").mockImplementation(async (name: string) => {
				removed.push(name);
			}),
		);

		const driver = microsandboxCloud.driver(context);
		const session = await driver.create(request);
		expect(session.sandboxRef).toEqual(sandboxRef("microsandbox-cloud", builtName));
		expect(Object.fromEntries(calls)).toMatchObject({
			image: [context.resolvedArtifact.ref],
			rootDisk: [40960],
			cpus: [4],
			memory: [8192],
			maxDuration: [MICROSANDBOX_SANDBOX_LIFETIME_MS / 1000],
			detached: [true],
			ephemeral: [true],
			label: [MICROSANDBOX_LABEL_MARKER, "microsandbox-cloud"],
		});
		expect(calls.map(([name]) => name)).not.toContain("envs");
		// Verification reads the record's own config; no in-guest command runs before the first exec.
		expect(created.execs).toEqual([]);
		// The credential lives in the backend selection only — never in a builder call.
		expect(JSON.stringify(calls)).not.toContain("msb_test-key");

		const result = await session.exec("echo hi");
		expect(result.exit).toEqual({ kind: "exited", code: 0 });
		expect(result.stdout).toBe("ran:echo hi");
		expect(await session.files?.exists("/tmp/absent")).toBe(false);
		await session.files?.writeText("/tmp/probe/file.txt", "payload");
		expect(created.execs.at(-1)).toBe("mkdir -p '/tmp/probe'");
		expect(await session.files?.readFile("/tmp/probe/file.txt")).toBe("payload");

		await session.destroy();
		expect(stopped.events).toEqual(["requestStop", "waitUntilStopped"]);
		expect(removed).toEqual([builtName]);
	});

	test("tears down an undersized allocation instead of measuring on it", async () => {
		const created = fakeNative("pending", 24576);
		const { builder } = fakeBuilder(async () => created.native);
		restore(
			spyOn(MsbSandbox, "builder").mockImplementation((name: string) => {
				(created.native as { name: string }).name = name;
				return builder;
			}),
		);
		restore(
			spyOn(MsbSandbox, "get").mockImplementation(
				async (name: string) => fakeHandle(name, "stopped").handle,
			),
		);
		const remove = restore(spyOn(MsbSandbox, "remove").mockResolvedValue(undefined));
		const error = await microsandboxCloud
			.driver(context)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "invalid-create-request", provider: "microsandbox-cloud" });
		expect(remove).toHaveBeenCalledTimes(1);
	});

	test("reconciles a rejected create by its name and removes the residual record", async () => {
		let builtName = "";
		const { builder } = fakeBuilder(async () => {
			throw new IoError("response lost");
		});
		restore(
			spyOn(MsbSandbox, "builder").mockImplementation((name: string) => {
				builtName = name;
				return builder;
			}),
		);
		const residue = fakeHandle("", "crashed");
		restore(
			spyOn(MsbSandbox, "get").mockImplementation(async (name: string) => {
				(residue.handle as { name: string }).name = name;
				return residue.handle;
			}),
		);
		const removed: string[] = [];
		restore(
			spyOn(MsbSandbox, "remove").mockImplementation(async (name: string) => {
				removed.push(name);
			}),
		);
		const error = await microsandboxCloud
			.driver(context)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "microsandbox-cloud" });
		// A crashed residue is not "stopped", so it is stopped first or remove() would reject and leak.
		expect(residue.events).toEqual(["requestStop", "waitUntilStopped"]);
		expect(removed).toEqual([builtName]);
	});

	test("treats only an SDK-refused configuration as definitive and never marks a retry", () => {
		const recovery = microsandboxCloudSpec(context).createRecovery;
		expect(recovery?.isDefinitive?.(new InvalidConfigError("bad config"))).toBe(true);
		expect(recovery?.isDefinitive?.(new Error("HTTP 429 capacity"))).toBe(false);
		expect(recovery?.isRetryableCreate).toBeUndefined();
	});

	test("surfaces a command that never reached the guest instead of synthesizing an exit", async () => {
		let execs = 0;
		const native = {
			name: "pending",
			// The listed-record config shape: verification must read the allocation from it as well.
			config: async () => ({ resources: { diskSizeMib: 40960, memoryMib: 8192, vcpus: 4 } }),
			execWith: async () => {
				execs += 1;
				throw new IoError("connection closed after acceptance");
			},
		};
		const { builder } = fakeBuilder(async () => native);
		restore(
			spyOn(MsbSandbox, "builder").mockImplementation((name: string) => {
				native.name = name;
				return builder;
			}),
		);
		const session = await microsandboxCloud.driver(context).create(request);
		// A synthesized exit would leave a detached launch polled for until the step budget expired,
		// and the command must not be replayed either: exactly one exec attempt, then a typed failure.
		await expect(session.exec("touch /tmp/must-run-once")).rejects.toMatchObject({
			code: "exec-failed",
			provider: "microsandbox-cloud",
		});
		expect(execs).toBe(1);
	});

	test("reconnects once for an idempotent filesystem read on a stale agent", async () => {
		let reads = 0;
		const stale = {
			name: "pending",
			config: fakeNative("x").native.config,
			execWith: fakeNative("x").native.execWith,
			fs: () => ({
				readToString: async () => {
					reads += 1;
					throw new IoError("stale agent");
				},
			}),
		};
		const fresh = fakeNative("fresh");
		fresh.files.set("/tmp/result", "recovered");
		const { builder } = fakeBuilder(async () => stale);
		restore(
			spyOn(MsbSandbox, "builder").mockImplementation((name: string) => {
				stale.name = name;
				return builder;
			}),
		);
		restore(
			spyOn(MsbSandbox, "get").mockImplementation(
				async (name: string) =>
					({
						name,
						status: "running",
						connect: async () => fresh.native,
					}) as unknown as Awaited<ReturnType<typeof MsbSandbox.get>>,
			),
		);
		const session = await microsandboxCloud.driver(context).create(request);
		expect(await session.files?.readFile("/tmp/result")).toBe("recovered");
		expect(reads).toBe(1);
	});

	test("refuses to reboot a sandbox that is no longer running", async () => {
		const stale = {
			name: "pending",
			config: fakeNative("x").native.config,
			execWith: fakeNative("x").native.execWith,
			fs: () => ({
				readToString: async () => {
					throw new IoError("stale agent");
				},
			}),
		};
		const { builder } = fakeBuilder(async () => stale);
		restore(
			spyOn(MsbSandbox, "builder").mockImplementation((name: string) => {
				stale.name = name;
				return builder;
			}),
		);
		restore(
			spyOn(MsbSandbox, "get").mockImplementation(
				async (name: string) => fakeHandle(name, "stopped").handle,
			),
		);
		const session = await microsandboxCloud.driver(context).create(request);
		await expect(session.files?.readFile("/tmp/anything")).rejects.toMatchObject({
			code: "filesystem-failed",
		});
	});
});

describe("Microsandbox Cloud account inventory and recovery", () => {
	test("drains every cursor page, owns by name shape, and counts the rest as foreign", async () => {
		const pages = [
			{
				sandboxes: [fakeHandle(OWNED_A, "running").handle, fakeHandle("dev-box", "running").handle],
				nextCursor: "page-2",
			},
			{
				sandboxes: [
					fakeHandle(OWNED_B, "stopped").handle,
					fakeHandle("other-stopped", "stopped").handle,
				],
				nextCursor: undefined,
			},
		];
		const cursors: Array<string | undefined> = [];
		restore(
			spyOn(MsbSandbox, "listWith").mockImplementation(async (configure) => {
				let cursor: string | undefined;
				const list = {
					limit: () => list,
					cursor: (value: string) => {
						cursor = value;
						return list;
					},
				};
				configure(list as never);
				cursors.push(cursor);
				const page = pages.shift();
				if (!page) throw new Error("listed past the last page");
				return page as never;
			}),
		);
		const driver = microsandboxCloud.driver(context);
		expect(await driver.inventory?.list()).toEqual({
			owned: [sandboxRef("microsandbox-cloud", OWNED_A), sandboxRef("microsandbox-cloud", OWNED_B)],
			foreignCount: 2,
		});
		expect(cursors).toEqual([undefined, "page-2"]);
	});

	test("refuses a listing that repeats its continuation cursor", async () => {
		restore(
			spyOn(MsbSandbox, "listWith").mockResolvedValue({
				sandboxes: [],
				nextCursor: "loop",
			} as never),
		);
		await expect(microsandboxCloud.driver(context).inventory?.list()).rejects.toMatchObject({
			code: "probe-failed",
			provider: "microsandbox-cloud",
		});
	});

	test("destroys by id with stop-before-remove and converges only on the SDK's absence", async () => {
		const running = fakeHandle(OWNED_A, "running");
		const get = restore(spyOn(MsbSandbox, "get").mockResolvedValue(running.handle));
		const removed: string[] = [];
		restore(
			spyOn(MsbSandbox, "remove").mockImplementation(async (name: string) => {
				removed.push(name);
			}),
		);
		const driver = microsandboxCloud.driver(context);
		await driver.destroyById?.(sandboxRef("microsandbox-cloud", OWNED_A));
		expect(running.events).toEqual(["requestStop", "waitUntilStopped"]);
		expect(removed).toEqual([OWNED_A]);

		get.mockRejectedValueOnce(new SandboxNotFoundError("gone"));
		await driver.destroyById?.(sandboxRef("microsandbox-cloud", OWNED_A));
		get.mockRejectedValueOnce(new IoError("control plane unavailable"));
		await expect(
			driver.destroyById?.(sandboxRef("microsandbox-cloud", OWNED_A)),
		).rejects.toMatchObject({ code: "destroy-failed", provider: "microsandbox-cloud" });
		await expect(
			driver.destroyById?.(sandboxRef("microsandbox-cloud", "not-ours")),
		).rejects.toMatchObject({ code: "invalid-sandbox-ref" });
	});

	test("observes running, terminal-but-present, and absent records distinctly", async () => {
		const get = restore(spyOn(MsbSandbox, "get").mockResolvedValue(fakeHandle(OWNED_A).handle));
		const probes = microsandboxCloud.driver(context).probes;
		const ref = sandboxRef("microsandbox-cloud", OWNED_A);
		expect(await probes?.observe(ref)).toEqual({ state: "running" });
		get.mockResolvedValueOnce(fakeHandle(OWNED_A, "stopped").handle);
		expect(await probes?.observe(ref)).toEqual({ state: "terminal" });
		get.mockRejectedValueOnce(new SandboxNotFoundError("gone"));
		expect(await probes?.observe(ref)).toEqual({ state: "absent" });
	});
});
