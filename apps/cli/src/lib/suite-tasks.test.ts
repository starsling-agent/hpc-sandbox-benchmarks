import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUITE_NAMES, SUITES } from "@sandbox-benchmarks/schema";
import type { PtsWarmPlan } from "./pts-warm.ts";
import { planPtsWarm, resolveWarmSuites, suiteWarmKind } from "./pts-warm.ts";
import { suiteMetricSummaryRows, suiteTaskSummaryRows } from "./suite-summary.ts";
import {
	conventionalTaskFile,
	describeSuiteTasks,
	fioProfileFromBenchSh,
	miseTaskFromCommand,
	parseMiseTaskInfoJson,
	ptsPinsFromScript,
	realworldVersionFromBenchSh,
	runTaskChildren,
	warmHintsFromScript,
} from "./suite-tasks.ts";

// apps/cli/src/lib → repo root
const root = join(import.meta.dir, "../../../..");

describe("miseTaskFromCommand", () => {
	it("extracts the task name from a mise run command", () => {
		expect(miseTaskFromCommand("mise run benchmark:disk:all")).toBe("benchmark:disk:all");
		expect(miseTaskFromCommand("  mise run benchmark:cpu:node")).toBe("benchmark:cpu:node");
	});

	it("returns undefined for non-mise commands", () => {
		expect(miseTaskFromCommand("echo hi")).toBeUndefined();
	});
});

describe("conventionalTaskFile", () => {
	it("maps colon task names onto the .mise/tasks file layout", () => {
		expect(conventionalTaskFile("benchmark:disk:all")).toBe(".mise/tasks/benchmark/disk/all");
		expect(conventionalTaskFile("benchmark:pgbench:pts:pgbench")).toBe(
			".mise/tasks/benchmark/pgbench/pts/pgbench",
		);
	});
});

describe("runTaskChildren", () => {
	it("extracts ordered unique run_task children from an orchestrator", () => {
		const script = readFileSync(join(root, ".mise/tasks/benchmark/disk/all"), "utf8");
		expect(runTaskChildren(script)).toEqual([
			"benchmark:disk:pts:fio-seq-read",
			"benchmark:disk:pts:fio-seq-write",
			"benchmark:disk:pts:fio-rand-read",
			"benchmark:disk:pts:fio-rand-write",
			"benchmark:disk:pts:hardlink",
		]);
	});
});

describe("ptsPinsFromScript", () => {
	it("reads run_pts_benchmark pins", () => {
		const script = readFileSync(
			join(root, ".mise/tasks/benchmark/cpu/pts/node-web-tooling"),
			"utf8",
		);
		expect(ptsPinsFromScript(script)).toEqual([
			{
				ptsProfile: "pts/node-web-tooling-1.0.1",
				resultsPrefix: "pts_node-web-tooling",
			},
		]);
	});

	it("reads run_fio_pts prefixes and applies the fio profile pin", () => {
		const script = readFileSync(join(root, ".mise/tasks/benchmark/disk/pts/fio-seq-read"), "utf8");
		expect(ptsPinsFromScript(script, { fioProfile: "pts/fio-2.1.0" })).toEqual([
			{
				ptsProfile: "pts/fio-2.1.0",
				resultsPrefix: "pts_fio-seq-read",
			},
		]);
	});

	it("derives realworld local profile pins", () => {
		const script = readFileSync(join(root, ".mise/tasks/benchmark/realworld/pts/mastra"), "utf8");
		expect(ptsPinsFromScript(script)).toEqual([
			{
				ptsProfile: "local/realworld-mastra-1.0.0",
				resultsPrefix: "pts_realworld-mastra",
			},
		]);
	});

	it("collects every pin when a leaf runs multiple PTS scenarios", () => {
		const script = readFileSync(join(root, ".mise/tasks/benchmark/pgbench/pts/pgbench"), "utf8");
		expect(ptsPinsFromScript(script)).toEqual([
			{
				ptsProfile: "pts/pgbench-1.15.0",
				resultsPrefix: "pts_pgbench-read-only",
			},
			{
				ptsProfile: "pts/pgbench-1.15.0",
				resultsPrefix: "pts_pgbench-read-write",
			},
		]);
	});

	it("ignores commented-out helper calls", () => {
		const script = `
# run_pts_benchmark "pts/old-1.0.0" "pts_old"
run_pts_benchmark "pts/new-1.0.0" "pts_new"
# run_fio_pts "Sequential Read" "1MB" "pts_fio-commented"
`;
		expect(ptsPinsFromScript(script, { fioProfile: "pts/fio-2.1.0" })).toEqual([
			{ ptsProfile: "pts/new-1.0.0", resultsPrefix: "pts_new" },
		]);
	});
});

describe("fioProfileFromBenchSh", () => {
	it("mines the fio version pin from run_fio_pts in lib/bench.sh", () => {
		const benchSh = readFileSync(join(root, "lib/bench.sh"), "utf8");
		expect(fioProfileFromBenchSh(benchSh)).toBe("pts/fio-2.1.0");
	});

	it("ignores commented pins outside the function body", () => {
		const fake = `
# run_pinned_pts "pts/fio-9.9.9" "pts_fake"
run_fio_pts() {
	run_pinned_pts "pts/fio-2.1.0" "$prefix"
}
`;
		expect(fioProfileFromBenchSh(fake)).toBe("pts/fio-2.1.0");
	});

	it("ignores a commented-out function stub before the real definition", () => {
		const fake = `
# run_fio_pts() {
# 	run_pinned_pts "pts/fio-9.9.9" "$prefix"
# }
run_fio_pts() {
	run_pinned_pts "pts/fio-2.1.0" "$prefix"
}
`;
		expect(fioProfileFromBenchSh(fake)).toBe("pts/fio-2.1.0");
	});
});

describe("realworldVersionFromBenchSh", () => {
	it("mines the realworld profile version from run_realworld_pts", () => {
		const benchSh = readFileSync(join(root, "lib/bench.sh"), "utf8");
		expect(realworldVersionFromBenchSh(benchSh)).toBe("1.0.0");
	});
});

describe("parseMiseTaskInfoJson", () => {
	it("keeps name, description, and file from mise task info --json", () => {
		expect(
			parseMiseTaskInfoJson(
				JSON.stringify({
					name: "benchmark:disk:all",
					description: "Run disk benchmarks",
					file: "/repo/.mise/tasks/benchmark/disk/all",
				}),
			),
		).toEqual({
			name: "benchmark:disk:all",
			description: "Run disk benchmarks",
			file: "/repo/.mise/tasks/benchmark/disk/all",
		});
	});
});

describe("describeSuiteTasks", () => {
	it("expands every registered suite's commands into mise leaves with PTS metadata", async () => {
		for (const suite of SUITE_NAMES) {
			const plan = await describeSuiteTasks(suite, root);
			expect(plan.suite).toBe(suite);
			expect(plan.commands).toEqual([...SUITES[suite].commands]);
			expect(plan.tasks.length).toBeGreaterThan(0);
			expect(plan.tasks.some((t) => t.role === "command")).toBe(true);
			// Orchestrators expand to leaves; leaf suites (realworld-*) are themselves leaves.
			expect(plan.metrics.map((m) => m.id)).toEqual([...SUITES[suite].metrics]);
		}
	});

	it("surfaces disk fio leaves with mise descriptions and the fio profile pin", async () => {
		const plan = await describeSuiteTasks("disk", root);
		const fio = plan.tasks.find((t) => t.task === "benchmark:disk:pts:fio-seq-read");
		expect(fio?.role).toBe("leaf");
		expect(fio?.description).toContain("fio sequential read");
		expect(fio?.ptsProfile).toBe("pts/fio-2.1.0");
		expect(fio?.resultsPrefix).toBe("pts_fio-seq-read");
		expect(fio?.file).toBe(".mise/tasks/benchmark/disk/pts/fio-seq-read");
	});

	it("joins multi-pin leaves (pgbench) into comma-separated summary fields", async () => {
		const plan = await describeSuiteTasks("pgbench", root);
		const pgbench = plan.tasks.find((t) => t.task === "benchmark:pgbench:pts:pgbench");
		expect(pgbench?.ptsProfile).toBe("pts/pgbench-1.15.0");
		expect(pgbench?.resultsPrefix).toBe("pts_pgbench-read-only, pts_pgbench-read-write");
	});
});

describe("summary rows", () => {
	it("renders task and metric tables for a suite plan", async () => {
		const plan = await describeSuiteTasks("cpu-node", root);
		const taskRows = suiteTaskSummaryRows(plan);
		expect(taskRows[0]?.[0]).toEqual({ data: "Task", header: true });
		expect(taskRows.length).toBeGreaterThan(1);
		const metricRows = suiteMetricSummaryRows(plan);
		expect(metricRows[0]?.[0]).toEqual({ data: "Metric", header: true });
		expect(metricRows.length).toBe(1 + plan.metrics.length);
	});
});

describe("warmHintsFromScript", () => {
	it("mines multiline seed_pts_download_cache + vendored install from iperf-localhost", () => {
		const script = readFileSync(
			join(root, ".mise/tasks/benchmark/network/pts/iperf-localhost"),
			"utf8",
		);
		const hints = warmHintsFromScript(script);
		expect(hints.vendoredProfiles).toEqual(["iperf-1.2.0"]);
		expect(hints.localProfiles).toEqual([]);
		expect(hints.seeds).toEqual([
			{
				filename: "iperf-3.14.tar.gz",
				sha256: "723fcc430a027bc6952628fa2a3ac77584a1d0bd328275e573fc9b206c155004",
				urls: [
					"https://downloads.es.net/pub/iperf/iperf-3.14.tar.gz",
					"https://sources.buildroot.net/iperf3/iperf-3.14.tar.gz",
				],
			},
		]);
	});

	it("mines both ISA branches of the STREAM leaf's own CFLAGS_OVERRIDE", () => {
		const stream = readFileSync(join(root, ".mise/tasks/benchmark/memory/pts/stream"), "utf8");
		// Pinned against the leaf: a warm compiled with different flags than the leaf measures is the
		// silent cross-provider skew its preamble exists to remove.
		expect(warmHintsFromScript(stream).cflagsOverride).toEqual({
			native: "-O3 -march=native -DSTREAM_ARRAY_SIZE=150000000",
			gvisor: "-O3 -march=x86-64-v3 -DSTREAM_ARRAY_SIZE=150000000",
		});
	});

	it("mines profile=$profile vendored installs, and pins no flags for a leaf without them", () => {
		const fastCli = readFileSync(join(root, ".mise/tasks/benchmark/network/pts/fast-cli"), "utf8");
		expect(warmHintsFromScript(fastCli).vendoredProfiles).toEqual(["fast-cli-1.0.0"]);
		expect(warmHintsFromScript(fastCli).cflagsOverride).toBeUndefined();
	});

	it("declines to guess a CFLAGS_OVERRIDE it cannot fully resolve", () => {
		// `\${…}` keeps the bash expansion literal (and out of Biome's noTemplateCurlyInString).
		const marchRef = `\${march}`;
		const script = [
			"march=native",
			`export CFLAGS_OVERRIDE="-O3 -march=${marchRef} -I$(pwd)"`,
		].join("\n");
		expect(warmHintsFromScript(script).cflagsOverride).toBeUndefined();
	});

	it("mines local hardlink install", () => {
		const script = readFileSync(join(root, ".mise/tasks/benchmark/disk/pts/hardlink"), "utf8");
		expect(warmHintsFromScript(script).localProfiles).toEqual(["hardlink-1.0.0"]);
	});
});

const targetIds = (plan: PtsWarmPlan): string[] => plan.targets.map((target) => target.id);

describe("planPtsWarm / resolveWarmSuites", () => {
	it("classifies suite warm kinds and presets", () => {
		expect(suiteWarmKind("disk")).toBe("synthetic");
		expect(suiteWarmKind("network")).toBe("synthetic");
		expect(suiteWarmKind("pgbench")).toBe("synthetic");
		expect(suiteWarmKind("realworld-mastra")).toBe("realworld");
		expect(resolveWarmSuites([])).toEqual([
			"cpu-node",
			"system",
			"pgbench",
			"memory",
			"disk",
			"network",
		]);
		expect(resolveWarmSuites(["synthetic"])).toEqual(resolveWarmSuites([]));
		expect(resolveWarmSuites(["network"])).toEqual(["network"]);
		expect(resolveWarmSuites(["realworld"])).toEqual([
			"realworld-mastra",
			"realworld-better-auth",
			"realworld-openclaw",
		]);
		expect(resolveWarmSuites(["all"])).toEqual([
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
		expect(resolveWarmSuites(["disk", "network"])).toEqual(["disk", "network"]);
		expect(() => resolveWarmSuites(["not-a-suite"])).toThrow(/invalid warm suite token/);
	});

	it("plans a single suite (network) without pulling unrelated profiles", async () => {
		const plan = await planPtsWarm(root, { suites: ["network"] });
		expect(plan.suites).toEqual(["network"]);
		// iperf's leaf re-stages the vendored override (which rm -rf's the installed tree), so
		// installing it here would be thrown away: it is seeded, not warmed.
		expect(plan.restagedByLeaf).toEqual(["iperf-1.2.0"]);
		expect(targetIds(plan)).toEqual(["local/iperf-wan-1.0.0"]);
		expect(plan.seeds.map((seed) => seed.filename)).toEqual(["iperf-3.14.tar.gz"]);
		expect(plan.localInstalls).toEqual([{ name: "iperf-wan-1.0.0", overlays: [] }]);
	});

	it("plans synthetic targets/seeds from the suite registry without hard-coded profile lists", async () => {
		const plan = await planPtsWarm(root, { suites: ["synthetic"] });
		expect(plan.suites).toEqual(["cpu-node", "system", "pgbench", "memory", "disk", "network"]);
		const ids = targetIds(plan);
		expect(ids).toContain("pts/fio-2.1.0");
		expect(ids).toContain("pts/pgbench-1.15.0");
		expect(ids).toContain("local/hardlink-1.0.0");
		expect(ids).toContain("local/iperf-wan-1.0.0");
		expect(ids).toContain("pts/stream-1.3.4");
		expect(ids).not.toContain("pts/fast-cli-1.0.0");
		expect(ids).not.toContain("pts/iperf-1.2.0");
		expect(plan.restagedByLeaf).toEqual(["iperf-1.2.0"]);
		expect(plan.localInstalls).toEqual([
			{ name: "hardlink-1.0.0", overlays: [] },
			{ name: "iperf-wan-1.0.0", overlays: [] },
		]);
		// STREAM's flags stay on STREAM. Handing them to the shared batch would rebuild the vendored
		// iperf/fio with -march=native, which their install.sh repairs exist to prevent.
		const withFlags = plan.targets.filter((target) => target.cflagsOverride !== undefined);
		expect(withFlags.map((target) => target.id)).toEqual(["pts/stream-1.3.4"]);
		expect(withFlags[0]?.cflagsOverride).toEqual({
			native: "-O3 -march=native -DSTREAM_ARRAY_SIZE=150000000",
			gvisor: "-O3 -march=x86-64-v3 -DSTREAM_ARRAY_SIZE=150000000",
		});
		const fio = plan.seeds.find((s) => s.filename === "fio-3.36.tar.gz");
		expect(fio?.sha256).toBe("0a07354876ca4d23518f8aa88682f23866455bbd2ff2d0f055d6e4b72f156553");
		const iperf = plan.seeds.find((s) => s.filename === "iperf-3.14.tar.gz");
		expect(iperf?.urls.length).toBeGreaterThanOrEqual(2);
	});

	it("plans realworld local profile targets with shared overlays", async () => {
		const plan = await planPtsWarm(root, { suites: ["realworld"] });
		expect(plan.suites).toEqual([
			"realworld-mastra",
			"realworld-better-auth",
			"realworld-openclaw",
		]);
		expect(targetIds(plan)).toContain("local/realworld-mastra-1.0.0");
		expect(targetIds(plan)).toContain("local/realworld-better-auth-1.0.0");
		expect(targetIds(plan)).toContain("local/realworld-openclaw-1.0.0");
		expect(plan.localInstalls).toEqual([
			{
				name: "realworld-better-auth-1.0.0",
				overlays: ["lib/pts/realworld/install.sh", "lib/pts/realworld/realworld-runner.sh"],
			},
			{
				name: "realworld-mastra-1.0.0",
				overlays: ["lib/pts/realworld/install.sh", "lib/pts/realworld/realworld-runner.sh"],
			},
			{
				name: "realworld-openclaw-1.0.0",
				overlays: ["lib/pts/realworld/install.sh", "lib/pts/realworld/realworld-runner.sh"],
			},
		]);
	});
});
