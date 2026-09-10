import { defineProviderMeta } from "../provider-meta.ts";
import { daytonaPricing, daytonaTransport } from "./_daytona.ts";

export default defineProviderMeta("daytona-vm", {
	displayName: "Daytona (VM)",
	vendor: "Daytona",
	quotaDomain: "daytona",
	website: "https://daytona.io",
	sdkPackage: "@daytona/sdk",
	artifact: { kind: "baked" },
	inputs: [
		"DAYTONA_API_KEY",
		{ name: "DAYTONA_TARGET", source: { kind: "variable" }, default: "us-west-2" },
		{ name: "DAYTONA_SNAPSHOT", source: { kind: "variable" }, required: false },
	],
	isolation: {
		class: "microVM",
		technology: "microVM (Linux VM)",
		notes:
			"Boots a snapshot baked with SandboxClass.LINUX_VM on Daytona's Linux-VM runners (region us-west-2, via DAYTONA_TARGET). Snapshot-based images; orgs locked to a dedicated region need their own snapshot (DAYTONA_SNAPSHOT). The prior single `daytona` entry mislabeled this as a container — the baked class has always been a microVM.",
	},
	pricing: daytonaPricing,
	maturity: {
		status: "ga",
		notes: "The validated reference provider for this harness (pre-baked toolchain snapshot).",
	},
	specPinning: "settable",
	transport: daytonaTransport,
});
