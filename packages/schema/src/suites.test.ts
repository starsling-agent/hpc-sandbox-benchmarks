import { describe, expect, it } from "bun:test";
import type { Suite } from "./index.ts";
import { METRIC_CATALOG, paddedSuiteToken, padSuiteList, SUITE_NAMES, SUITES } from "./index.ts";
// Not part of the public surface (curation is an implementation detail of the catalog merge); this
// PR's pinned-subset test reaches in directly to compare its suite's declarations against curated keys.
import { ptsOverrides } from "./pts-overrides.ts";

describe("suite registry", () => {
	it("registers cpu-node as a PTS- and Node-backed suite", () => {
		const cpuNode = SUITES["cpu-node"];
		expect(cpuNode.setupPts).toBe(true);
		expect(cpuNode.setupNode).toBe(true);
		expect(cpuNode.commands).toEqual(["mise run benchmark:cpu:node"]);
	});

	it("declares the cpu dimension and the node-web-tooling metric it emits", () => {
		const cpuNode = SUITES["cpu-node"];
		expect(cpuNode.dimensions).toEqual(["cpu"]);
		expect(cpuNode.metrics).toEqual(["node_web_tooling_runs_per_s"]);
	});

	it("exposes the suite names", () => {
		expect(SUITE_NAMES).toEqual([
			"cpu-node",
			"system",
			"pgbench",
			"memory",
			"disk",
			"network",
			"realworld-mastra",
			"realworld-better-auth",
			"realworld-openclaw",
		]);
	});

	it("declares the per-tier pass policy and replicate count (R)", () => {
		// Real-world captures cold-start once (k=1, no in-sandbox convergence) across many sandboxes
		// (R=12, data-informed so the between-machine CIs separate providers). The synthetics run R=3, and
		// PTS convergence is enabled on the two suites that converge cheaply and predictably: `memory`
		// (STREAM, a tiny budget-safe loop) and `cpu-node` (CPU-bound, so DynamicRunCount settles near its
		// ~3-pass minimum — no runaway). The rest keep a fixed count — convergence there re-introduces fio's
		// runaway (disk), overran the budget live on modal-gvisor (system/SQLite, run #49), or breaks iperf's
		// fixed-trial rule (network). cpu-generic is retired; pgbench is split out of system.
		for (const name of [
			"realworld-mastra",
			"realworld-better-auth",
			"realworld-openclaw",
		] as const) {
			// Suite-typed view: the realworld literals omit ptsConverge entirely (satisfies narrows the
			// const), so read it through the interface to assert it stays off — realworld does NOT converge.
			const suite: Suite = SUITES[name];
			expect(suite.ptsTimesToRun).toBe(1);
			expect(suite.ptsConverge).toBeUndefined();
			expect(suite.defaultReplicas).toBe(12);
		}
		for (const name of ["cpu-node", "system", "pgbench", "memory", "disk", "network"] as const) {
			expect(SUITES[name].ptsTimesToRun).toBe(2);
			expect(SUITES[name].defaultReplicas).toBe(3);
		}
		// Convergence is enabled on the two suites that converge cheaply and predictably: cpu-node + memory.
		const converging: string[] = SUITE_NAMES.filter((name) => (SUITES[name] as Suite).ptsConverge);
		expect(converging.sort()).toEqual(["cpu-node", "memory"]);
	});

	it("mirrors each realworld suite's metrics from the generated catalog (no hand-drift)", () => {
		// The task set already lives in test-definition.xml, target.env, and the generated catalog;
		// this pins the fourth (hand-maintained) copy in SUITES to the catalog in BOTH directions, so
		// an added/removed/renamed task can't leave a suite emitting an undeclared metric or
		// declaring a metric its profile no longer produces.
		const profileOf = {
			"realworld-mastra": "local/realworld-mastra",
			"realworld-better-auth": "local/realworld-better-auth",
			"realworld-openclaw": "local/realworld-openclaw",
		} as const;
		for (const [suiteName, ptsTest] of Object.entries(profileOf)) {
			const fromCatalog = METRIC_CATALOG.filter((m) => m.pts?.test === ptsTest)
				.map((m) => m.id)
				.sort();
			expect(fromCatalog.length).toBeGreaterThan(0);
			const declared: string[] = [...SUITES[suiteName as keyof typeof SUITES].metrics];
			expect(declared.sort()).toEqual(fromCatalog);
		}
	});

	it("mirrors the unpinned suites' metrics from the generated catalog (no hand-drift)", () => {
		// These suites' declared metrics are exactly what the catalog lists for their profiles — pin the
		// declared list to it in BOTH directions (a profile bump that adds/renames a combination fails
		// here instead of silently stranding the list). stream's Type axis is the matrix case; pybench,
		// sqlite and git declare no <Option> axes, so the pin holds over their wildcard result.
		// (pgbench and network/iperf are preset-pinned against full upstream matrices — gated by the
		// subset test below.)
		const profilesOf = {
			memory: ["pts/stream"],
			system: ["pts/pybench", "pts/sqlite-speedtest", "pts/git"],
		} as const;
		for (const [suiteName, ptsTests] of Object.entries(profilesOf)) {
			const fromCatalog = METRIC_CATALOG.filter(
				(m) => m.pts && (ptsTests as readonly string[]).includes(m.pts.test),
			)
				.map((m) => m.id)
				.sort();
			expect(fromCatalog.length).toBeGreaterThan(0);
			const declared: string[] = [...SUITES[suiteName as keyof typeof SUITES].metrics];
			expect(declared.sort()).toEqual(fromCatalog);
		}
	});

	it("pins the PINNED-subset suites to their curated override keys", () => {
		// disk (fio), pgbench, and network (iperf, vendored byte-identical to upstream's full matrix)
		// deliberately declare a SUBSET of their profile's catalogued combinations — the ones the
		// producer tasks pin via PRESET_OPTIONS — so a catalog mirror can't gate them. Every declared
		// subset id is also a curated pts-overrides key (only the producible combinations get short
		// labels), so equality against the override keys catches a wrong-axis id here: with the full
		// matrix catalogued, a typo'd engine, block size, parallel count or scale would otherwise pass
		// the suite contract and just never receive samples.
		const overrideKeys = Object.keys(ptsOverrides);
		const subsets = [
			{ suite: "disk", prefix: "fio_" },
			{ suite: "pgbench", prefix: "pgbench_" },
			{ suite: "network", prefix: "iperf_" },
		] as const;
		for (const { suite, prefix } of subsets) {
			const declared: string[] = SUITES[suite].metrics.filter((id) => id.startsWith(prefix)).sort();
			const curated = overrideKeys.filter((id) => id.startsWith(prefix)).sort();
			expect(declared.length).toBeGreaterThan(0);
			expect(declared).toEqual(curated);
		}
	});

	it("keeps command timeouts within the requested sandbox lifetime", () => {
		for (const suite of Object.values(SUITES)) {
			expect(suite.commandTimeoutMinutes).toBeLessThanOrEqual(suite.timeoutMinutes);
		}
	});
});

describe("padded suite tokens", () => {
	it("wraps a single suite for exact GHA contains() matching", () => {
		expect(paddedSuiteToken("cpu-node")).toBe(",cpu-node,");
	});

	it("pads the full list so every token matches as a substring", () => {
		const list = padSuiteList(["cpu-node", "pgbench"]);
		expect(list).toBe(",cpu-node,pgbench,");
		expect(list.includes(paddedSuiteToken("cpu-node"))).toBe(true);
		expect(list.includes(paddedSuiteToken("pgbench"))).toBe(true);
	});
});
