// run.cloud's public usage API is organization-wide cumulative wall-clock, so no sandbox-scoped
// billed figure exists to capture. The hook records that honestly instead of calling the account
// endpoint and delta-attributing a number to one sandbox.
import type { ProviderCostEvidenceCapability } from "@sandbox-benchmarks/driver";
import { RUNCLOUD_PROVENANCE } from "./provenance.ts";

export const runcloudCostEvidence: ProviderCostEvidenceCapability<"runcloud"> = {
	sdk: RUNCLOUD_PROVENANCE,
	captureAfterTeardown: async (input) => {
		const subject = { kind: "sandbox" as const, sandboxId: input.sandboxId };
		if (!input.teardown.completed) {
			return {
				kind: "missing",
				cell: input.cell,
				subject,
				capturedAt: new Date().toISOString(),
				sdk: RUNCLOUD_PROVENANCE,
				reason: "sandbox_teardown_unconfirmed",
				detail: "Sandbox teardown was not confirmed; no provider usage was considered.",
			};
		}
		return {
			kind: "missing",
			cell: input.cell,
			subject,
			capturedAt: new Date().toISOString(),
			sdk: RUNCLOUD_PROVENANCE,
			reason: "not_sandbox_scoped",
			detail:
				"The installed public run.cloud usage API is organization-wide cumulative usage and was not called or delta-attributed to this sandbox.",
		};
	},
};
