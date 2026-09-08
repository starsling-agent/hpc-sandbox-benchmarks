// Each schema provider id maps to a ComputeSDK factory plus benchmark create-time policy. Prefer the
// maintained @computesdk wrappers. Vercel uses its native SDK because the published wrapper still
// pins Sandbox v1; run.cloud also uses its native SDK because no @computesdk wrapper is published.

import { blaxel } from "@computesdk/blaxel";
import { daytona } from "@computesdk/daytona";
import { namespace } from "@computesdk/namespace";
import type { ProviderId } from "@sandbox-benchmarks/schema";
import { PROVIDER_IDS, TARGET_SPEC } from "@sandbox-benchmarks/schema";
import type { DaytonaConfig } from "../config.ts";
import { config } from "../config.ts";
import { blaxelWithVolumeAndKeepAlive } from "./blaxel-volume.ts";
import { runcloudCostEvidence } from "./cost-evidence.ts";
import { daytonaActivateSnapshot } from "./daytona-snapshot.ts";
import { daytonaClientTarget } from "./daytona-target.ts";
import { microsandboxCloudCompute } from "./microsandbox.ts";
import { RUNCLOUD_CREATE_CEILING_MS, runcloudCompute } from "./runcloud.ts";
import { runloopCompute } from "./runloop.ts";
import type { ProviderAdapter } from "./types.ts";
import { vercelCompute } from "./vercel.ts";

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
] as const satisfies readonly ProviderId[];

/** A schema id served by a registered DriverModule. Derived from the list, so the two cannot drift. */
export type MigratedDriverId = (typeof MIGRATED_DRIVER_IDS)[number];
/** Schema ids still served by this package's ComputeSDK adapters. */
export type LegacyAdapterId = Exclude<ProviderId, MigratedDriverId>;

/**
 * The Daytona VM and container variants share one adapter shape — the same account API key and the
 * same create-time policy — and differ only in the account config the config gatekeeper resolved:
 * region target and which pre-baked snapshot to boot. The sandbox class (LINUX_VM vs CONTAINER) is
 * fixed inside each variant's snapshot at bake time, so nothing selects it here. The region CANNOT
 * ride createOptions: the native SDK's create() honors only the CLIENT-level target (constructor
 * config or the DAYTONA_TARGET env fallback), and the wrapper builds its client from the apiKey
 * alone — so daytonaClientTarget's env-pin around create is the only channel through this wrapper
 * (race-free: each CI job runs exactly one provider). autoStopInterval does ride the wrapper's
 * provider-options passthrough into Daytona's native createParams; the universal `timeout` is only
 * the create-call deadline, so disable native auto-stop and rely on the harness's guaranteed
 * teardown. Never read process.env here.
 */
function daytonaAdapter(cfg: DaytonaConfig): ProviderAdapter {
	return {
		artifact: { kind: "baked", ref: cfg.snapshot },
		createCompute: () =>
			daytonaActivateSnapshot(
				daytonaClientTarget(daytona({ apiKey: cfg.apiKey }), cfg.target),
				cfg,
			),
		createOptions: {
			snapshotId: cfg.snapshot,
			autoStopInterval: 0,
		},
	};
}

/** The longest suite has a 155-minute budget. Give Microsandbox enough lifetime for setup and
 * teardown as well, while keeping leaked benchmark sandboxes self-expiring. */
const MICROSANDBOX_MAX_DURATION_SECS = 3 * 60 * 60;
const RUNCLOUD_MAX_DURATION_SECS = 3 * 60 * 60;

/**
 * Microsandbox's `create` does not return until the sandbox is RUNNING, so the toolchain image pull
 * happens inside it — unlike providers whose create is accepted in well under a second and whose pull
 * is absorbed by the readiness probe loop afterwards. The toolchain image is ~1.5 GiB compressed
 * across 7 layers and CI runners always start with a cold cache, which the harness's 5-minute default
 * per-attempt budget can easily lose to. A create timeout is not classified as a capacity error, so
 * that loss is not retried: the cell records `sandbox-create-failed` and produces zero results.
 */
const MICROSANDBOX_CREATE_TIMEOUT_MS = 20 * 60 * 1000;

/** The longest suite has a 155-minute budget; leave setup/collection margin while ensuring a leaked
 * Runloop Devbox expires. Runloop allows keep-alive durations up to 48 hours. */
const RUNLOOP_KEEP_ALIVE_SECS = 3 * 60 * 60;
/** Bound Runloop's create-and-await-running poll. The hardened adapter tears down an accepted
 * allocation if this deadline expires, so a cold start cannot hang the runner or leak a Devbox. */
const RUNLOOP_CREATE_TIMEOUT_MS = 20 * 60 * 1000;

function microsandboxCloudCredentials(): { kind: "cloud"; url?: string; apiKey: string } {
	const { apiUrl, apiKey } = config.microsandboxCloud;
	if (!apiKey) {
		throw new Error("microsandbox-cloud requires MSB_API_KEY");
	}
	// Omitting the URL intentionally delegates to the SDK's api.microsandbox.dev default. Keeping the
	// property absent, instead of passing undefined, also makes the backend selection shape explicit.
	return apiUrl ? { kind: "cloud", url: apiUrl, apiKey } : { kind: "cloud", apiKey };
}

/**
 * Harness adapters for providers not yet on DriverModule. The `Record<LegacyAdapterId, …>` type
 * forces exactly one adapter per unmigrated schema id, so a waived provider added to the schema
 * without an adapter here — or an adapter with a typo'd / unknown id — is a compile error. The four
 * registered DriverModule ids are omitted on purpose; default bench-suite loads them via
 * `loadDriverModule`, and a CLI partition test proves this set and `DRIVERS` are disjoint and
 * jointly complete.
 */
export const adapters: Record<LegacyAdapterId, ProviderAdapter> = {
	// Both Daytona variants share the account API key (the schema meta owns DAYTONA_API_KEY); they
	// differ only in region + the class-specific snapshot resolved by the config gatekeeper.
	"daytona-container": daytonaAdapter(config.daytonaContainer),
	blaxel: {
		artifact: { kind: "none" },
		// Credentials come from BL_API_KEY/BL_WORKSPACE (the factory's env fallback). Boot the Debian
		// ts-app image as root (the stock Alpine base-image has no apt — PTS uninstallable). Blaxel
		// couples CPU to RAM (measured: vCPU ≈ memory_MB / 2048) and exposes no cgroup cpu.max, so
		// memory=8192 yields the target's 8 GiB RAM and 4 vCPU — the target pins vCPU at 4 precisely so
		// Blaxel's coupled point matches on effective vCPU/memory (specMatched=true), no comparability
		// caveat. Disk is separate: blaxelWithVolumeAndKeepAlive mounts a 40 GiB volume at the PTS data
		// dir where the heavy suites write (see blaxel-volume.ts), so it clears the disk gate like the
		// other runners (not part of the specMatched check). It also holds one sleeping native process
		// with keepAlive=true: without an inbound request Blaxel enters standby after ~15s, which would
		// pause a synchronous benchmark. No pre-baked toolchain snapshot yet — setup steps run fallbacks.
		createCompute: () =>
			blaxelWithVolumeAndKeepAlive(
				blaxel({ image: "blaxel/ts-app:latest", memory: 8192, region: "us-was-1" }),
			),
		createOptions: {},
	},
	"microsandbox-cloud": {
		artifact: { kind: "image", ref: config.toolchainImage },
		// The API key remains in the CloudBackend HTTP/WebSocket client. It is never forwarded through
		// createOptions, metadata, or the benchmark's in-guest environment.
		createCompute: () =>
			microsandboxCloudCompute({
				backend: microsandboxCloudCredentials(),
				ephemeral: true,
				image: config.toolchainImage,
				cpus: TARGET_SPEC.vcpus,
				memoryMib: TARGET_SPEC.memoryGb * 1024,
				rootDiskMib: TARGET_SPEC.diskGb * 1024,
				namePrefix: "bench-cloud-",
				timeoutMs: MICROSANDBOX_MAX_DURATION_SECS * 1000,
			}),
		createOptions: { templateId: config.toolchainImage },
		createTimeoutMs: MICROSANDBOX_CREATE_TIMEOUT_MS,
	},
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
	vercel: {
		artifact: { kind: "mirror", ref: config.vercelImage },
		// @computesdk/vercel still targets Sandbox v1. Keep its defineProvider shape, but use the latest
		// native SDK so the shared VCR image and v2 lifecycle/filesystem APIs remain available.
		createCompute: () => vercelCompute({ image: config.vercelImage, vcpus: TARGET_SPEC.vcpus }),
		createOptions: {},
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
