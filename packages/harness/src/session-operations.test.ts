import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DriverModule,
	ExecResult,
	ProviderId,
	SandboxDriver,
	SandboxSession,
} from "@sandbox-benchmarks/driver";
import { bakedArtifactName, TARGET_SPEC } from "@sandbox-benchmarks/schema";
import { TOOLCHAIN_IMAGE_NAME, TOOLCHAIN_VERSION } from "@sandbox-benchmarks/schema/toolchain";
import { executeSuite, withSandboxWork } from "./index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const result = (stdout = ""): ExecResult => ({
	exit: { kind: "exited", code: 0 },
	stdout,
	stderr: "",
	durationMs: 1,
	truncated: false,
});
const artifact = { kind: "baked", ref: bakedArtifactName("e2b", "version") } as const;
function fixture(exec: SandboxSession["exec"]) {
	const calls: string[] = [];
	const session: SandboxSession = {
		sandboxRef: { provider: "e2b", id: "itest" },
		artifact,
		native: {},
		exec,
		async destroy() {
			calls.push("destroy");
		},
	};
	const driver: SandboxDriver = {
		probes: { observe: async () => ({ state: calls.includes("destroy") ? "absent" : "running" }) },
		async create(request, options) {
			expect(request.artifact).toEqual(artifact);
			expect(request.deadlineMs).toBe(1000);
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			calls.push("create");
			return session;
		},
	};
	const module: DriverModule<ProviderId> = {
		id: "e2b",
		driver: () => driver,
		provenance: { packageName: "fixture", version: "1" },
		createBudget: { owner: "harness", timeoutMs: 1000 },
		execution: { syncCapMs: null, durable: "none" },
		readiness: { startup: "create-returns-ready" },
	};
	return { allocation: { module, driver, request: { artifact, spec: TARGET_SPEC } }, calls };
}

describe("declarative session operations", () => {
	test("persists request evidence before readiness and observed evidence before a disk gap", async () => {
		const root = mkdtempSync(join(tmpdir(), "session-suite-"));
		roots.push(root);
		const { allocation, calls } = fixture(async (command) => {
			if (command === "sh -c 'exit 0'") {
				const files = readdirSync(root);
				expect(files).toHaveLength(1);
				expect(readFileSync(join(root, files[0] ?? ""), "utf8")).toContain("request-fallback");
			}
			if (command.includes("/toolchain-manifest.json"))
				return result(
					JSON.stringify({ image_name: TOOLCHAIN_IMAGE_NAME, image_version: TOOLCHAIN_VERSION }),
				);
			if (command.includes("df -Pk")) return result("1");
			return result();
		});
		await executeSuite({
			allocation,
			runId: "session-test",
			suiteName: "system",
			resultsDir: root,
		});
		expect(calls).toEqual(["create", "destroy"]);
		const contents = readdirSync(root)
			.map((name) => readFileSync(join(root, name), "utf8"))
			.join("\n");
		expect(contents).toContain("guest-fingerprint");
		expect(contents).toContain("disk-shortfall");
		expect(contents).toContain("itest");
	});
	test("readiness failure retains request attribution and always destroys", async () => {
		const root = mkdtempSync(join(tmpdir(), "session-suite-"));
		roots.push(root);
		const { allocation, calls } = fixture(async () => {
			throw new Error("not ready");
		});
		await expect(
			executeSuite({ allocation, runId: "session-test", suiteName: "system", resultsDir: root }),
		).rejects.toThrow("not ready");
		expect(calls).toEqual(["create", "destroy"]);
		expect(
			readdirSync(root)
				.map((name) => readFileSync(join(root, name), "utf8"))
				.join("\n"),
		).toContain("request-fallback");
	});
	test("managed work exposes native results and tears down after workload failure", async () => {
		const { allocation, calls } = fixture(async () => result());
		const failure = new Error("work failed");
		await expect(
			withSandboxWork(allocation, async ({ session, runner }) => {
				expect(session.sandboxRef.id).toBe("itest");
				expect((await runner.step("work", "true", 500)).exit).toEqual({ kind: "exited", code: 0 });
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(calls).toEqual(["create", "destroy"]);
	});
	test("managed work reclaims a create that resolves after its budget", async () => {
		const { allocation } = fixture(async () => result());
		const pending = Promise.withResolvers<SandboxSession>();
		let destroyed = false;
		let worked = false;
		const scope = withSandboxWork(
			{
				...allocation,
				module: { ...allocation.module, createBudget: { owner: "harness", timeoutMs: 1 } },
				driver: { create: () => pending.promise },
			},
			async () => {
				worked = true;
			},
		);
		await expect(scope).rejects.toThrow("Sandbox creation timed out");
		pending.resolve({
			sandboxRef: { provider: "e2b", id: "ilate" },
			artifact,
			native: {},
			exec: async () => result(),
			destroy: async () => {
				destroyed = true;
			},
		});
		for (let i = 0; i < 10 && !destroyed; i++) await Bun.sleep(1);
		expect(destroyed).toBe(true);
		expect(worked).toBe(false);
	});
});

test("suite teardown permits control-plane deletion beyond the old 15-second ceiling", async () => {
	const root = mkdtempSync(join(tmpdir(), "suite-teardown-"));
	roots.push(root);
	const { allocation, calls } = fixture(async (command) => {
		if (command.includes("/toolchain-manifest.json"))
			return result(
				JSON.stringify({ image_name: TOOLCHAIN_IMAGE_NAME, image_version: TOOLCHAIN_VERSION }),
			);
		if (command.includes("df -Pk")) return result("1");
		return result();
	});
	const create = allocation.driver.create;
	allocation.driver.create = async (request, options) => {
		const session = await create(request, options);
		return {
			...session,
			destroy: async () => {
				await Bun.sleep(25);
				calls.push("destroy");
			},
		};
	};
	// Compress only the old/new teardown ceilings; the simulated control-plane deletion takes 25ms.
	const original = globalThis.setTimeout;
	const accelerated = Object.assign((...args: Parameters<typeof setTimeout>) => {
		const [callback, ms, ...rest] = args;
		return original(callback, ms === 15_000 ? 15 : ms === 60_000 ? 60 : ms, ...rest);
	}, original);
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(accelerated);
	try {
		await executeSuite({
			allocation,
			runId: "teardown-test",
			suiteName: "system",
			resultsDir: root,
		});
		const file = readdirSync(root).find((name) => name.startsWith("cleanup-"));
		if (!file) throw new Error("missing cleanup receipt");
		expect(JSON.parse(readFileSync(join(root, file), "utf8"))).toMatchObject({
			completed: true,
			confirmedAbsent: true,
		});
	} finally {
		timer.mockRestore();
		await Bun.sleep(30);
	}
});
