import { defineProviderMeta } from "../provider-meta.ts";
import { modalPricing, modalTransport } from "./_modal.ts";

export default defineProviderMeta("modal-vm", {
	displayName: "Modal (VM)",
	vendor: "Modal",
	website: "https://modal.com",
	sdkPackage: "modal",
	artifact: { kind: "image" },
	inputs: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
	isolation: {
		class: "microVM",
		technology: "microVM (VM runtime)",
		notes:
			"Modal's experimental VM runtime — a gVisor-free KVM microVM, selected per-create via experimentalOptions {vm_runtime:true} (no separate image; same pushed toolchain image as modal-gvisor).",
	},
	pricing: modalPricing,
	maturity: {
		status: "beta",
		notes:
			"Isolation variant sharing Modal credentials/pricing with modal-gvisor; adds experimentalOptions {vm_runtime:true} at create. Now carries committed runs and is in the default matrix set.",
	},
	specPinning: "settable",
	transport: modalTransport,
});
