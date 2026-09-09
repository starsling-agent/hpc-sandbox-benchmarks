import { defineProviderMeta } from "../provider-meta.ts";

export default defineProviderMeta("microsandbox-cloud", {
	displayName: "Microsandbox Cloud",
	vendor: "Microsandbox",
	website: "https://microsandbox.dev",
	sdkPackage: "microsandbox",
	artifact: { kind: "image" },
	// MSB_API_URL is only an override for staging/private deployments. The SDK defaults to
	// api.microsandbox.dev, so the key alone is the cloud-selection and credential gate.
	inputs: ["MSB_API_KEY", { name: "MSB_API_URL", source: { kind: "variable" }, required: false }],
	isolation: {
		class: "microVM",
		technology: "libkrun microVM (cloud)",
		notes:
			"The Microsandbox SDK talks to msb-cloud; Nomad schedules the same libkrun microVM runtime on remote hosts.",
	},
	pricing: {
		model: "published",
		components: [
			{
				id: "cpu-overage",
				resource: "cpu",
				billingBasis: "provisioned",
				vendorUnit: "vCPU",
				usdPerUnitHour: 0.05,
				quantityRule: { kind: "linear", dimension: "vcpus", unitsPerTargetUnit: 1 },
				tier: "Builder overage",
			},
			{
				id: "memory-overage",
				resource: "memory",
				billingBasis: "provisioned",
				vendorUnit: "GiB",
				usdPerUnitHour: 0.0162,
				quantityRule: { kind: "linear", dimension: "memoryGb", unitsPerTargetUnit: 1 },
				tier: "Builder overage",
			},
			{
				id: "disk-overage",
				resource: "disk",
				billingBasis: "provisioned",
				vendorUnit: "GiB",
				usdPerUnitHour: 0.0001,
				quantityRule: { kind: "linear", dimension: "diskGb", unitsPerTargetUnit: 1 },
				tier: "Builder overage",
			},
		],
		adjustments: [
			{
				kind: "fee",
				plan: "Builder",
				resource: "plan",
				quantity: 49,
				unit: "USD",
				scope: "monthly",
			},
			{
				kind: "allowance",
				plan: "Builder",
				resource: "cpu",
				quantity: 500,
				unit: "vCPU-hour",
				scope: "monthly",
			},
			{
				kind: "allowance",
				plan: "Builder",
				resource: "memory",
				quantity: 2000,
				unit: "GiB-hour",
				scope: "monthly",
			},
			{
				kind: "allowance",
				plan: "Builder",
				resource: "disk",
				quantity: 2000,
				unit: "GiB-hour",
				scope: "monthly",
			},
		],
		targetHourlyCost: {
			kind: "plan_dependent",
			reason: "The charge depends on plan fees, remaining monthly pools, and overage consumption.",
		},
		notes:
			"Published Builder plan pools and overage rates are retained without converting them into one account-independent hourly total.",
		sources: [
			{
				label: "Microsandbox pricing",
				url: "https://microsandbox.dev/pricing",
				checkedAt: "2026-08-08",
			},
		],
	},
	maturity: {
		status: "beta",
		notes:
			"Create, readiness, exec, filesystem, list, and graceful teardown are supported. Cloud snapshots and published ports are not yet available.",
	},
	specPinning: "settable",
	transport: {
		// The adapter does not expose streaming callbacks. Use detached+filesystem polling for any
		// benchmark-length step so a long-lived remote WebSocket is not the durability boundary.
		streaming: false,
		syncCapMs: 60_000,
		detachedPoll: true,
	},
});
