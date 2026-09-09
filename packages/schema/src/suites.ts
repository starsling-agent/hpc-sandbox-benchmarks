import { type } from "arktype";
import type { Dimension } from "./metrics.ts";

/**
 * The benchmark suite registry — the shared contract between the harness (which runs a suite's
 * commands inside a sandbox) and CI matrix planning (which fans suites out into jobs). Kept here in
 * schema, dependency-free, so both consumers import one source of truth and never disagree on the
 * suite list or its per-suite budgets.
 *
 * Each suite also declares the {@link Suite.dimensions} it measures and the catalogued
 * {@link Suite.metrics} it emits — the producer↔catalog half of the contract. `./suite-contract.ts`
 * checks that declaration against the Metric Catalog at schema load, so a suite emitting an
 * uncatalogued or off-dimension metric fails fast at the boundary instead of silently corrupting the
 * comparison once it runs. The `Dimension` import is type-only, so this module stays runtime
 * dependency-free; the catalog coupling lives entirely in the contract checker.
 *
 * A suite's `commands` are mise tasks (e.g. `mise run benchmark:cpu:node`) implemented by the
 * in-sandbox producer under `/.mise/tasks/benchmark/**` + `/lib/bench.sh`. This slice ships a single
 * cpu-node suite; adding the next is one entry here plus its thin task file (see the producer's
 * `bench.sh` helpers), not a reshape of the harness.
 */

export interface Suite {
	/** Install the Phoronix Test Suite during setup (PTS-backed suites need it). */
	setupPts?: boolean;
	/** Install Node 22 + pnpm 10 during setup. */
	setupNode?: boolean;
	/** Timeout applied to each benchmark command, in minutes. */
	commandTimeoutMinutes: number;
	/** Requested sandbox lifetime, in minutes (covers setup + the suite). */
	timeoutMinutes: number;
	/** Skip (with a marker) when the sandbox has less than this much free disk, in GiB. */
	minDiskGb?: number;
	/**
	 * In-sandbox repeat count (k): how many timed PTS passes each case runs (FORCE_TIMES_TO_RUN), threaded
	 * into the harness preamble. Absent → the harness default ({@link DEFAULT_PTS_TIMES_TO_RUN}, k=2).
	 * Captures WITHIN-machine noise cheaply; between-machine variance is the {@link defaultReplicas} axis.
	 * Ignored when {@link ptsConverge} is set (convergence chooses the count itself); still the documented
	 * fixed fallback the suite would use if convergence were turned off.
	 */
	ptsTimesToRun?: number;
	/**
	 * Let PTS's own statistical convergence (DynamicRunCount) choose the in-sandbox pass count instead of
	 * pinning it to {@link ptsTimesToRun}: run a minimum, then keep going while the standard deviation
	 * across passes exceeds PTS's threshold, up to PTS's cap. This is the WITHIN-machine tightening knob,
	 * set on the two suites whose passes converge cheaply and predictably: `memory` (STREAM is a tiny,
	 * tight bandwidth loop) and `cpu-node` (CPU-bound, so low within-machine variance settles DynamicRunCount
	 * near its ~3-pass minimum — no runaway, and its budget is bumped for headroom). It is deliberately LEFT
	 * OFF wherever a variable pass count is unsafe or wrong: the I/O suites (disk — fio's DynamicRunCount
	 * blew up to 20-40 runs and exhausted the suite historically; pgbench — each pass re-runs an expensive
	 * scale-100 init), the system suite (SQLite's I/O variance timed convergence out at its 55-min budget on
	 * modal-gvisor in run #49), the network suite (a documented "trial count stays 2" rule + per-run WAN
	 * server reselection), and the realworld suites (k=1 — the cold install/build IS the metric). Those take
	 * their tightness from {@link defaultReplicas} replicate sandboxes instead. The `pts_passes` dispatch
	 * input (BENCH_PTS_PASSES) overrides this per run — a fixed number, or `converge` to force convergence
	 * on every suite (accepting the budget risk on the I/O + system suites).
	 */
	ptsConverge?: boolean;
	/**
	 * Replicate sandboxes (R) to run per (provider, suite) — the between-sandbox axis the CI matrix fans
	 * out. R replicates capture host placement / noisy-neighbour variance the in-sandbox repeats can't.
	 * The total retained sample count per case is R × k. Absent → a single replicate (R=1).
	 */
	defaultReplicas?: number;
	/**
	 * The Dimensions this suite measures — the axes its metrics land on. Every id in {@link metrics}
	 * must sit on one of these, and every dimension here must be covered by at least one declared
	 * metric (both enforced by `./suite-contract.ts` at load). Declared alongside `metrics` rather than
	 * derived from them so a metric catalogued on an unexpected dimension is rejected (off-dimension)
	 * rather than silently widening the suite's axes; it also lets the leaderboard/matrix group suites
	 * by axis without expanding the metric list.
	 */
	dimensions: readonly Dimension[];
	/**
	 * The catalogued Metric ids this suite emits. Each must exist in `METRIC_CATALOG` and sit on one of
	 * {@link dimensions} — the producer↔catalog contract, checked fail-fast at schema load. A suite may
	 * list a subset of a multi-result test's catalogued metrics when its `commands` run only some option
	 * combinations (the unrun entries simply never receive samples).
	 */
	metrics: readonly string[];
	/** Commands run sequentially in the repo checkout. Sandboxes run as root, so no `sudo` prefix. */
	commands: string[];
}

/**
 * The suite registry. Suite names fan out into the in-sandbox mise tasks under
 * `/.mise/tasks/benchmark/**`; keep the two in sync (a drift gate lands with the multi-suite work).
 */
export const SUITES = {
	"cpu-node": {
		setupPts: true,
		setupNode: true,
		// Long-synthetic tier, PTS CONVERGES in-sandbox (R=3): node-web-tooling is CPU-bound, so its
		// within-machine variance is low and DynamicRunCount settles near its ~3-pass minimum rather than
		// expanding toward a runaway tail (the I/O suites' failure mode) — and ~3 passes is exactly what
		// cpu-node ran before PR #129 lowered it to k=2, so the budget has handled it. The command/sandbox
		// budgets are bumped 60→75 / 70→85 (still under realworld's 90) for headroom on the extra
		// convergence pass on slower providers; gVisor taxes I/O, not CPU, so cpu-node isn't exposed to
		// the SQLite-style overrun that timed `system` out. Between-machine spread still rides R=3.
		commandTimeoutMinutes: 75,
		timeoutMinutes: 85,
		ptsTimesToRun: 2,
		ptsConverge: true,
		defaultReplicas: 3,
		// cpu-node runs only `benchmark:cpu:node` (node-web-tooling); it is the sole cpu-dimension suite.
		dimensions: ["cpu"],
		metrics: ["node_web_tooling_runs_per_s"],
		commands: ["mise run benchmark:cpu:node"],
	},
	// The system dimension (pybench + sqlite + git): PyBench (Python interpreter) + SQLite Speedtest
	// (single-result wildcards) + common Git operations over a fixed GTK checkout. PostgreSQL (pgbench)
	// is its own leg below — split out so its ~1.5 GB dataset and long runtime don't gate the quick
	// system probes. Long-synthetic tier: k=2 FIXED (R=3). Convergence is OFF: pybench and git are stable,
	// but SQLite Speedtest touches I/O — a converge run (#49) drove DynamicRunCount past the 55-min command
	// budget and timed the whole system suite out on modal-gvisor (gVisor's slower I/O). So system keeps a
	// fixed count and takes its tightness from the R=3 replicates, like the other I/O-touching suites; a
	// calibration dispatch that re-derives a converge-safe budget could re-enable it later.
	system: {
		setupPts: true,
		commandTimeoutMinutes: 55,
		timeoutMinutes: 65,
		minDiskGb: 5,
		ptsTimesToRun: 2,
		defaultReplicas: 3,
		dimensions: ["system"],
		metrics: ["pybench_milliseconds", "sqlite_speedtest_seconds", "git_seconds"],
		commands: ["mise run benchmark:system:all"],
	},
	// The system dimension (PostgreSQL via pgbench), pinned to one (scale 100, 50 clients) point per mode
	// — each mode posts a TPS and an Average Latency metric. pgbench runs server + client fully in-sandbox
	// (same topology on every provider). At k=2 it makes four timed passes (two per mode), each with its
	// own scale-100 `pgbench -i`; that and the ~1.5 GB dataset set the budget and disk floor. Requires the
	// baked image (postgres pre-built, libicu-dev present); on a stock image the from-source postgres
	// build lands inside this budget too. Long-synthetic tier: k=2 FIXED (R=3). Convergence is OFF —
	// each timed pass re-runs an expensive scale-100 `pgbench -i`, so a variable DynamicRunCount count
	// would blow the 75-min budget the four fixed passes already fill; R=3 replicates carry the spread.
	pgbench: {
		setupPts: true,
		commandTimeoutMinutes: 75,
		timeoutMinutes: 85,
		minDiskGb: 5,
		ptsTimesToRun: 2,
		defaultReplicas: 3,
		dimensions: ["system"],
		metrics: [
			"pgbench_scaling_factor_100_clients_50_mode_read_only",
			"pgbench_scaling_factor_100_clients_50_mode_read_only_average_latency",
			"pgbench_scaling_factor_100_clients_50_mode_read_write",
			"pgbench_scaling_factor_100_clients_50_mode_read_write_average_latency",
		],
		commands: ["mise run benchmark:pgbench:all"],
	},
	// The memory dimension: STREAM (Copy/Scale/Add/Triad). Short — STREAM runs in a couple of minutes.
	// Long-synthetic tier, PTS CONVERGES in-sandbox (R=3) — one of the two converging suites (with cpu-node):
	// STREAM is a tight, cheap bandwidth loop, so DynamicRunCount settles fast and even a long convergence
	// fits the 30-min budget many times over (unlike system, whose SQLite leg timed convergence out in run #49).
	// Three replicate sandboxes capture the between-machine bandwidth spread STREAM Copy is notorious for
	// under noisy virtualization (STREAM's between-machine CV is the highest of the synthetics, so R=3
	// leaves it the widest-interval headline — convergence tightens within-machine, replicas the rest).
	memory: {
		setupPts: true,
		commandTimeoutMinutes: 30,
		timeoutMinutes: 40,
		ptsTimesToRun: 2,
		ptsConverge: true,
		defaultReplicas: 3,
		dimensions: ["memory"],
		metrics: ["stream_type_copy", "stream_type_scale", "stream_type_add", "stream_type_triad"],
		commands: ["mise run benchmark:memory:all"],
	},
	// The disk dimension: pts/fio across four pinned scenarios (seq read/write 1MB, rand read/write
	// 4KB; Engine Linux AIO, Job Count 1, Default Test Directory) plus hardlink throughput (stress-ng
	// --link, a repo-local PTS profile). Each fio scenario posts a bandwidth AND an IOPS result —
	// scale-pinned twin metrics. Direct is probed per sandbox (O_DIRECT fails on some sandbox
	// filesystems), so every scenario declares an O_DIRECT and a buffered variant; each provider emits
	// exactly one of the two and the mode travels in the metric identity (the contract allows declared-
	// but-unrun combinations). At k=2 the budget covers two timed passes of each of the four 60s scenarios
	// plus the hardlink profile; fio writes 1 GiB test files, hence the raised disk floor. Long-synthetic
	// tier: k=2 FIXED (R=3). Convergence is OFF here for a hard-won reason — PTS's DynamicRunCount expanded
	// noisy fio cases to 20-40 runs and exhausted the suite (lib/bench.sh), the exact blowup the fixed pin
	// was introduced to prevent; the between-machine spread rides the R=3 replicates instead.
	disk: {
		setupPts: true,
		commandTimeoutMinutes: 65,
		timeoutMinutes: 75,
		minDiskGb: 4,
		ptsTimesToRun: 2,
		defaultReplicas: 3,
		dimensions: ["disk"],
		metrics: [
			"hardlink_bogo_ops_per_s",
			"fio_type_sequential_read_engine_linux_aio_direct_yes_block_size_1mb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_sequential_read_engine_linux_aio_direct_yes_block_size_1mb_job_count_1_disk_target_default_test_directory_iops",
			"fio_type_sequential_write_engine_linux_aio_direct_yes_block_size_1mb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_sequential_write_engine_linux_aio_direct_yes_block_size_1mb_job_count_1_disk_target_default_test_directory_iops",
			"fio_type_random_read_engine_linux_aio_direct_yes_block_size_4kb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_random_read_engine_linux_aio_direct_yes_block_size_4kb_job_count_1_disk_target_default_test_directory_iops",
			"fio_type_random_write_engine_linux_aio_direct_yes_block_size_4kb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_random_write_engine_linux_aio_direct_yes_block_size_4kb_job_count_1_disk_target_default_test_directory_iops",
			"fio_type_sequential_read_engine_linux_aio_direct_no_block_size_1mb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_sequential_read_engine_linux_aio_direct_no_block_size_1mb_job_count_1_disk_target_default_test_directory_iops",
			"fio_type_sequential_write_engine_linux_aio_direct_no_block_size_1mb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_sequential_write_engine_linux_aio_direct_no_block_size_1mb_job_count_1_disk_target_default_test_directory_iops",
			"fio_type_random_read_engine_linux_aio_direct_no_block_size_4kb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_random_read_engine_linux_aio_direct_no_block_size_4kb_job_count_1_disk_target_default_test_directory_iops",
			"fio_type_random_write_engine_linux_aio_direct_no_block_size_4kb_job_count_1_disk_target_default_test_directory_mb_per_s",
			"fio_type_random_write_engine_linux_aio_direct_no_block_size_4kb_job_count_1_disk_target_default_test_directory_iops",
		],
		commands: ["mise run benchmark:disk:all"],
	},
	// The network dimension, iperf composition (benchmark:network:suite): iperf3 over localhost
	// isolates the sandbox's network stack/virtualization overhead (virtio/KVM vs gVisor netstack vs
	// host namespaces) from Internet weather, and iperf3 against the closest curated public server
	// (local/iperf-wan; chosen at run time by TCP-connect RTT probe, recorded as provenance)
	// measures WAN throughput both directions with real byte accounting. These supersede the
	// fast-cli + dd|nc loopback leaves IN THE SUITE (run 29937467891: Chrome's page-scrape
	// measurement was structurally unreliable on fast datacenter paths — every trial on
	// daytona-vm/novita/blaxel died in the memory watchdog and the surviving numbers were
	// buffer-fill transients); the old leaves and profiles stay runnable manually via
	// benchmark:network:all. The suite task also runs latency/DNS and a small GitHub
	// control-download probe as raw provenance. Long-synthetic tier: k=2 FIXED (R=3). Convergence is OFF —
	// the vendored iperf profile carries a documented "trial count stays 2" repo rule (its install.sh), and
	// the WAN leg reselects the closest public server per run, so repeated in-sandbox passes aren't
	// like-for-like; the between-machine spread rides the R=3 replicates instead.
	network: {
		setupPts: true,
		commandTimeoutMinutes: 30,
		timeoutMinutes: 40,
		ptsTimesToRun: 2,
		defaultReplicas: 3,
		dimensions: ["network"],
		metrics: [
			"iperf_server_address_localhost_server_port_5201_duration_10_seconds_test_tcp_parallel_1",
			"iperf_server_address_localhost_server_port_5201_duration_10_seconds_test_tcp_parallel_10",
			"iperf_server_address_localhost_server_port_5201_duration_10_seconds_test_udp_10000mbit_objective_parallel_1",
			"iperf_wan_direction_download",
			"iperf_wan_direction_upload",
		],
		commands: ["mise run benchmark:network:suite"],
	},
	// The realworld dimension (ENG-135/136/137/138): real OSS repos run through their own CI tasks,
	// each a repo-local PTS profile with a Task option axis. Real-world tier: k=1 in-sandbox pass (the
	// cold-start IS the metric — NO in-sandbox convergence; re-running the install inside one sandbox
	// isn't a cold install) × R=12 replicate sandboxes (n = 12 per case) — replicas, not repeats, carry
	// the between-machine variance users actually experience. R was raised 5→12 from the committed
	// dataset's between-run variance: at R=5 the headline cold-install/build metrics' 95% CI half-width
	// ran ~8% (median) to ~18% (p75 of metric×provider series); R=12 brings that to ~5%/~12% (√(5/12)≈0.65×),
	// separating providers that differ by more than ~12% (near-ties under ~5% stay ties at any practical R). Budgets
	// are provisional ceilings re-derived after a calibration dispatch. mastra's task matrix is the narrowest (scoped to
	// packages/core) but its monorepo has the largest install/build footprint — hence the biggest
	// minDiskGb. better-auth and openclaw run their full task matrices including a cold pnpm install
	// and a full build.
	"realworld-mastra": {
		setupPts: true,
		setupNode: true,
		commandTimeoutMinutes: 80,
		timeoutMinutes: 90,
		minDiskGb: 30,
		ptsTimesToRun: 1,
		defaultReplicas: 12,
		dimensions: ["realworld"],
		metrics: [
			"realworld_mastra_task_git_clone",
			"realworld_mastra_task_cold_install",
			"realworld_mastra_task_lint_format",
			"realworld_mastra_task_build_core",
			"realworld_mastra_task_test_core",
		],
		commands: ["mise run benchmark:realworld:pts:mastra"],
	},
	// At k=1 each task case runs once (including the per-run git-clean/install resets); the command
	// budget covers slower virtualized filesystems while the sandbox lifetime leaves setup and
	// collection headroom. The workflow timeout gate independently reserves host-job margin beyond the
	// longest sandbox lifetime.
	"realworld-better-auth": {
		setupPts: true,
		setupNode: true,
		commandTimeoutMinutes: 80,
		timeoutMinutes: 90,
		minDiskGb: 10,
		ptsTimesToRun: 1,
		defaultReplicas: 12,
		dimensions: ["realworld"],
		metrics: [
			"realworld_better_auth_task_git_clone",
			"realworld_better_auth_task_cold_install",
			"realworld_better_auth_task_lint_biome",
			"realworld_better_auth_task_lint_deps_knip",
			"realworld_better_auth_task_lint_format",
			"realworld_better_auth_task_lint_spell",
			"realworld_better_auth_task_lint_types",
			"realworld_better_auth_task_lint_packages",
			"realworld_better_auth_task_typecheck",
			"realworld_better_auth_task_build",
		],
		commands: ["mise run benchmark:realworld:pts:better-auth"],
	},
	"realworld-openclaw": {
		setupPts: true,
		setupNode: true,
		commandTimeoutMinutes: 80,
		timeoutMinutes: 90,
		minDiskGb: 25,
		ptsTimesToRun: 1,
		defaultReplicas: 12,
		dimensions: ["realworld"],
		metrics: [
			"realworld_openclaw_task_git_clone",
			"realworld_openclaw_task_cold_install",
			"realworld_openclaw_task_lint_oxlint",
			"realworld_openclaw_task_lint_extensions",
			"realworld_openclaw_task_typecheck",
			"realworld_openclaw_task_shrinkwrap_check",
			"realworld_openclaw_task_test_unit_fast",
			"realworld_openclaw_task_test_types",
		],
		commands: ["mise run benchmark:realworld:pts:openclaw"],
	},
} as const satisfies Record<string, Suite>;

/** A registered suite name. */
export type SuiteName = keyof typeof SUITES;

/** The known suite names. */
export const SUITE_NAMES = Object.keys(SUITES) as SuiteName[];

/** Runtime form of the canonical suite-name vocabulary. */
export const suiteNameSchema = type.enumerated(...SUITE_NAMES);

/**
 * Host-side checkout/teardown/normalization/upload allowance beyond the sandbox lifetime — what a
 * bench job needs ON TOP of the suite budgets it runs, charged ONCE per job rather than per suite.
 *
 * Owned here, next to the `timeoutMinutes` it is always added to, because two independent consumers
 * must agree on it or the pair contradicts itself: the workflow gate (`checkWorkflowTimeouts`) uses
 * it as the floor a job's `timeout-minutes` must clear, and `bench-suite`'s fan-out guard
 * (`fleetBudgetError`) uses it to decide whether a capped fleet's serial waves fit that same budget.
 * A guard using a smaller margin than the gate would admit a fan-out the gate considers unaffordable
 * and let the cell be cancelled with every shard lost — which is the exact outcome both exist to
 * prevent.
 */
export const WORKFLOW_TIMEOUT_MARGIN_MINUTES = 15;

/**
 * The comma-padded token for one suite, e.g. `cpu-node` → `,cpu-node,`. GitHub Actions `if:`
 * expressions can't split strings, so the setup job emits the planned suites as a padded list
 * ({@link padSuiteList}) and each suite job matches its own token with `contains(..., ',<suite>,')`.
 * One owner for the padding so the emitter and any drift gate can never disagree on the spelling.
 */
export function paddedSuiteToken(suite: string): string {
	return `,${suite},`;
}

/** The full padded list the setup job emits, e.g. `[a, b]` → `,a,b,`. */
export function padSuiteList(suites: readonly string[]): string {
	return `,${suites.join(",")},`;
}
