// The harness-measured Metrics: the lifecycle and control-plane Dimensions PTS cannot see.
//
// Phoronix profiles measure work done INSIDE an already-running sandbox; they are blind to how fast a
// provider spawns, execs, snapshots, and tears a sandbox down, and to how quickly its control-plane
// API answers. Those axes are measured directly by the harness lifecycle driver
// (@sandbox-benchmarks/harness), which times each provider SDK call and labels every timing Sample
// with one of the {@link HARNESS_METRIC_IDS} below — exactly as the PTS parser maps a `<Result>` onto
// a catalogued id. So these MetricDefs carry NO `pts` provenance: they are populated from harness
// timings, never from a parsed profile.
//
// These entries are hand-authored (the XML generator owns only the PTS half of the Catalog) and merged
// into METRIC_CATALOG by catalog.ts. The catalog drift gate diffs only the generated PTS module, so
// editing this file never trips it.
import type { MetricDef } from "./metrics.ts";

/**
 * The stable Metric id the harness emits for each timed lifecycle/control-plane operation — the one
 * source of truth both sides share. The harness imports this map to label each {@link RawRun} it
 * produces, and {@link harnessMetrics} keys its MetricDefs off the same values, so a `RawRun.operation`
 * is a catalogued Metric id by construction (the harness-side analogue of the PTS test→id mapping).
 *
 * Keyed by the operation the driver performs, not by the id, so the harness reads
 * `HARNESS_METRIC_IDS.spawn` rather than repeating the string literal.
 */
export const HARNESS_METRIC_IDS = {
	/** Create-resolve: wall time until `sandbox.create()` returns a handle — NOT yet a usable sandbox. */
	spawn: "lifecycle_spawn_ms",
	/**
	 * Honest cold start: t0 (before create) → the FIRST trivial exec that returns successfully. Unlike
	 * {@link spawn} this includes the readiness wait, so it is the real "ready to do work" latency.
	 */
	coldStart: "lifecycle_cold_start_ms",
	/** Readiness wait: create-resolve → the first successful exec — the gap {@link spawn} can't see. */
	firstExec: "lifecycle_time_to_first_exec_ms",
	/** A trivial in-sandbox command round-trip — the exec-path latency floor. */
	exec: "lifecycle_exec_ms",
	/** Capturing a snapshot/image from a running sandbox. */
	snapshot: "lifecycle_snapshot_ms",
	/** `sandbox.destroy()` releases the sandbox. */
	teardown: "lifecycle_teardown_ms",
	/** Control-plane read: a sandbox status/metadata lookup (`getInfo`). */
	controlPlaneInfo: "control_plane_info_ms",
	/** Control-plane enumeration: listing the account's sandboxes. */
	controlPlaneList: "control_plane_list_ms",
	/** A 64KiB-stdout exec round-trip — exec overhead including output streaming. */
	execPayload64k: "control_plane_exec_payload_64k_ms",
} as const;

/** The operations the lifecycle driver times — the keys of {@link HARNESS_METRIC_IDS}. */
export type HarnessOperation = keyof typeof HARNESS_METRIC_IDS;

/** A Metric id the harness emits — a value of {@link HARNESS_METRIC_IDS}. */
export type HarnessMetricId = (typeof HARNESS_METRIC_IDS)[HarnessOperation];

// Every harness Metric is a latency in milliseconds where lower is better; spelled once here so the
// table below stays a list of the editorial fields (id/label/description/headline) that actually differ.
const MS = "ms";
const LIB = "LIB";

/**
 * The non-PTS Metric Catalog slice: the lifecycle and control-plane Metrics, in display order. Exactly
 * one `headline:true` per Dimension (cold-start for lifecycle, sandbox-info for control-plane), the
 * invariant catalog.ts enforces at load and harness-metrics.test asserts here. No `pts` field — these
 * are populated from harness timings, so the catalogSchema PTS-mapping invariant skips them.
 */
export const harnessMetrics: MetricDef[] = [
	{
		id: HARNESS_METRIC_IDS.spawn,
		dimension: "lifecycle",
		unit: MS,
		direction: LIB,
		headline: false,
		label: "Spawn",
		description:
			"Wall time for the provider's SDK create() call to return a sandbox handle. This is create-resolve only — the handle is not necessarily ready to run a command yet, so cold-start is the honest headline.",
	},
	{
		id: HARNESS_METRIC_IDS.coldStart,
		dimension: "lifecycle",
		unit: MS,
		direction: LIB,
		headline: true,
		label: "Cold start",
		description:
			"Honest cold start: wall time from before the SDK create() call until the first trivial in-sandbox command returns successfully — create plus the readiness wait. The real 'ready to do work' latency.",
	},
	{
		id: HARNESS_METRIC_IDS.firstExec,
		dimension: "lifecycle",
		unit: MS,
		direction: LIB,
		headline: false,
		label: "Time to first exec",
		description:
			"Wall time from create() returning a handle until the first trivial command runs successfully — the readiness gap between a resolved handle and a usable sandbox that spawn alone cannot see.",
	},
	{
		id: HARNESS_METRIC_IDS.exec,
		dimension: "lifecycle",
		unit: MS,
		direction: LIB,
		headline: false,
		label: "Exec round-trip",
		description:
			"Wall time of a trivial in-sandbox command round-trip — the exec-path latency floor, independent of the work the command does.",
	},
	{
		id: HARNESS_METRIC_IDS.snapshot,
		dimension: "lifecycle",
		unit: MS,
		direction: LIB,
		headline: false,
		label: "Snapshot",
		description:
			"Wall time to capture a snapshot/image from a running sandbox. Recorded as a skip when the provider integration under measurement exposes no snapshot operation.",
	},
	{
		id: HARNESS_METRIC_IDS.teardown,
		dimension: "lifecycle",
		unit: MS,
		direction: LIB,
		headline: false,
		label: "Teardown",
		description:
			"Wall time for the provider to destroy a sandbox and release its resources, measured by the harness around the SDK destroy() call.",
	},
	{
		id: HARNESS_METRIC_IDS.controlPlaneInfo,
		dimension: "control-plane",
		unit: MS,
		direction: LIB,
		headline: true,
		label: "Sandbox info",
		description:
			"Round-trip latency of a sandbox status/metadata lookup (getInfo) — the control-plane read path.",
	},
	{
		id: HARNESS_METRIC_IDS.controlPlaneList,
		dimension: "control-plane",
		unit: MS,
		direction: LIB,
		headline: false,
		label: "List sandboxes",
		description:
			"Round-trip latency of listing the account's sandboxes — the control-plane enumeration path. Recorded as a skip when the provider integration under measurement exposes no list operation.",
	},
	{
		id: HARNESS_METRIC_IDS.execPayload64k,
		dimension: "control-plane",
		unit: MS,
		direction: LIB,
		headline: false,
		label: "Exec 64KiB payload",
		description:
			"Round-trip latency of an exec that writes exactly 64KiB to stdout (head -c 65536 /dev/zero | tr '\\0' 'a') — exec overhead including output streaming, isolated from the trivial round-trip floor.",
	},
];
