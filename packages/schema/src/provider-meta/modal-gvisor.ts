import { defineProviderMeta } from "../provider-meta.ts";
import { modalPricing, modalTransport } from "./_modal.ts";

export default defineProviderMeta("modal-gvisor", {
	displayName: "Modal (gVisor)",
	vendor: "Modal",
	website: "https://modal.com",
	sdkPackage: "modal",
	artifact: { kind: "image" },
	inputs: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
	isolation: {
		class: "userspace",
		technology: "gVisor container",
		notes:
			"Modal's default sandbox runtime. scalableSandboxes enabled in the harness; nproc tracks the requested cpu 1:1.",
	},
	pricing: modalPricing,
	maturity: { status: "ga", notes: "scalableSandboxes enabled in the harness." },
	specPinning: "settable",
	transport: modalTransport,
});
