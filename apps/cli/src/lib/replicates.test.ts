import { describe, expect, it } from "bun:test";
import { WORKFLOW_TIMEOUT_MARGIN_MINUTES } from "@sandbox-benchmarks/schema";
import {
	fleetBudgetError,
	fleetWaves,
	lastFlagValue,
	parseReplicatesFlag,
	replicatePaths,
	resolveCellBudgetMinutes,
	resolveMaxConcurrency,
	resolveRunnerLifetimeMinutes,
	runnerLifetimeError,
	runPooled,
} from "./replicates.ts";

describe("lastFlagValue", () => {
	it("reads both spellings and takes the last occurrence", () => {
		expect(lastFlagValue(["--replicates", "0,1"], "replicates")).toBe("0,1");
		expect(lastFlagValue(["--replicates=0,1"], "replicates")).toBe("0,1");
		expect(lastFlagValue(["--replicates=0", "--replicates", "9"], "replicates")).toBe("9");
	});

	it("returns undefined when the flag is absent", () => {
		expect(lastFlagValue(["e2b", "memory"], "replicates")).toBeUndefined();
	});

	// The singular and plural spellings must not consume each other's operands — a `--replicates`
	// swallowed by `--replicate` would run one sandbox where the plan asked for R.
	it("does not confuse the singular and plural spellings", () => {
		expect(lastFlagValue(["--replicates", "0,1,2"], "replicate")).toBeUndefined();
		expect(lastFlagValue(["--replicates=0,1,2"], "replicate")).toBeUndefined();
		expect(lastFlagValue(["--replicate", "3"], "replicates")).toBeUndefined();
	});

	it("throws on a dangling flag rather than defaulting", () => {
		expect(() => lastFlagValue(["--replicates"], "replicates")).toThrow(/requires an index/);
	});
});

describe("parseReplicatesFlag", () => {
	it("returns undefined when the flag is absent", () => {
		expect(parseReplicatesFlag(["e2b", "memory", "run-1"])).toBeUndefined();
	});

	it("parses the JSON array plan-replicates emits", () => {
		expect(parseReplicatesFlag(["--replicates", "[0,1,2]"])).toEqual([0, 1, 2]);
		expect(parseReplicatesFlag(["--replicates=[0]"])).toEqual([0]);
	});

	it("parses the comma-separated spelling, tolerating whitespace", () => {
		expect(parseReplicatesFlag(["--replicates", "0,1,2"])).toEqual([0, 1, 2]);
		expect(parseReplicatesFlag(["--replicates", " 0 , 1 "])).toEqual([0, 1]);
		expect(parseReplicatesFlag(["--replicates", "4"])).toEqual([4]);
	});

	it("preserves a non-contiguous axis rather than renumbering it", () => {
		expect(parseReplicatesFlag(["--replicates", "[3,7]"])).toEqual([3, 7]);
	});

	// An empty fan-out would upload no shard and read downstream as "never scheduled"; a repeated index
	// would fold two sandboxes into one replicate slot at aggregate time. Both must fail the cell.
	it("rejects an empty axis and repeated indices", () => {
		expect(() => parseReplicatesFlag(["--replicates", ""])).toThrow(/must not be blank/);
		expect(() => parseReplicatesFlag(["--replicates", "[]"])).toThrow(/at least one index/);
		expect(() => parseReplicatesFlag(["--replicates", "0,1,0"])).toThrow(/must not repeat/);
	});

	it("rejects malformed indices and non-array JSON", () => {
		expect(() => parseReplicatesFlag(["--replicates", "0,,1"])).toThrow(/non-negative integer/);
		expect(() => parseReplicatesFlag(["--replicates", "0,-1"])).toThrow(/non-negative integer/);
		expect(() => parseReplicatesFlag(["--replicates", "0,1.5"])).toThrow(/non-negative integer/);
		expect(() => parseReplicatesFlag(["--replicates", "[0,"])).toThrow(/JSON array/);
	});

	// `Number.isInteger` is true of both of these, and neither can name a real replicate slot: 1e21
	// would spell its shard `<runId>-r1e+21.json`, and above 2^53 distinct operands stop being
	// distinct numbers — so a pair that does not look repeated collides into one slot at aggregate time.
	it("rejects indices outside the safe-integer range", () => {
		expect(() => parseReplicatesFlag(["--replicates", "1e21"])).toThrow(/non-negative integer/);
		expect(() =>
			parseReplicatesFlag(["--replicates", "9007199254740992,9007199254740993"]),
		).toThrow(/non-negative integer/);
	});
});

describe("replicatePaths", () => {
	// Every shard of one run carries the same `runId` FIELD, so only the filename keeps them apart —
	// and commit-dataset.yml globs exactly this shape.
	it("gives each replicate its own raw tree and a suffixed shard file", () => {
		expect(replicatePaths("ci-1", 0)).toEqual({
			rawRoot: "data/raw/ci-1/r0",
			outFile: "data/runs/ci-1-r0.json",
		});
		expect(replicatePaths("ci-1", 11).outFile).toBe("data/runs/ci-1-r11.json");
	});
});

describe("resolveMaxConcurrency", () => {
	it("defaults to unbounded — the whole fleet at once, as R separate runners were", () => {
		expect(resolveMaxConcurrency([], {})).toBe(Number.POSITIVE_INFINITY);
		expect(resolveMaxConcurrency([], { BENCH_MAX_CONCURRENCY: "" })).toBe(Number.POSITIVE_INFINITY);
	});

	it("reads the flag and the env var, with the flag winning", () => {
		expect(resolveMaxConcurrency(["--max-concurrency", "3"], {})).toBe(3);
		expect(resolveMaxConcurrency([], { BENCH_MAX_CONCURRENCY: "2" })).toBe(2);
		expect(resolveMaxConcurrency(["--max-concurrency=4"], { BENCH_MAX_CONCURRENCY: "2" })).toBe(4);
	});

	// A blank FLAG is a typo; a blank ENV is what CI sets whenever the dispatch input is left empty.
	// Conflating them would let `--max-concurrency=` pick the widest fan-out AND mask a deliberate env cap.
	it("rejects a blank flag operand but keeps a blank env meaning unbounded", () => {
		expect(() => resolveMaxConcurrency(["--max-concurrency="], {})).toThrow(/must not be blank/);
		expect(() => resolveMaxConcurrency(["--max-concurrency", ""], {})).toThrow(/must not be blank/);
		// The production path: bench-suite.yml always sets the key, blank when the input is blank.
		expect(resolveMaxConcurrency([], { BENCH_MAX_CONCURRENCY: "" })).toBe(Number.POSITIVE_INFINITY);
		// A blank flag must not silently win over a real env cap either.
		expect(() =>
			resolveMaxConcurrency(["--max-concurrency="], { BENCH_MAX_CONCURRENCY: "4" }),
		).toThrow(/must not be blank/);
	});

	it("rejects a non-positive or non-integer cap instead of silently serializing", () => {
		expect(() => resolveMaxConcurrency(["--max-concurrency", "0"], {})).toThrow(/positive integer/);
		expect(() => resolveMaxConcurrency([], { BENCH_MAX_CONCURRENCY: "1.5" })).toThrow(
			/positive integer/,
		);
		expect(() => resolveMaxConcurrency([], { BENCH_MAX_CONCURRENCY: "lots" })).toThrow(
			/positive integer/,
		);
	});
});

describe("resolveCellBudgetMinutes", () => {
	// No budget is the honest local answer — nothing cancels a laptop run, so there is nothing the
	// fan-out guard could meaningfully compare against.
	it("is undefined when CI did not hand one down", () => {
		expect(resolveCellBudgetMinutes({})).toBeUndefined();
		expect(resolveCellBudgetMinutes({ BENCH_CELL_BUDGET_MINUTES: "" })).toBeUndefined();
	});

	it("reads the job budget the workflow advertises", () => {
		expect(resolveCellBudgetMinutes({ BENCH_CELL_BUDGET_MINUTES: "180" })).toBe(180);
	});

	// A malformed budget must not read as "unbounded": that would disable the guard silently, which is
	// the same outcome as not having it on the one run where it mattered.
	it("rejects a malformed budget rather than falling back to no check", () => {
		expect(() => resolveCellBudgetMinutes({ BENCH_CELL_BUDGET_MINUTES: "0" })).toThrow(
			/positive integer/,
		);
		expect(() => resolveCellBudgetMinutes({ BENCH_CELL_BUDGET_MINUTES: "90.5" })).toThrow(
			/positive integer/,
		);
		expect(() => resolveCellBudgetMinutes({ BENCH_CELL_BUDGET_MINUTES: "later" })).toThrow(
			/positive integer/,
		);
	});
});

describe("resolveRunnerLifetimeMinutes", () => {
	// Hosted runners and local machines outlive the job, so the guard is inert everywhere except the
	// one workflow route that lands on an ephemeral self-hosted label.
	it("is undefined when the runner outlives the job", () => {
		expect(resolveRunnerLifetimeMinutes({})).toBeUndefined();
		expect(resolveRunnerLifetimeMinutes({ BENCH_RUNNER_LIFETIME_MINUTES: "" })).toBeUndefined();
	});

	it("reads the lifetime the workflow advertises for an ephemeral runner", () => {
		expect(resolveRunnerLifetimeMinutes({ BENCH_RUNNER_LIFETIME_MINUTES: "70" })).toBe(70);
	});

	it("rejects a malformed lifetime rather than falling back to no check", () => {
		expect(() => resolveRunnerLifetimeMinutes({ BENCH_RUNNER_LIFETIME_MINUTES: "0" })).toThrow(
			/positive integer/,
		);
		expect(() => resolveRunnerLifetimeMinutes({ BENCH_RUNNER_LIFETIME_MINUTES: "70m" })).toThrow(
			/positive integer/,
		);
	});
});

describe("runnerLifetimeError", () => {
	// A runner may have a shorter lifetime than the requested suite; the self-hosted label is
	// reaped at 70 minutes even while the step is healthy.
	const ephemeral = { runnerLifetimeMinutes: 70 };

	it("passes a suite that finishes inside the runner's lifetime with host margin to spare", () => {
		expect(
			runnerLifetimeError({ ...ephemeral, suite: "cpu-node", suiteTimeoutMinutes: 40 }),
		).toBeUndefined();
	});

	// Same reasoning as fleetBudgetError's margin case: the reaper does not wait for checkout,
	// teardown, normalization and upload either, so a suite landing on exactly the lifetime is refused.
	it("rejects a suite that lands on the lifetime with no host margin left", () => {
		expect(
			runnerLifetimeError({ ...ephemeral, suite: "cpu-node", suiteTimeoutMinutes: 70 }),
		).toMatch(/past the 70-minute lifetime/);
		expect(
			runnerLifetimeError({
				...ephemeral,
				suite: "cpu-node",
				suiteTimeoutMinutes: 70 - WORKFLOW_TIMEOUT_MARGIN_MINUTES,
			}),
		).toBeUndefined();
	});

	// The failure this exists to prevent has no logs and no artifact at all — the cell simply stops
	// existing — so the message has to name the trade and the two ways out.
	it("explains the reaping and how to get out of it", () => {
		const error = runnerLifetimeError({
			...ephemeral,
			suite: "realworld-mastra",
			suiteTimeoutMinutes: 155,
		});
		expect(error).toMatch(/stuck in_progress with no logs and no artifact/);
		expect(error).toMatch(/before any sandbox is created/);
		expect(error).toMatch(/shorter suite, or route it to a runner that outlives 170 minutes/);
	});
});

describe("fleetWaves", () => {
	it("is one wave whenever the cap admits the whole fleet", () => {
		expect(fleetWaves(12, Number.POSITIVE_INFINITY)).toBe(1);
		expect(fleetWaves(12, 12)).toBe(1);
		expect(fleetWaves(12, 99)).toBe(1);
	});

	it("rounds a partial final wave up", () => {
		expect(fleetWaves(12, 6)).toBe(2);
		expect(fleetWaves(12, 5)).toBe(3);
		expect(fleetWaves(12, 1)).toBe(12);
	});
});

describe("fleetBudgetError", () => {
	// The shipped realworld cell: R=12, a 90-minute suite, the 180-minute job.
	const realworld = { replicates: 12, suite: "realworld-mastra", suiteTimeoutMinutes: 90 };

	it("passes an uncapped fan-out — one wave is the budget the job was sized for", () => {
		expect(
			fleetBudgetError({
				...realworld,
				maxConcurrency: Number.POSITIVE_INFINITY,
				budgetMinutes: 180,
			}),
		).toBeUndefined();
	});

	it("passes a cap that admits the whole fleet in one wave", () => {
		expect(
			fleetBudgetError({ ...realworld, maxConcurrency: 12, budgetMinutes: 180 }),
		).toBeUndefined();
	});

	// The margin is not optional slack. Two waves land on EXACTLY the 180-minute budget (2 x 90), so a
	// guard comparing bare sandbox time would wave this through with nothing left for the checkout,
	// teardown, normalization and upload the job still has to do — and the cell is cancelled with all
	// 12 shards lost, which is the outcome this guard exists to refuse.
	it("rejects a cap that lands on the budget with no host margin left", () => {
		const error = fleetBudgetError({ ...realworld, maxConcurrency: 6, budgetMinutes: 180 });
		expect(error).toContain("2 serial waves");
		expect(error).toContain(`+ ${WORKFLOW_TIMEOUT_MARGIN_MINUTES} minutes of host margin`);
		expect(error).toContain("up to 195 minutes");
	});

	// 3 waves x 90 + 15 = 285 > 180. Rejecting costs a dispatch; discovering it costs three hours and
	// the cell.
	it("rejects a cap that deterministically overruns, naming the smallest cap that fits", () => {
		const error = fleetBudgetError({ ...realworld, maxConcurrency: 4, budgetMinutes: 180 });
		expect(error).toContain("3 serial waves");
		expect(error).toContain("up to 285 minutes");
		expect(error).toContain("180-minute job budget");
		// floor((180 - 15) / 90) = 1 affordable wave, so ceil(12 / 1) = 12 — at the shipped realworld
		// defaults no cap below the full fleet fits, and the message says so rather than inventing one.
		expect(error).toContain("at least 12");
	});

	// A suite that cannot fit the job even once is not a concurrency problem, and telling the operator
	// to raise a cap they cannot raise far enough would send them in circles.
	it("does not recommend a cap when even one wave overruns", () => {
		const error = fleetBudgetError({
			replicates: 3,
			suite: "cpu-node",
			suiteTimeoutMinutes: 200,
			maxConcurrency: 2,
			budgetMinutes: 180,
		});
		expect(error).toContain("leave --max-concurrency blank");
		expect(error).not.toContain("at least");
	});
});

describe("runPooled", () => {
	const flush = (): Promise<void> => Bun.sleep(0);
	/** For the cases that assert scheduling, not error handling: a throw here is a test bug. */
	const throwOnError = (error: unknown): never => {
		throw error;
	};

	it("returns results in input order regardless of completion order", async () => {
		const results = await runPooled(
			[30, 10, 20],
			3,
			async (ms) => {
				await Bun.sleep(ms);
				return ms;
			},
			throwOnError,
		);
		expect(results).toEqual([30, 10, 20]);
	});

	// THE isolation guarantee. A rejecting Promise.all would unwind the pool and abandon the peers
	// mid-suite — sandboxes alive, shards unwritten, and the caller exiting before it can report.
	it("never rejects: a throwing item becomes its own failure and peers still finish", async () => {
		const finished: number[] = [];
		const results = await runPooled(
			[0, 1, 2, 3],
			4,
			async (i) => {
				if (i === 1) {
					await Bun.sleep(1);
					throw new Error("replicate 1 exploded");
				}
				await Bun.sleep(20);
				finished.push(i);
				return `ok:${i}`;
			},
			(error, _item, index) => `failed:${index}:${(error as Error).message}`,
		);
		expect(results).toEqual(["ok:0", "failed:1:replicate 1 exploded", "ok:2", "ok:3"]);
		// The peers ran to completion rather than being abandoned when their sibling threw.
		expect(finished.toSorted()).toEqual([0, 2, 3]);
	});

	it("keeps the pool draining when every item throws", async () => {
		const results = await runPooled(
			[0, 1, 2],
			2,
			async (i) => {
				throw new Error(`boom ${i}`);
			},
			(error) => (error as Error).message,
		);
		expect(results).toEqual(["boom 0", "boom 1", "boom 2"]);
	});

	/** The highest number of `fn` calls ever in flight at once, driving `count` items at `limit`. */
	const peakConcurrency = async (count: number, limit: number): Promise<number> => {
		let inFlight = 0;
		let peak = 0;
		await runPooled(
			Array.from({ length: count }, (_, i) => i),
			limit,
			async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await flush();
				inFlight--;
				return null;
			},
			throwOnError,
		);
		return peak;
	};

	it("never exceeds the concurrency limit", async () => {
		expect(await peakConcurrency(6, 2)).toBe(2);
	});

	it("runs everything at once when the limit is unbounded", async () => {
		expect(await peakConcurrency(4, Number.POSITIVE_INFINITY)).toBe(4);
	});

	it("returns [] for an empty item list", async () => {
		expect(await runPooled([], 4, async () => "never", throwOnError)).toEqual([]);
	});

	// A throwing `onError` is a caller bug, but it must not become the thing the required `onError`
	// exists to prevent: peers abandoned mid-flight. Every item still gets its turn, and the bug
	// surfaces only once nothing is in flight.
	it("drains every item before surfacing a throwing onError", async () => {
		const started: number[] = [];
		const finished: number[] = [];
		const run = runPooled(
			[0, 1, 2, 3],
			2,
			async (i) => {
				started.push(i);
				await flush();
				finished.push(i);
				// Items 1 and 2 fail, so onError runs mid-pool with peers still queued behind them.
				if (i === 1 || i === 2) throw new Error(`boom ${i}`);
				return i;
			},
			() => {
				throw new Error("converter exploded");
			},
		);
		await expect(run).rejects.toThrow(/onError threw .* results are incomplete/s);
		expect(started.sort()).toEqual([0, 1, 2, 3]);
		expect(finished.sort()).toEqual([0, 1, 2, 3]);
	});
});
