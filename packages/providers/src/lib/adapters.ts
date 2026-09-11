// Each schema provider id maps to a ComputeSDK factory plus benchmark create-time policy. Prefer the
// maintained @computesdk wrappers. Vercel uses its native SDK because the published wrapper still
// pins Sandbox v1; run.cloud also uses its native SDK because no @computesdk wrapper is published.

import { namespace } from "@computesdk/namespace";
import type { ProviderId } from "@sandbox-benchmarks/schema";
import { PROVIDER_IDS, TARGET_SPEC } from "@sandbox-benchmarks/schema";
import { config } from "../config.ts";
import { runcloudCostEvidence } from "./cost-evidence.ts";
import { RUNCLOUD_CREATE_CEILING_MS, runcloudCompute } from "./runcloud.ts";
import { runloopCompute } from "./runloop.ts";
import type { ProviderAdapter } from "./types.ts";

/**
 * Provider ids whose production path is a registered DriverModule, not a `packages/providers`
 * adapter. Must stay in lockstep with `Object.keys(DRIVERS)` — the CLI partition test proves it.
 *
 * Deliberately a standalone list rather than anything derived from {@link adapters}: this is the
 * only reason an id may be absent from the join below, so reading it off the adapter table would
 * make {@link assertProviderJoin} tautological and hide the missing-adapter drift it exists to
 * catch. `packages/drivers` cannot be imported here either — the dependency DAG (ADR-0002) points
 * the other way, and this package must not pull a fleet of vendor SDKs into its load.
 */
export const MIGRATED_DRIVER_IDS = [
	"e2b",
	"modal-gvisor",
	"modal-vm",
	"tama",
	"novita",
	"daytona-vm",
	"daytona-container",
	"vercel",
	"blaxel",
	"microsandbox-cloud",
] as const satisfies readonly ProviderId[];

/** A schema id served by a registered DriverModule. Derived from the list, so the two cannot drift. */
export type MigratedDriverId = (typeof MIGRATED_DRIVER_IDS)[number];
/** Schema ids still served by this package's ComputeSDK adapters. */
export type LegacyAdapterId = Exclude<ProviderId, MigratedDriverId>;

/** The longest suite has a 155-minute budget; leave setup/collection margin while keeping leaked
 * benchmark sandboxes self-expiring. */
const RUNCLOUD_MAX_DURATION_SECS = 3 * 60 * 60;

/** The longest suite has a 155-minute budget; leave setup/collection margin while ensuring a leaked
 * Runloop Devbox expires. Runloop allows keep-alive durations up to 48 hours. */
const RUNLOOP_KEEP_ALIVE_SECS = 3 * 60 * 60;
/** Bound Runloop's create-and-await-running poll. The hardened adapter tears down an accepted
 * allocation if this deadline expires, so a cold start cannot hang the runner or leak a Devbox. */
const RUNLOOP_CREATE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Harness adapters for providers not yet on DriverModule. The `Record<LegacyAdapterId, …>` type
 * forces exactly one adapter per unmigrated schema id, so a waived provider added to the schema
 * without an adapter here — or an adapter with a typo'd / unknown id — is a compile error. The four
 * registered DriverModule ids are omitted on purpose; default bench-suite loads them via
 * `loadDriverModule`, and a CLI partition test proves this set and `DRIVERS` are disjoint and
 * jointly complete.
 */
export const adapters: Record<LegacyAdapterId, ProviderAdapter> = {
	runloop: {
		artifact: { kind: "baked", ref: config.runloopBlueprint },
		// Boot the immutable version-scoped Blueprint by name. Runloop resolves that name to its latest
		// successful build; the release lane owns creation from the shared toolchain image. Per-run launch
		// parameters retain the benchmark's target sizing and keep-alive override. The API key stays in
		// the SDK's RUNLOOP_API_KEY fallback and never enters guest-visible create options.
		createCompute: runloopCompute,
		createOptions: {
			timeout: RUNLOOP_CREATE_TIMEOUT_MS,
			blueprint_name: config.runloopBlueprint,
			launch_parameters: {
				resource_size_request: "CUSTOM_SIZE",
				custom_cpu_cores: TARGET_SPEC.vcpus,
				custom_gb_memory: TARGET_SPEC.memoryGb,
				custom_disk_size: TARGET_SPEC.diskGb,
				keep_alive_time_seconds: RUNLOOP_KEEP_ALIVE_SECS,
			},
		},
	},
	namespace: {
		artifact: { kind: "image", ref: config.toolchainImage },
		// The token rides the factory's own NSC_TOKEN_FILE env fallback (getAndValidateCredentials) —
		// CI's OIDC federation (nscloud-setup) lands the token there, not in NSC_TOKEN — never read
		// here, same as blaxel's BL_API_KEY. virtualCpu/memoryMegabytes are per-instance knobs on this
		// factory config (not per-create options), so the target spec is pinned once, at construction,
		// like blaxel's/modal's cpu/memory.
		createCompute: () =>
			namespace({
				virtualCpu: TARGET_SPEC.vcpus,
				memoryMegabytes: TARGET_SPEC.memoryGb * 1024,
			}),
		// Namespace has no template/snapshot system — `create()` pulls an arbitrary OCI ref straight
		// from `options.image` (computesdk's open CreateSandboxOptions passthrough), so, like modal's
		// fromRegistry boot, this points directly at the published toolchain image; nothing to bake.
		createOptions: { image: config.toolchainImage },
	},
	runcloud: {
		artifact: { kind: "image", ref: config.toolchainImage },
		// run.cloud boots the OCI image directly and exposes independent CPU, memory, and writable-disk
		// knobs. Keep both its lifetime and idle-pause window above the longest 155-minute suite so a
		// detached benchmark is not paused while the harness is polling its done file. create() polls
		// until the sandbox is running and owns failed-allocation cleanup. Disable the harness's
		// non-cancellable outer race: abandoning create while it is cleaning up would let bench-suite's
		// explicit process exit terminate that teardown and strand the billable sandbox. The adapter
		// independently bounds each native control-plane call, so awaiting its ownership does not turn a
		// wedged SDK request into an unbounded create.
		createCompute: runcloudCompute,
		createOptions: {
			image: config.toolchainImage,
			cpu: TARGET_SPEC.vcpus,
			memory: TARGET_SPEC.memoryGb * 1024,
			disk: TARGET_SPEC.diskGb,
			idlePauseSeconds: RUNCLOUD_MAX_DURATION_SECS,
			timeoutSeconds: RUNCLOUD_MAX_DURATION_SECS,
		},
		createTimeoutMs: null,
		// With the harness race off, the adapter's own bounds are the only ceiling on an attempt — hand
		// them over so the create-retry loop can refuse a retry the budget cannot absorb.
		createAttemptCeilingMs: RUNCLOUD_CREATE_CEILING_MS,
		costEvidence: runcloudCostEvidence,
	},
};

/**
 * Whether `id` is a schema provider this package is still expected to serve.
 *
 * Answers from the schema registry and the migrated-id list — never from `adapters` itself. A
 * membership test against the table would report "not ours" for a waived provider whose adapter is
 * simply MISSING, which is exactly the drift {@link assertProviderJoin} must still be able to see.
 */
export function isLegacyAdapterId(id: string): id is LegacyAdapterId {
	return (
		(PROVIDER_IDS as readonly string[]).includes(id) &&
		!(MIGRATED_DRIVER_IDS as readonly string[]).includes(id)
	);
}
