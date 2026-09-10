import { defineProviderMeta } from "../provider-meta.ts";
import { daytonaPricing, daytonaTransport } from "./_daytona.ts";

export default defineProviderMeta("daytona-container", {
	displayName: "Daytona (container)",
	vendor: "Daytona",
	quotaDomain: "daytona",
	website: "https://daytona.io",
	sdkPackage: "@daytona/sdk",
	artifact: { kind: "baked", nameSuffix: "-container" },
	inputs: [
		"DAYTONA_API_KEY",
		{
			name: "DAYTONA_CONTAINER_TARGET",
			source: { kind: "variable" },
			default: "us-west-2",
		},
		{ name: "DAYTONA_CONTAINER_SNAPSHOT", source: { kind: "variable" }, required: false },
	],
	isolation: {
		class: "container",
		technology: "container (Sysbox/OCI)",
		notes:
			"Boots its own snapshot baked with SandboxClass.CONTAINER on Daytona's container runners in region us-west-2 (Daytona's default class uses Sysbox-based OCI containers, not gVisor). Separate snapshot from daytona-vm because the sandbox class is fixed at snapshot-bake time, not per-create.",
	},
	pricing: daytonaPricing,
	maturity: {
		status: "beta",
		notes:
			"New isolation variant sharing Daytona credentials/pricing with daytona-vm; boots a container-class snapshot in region us-west-2. Not yet a committed run.",
	},
	specPinning: "settable",
	transport: daytonaTransport,
});
