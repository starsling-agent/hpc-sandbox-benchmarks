import { defineProviderMeta } from "../provider-meta.ts";

export default defineProviderMeta("tama", {
	displayName: "tama",
	vendor: "tama",
	website: "https://tama.computer",
	// No SDK is published for any language; the CLI is the only programmatic surface, so the adapter
	// drives `tama` as a subprocess and parses its `--json` output.
	sdkPackage: "tama CLI",
	artifact: { kind: "image" },
	// Required, DESPITE the adapter being able to authenticate from an existing `tama login` profile.
	// requiredEnvVars is the credential gate, and the gate is what turns an unwired provider into a
	// recorded SKIP instead of a failed cell: a CLI profile is invisible to it, so treating "no token"
	// as "maybe the profile works" would mean a matrix cell with no credential at all discovers that
	// by failing to create a sandbox. Preparation authenticates with the explicit token once per driver
	// context, serialized across contexts so profile writes do not race. Local devs use separate
	// benchmark credentials and export a token from `tama tokens create`
	// — see .env.example.
	inputs: ["TAMA_TOKEN", { name: "TAMA_CLI", source: { kind: "variable" }, required: false }],
	isolation: {
		class: "container",
		// Declared from an in-guest probe, because the vendor publishes no isolation claim. Every
		// signal points at a shared-kernel container rather than the "machine" the CLI's vocabulary
		// implies: systemd-detect-virt reports `container-other`, there is no `hypervisor` CPU flag,
		// /dev/kvm is absent, `/` is an overlay, PID 1 is a vendor `goproc` supervisor, and the DMI
		// product/vendor is the bare-metal host (COMPAL SR220-2) rather than a synthetic VM board.
		technology: "container (shared kernel)",
		notes:
			"Probed, not vendor-declared. CPU and memory are enforced through cgroup v2 (cpu.max, memory.max), but /proc/meminfo reports the HOST's memory (1.5 TiB observed on an 8 GiB request), which is the shared-kernel signature and the reason memory-sized workloads need the effective-spec split.",
	},
	pricing: {
		// The CPU-only rate the benchmark's target bills under is published on the site's pricing
		// section — separately from `tama offers`, which lists $/hr per GPU type plus a default box
		// share (e.g. RTX4090 $0.66/hr, 7cpu/42Gi) and says nothing about a GPU-less machine.
		model: "published",
		components: [
			{
				id: "cpu",
				resource: "cpu",
				// Billed for the seconds the machine is RUNNING, against what it was allocated — a stopped
				// machine bills nothing, but nothing about the benchmark's own load changes the rate.
				billingBasis: "provisioned",
				vendorUnit: "vCPU",
				usdPerUnitHour: 0.0095,
				quantityRule: { kind: "linear", dimension: "vcpus", unitsPerTargetUnit: 1 },
			},
			{
				id: "memory",
				resource: "memory",
				billingBasis: "provisioned",
				vendorUnit: "GiB",
				usdPerUnitHour: 0.0045,
				quantityRule: { kind: "linear", dimension: "memoryGb", unitsPerTargetUnit: 1 },
			},
		],
		// No disk component: tama exposes no disk knob and prices none, so the target's 40 GB is met
		// by the shared overlay's capacity rather than by a billable allocation (see specPinning).
		targetHourlyCost: { kind: "exact", componentIds: ["cpu", "memory"] },
		notes:
			"Per-second billing for the seconds a machine is running; snapshots and stopped machines are free. The rate is charged on the ALLOCATED size, so the benchmark's 4 vCPU / 8 GiB target costs 4 x $0.0095 + 8 x $0.0045 = $0.074/hr. GPU machines bill a per-card rate instead (`tama offers`), which this CPU-only target never enters.",
		sources: [{ label: "tama pricing", url: "https://tama.computer", checkedAt: "2026-08-13" }],
	},
	maturity: {
		status: "beta",
		notes:
			"CLI-backed adapter covering create, lifecycle, streaming exec, and teardown; opt-in until a committed validation run exists.",
	},
	// `tama new` takes --cpu and --memory. Disk is NOT settable and is not reported per machine: the
	// observed root filesystem is a large shared overlay (878 GB), so the 40 GB target is cleared by
	// capacity rather than by a pinned request.
	specPinning: "settable",
	transport: {
		// The adapter spawns the CLI and forwards its stdout/stderr pipes as chunks, so a long exec
		// stays observable instead of buffering. A 10-minute synchronous exec was validated end to end
		// (see the adapter), but keep the repository's conservative 60s policy for sustained
		// synchronous transport: longer work daemonizes and polls the harness-owned done file.
		streaming: true,
		syncCapMs: 60_000,
		detachedPoll: true,
	},
});
