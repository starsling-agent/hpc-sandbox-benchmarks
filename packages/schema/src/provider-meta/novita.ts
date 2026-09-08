import { defineProviderMeta } from "../provider-meta.ts";

export default defineProviderMeta("novita", {
	displayName: "Novita",
	vendor: "Novita",
	website: "https://novita.ai/sandbox",
	// Native SDK with the regional control plane and its dedicated API-key channel.
	sdkPackage: "novita-sandbox",
	artifact: { kind: "baked" },
	inputs: [
		"NOVITA_API_KEY",
		{ name: "NOVITA_TEMPLATE", source: { kind: "variable" }, required: false },
	],
	isolation: {
		class: "microVM",
		technology: "microVM",
		notes:
			"Dedicated microVM per sandbox; E2B-protocol-compatible control plane (us-phx-1.sandbox.novita.ai) driven through the native novita-sandbox SDK.",
	},
	pricing: {
		model: "published",
		components: [
			{
				id: "cpu",
				resource: "cpu",
				billingBasis: "provisioned",
				vendorUnit: "vCPU",
				usdPerUnitHour: 0.03528,
				quantityRule: { kind: "linear", dimension: "vcpus", unitsPerTargetUnit: 1 },
			},
			{
				id: "memory",
				resource: "memory",
				billingBasis: "provisioned",
				vendorUnit: "GiB",
				usdPerUnitHour: 0.01152,
				quantityRule: { kind: "linear", dimension: "memoryGb", unitsPerTargetUnit: 1 },
			},
			{
				id: "disk",
				resource: "disk",
				billingBasis: "provisioned",
				vendorUnit: "GB",
				usdPerUnitHour: 0.00009,
				quantityRule: { kind: "linear", dimension: "diskGb", unitsPerTargetUnit: 1 },
			},
		],
		adjustments: [
			{
				kind: "allowance",
				plan: "all",
				resource: "disk",
				quantity: 60,
				unit: "GB",
				scope: "monthly",
				notes:
					"Account-wide persistent-storage allowance for paused sandboxes; running sandboxes instead include 20 GB of ephemeral storage.",
			},
		],
		targetHourlyCost: { kind: "exact", componentIds: ["cpu", "memory"] },
		notes:
			"Provisioned CPU and memory pricing; running ephemeral and paused persistent storage remain outside benchmark economics.",
		sources: [
			{
				label: "Novita Sandbox pricing",
				url: "https://novita.ai/docs/guides/sandbox-pricing",
				checkedAt: "2026-08-08",
			},
		],
	},
	maturity: {
		status: "beta",
		notes:
			"E2B-compatible API; boots the pre-baked toolchain template created on Novita's control plane by the bake pipeline (novita-sandbox Template.build). Pay-as-you-go caps sandboxes at 8 vCPU / 8 GB RAM, which is why this stays beta rather than GA.",
	},
	// E2B protocol: resources come from the template (cpu/memory pinned at template create), not
	// the per-sandbox create() call.
	specPinning: "fixed",
	transport: {
		// Same wrapper (and therefore the same caps) as e2b: `sandbox.commands.run(cmd)` with no
		// options applies the E2B SDK's default 60s command timeout, and onStdout/onStderr are never
		// passed through. The compat API exposes the same filesystem + `background`, so detached+poll
		// is the long-step path.
		streaming: false,
		syncCapMs: 60_000,
		detachedPoll: true,
	},
});
