import { describe, expect, test } from "bun:test";
import type {
	CreateRequest,
	ExecOptions,
	SandboxDriver,
	SandboxSession,
} from "@sandbox-benchmarks/driver";
import type { DriverProviderId } from "@sandbox-benchmarks/drivers";
import { DRIVERS } from "@sandbox-benchmarks/drivers";
import { cleanupOwnedSandboxes } from "@sandbox-benchmarks/harness";
import type { LegacyAdapterId } from "@sandbox-benchmarks/providers";
import { isLegacyAdapterId, providers } from "@sandbox-benchmarks/providers";
import type { ProviderId } from "@sandbox-benchmarks/schema";
import { PROVIDERS, REGISTRY, TOOLCHAIN_VERSION } from "@sandbox-benchmarks/schema";
import {
	createOwnedDriverSession,
	driverTransport,
	isDriverProviderId,
	resolveDriverArtifact,
	sessionHandle,
	usesDriverSuite,
} from "./driver-run.ts";

/** A session with only the three required members; `files` and `launch` are deliberately absent. */
function bareSession(
	exec: (
		command: string,
		options?: ExecOptions,
	) => Promise<Awaited<ReturnType<SandboxSession["exec"]>>>,
	overrides: Partial<SandboxSession> = {},
): SandboxSession {
	return {
		sandboxRef: { provider: "e2b", id: "isandbox" },
		artifact: { kind: "baked", ref: "template" },
		native: undefined,
		exec,
		destroy: async () => {},
		...overrides,
	};
}

const okResult = (stdout = "", stderr = "") => ({
	exit: { kind: "exited", code: 0 } as const,
	stdout,
	stderr,
	durationMs: 1,
	truncated: false,
});

const createRequest: CreateRequest = {
	spec: { vcpus: 2, memoryGb: 4 },
	artifact: { kind: "baked", ref: "template" },
	deadlineMs: 60_000,
};

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
			? true
			: false
		: false;
type Expect<Condition extends true> = Condition;

describe("bench-suite driver vs legacy selection (Phase A unit 1)", () => {
	test("registered DriverModule ids and leftover adapters partition ProviderId", () => {
		type _complete = Expect<Equal<ProviderId, DriverProviderId | LegacyAdapterId>>;
		type _disjoint = Expect<
			Extract<DriverProviderId, LegacyAdapterId> extends never ? true : false
		>;
		const driverIds = Object.keys(DRIVERS);
		const adapterIds: string[] = providers.map((provider) => provider.name);
		expect(driverIds.sort()).toEqual(["e2b", "modal-gvisor", "modal-vm", "tama"]);
		expect([...driverIds, ...adapterIds].sort()).toEqual(PROVIDERS.map((meta) => meta.id).sort());
		expect(driverIds.filter((id) => adapterIds.includes(id))).toEqual([]);
		for (const id of driverIds) {
			expect(isDriverProviderId(id)).toBe(true);
			expect(isLegacyAdapterId(id)).toBe(false);
		}
		for (const id of adapterIds) {
			expect(isDriverProviderId(id)).toBe(false);
			expect(isLegacyAdapterId(id)).toBe(true);
		}
	});

	test("registered ids select runDriverSuite without --driver-path", () => {
		for (const id of Object.keys(DRIVERS)) {
			expect(usesDriverSuite(id)).toBe(true);
			expect(usesDriverSuite(id, false)).toBe(true);
			expect(usesDriverSuite(id, true)).toBe(true);
		}
	});

	test("waived ids stay on the legacy path unless --driver-path forces the driver lane", () => {
		expect(usesDriverSuite("daytona-vm")).toBe(false);
		expect(usesDriverSuite("runcloud")).toBe(false);
		expect(usesDriverSuite("novita", false)).toBe(false);
		expect(usesDriverSuite("daytona-vm", true)).toBe(true);
		expect(isDriverProviderId("runcloud")).toBe(false);
	});

	test("an unknown id does not invent a DriverModule", () => {
		expect(usesDriverSuite("nope")).toBe(false);
		expect(isDriverProviderId("nope")).toBe(false);
	});
});

describe("createOwnedDriverSession", () => {
	test("registers before create and releases ownership only after provider destroy", async () => {
		let createSignal: AbortSignal | undefined;
		let destroys = 0;
		const raw = bareSession(async () => okResult(), {
			destroy: async () => {
				destroys += 1;
			},
		});
		const driver: SandboxDriver = {
			create: async (_request, options) => {
				createSignal = options?.signal;
				return raw;
			},
		};
		const session = await createOwnedDriverSession(driver, createRequest);
		expect(createSignal).toBeInstanceOf(AbortSignal);
		await session.destroy();
		await session.destroy();
		expect(destroys).toBe(1);
	});

	test("can hand a kept session out of process ownership", async () => {
		let destroys = 0;
		const driver: SandboxDriver = {
			create: async () =>
				bareSession(async () => okResult(), {
					destroy: async () => {
						destroys += 1;
					},
				}),
		};
		const session = await createOwnedDriverSession(driver, createRequest);

		expect(session.releaseOwnership()).toBe(true);
		expect(session.releaseOwnership()).toBe(false);
		expect(await cleanupOwnedSandboxes()).toEqual([]);
		expect(destroys).toBe(0);
		await session.destroy();
		expect(destroys).toBe(1);
	});
});

describe("resolveDriverArtifact", () => {
	test("derives a baked provider's ref from the registry, per phase", () => {
		const version = resolveDriverArtifact("e2b");
		const candidate = resolveDriverArtifact("e2b", { phase: "candidate" });
		expect(version).toEqual({
			kind: "baked",
			ref: `sandbox-benchmarks-toolchain-${TOOLCHAIN_VERSION}`,
		});
		expect(candidate.kind).toBe("baked");
		expect("ref" in candidate && candidate.ref.endsWith("-candidate")).toBe(true);
	});

	test("derives an image provider's ref from the toolchain leaf", () => {
		const resolved = resolveDriverArtifact("tama");
		expect(resolved).toEqual({
			kind: "image",
			ref: `ghcr.io/starslingdev/sandbox-benchmarks-toolchain:${TOOLCHAIN_VERSION}`,
		});
	});

	test("an explicit ref overrides the derived default", () => {
		expect(resolveDriverArtifact("e2b", { ref: "my-template" })).toEqual({
			kind: "baked",
			ref: "my-template",
		});
	});

	test("rejects a ref for a provider that boots stock", () => {
		const stock = Object.keys(REGISTRY).find(
			(id) => REGISTRY[id as keyof typeof REGISTRY].artifact.kind === "none",
		);
		expect(stock).toBeDefined();
		expect(() =>
			resolveDriverArtifact(stock as Parameters<typeof resolveDriverArtifact>[0], { ref: "x" }),
		).toThrow(/cannot boot ref/);
	});

	test("a mirrored artifact cannot be resolved without an explicit ref", () => {
		expect(() => resolveDriverArtifact("vercel")).toThrow(/pass an explicit ref/);
		expect(resolveDriverArtifact("vercel", { ref: "vcr/image:v8" })).toEqual({
			kind: "mirror",
			ref: "vcr/image:v8",
		});
	});
});

describe("driverTransport", () => {
	test("a declared durable route becomes detachedPoll, and the cap crosses unchanged", () => {
		expect(driverTransport({ syncCapMs: 60_000, durable: "native-launch" })).toEqual({
			streaming: false,
			syncCapMs: 60_000,
			detachedPoll: true,
		});
		expect(driverTransport({ syncCapMs: 60_000, durable: "shell-detach" }).detachedPoll).toBe(true);
	});

	test("durable none is the only shape that disables the detached transport", () => {
		expect(driverTransport({ syncCapMs: null, durable: "none" })).toEqual({
			streaming: false,
			syncCapMs: null,
			detachedPoll: false,
		});
	});
});

describe("sessionHandle", () => {
	test("omits filesystem entirely when the session exposes none", () => {
		const handle = sessionHandle(bareSession(async () => okResult()));
		// Capability-by-presence: the detached poll must see `undefined`, never a throwing stub.
		expect(handle.filesystem).toBeUndefined();
		expect("filesystem" in handle).toBe(false);
	});

	test("exposes filesystem when the session has a working one", async () => {
		const handle = sessionHandle(
			bareSession(async () => okResult(), {
				files: {
					readFile: async () => "contents",
					exists: async () => true,
					writeText: async () => {},
				},
			}),
		);
		expect(await handle.filesystem?.readFile("/tmp/x")).toBe("contents");
		expect(await handle.filesystem?.exists("/tmp/x")).toBe(true);
	});

	test("carries the guest's real exit code through", async () => {
		const handle = sessionHandle(
			bareSession(async () => ({ ...okResult("out", "err"), exit: { kind: "exited", code: 7 } })),
		);
		expect(await handle.runCommand("sh -c 'exit 7'")).toEqual({
			stdout: "out",
			stderr: "err",
			exitCode: 7,
		});
	});

	test("preserves a withheld exit code as evidence rather than a bare 1", async () => {
		const handle = sessionHandle(
			bareSession(async () => ({
				...okResult(),
				exit: { kind: "unknown", detail: "vendor omitted status" },
			})),
		);
		const result = await handle.runCommand("sh -c true");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("vendor omitted status");
	});

	test("maps a signalled outcome onto a failure that names the signal", async () => {
		const handle = sessionHandle(
			bareSession(async () => ({ ...okResult(), exit: { kind: "signalled", signal: "SIGKILL" } })),
		);
		const result = await handle.runCommand("sh -c 'kill -9 $$'");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("SIGKILL");
	});

	test("a background request uses the session's native launch when present", async () => {
		const launched: string[] = [];
		const handle = sessionHandle(
			bareSession(
				async () => {
					throw new Error("exec must not run a background command");
				},
				{
					launch: async (command) => {
						launched.push(command);
					},
				},
			),
		);
		expect(await handle.runCommand("long-job", { background: true })).toEqual({
			stdout: "",
			stderr: "",
			exitCode: 0,
		});
		expect(launched).toEqual(["long-job"]);
	});

	test("a background request falls back to the kit's detach when launch is absent", async () => {
		const commands: string[] = [];
		const handle = sessionHandle(
			bareSession(async (command) => {
				commands.push(command);
				return okResult();
			}),
		);
		await handle.runCommand("long-job", { background: true });
		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("nohup");
		expect(commands[0]).toContain("long-job");
	});
});
