// Pure mapping from a provider id to the create-options that boot its *candidate* artifact, so the
// bake can validate exactly what it just built (not the public version). Kept pure + injectable so
// it's unit-testable without the env-backed config.
import type { ProviderId } from "@sandbox-benchmarks/schema";
import type { DriverResolvedArtifact } from "@sandbox-benchmarks/schema/driver-schemas";

export { baseImageUse } from "@sandbox-benchmarks/schema/provider-artifacts";

export interface CandidateRefs {
	e2bTemplateCandidate: string;
	/** Candidate LINUX_VM snapshot for daytona-vm. */
	daytonaSnapshotCandidate: string;
	/** Candidate CONTAINER snapshot for daytona-container (its own snapshot + region). */
	daytonaContainerSnapshotCandidate: string;
	/** Candidate template on Novita's E2B-compatible control plane (its own namespace). */
	novitaTemplateCandidate: string;
	/** Candidate Blueprint on Runloop's control plane. */
	runloopBlueprintCandidate: string;
	toolchainImageCandidate: string;
	/** Candidate image mirrored into the linked project's Vercel Container Registry. */
	vercelImageCandidate: string;
	/** daytona-vm runner target (us-west-2; undefined → account default). */
	daytonaVmTarget?: string;
	/** daytona-container runner target (us-west-2; undefined → account default). */
	daytonaContainerTarget?: string;
}

interface CandidateLaunch {
	artifact: DriverResolvedArtifact;
	createOptions: Record<string, unknown>;
}

/** One authoritative candidate projection: the boot override and the identity it selects. */
function candidateLaunch(id: ProviderId, refs: CandidateRefs): CandidateLaunch {
	switch (id) {
		case "e2b":
			// computesdk maps snapshotId → the e2b template id/name.
			return {
				artifact: { kind: "baked", ref: refs.e2bTemplateCandidate },
				createOptions: { snapshotId: refs.e2bTemplateCandidate },
			};
		case "daytona-vm":
			return {
				artifact: { kind: "baked", ref: refs.daytonaSnapshotCandidate },
				createOptions: {
					snapshotId: refs.daytonaSnapshotCandidate,
					...(refs.daytonaVmTarget ? { target: refs.daytonaVmTarget } : {}),
				},
			};
		case "daytona-container":
			return {
				artifact: { kind: "baked", ref: refs.daytonaContainerSnapshotCandidate },
				createOptions: {
					snapshotId: refs.daytonaContainerSnapshotCandidate,
					...(refs.daytonaContainerTarget ? { target: refs.daytonaContainerTarget } : {}),
				},
			};
		case "modal-gvisor":
		case "modal-vm":
		// Same candidate image as modal-gvisor; the VM runtime is selected by the adapter's base
		// createOptions (experimentalOptions:{vm_runtime:true}), which validate-run.ts preserves
		// through the spread — so this candidate override, like modal-gvisor's, is only the templateId.
		case "microsandbox-cloud":
			// Microsandbox Cloud consumes the shared OCI image.
			return {
				artifact: { kind: "image", ref: refs.toolchainImageCandidate },
				createOptions: { templateId: refs.toolchainImageCandidate },
			};
		case "blaxel":
			// Stock base image — no candidate artifact to point at.
			return { artifact: { kind: "none" }, createOptions: {} };
		case "novita":
			// Same mapping as e2b (snapshotId → template name), against Novita's control plane.
			return {
				artifact: { kind: "baked", ref: refs.novitaTemplateCandidate },
				createOptions: { snapshotId: refs.novitaTemplateCandidate },
			};
		case "runloop":
			return {
				artifact: { kind: "baked", ref: refs.runloopBlueprintCandidate },
				createOptions: { blueprint_name: refs.runloopBlueprintCandidate },
			};
		case "namespace":
		// No template/snapshot system — points create() at the candidate image directly, same as modal.
		case "runcloud":
		// The native SDK boots an arbitrary OCI image directly; there is no template to bake.
		case "tama":
			// `tama new --image` pulls an arbitrary OCI ref at create time, so the candidate boots the same
			// way the published version does; there is no provider-side artifact.
			return {
				artifact: { kind: "image", ref: refs.toolchainImageCandidate },
				createOptions: { image: refs.toolchainImageCandidate },
			};
		case "vercel":
			return {
				artifact: { kind: "mirror", ref: refs.vercelImageCandidate },
				createOptions: { templateId: refs.vercelImageCandidate },
			};
	}
}

/** Create-options overrides that point a provider at its candidate artifact for the validate boot. */
export function candidateCreateOptions(
	id: ProviderId,
	refs: CandidateRefs,
): Record<string, unknown> {
	return candidateLaunch(id, refs).createOptions;
}

/** The exact artifact selected by {@link candidateCreateOptions}, from the same projection. */
export function candidateResolvedArtifact(
	id: ProviderId,
	refs: CandidateRefs,
): DriverResolvedArtifact {
	return candidateLaunch(id, refs).artifact;
}
