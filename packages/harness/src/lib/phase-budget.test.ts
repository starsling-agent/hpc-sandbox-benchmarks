import { expect, test } from "bun:test";
import type { SandboxSession } from "@sandbox-benchmarks/driver";
import { SessionStepRunner } from "./execute.ts";

test("an exhausted phase never launches a subsequent command", async () => {
	let calls = 0;
	let deadline = Date.now() + 60_000;
	const session: SandboxSession = {
		sandboxRef: { provider: "tama", id: "test" },
		artifact: { kind: "none" },
		native: undefined,
		destroy: async () => {},
		exec: async () => {
			calls++;
			return {
				exit: { kind: "exited", code: 0 },
				stdout: "",
				stderr: "",
				durationMs: 1,
				truncated: false,
			};
		},
	};
	const runner = new SessionStepRunner(
		session,
		{ syncCapMs: null, durable: "none" },
		undefined,
		{ mode: "fixed", times: 2 },
		() => deadline,
	);
	runner.phase = "benchmark";
	await runner.step("first command", "true", 1000);
	deadline = Date.now() - 1;
	await expect(runner.step("second command", "true", 1000)).rejects.toThrow("phase deadline");
	expect(calls).toBe(1);
});

test("foreground transport failure preserves attempted phase with unknown exit", async () => {
	const session: SandboxSession = {
		sandboxRef: { provider: "tama", id: "test" },
		artifact: { kind: "none" },
		native: undefined,
		destroy: async () => {},
		exec: async () => {
			throw new Error("transport unavailable");
		},
	};
	const runner = new SessionStepRunner(session, { syncCapMs: null, durable: "none" });
	runner.phase = "benchmark";
	await expect(runner.run("workload", "true", 1000)).rejects.toThrow("transport unavailable");
	expect(runner.stepLog).toMatchObject([{ label: "workload", phase: "benchmark", exitCode: null }]);
});

test("managed setup pins and verifies the experiment commit, independent of ambient branch defaults", async () => {
	const { setupSteps } = await import("./setup.ts");
	const sha = "a".repeat(40);
	const clone = setupSteps(
		{ commands: [], commandTimeoutMinutes: 1, timeoutMinutes: 1, dimensions: [], metrics: [] },
		sha,
	).find((step) => step.label === "clone repo");
	expect(clone?.script).toContain(`git checkout --detach "${sha}"`);
	expect(clone?.script).toContain(`test "$(git rev-parse HEAD)" = "${sha}"`);
});
