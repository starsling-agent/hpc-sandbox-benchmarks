import { describe, expect, it } from "bun:test";
import type { ProviderTransport } from "@sandbox-benchmarks/schema";
import { getProvider, PTS_STATE_SELECT_SH } from "@sandbox-benchmarks/schema";
import type { SandboxHandle } from "./execute.ts";
import {
	buildPreamble,
	DEFAULT_PTS_TIMES_TO_RUN,
	MIN,
	PREAMBLE,
	resolvePtsPassPolicy,
	StepRunner,
	selectTransport,
	shellQuote,
} from "./execute.ts";

const CAPPED: ProviderTransport = { streaming: false, syncCapMs: MIN, detachedPoll: true };
const UNCAPPED: ProviderTransport = { streaming: false, syncCapMs: null, detachedPoll: true };
const CAPPED_NO_DETACH: ProviderTransport = {
	streaming: false,
	syncCapMs: MIN,
	detachedPoll: false,
};

describe("selectTransport", () => {
	it("detaches a step that could reach or outlast a capped provider's synchronous limit", () => {
		// Budget past the cap, and the provider supports detached+poll → detached.
		expect(selectTransport(CAPPED, 2 * MIN)).toBe("detached");
		// Budget exactly at the cap could run right up to a hard limit with no margin (E2B's cap *is*
		// its SDK connection timeout) → detached, not sync. The boundary is inclusive of detach.
		expect(selectTransport(CAPPED, MIN)).toBe("detached");
	});

	it("keeps a step safely within the cap synchronous", () => {
		// Strictly under the cap → direct exec.
		expect(selectTransport(CAPPED, MIN - 1)).toBe("sync");
		expect(selectTransport(CAPPED, MIN / 2)).toBe("sync");
	});

	it("keeps every step synchronous on an uncapped provider", () => {
		// No cap → a synchronous exec is always safe, even for a long step.
		expect(selectTransport(UNCAPPED, 200 * MIN)).toBe("sync");
	});

	it("stays synchronous past the cap when the provider can't detach (no durable alternative)", () => {
		expect(selectTransport(CAPPED_NO_DETACH, 5 * MIN)).toBe("sync");
	});

	it("detaches a suite-length step on namespace, whose sync exec is capped in practice", () => {
		// Regression guard against the declaration this fixes, read from the REAL registry rather than a
		// fixture — a fixture would keep passing if the registry regressed. namespace was declared
		// uncapped + detachedPoll:false, which routed a 55-minute benchmark through one synchronous exec;
		// live run 30314097333 lost it at 4m18.8s with two of three PTS profiles done. A suite-length step
		// must detach here, while a short step must still take the cheap synchronous path.
		// getProvider's literal-id overload returns non-optional, so there is no `if (!x) return` guard —
		// which matters: such a guard would make this regression test silently PASS if the entry vanished.
		const { transport } = getProvider("namespace");
		expect(selectTransport(transport, 55 * MIN)).toBe("detached");
		expect(selectTransport(transport, MIN)).toBe("sync");
	});

	it("detaches 20+ minute Vercel suites instead of holding one synchronous connection", () => {
		const { transport } = getProvider("vercel");
		for (const minutes of [20, 30]) {
			expect(selectTransport(transport, minutes * MIN)).toBe("detached");
		}
		expect(selectTransport(transport, MIN)).toBe("detached");
		expect(selectTransport(transport, MIN - 1)).toBe("sync");
	});
});

describe("sandbox preamble", () => {
	for (const uid of [0, 1000]) {
		it(`passes the selected privilege command to child tasks for uid ${uid}`, () => {
			const result = Bun.spawnSync([
				"bash",
				"-c",
				[
					`unset SUDO; id() { printf '%s\\n' '${uid}'; }; sudo() { :; }`,
					buildPreamble(),
					`bash -c 'printf "%s" "\${SUDO-unset}"'`,
				].join("; "),
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toBe(uid === 0 ? "" : "sudo -E");
		});
	}
	it("does not auto-install repository developer tools when running benchmark tasks", () => {
		expect(PREAMBLE).toContain("MISE_TASK_RUN_AUTO_INSTALL=0");
	});

	it("separates an injected user's writable PTS state from the baked profile registry", () => {
		// One canonical snippet, interpolated — not restated here, so this test cannot drift from the
		// generated smoke probe the way three hand-written copies did.
		expect(PREAMBLE).toContain(PTS_STATE_SELECT_SH);
		expect(PREAMBLE).toContain(
			"PTS_TEST_INSTALL_ROOT_PATH=/var/lib/phoronix-test-suite/installed-tests/",
		);
	});

	// The preamble prefixes EVERY command and is joined under `set -eo pipefail`, so a failing write
	// here takes down the whole step — including probes that never touch PTS. PTS creates its own state
	// directory, so selecting state must stay read-only.
	it("selects PTS state without writing to the filesystem", () => {
		expect(PTS_STATE_SELECT_SH).not.toContain("mkdir");
		expect(PTS_STATE_SELECT_SH).not.toContain("$HOME");
	});

	it("never disables the mise python — baked images have no distro python3 to fall back to", () => {
		// Regression pin: MISE_DISABLE_TOOLS=python turned every python3 on a baked image into
		// "mise ERROR python3 is not a valid shim" (pybench ran green with zero metrics on every
		// baked provider) because the images ship only the mise-shimmed python, no distro python3.
		expect(PREAMBLE).not.toContain("MISE_DISABLE_TOOLS");
	});

	// buildPreamble omits the trial vars entirely under BENCH_PASSES=1 (contract-verification mode), so
	// these trial-count assertions only hold outside it — skip in that mode rather than fail a contract run.
	it.skipIf(process.env.BENCH_PASSES === "1")(
		"uses two fixed PTS trials by default for a publishable comparison",
		() => {
			expect(PREAMBLE).toContain("PTS_RESPECT_TIMES_TO_RUN=1");
			expect(PREAMBLE).toContain("FORCE_TIMES_TO_RUN=2");
		},
	);

	it.skipIf(process.env.BENCH_PASSES === "1")(
		"pins the PTS repeat count (k) a suite requests",
		() => {
			expect(buildPreamble({ mode: "fixed", times: 1 })).toContain("FORCE_TIMES_TO_RUN=1");
			expect(buildPreamble({ mode: "fixed", times: 3 })).toContain("FORCE_TIMES_TO_RUN=3");
			// The variance-driven policy stays disabled at every k so a noisy provider can't stretch a suite.
			expect(buildPreamble({ mode: "fixed", times: 3 })).toContain("PTS_RESPECT_TIMES_TO_RUN=1");
		},
	);

	it.skipIf(process.env.BENCH_PASSES === "1")(
		"hands the pass count to PTS's convergence in converge mode (no forced/respect pins)",
		() => {
			const preamble = buildPreamble({ mode: "converge" });
			// The marker tells lib/bench.sh not to fall back to forcing a single pass.
			expect(preamble).toContain("BENCH_PTS_CONVERGE=1");
			// Neither pin is set, so PTS's DynamicRunCount governs the pass count.
			expect(preamble).not.toContain("FORCE_TIMES_TO_RUN");
			expect(preamble).not.toContain("PTS_RESPECT_TIMES_TO_RUN");
		},
	);

	it("rejects a non-positive or fractional fixed k (would emit an empty/bogus FORCE_TIMES_TO_RUN)", () => {
		// Throws before touching the env, so this holds in every mode including BENCH_PASSES=1.
		expect(() => buildPreamble({ mode: "fixed", times: 0 })).toThrow(/positive integer/);
		expect(() => buildPreamble({ mode: "fixed", times: -1 })).toThrow(/positive integer/);
		expect(() => buildPreamble({ mode: "fixed", times: 1.5 })).toThrow(/positive integer/);
	});
});

describe("resolvePtsPassPolicy", () => {
	it("defaults to the suite's fixed count, or the harness default when the suite pins none", () => {
		expect(resolvePtsPassPolicy({ ptsTimesToRun: 3 }, {})).toEqual({ mode: "fixed", times: 3 });
		expect(resolvePtsPassPolicy({}, {})).toEqual({
			mode: "fixed",
			times: DEFAULT_PTS_TIMES_TO_RUN,
		});
		// A blank/whitespace override is treated as unset, not an error.
		expect(resolvePtsPassPolicy({ ptsTimesToRun: 2 }, { BENCH_PTS_PASSES: "  " })).toEqual({
			mode: "fixed",
			times: 2,
		});
	});

	it("converges by default for a suite that declares ptsConverge", () => {
		// The synthetic suites carry ptsConverge — a bare run hands their pass count to PTS's convergence.
		expect(resolvePtsPassPolicy({ ptsConverge: true, ptsTimesToRun: 2 }, {})).toEqual({
			mode: "converge",
		});
	});

	it("honors a converge override (any casing), forcing it even on a fixed suite", () => {
		expect(resolvePtsPassPolicy({ ptsTimesToRun: 2 }, { BENCH_PTS_PASSES: "converge" })).toEqual({
			mode: "converge",
		});
		expect(resolvePtsPassPolicy({ ptsTimesToRun: 5 }, { BENCH_PTS_PASSES: "Converge" })).toEqual({
			mode: "converge",
		});
	});

	it("honors a numeric override, overriding a suite's converge default", () => {
		// A dispatch pinning a fixed count wins over the suite's own converge policy.
		expect(resolvePtsPassPolicy({ ptsConverge: true }, { BENCH_PTS_PASSES: "10" })).toEqual({
			mode: "fixed",
			times: 10,
		});
	});

	it("throws on an override that is neither converge nor a positive integer", () => {
		expect(() => resolvePtsPassPolicy({ ptsTimesToRun: 2 }, { BENCH_PTS_PASSES: "lots" })).toThrow(
			/BENCH_PTS_PASSES/,
		);
		expect(() => resolvePtsPassPolicy({ ptsTimesToRun: 2 }, { BENCH_PTS_PASSES: "0" })).toThrow(
			/positive integer/,
		);
		expect(() => resolvePtsPassPolicy({ ptsTimesToRun: 2 }, { BENCH_PTS_PASSES: "2.5" })).toThrow(
			/positive integer/,
		);
	});
});

describe("shellQuote", () => {
	it("wraps in single quotes and escapes embedded quotes", () => {
		expect(shellQuote("echo hi")).toBe("'echo hi'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});

describe("StepRunner", () => {
	it("runs a step through the preamble, records it, and returns the result", async () => {
		const commands: string[] = [];
		const sandbox: SandboxHandle = {
			runCommand: async (command) => {
				commands.push(command);
				return { exitCode: 0, stdout: "ok" };
			},
			destroy: async () => undefined,
		};
		const runner = new StepRunner(sandbox);

		const result = await runner.run("echo", "echo hi", 5_000);

		expect(result.exitCode).toBe(0);
		expect(runner.stepLog).toHaveLength(1);
		expect(runner.stepLog[0]).toMatchObject({ label: "echo", phase: "setup", exitCode: 0 });
		expect(commands[0]).toContain(PREAMBLE);
		expect(commands[0]).toContain("echo hi");
	});

	// Same BENCH_PASSES=1 caveat as the preamble tests above: the k is only emitted when trials are on.
	it.skipIf(process.env.BENCH_PASSES === "1")(
		"threads a per-suite PTS repeat count (k) into every step's preamble",
		async () => {
			const commands: string[] = [];
			const sandbox: SandboxHandle = {
				runCommand: async (command) => {
					commands.push(command);
					return { exitCode: 0, stdout: "ok" };
				},
				destroy: async () => undefined,
			};
			const runner = new StepRunner(sandbox, undefined, undefined, { mode: "fixed", times: 3 });
			await runner.run("echo", "echo hi", 5_000);
			expect(commands[0]).toContain("FORCE_TIMES_TO_RUN=3");
			expect(commands[0]).not.toContain("FORCE_TIMES_TO_RUN=2");
		},
	);

	it("throws on a non-zero exit unless allowFailure is set", async () => {
		const sandbox: SandboxHandle = {
			runCommand: async () => ({ exitCode: 1 }),
			destroy: async () => undefined,
		};
		const runner = new StepRunner(sandbox);

		await expect(runner.run("fail", "false", 5_000)).rejects.toThrow(/exit code 1/);
		const tolerated = await runner.run("fail-ok", "false", 5_000, { allowFailure: true });
		expect(tolerated.exitCode).toBe(1);
		// The receipt must let a reader tell the tolerated exit from the real failure.
		expect(runner.stepLog).toEqual([
			{ phase: "setup", label: "fail", ms: expect.any(Number), exitCode: 1 },
			{ phase: "setup", label: "fail-ok", ms: expect.any(Number), exitCode: 1, allowFailure: true },
		]);
	});
});

describe("StepRunner.runDetached", () => {
	it("captures diagnostic output when native launch never settles", async () => {
		const commands: string[] = [];
		const sandbox: SandboxHandle = {
			runCommand: async (command, options) => {
				commands.push(command);
				if (options?.background) return new Promise(() => {});
				return { exitCode: 0, stdout: "last output from native launch" };
			},
			destroy: async () => {},
		};
		const runner = new StepRunner(sandbox);
		await expect(runner.runDetached("hung launch", "true", 10)).rejects.toThrow("timed out");
		expect(runner.detachedEvidence[0]?.state).toBe("deadline-exceeded");
		expect(runner.detachedEvidence[0]?.logTail).toContain("last output from native launch");
		expect(commands.some((command) => command.includes("pkill"))).toBe(true);
	});
	// A fake sandbox whose filesystem reports the done-file present after `readyAfter` polls and
	// serves canned log/exit-code contents — the detached transport's two reads.
	function detachedSandbox(opts: { readyAfter?: number; exitCode?: string; log?: string }): {
		sandbox: SandboxHandle;
		commands: Array<{ command: string; background?: boolean }>;
	} {
		const commands: Array<{ command: string; background?: boolean }> = [];
		let polls = 0;
		const sandbox: SandboxHandle = {
			runCommand: async (command, options) => {
				commands.push({ command, background: options?.background });
				return { exitCode: 0, stdout: "" };
			},
			destroy: async () => undefined,
			filesystem: {
				exists: async (path) => path.endsWith(".done") && polls++ >= (opts.readyAfter ?? 0),
				readFile: async (path) =>
					path.endsWith(".done")
						? receipt(path, opts.exitCode ?? "0")
						: (opts.log ?? "benchmark output"),
			},
		};
		return { sandbox, commands };
	}

	it("starts the step in the background and returns the polled log + exit code", async () => {
		const { sandbox, commands } = detachedSandbox({ log: "ran on the host", exitCode: "0\n" });
		const runner = new StepRunner(sandbox);

		const result = await runner.runDetached("bench", "mise run benchmark", 60_000);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ran on the host");
		// First command is the detached start, flagged background; never a synchronous foreground exec.
		expect(commands[0]?.background).toBe(true);
		// Double-fork daemonization: an outer nohup launches an inner nohup, not a single setsid.
		expect(commands[0]?.command).toContain("nohup");
		expect(commands[0]?.command).not.toContain("setsid");
		expect(runner.stepLog).toHaveLength(1);
		expect(runner.stepLog[0]).toMatchObject({ label: "bench", exitCode: 0 });
	});

	it("deletes the detached log + done files after reading them back", async () => {
		// Each retried collect starts a fresh detached step whose log holds the entire base64 results
		// tar; without cleanup those large files pile up in the sandbox's /tmp across retries, exactly
		// when the disk is tight. The completed step must rm both files once their contents are in hand.
		const { sandbox, commands } = detachedSandbox({ log: "done", exitCode: "0" });
		const runner = new StepRunner(sandbox);
		await runner.runDetached("bench", "mise run benchmark", 60_000);
		const cleanup = commands.find((c) => c.command.includes("rm -f") && c.command.includes(".log"));
		expect(cleanup).toBeDefined();
		expect(cleanup?.command).toContain(".done");
	});

	it("propagates a non-zero detached exit code as a failure", async () => {
		const { sandbox } = detachedSandbox({ exitCode: "42" });
		const runner = new StepRunner(sandbox);
		await expect(runner.runDetached("bench", "false", 60_000)).rejects.toThrow(/exit code 42/);
	});

	it("times out (and best-effort kills) when the done-file never appears", async () => {
		// exists always false → never ready; a 0ms budget trips the deadline on the first poll.
		const commands: string[] = [];
		const sandbox: SandboxHandle = {
			runCommand: async (command) => {
				commands.push(command);
				return { exitCode: 0, stdout: "" };
			},
			destroy: async () => undefined,
			filesystem: { exists: async () => false, readFile: async () => "" },
		};
		const runner = new StepRunner(sandbox);
		await expect(runner.runDetached("bench", "sleep 999", 0)).rejects.toThrow(/timed out/);
		expect(commands.some((c) => c.includes("pkill"))).toBe(true);
	});

	it("surfaces the detached log's tail on timeout, before the kill discards the sandbox", async () => {
		// Regression: the timeout path used to pkill and throw without ever reading logPath, so a hung
		// step (the one whose output matters most) was a black box in CI.
		const reads: string[] = [];
		const sandbox: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: "" }),
			destroy: async () => undefined,
			filesystem: {
				exists: async () => false,
				readFile: async (path) => {
					reads.push(path);
					return "line one\nStarted Run 18 @ 04:10:59 *";
				},
			},
		};
		const logged: string[] = [];
		const spy = console.log;
		console.log = (msg: string) => void logged.push(String(msg));
		try {
			const runner = new StepRunner(sandbox);
			await expect(runner.runDetached("bench", "sleep 999", 0)).rejects.toThrow(/timed out/);
		} finally {
			console.log = spy;
		}
		expect(reads.some((p) => p.endsWith(".log"))).toBe(true);
		expect(logged.join("\n")).toContain("Started Run 18");
	});

	it("distinguishes an unreadable log (wedged sandbox) from a quiet one", async () => {
		// A read that never resolves means the sandbox stopped answering — not that the step was silent.
		const sandbox: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: "" }),
			destroy: async () => undefined,
			filesystem: {
				exists: async () => false,
				readFile: async () => {
					throw new Error("sandbox unresponsive");
				},
			},
		};
		const logged: string[] = [];
		const spy = console.log;
		console.log = (msg: string) => void logged.push(String(msg));
		try {
			const runner = new StepRunner(sandbox);
			await expect(runner.runDetached("bench", "sleep 999", 0)).rejects.toThrow(/timed out/);
		} finally {
			console.log = spy;
		}
		expect(logged.join("\n")).toContain("cause is unknown");
	});

	// A sandbox with NO filesystem API: the detached transport must still detach (double-fork) and
	// observe completion by `cat`-ing the done-file over exec. runCommand answers each command shape —
	// the launch (contains nohup), the done-file probe (`cat …done`), and the log read (`cat …log`).
	function catPollSandbox(opts: { readyAfter?: number; exitCode?: string; log?: string }): {
		sandbox: SandboxHandle;
		commands: Array<{ command: string; background?: boolean }>;
	} {
		const commands: Array<{ command: string; background?: boolean }> = [];
		const readyAfter = opts.readyAfter ?? 0;
		let probes = 0;
		const sandbox: SandboxHandle = {
			runCommand: async (command, options) => {
				commands.push({ command, background: options?.background });
				if (command.includes("nohup")) return { exitCode: 0, stdout: "launched" };
				if (command.includes(".done")) {
					const ready = probes++ >= readyAfter;
					return {
						exitCode: 0,
						stdout: ready ? receipt(command, opts.exitCode ?? "0") : "__RUNNING__",
					};
				}
				return { exitCode: 0, stdout: opts.log ?? "cat output" }; // the `.log` read
			},
			destroy: async () => undefined,
		};
		return { sandbox, commands };
	}

	/** Both completion and the log read-back went over the exec `cat` poll, not a filesystem API. */
	function expectPolledOverExec(commands: Array<{ command: string }>): void {
		for (const suffix of [".done", ".log"]) {
			expect(commands.some((c) => c.command.includes("cat") && c.command.includes(suffix))).toBe(
				true,
			);
		}
	}

	it("polls the done-file over exec when the sandbox has no filesystem", async () => {
		const { sandbox, commands } = catPollSandbox({
			readyAfter: 2,
			log: "ran via cat",
			exitCode: "0",
		});
		// Inject a no-op sleep so the two not-ready polls don't actually wait.
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);

		const result = await runner.runDetached("bench", "mise run benchmark", 60_000);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ran via cat");
		// Still a real detach: the launch is backgrounded and double-fork daemonized, not a foreground run.
		expect(commands[0]?.background).toBe(true);
		expect(commands[0]?.command).toContain("nohup");
		// Completion is observed by cat-ing the done-file (the no-filesystem fallback), then the log.
		expectPolledOverExec(commands);
	});

	it("degrades to the exec poll when the filesystem is PRESENT but unsupported", async () => {
		// The live namespace failure this guards: computesdk gives an adapter with no `filesystem` table
		// its UnsupportedFileSystem stub, so `filesystem` is truthy and every call throws. The poll picked
		// the fs path and 12 straight throws killed the step as a "dead sandbox" — while plain exec was
		// answering fine the whole time. A present-but-broken fs must degrade to cat, not fail the step,
		// and the degradation must NOT consume the consecutive-failure budget meant for real outages.
		const { sandbox, commands } = catPollSandbox({
			readyAfter: 1,
			log: "ran via cat",
			exitCode: "0",
		});
		let fsCalls = 0;
		const unsupported = () => {
			fsCalls++;
			return Promise.reject(
				new Error("Filesystem operations are not supported by namespace's sandbox environment."),
			);
		};
		// Attach to the same handle `commands` records through, rather than a spread copy — one object, so
		// the assertions below can't be reading a different fake than the one the runner drove.
		sandbox.filesystem = { exists: unsupported, readFile: unsupported };
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);

		const result = await runner.runDetached("bench", "mise run benchmark", 60_000);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ran via cat");
		// Discovered by use, then abandoned: exactly one fs attempt, never retried.
		expect(fsCalls).toBe(1);
		// Completion and the log read-back both came over exec instead.
		expectPolledOverExec(commands);
	});

	it("propagates a non-zero exit from the cat-polled done-file", async () => {
		const { sandbox } = catPollSandbox({ exitCode: "42" });
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
		await expect(runner.runDetached("bench", "false", 60_000)).rejects.toThrow(/exit code 42/);
	});

	it("fails fast when the cat poll returns a non-zero exit — a wedged shell, not still-running", async () => {
		// Regression: the `|| echo __RUNNING__` guard makes bash exit 0 for both a present and an absent
		// done-file, so a non-zero exit means the shell itself couldn't run. runCommand RESOLVES with
		// that code rather than rejecting, so it slipped past the throw-based fast-fail and read as
		// "still running" — sitting on a wedged sandbox for the whole budget.
		let launched = false;
		const sandbox: SandboxHandle = {
			runCommand: async (command) => {
				if (!launched && command.includes("nohup")) {
					launched = true;
					return { exitCode: 0, stdout: "launched" };
				}
				return { exitCode: 137, stdout: "" }; // shell couldn't run: no reject, just a bad code
			},
			destroy: async () => undefined,
		};
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
		await expect(runner.runDetached("bench", "mise run benchmark", 60 * 60_000)).rejects.toThrow(
			/lost its sandbox.*stopped responding/,
		);
	});

	it("fails fast when every detached poll throws — a dead sandbox, not a quiet step", async () => {
		// Regression: poll failures were swallowed as "not done yet", so a sandbox killed mid-step
		// (e2b orchestrator-stops, 2026-07-10) looked like a quietly-running benchmark for the WHOLE
		// command budget — CI cells sat on a corpse for 60+ minutes until the runner was reclaimed.
		let launched = false;
		const sandbox: SandboxHandle = {
			runCommand: async (command) => {
				if (!launched && command.includes("nohup")) {
					launched = true;
					return { exitCode: 0, stdout: "launched" };
				}
				throw new Error("sandbox is probably not running anymore");
			},
			destroy: async () => undefined,
			filesystem: {
				exists: async () => {
					throw new Error("sandbox is probably not running anymore");
				},
				readFile: async () => {
					throw new Error("sandbox is probably not running anymore");
				},
			},
		};
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
		// Budget far above the poll-failure threshold: the fast-fail, not the deadline, must trip.
		await expect(runner.runDetached("bench", "mise run benchmark", 60 * 60_000)).rejects.toThrow(
			/lost its sandbox.*stopped responding/,
		);
	});

	it("tolerates a transient poll blip when later polls succeed", async () => {
		// One flaky poll must not kill an hour-long benchmark — only a consecutive run of failures may.
		let polls = 0;
		const sandbox: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: "launched" }),
			destroy: async () => undefined,
			filesystem: {
				exists: async (path) => {
					if (!path.endsWith(".done")) return false;
					polls++;
					if (polls === 1) throw new Error("transient fs blip");
					return polls >= 3;
				},
				readFile: async (path) => (path.endsWith(".done") ? receipt(path) : "recovered fine"),
			},
		};
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
		const result = await runner.runDetached("bench", "mise run benchmark", 60_000);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("recovered fine");
	});

	it("retries the completed step's log read-back through transient fs blips", async () => {
		// Regression: the completion read-back was ONE fs attempt with the error folded into stdout ""
		// (Blaxel, 2026-07-19) — a transient fs-API slowdown silently discarded a finished suite's
		// results. A blip must be retried, not swallowed.
		let logReads = 0;
		const sandbox: SandboxHandle = {
			runCommand: async () => ({ exitCode: 0, stdout: "launched" }),
			destroy: async () => undefined,
			filesystem: {
				exists: async (path) => path.endsWith(".done"),
				readFile: async (path) => {
					if (path.endsWith(".done")) return receipt(path);
					if (++logReads < 3) throw new Error("fs API slow");
					return "read back on attempt 3";
				},
			},
		};
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
		const result = await runner.runDetached("bench", "mise run benchmark", 60_000);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("read back on attempt 3");
		expect(logReads).toBe(3);
	});

	it("falls back to the exec transport when the fs log read-back keeps failing", async () => {
		// The fs API can be wedged while plain exec still answers — the log must come back over `cat`
		// rather than the whole completed step failing.
		const commands: string[] = [];
		const sandbox: SandboxHandle = {
			runCommand: async (command) => {
				commands.push(command);
				if (command.includes("cat")) return { exitCode: 0, stdout: "read back over exec" };
				return { exitCode: 0, stdout: "launched" };
			},
			destroy: async () => undefined,
			filesystem: {
				exists: async (path) => path.endsWith(".done"),
				readFile: async (path) => {
					if (path.endsWith(".done")) return receipt(path);
					throw new Error("fs API down"); // every .log read
				},
			},
		};
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
		const result = await runner.runDetached("bench", "mise run benchmark", 60_000);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("read back over exec");
		expect(commands.some((c) => c.includes("cat") && c.includes(".log"))).toBe(true);
	});

	it("throws a distinct transport-failure error when the completed log is unreachable everywhere", async () => {
		// Regression: with every transport dead this returned stdout "" — collectResults then threw a
		// misleading marker error and a fully-valid suite run was discarded. The step must fail with a
		// diagnosis that says the step COMPLETED but its output could not be fetched.
		const sandbox: SandboxHandle = {
			runCommand: async (command) => {
				if (command.includes("cat")) throw new Error("exec transport down too");
				return { exitCode: 0, stdout: "launched" };
			},
			destroy: async () => undefined,
			filesystem: {
				exists: async (path) => path.endsWith(".done"),
				readFile: async (path) => {
					if (path.endsWith(".done")) return receipt(path);
					throw new Error("fs API down");
				},
			},
		};
		const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
		await expect(runner.runDetached("bench", "mise run benchmark", 60_000)).rejects.toThrow(
			/completed but its log could not be read back \(transport failure\)/,
		);
	});

	it("distinguishes a wedged from a quiet sandbox on the no-filesystem path too", async () => {
		// Regression: readLogTail read the log via catFile, which folds every failure into "". On a
		// provider with no filesystem API the `.catch(() => null)` could therefore never fire, so a
		// wedged sandbox was reported as a step that ran quietly — the exact diagnosis this is meant to
		// tell apart. Only the fs path was covered before, which is how it shipped.
		const sandbox: SandboxHandle = {
			runCommand: async (command) => {
				if (command.includes("nohup")) return { exitCode: 0, stdout: "launched" };
				if (command.includes(".done")) return { exitCode: 0, stdout: "__RUNNING__" };
				throw new Error("sandbox unresponsive"); // the `.log` read
			},
			destroy: async () => undefined,
		};
		const logged: string[] = [];
		const spy = console.log;
		console.log = (msg: string) => void logged.push(String(msg));
		try {
			const runner = new StepRunner(sandbox, CAPPED, async () => undefined);
			await expect(runner.runDetached("bench", "sleep 999", 0)).rejects.toThrow(/timed out/);
		} finally {
			console.log = spy;
		}
		expect(logged.join("\n")).toContain("cause is unknown");
	});

	it("backs off the poll interval geometrically up to the cap", async () => {
		// Done only after 7 not-ready polls → 7 inter-poll sleeps, exercising the geometric ramp + cap.
		const { sandbox } = detachedSandbox({ readyAfter: 7, exitCode: "0", log: "done" });
		const slept: number[] = [];
		const runner = new StepRunner(sandbox, CAPPED, async (ms) => {
			slept.push(ms);
		});

		await runner.runDetached("bench", "mise install", 60 * MIN);

		// 1.5s start, ×1.5 each poll, capped at 10s: 1500, 2250, 3375, 5062.5, 7593.75, 10000, 10000.
		expect(slept).toEqual([1_500, 2_250, 3_375, 5_062.5, 7_593.75, 10_000, 10_000]);
	});
});

describe("StepRunner.step (capability-driven transport)", () => {
	// A sandbox WITH a filesystem (so a detached selection truly detaches rather than falling back),
	// recording each command and its background flag. The done-file is present from the first poll.
	function fsSandbox(): {
		sandbox: SandboxHandle;
		commands: Array<{ command: string; background?: boolean }>;
	} {
		const commands: Array<{ command: string; background?: boolean }> = [];
		const sandbox: SandboxHandle = {
			runCommand: async (command, options) => {
				commands.push({ command, background: options?.background });
				return { exitCode: 0, stdout: "" };
			},
			destroy: async () => undefined,
			filesystem: {
				exists: async (path) => path.endsWith(".done"),
				readFile: async (path) => (path.endsWith(".done") ? receipt(path) : "out"),
			},
		};
		return { sandbox, commands };
	}

	it("detaches a long step on a capped provider", async () => {
		const { sandbox, commands } = fsSandbox();
		const runner = new StepRunner(sandbox, CAPPED);
		await runner.step("long", "mise install", 20 * MIN);
		// Detached start: backgrounded, double-fork daemonized (nohup).
		expect(commands[0]?.background).toBe(true);
		expect(commands[0]?.command).toContain("nohup");
	});

	it("runs a short step synchronously on a capped provider", async () => {
		const { sandbox, commands } = fsSandbox();
		const runner = new StepRunner(sandbox, CAPPED);
		// Budget strictly under the cap → direct exec.
		await runner.step("short", "df -Pk /", MIN / 2);
		// Direct exec: a single bash -c, no background flag, no detach wrapper.
		expect(commands[0]?.background).toBeUndefined();
		expect(commands[0]?.command).toContain("bash -c");
		expect(commands[0]?.command).not.toContain("nohup");
	});

	it("stays synchronous past the cap on a provider that can't detach", async () => {
		// CAPPED_NO_DETACH exercises step()'s wiring end-to-end (selectTransport via the constructor):
		// even a long budget has no durable alternative, so it must stay a direct foreground exec and
		// never background. Guards the no-detach fallback against a future regression in step()'s wiring.
		const { sandbox, commands } = fsSandbox();
		const runner = new StepRunner(sandbox, CAPPED_NO_DETACH);
		await runner.step("long", "mise install", 5 * MIN);
		expect(commands[0]?.background).toBeUndefined();
		expect(commands[0]?.command).toContain("bash -c");
		expect(commands[0]?.command).not.toContain("nohup");
	});

	it("runs a long step synchronously on an uncapped provider", async () => {
		const { sandbox, commands } = fsSandbox();
		const runner = new StepRunner(sandbox, UNCAPPED);
		await runner.step("long", "mise run benchmark", 110 * MIN);
		// No cap → direct exec even for a multi-minute step; the filesystem is never polled.
		expect(commands[0]?.background).toBeUndefined();
		expect(commands[0]?.command).not.toContain("nohup");
	});

	it("defaults to a capped profile when constructed without a transport", async () => {
		// The no-transport constructor (used by the unit-test fakes) detaches a long step by default.
		const { sandbox, commands } = fsSandbox();
		const runner = new StepRunner(sandbox);
		await runner.step("long", "mise install", 20 * MIN);
		expect(commands[0]?.background).toBe(true);
	});
});

function receipt(location: string, code = "0"): string {
	const identity = /bench-[a-f0-9-]+/.exec(location)?.[0];
	return `v1 ${identity} ${code}`;
}
