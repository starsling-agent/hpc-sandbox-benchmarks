import { describe, expect, test } from "bun:test";
import type { ExecResult, SandboxSession } from "@sandbox-benchmarks/driver";
import { MIN, SessionStepRunner } from "./execute.ts";

function result(stdout = "", code = 0): ExecResult {
	return { exit: { kind: "exited", code }, stdout, stderr: "", durationMs: 1, truncated: false };
}
function session(overrides: Partial<SandboxSession> = {}): SandboxSession {
	return {
		sandboxRef: { provider: "e2b", id: "isession" },
		artifact: { kind: "none" },
		native: {},
		exec: async () => result(),
		destroy: async () => {},
		...overrides,
	};
}

describe("session execution", () => {
	test("preserves the entire direct execution result and unknown exits", async () => {
		const unknown: ExecResult = {
			...result("partial output"),
			exit: { kind: "unknown", detail: "connection closed" },
			truncated: true,
		};
		const runner = new SessionStepRunner(session({ exec: async () => unknown }), {
			syncCapMs: null,
			durable: "none",
		});
		expect(await runner.step("probe", "true", MIN, { allowFailure: true, silent: true })).toBe(
			unknown,
		);
		expect(runner.stepLog[0]?.exitCode).toBeNull();
		await expect(runner.step("required", "true", MIN, { silent: true })).rejects.toThrow(
			"unknown (connection closed)",
		);
	});
	test("reports a signal without inventing a numeric exit", async () => {
		const runner = new SessionStepRunner(
			session({
				exec: async () => ({ ...result(), exit: { kind: "signalled", signal: "SIGTERM" } }),
			}),
			{ syncCapMs: null, durable: "none" },
		);
		await expect(runner.step("killed", "true", MIN)).rejects.toThrow("signal SIGTERM");
		expect(runner.stepLog[0]?.exitCode).toBeNull();
	});
	test("launches exactly once and retains combined logs with transient readback retries", async () => {
		const launched: string[] = [];
		let reads = 0;
		const delays: number[] = [];
		const runner = new SessionStepRunner(
			session({
				launch: async (command) => {
					launched.push(command);
				},
				files: {
					exists: async () => true,
					readFile: async (path) => {
						if (path.endsWith(".done")) return "7";
						if (++reads === 1) throw new Error("transient file read");
						return "stdout and stderr\n";
					},
					writeText: async () => {},
				},
			}),
			{ syncCapMs: MIN, durable: "native-launch" },
			async (ms) => {
				delays.push(ms);
			},
		);
		const done = await runner.step("durable", "echo stdout; echo stderr >&2; exit 7", MIN, {
			allowFailure: true,
			silent: true,
		});
		expect(launched).toHaveLength(1);
		expect(launched[0]).not.toContain("nohup");
		expect(launched[0]).toContain("2>&1");
		expect(done.exit).toEqual({ kind: "exited", code: 7 });
		expect(done.stdout).toBe("stdout and stderr\n");
		expect(delays).toEqual([2000]);
	});
	test("uses the driver shell launch once when no native launch exists", async () => {
		const commands: string[] = [];
		const runner = new SessionStepRunner(
			session({
				exec: async (command) => {
					commands.push(command);
					if (command.includes("cat /tmp") && command.includes(".done")) return result("0");
					return result("output");
				},
			}),
			{ syncCapMs: MIN, durable: "shell-detach" },
		);
		await runner.step("shell", "true", MIN, { silent: true });
		expect(commands.filter((command) => command.includes("nohup"))).toHaveLength(1);
		expect(commands.find((command) => command.includes("nohup"))?.match(/nohup/g)).toHaveLength(1);
	});
	test("does not fabricate a numeric failure from a malformed done file", async () => {
		const runner = new SessionStepRunner(
			session({
				launch: async () => {},
				files: {
					exists: async () => true,
					readFile: async (path) => (path.endsWith(".done") ? "7garbage" : "partial log"),
					writeText: async () => {},
				},
			}),
			{ syncCapMs: MIN, durable: "native-launch" },
		);
		const done = await runner.step("malformed", "true", MIN, { allowFailure: true, silent: true });
		expect(done.exit).toEqual({ kind: "unknown", detail: "invalid detached completion status" });
		expect(done.stdout).toBe("partial log");
		expect(runner.stepLog[0]?.exitCode).toBeNull();
	});
});
