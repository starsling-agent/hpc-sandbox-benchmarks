import { defineProviderMeta } from "../provider-meta.ts";

export default defineProviderMeta("blaxel", {
	displayName: "Blaxel",
	vendor: "Blaxel",
	website: "https://blaxel.ai",
	sdkPackage: "@blaxel/core",
	artifact: { kind: "none" },
	inputs: ["BL_API_KEY", "BL_WORKSPACE"],
	isolation: {
		class: "microVM",
		technology: "microVM",
		notes:
			"Blaxel sandboxes (sub-25ms boot claim). CPU is COUPLED to RAM (measured: cores = memory MB / 2048) with no cgroup cpu.max, and the sandbox root is a RAM-overlay tmpfs with no independent disk knob (storageMb/diskPercent are accepted but silently ignored on this plan). The adapter pins memory=8192 -> 8 GiB RAM and 4 vCPU (specMatched=true covers that effective vCPU/memory pair only), and mounts a 40 GiB volume at the PTS data dir so the separate disk gate clears (see blaxel-volume.ts). The target's vCPU is 4 precisely so Blaxel's coupled point lands on-spec — the dimensions stay coupled, so a different target shape would put Blaxel off-spec again.",
	},
	pricing: {
		model: "published",
		components: [
			{
				id: "active-compute",
				resource: "cpu_memory",
				billingBasis: "active",
				vendorUnit: "GB RAM",
				usdPerUnitHour: 0.0414,
				quantityRule: { kind: "linear", dimension: "memoryGb", unitsPerTargetUnit: 1 },
				notes:
					"$0.0000115/GB-RAM-s; CPU is bundled with memory and suspended sandboxes stop accruing compute.",
			},
		],
		targetHourlyCost: {
			kind: "usage_dependent",
			reason:
				"The complete charge depends on active time; the target rate alone only gives a 100%-active estimate.",
		},
		notes: "Memory-sized bundled CPU is billed only while active.",
		sources: [
			{ label: "Blaxel pricing", url: "https://blaxel.ai/pricing", checkedAt: "2026-08-08" },
			{
				label: "Sandbox billing behavior",
				url: "https://docs.blaxel.ai/Sandboxes/Overview",
				checkedAt: "2026-08-08",
			},
		],
	},
	maturity: {
		status: "beta",
		notes:
			"Now carries committed runs and is in the default matrix set. memory=8192 hits the 4 vCPU / 8 GiB target (specMatched=true is that vCPU/memory check only); the 40 GiB volume (mounted at the PTS data dir) separately lets the realworld suites (mastra 30, openclaw 25) clear the disk gate instead of skipping.",
	},
	// memory=8192 lands on the target's 8 GiB / 4 vCPU point because the target's vCPU was chosen to
	// sit on Blaxel's RAM/CPU coupling curve (specMatched only judges that pair). The 40 GiB volume
	// is the separate disk-gate path, not part of specMatched. The dimensions are still coupled --
	// you can't set CPU and RAM independently -- so "fixed" remains the honest capability: this
	// particular target is reachable, an arbitrary one would not be.
	specPinning: "fixed",
	transport: {
		// The driver execs through the sandbox gateway's process API; long synchronous execs are not
		// validated, so apply the conservative 60s policy bound and launch long steps as native
		// background processes polled through the sandbox filesystem.
		streaming: false,
		syncCapMs: 60_000,
		detachedPoll: true,
	},
});
