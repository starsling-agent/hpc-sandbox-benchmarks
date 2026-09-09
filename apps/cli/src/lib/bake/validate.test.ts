import { describe, expect, it } from "bun:test";
import { PROVIDERS } from "@sandbox-benchmarks/schema";
import type { CandidateRefs } from "./validate.ts";
import { baseImageUse, candidateCreateOptions, candidateResolvedArtifact } from "./validate.ts";

const refs: CandidateRefs = {
	e2bTemplateCandidate: "tc-v1-candidate",
	daytonaSnapshotCandidate: "snap-v1-candidate",
	daytonaContainerSnapshotCandidate: "snap-v1-container-candidate",
	// Distinct from the e2b value so the novita case fails if it ever reads the e2b field.
	novitaTemplateCandidate: "tc-v1-novita-candidate",
	runloopBlueprintCandidate: "tc-v1-runloop-candidate",
	toolchainImageCandidate: "ghcr.io/o/tc:v1-candidate",
	vercelImageCandidate: "sandbox-benchmarks-toolchain-vercel:v1-candidate",
	daytonaVmTarget: "us-west-2",
	daytonaContainerTarget: "us-west-2",
};

describe("candidateCreateOptions", () => {
	it("keeps every candidate's recorded artifact adjacent to its actual boot override", () => {
		for (const provider of PROVIDERS) {
			const artifact = candidateResolvedArtifact(provider.id, refs);
			expect(artifact.kind).toBe(provider.artifact.kind);
			if (artifact.kind !== "none") {
				expect(JSON.stringify(candidateCreateOptions(provider.id, refs))).toContain(artifact.ref);
			}
		}
	});

	it("points e2b at the candidate template via snapshotId", () => {
		expect(candidateCreateOptions("e2b", refs)).toEqual({ snapshotId: "tc-v1-candidate" });
	});

	it("points daytona-vm at its candidate snapshot + region target", () => {
		expect(candidateCreateOptions("daytona-vm", refs)).toEqual({
			snapshotId: "snap-v1-candidate",
			target: "us-west-2",
		});
	});

	it("points daytona-container at its own candidate snapshot + region target", () => {
		expect(candidateCreateOptions("daytona-container", refs)).toEqual({
			snapshotId: "snap-v1-container-candidate",
			target: "us-west-2",
		});
	});

	it("omits the daytona-vm target when the region has none (account default)", () => {
		expect(candidateCreateOptions("daytona-vm", { ...refs, daytonaVmTarget: undefined })).toEqual({
			snapshotId: "snap-v1-candidate",
		});
	});

	it("points novita at its candidate template via snapshotId (e2b mapping, Novita's control plane)", () => {
		expect(candidateCreateOptions("novita", refs)).toEqual({
			snapshotId: "tc-v1-novita-candidate",
		});
	});

	it("points Runloop at its candidate Blueprint by name", () => {
		expect(candidateCreateOptions("runloop", refs)).toEqual({
			blueprint_name: "tc-v1-runloop-candidate",
		});
	});

	it("points modal-gvisor at the candidate image via templateId", () => {
		expect(candidateCreateOptions("modal-gvisor", refs)).toEqual({
			templateId: "ghcr.io/o/tc:v1-candidate",
		});
	});

	it("points modal-vm at the same candidate image (VM runtime stays on the adapter base)", () => {
		// candidateCreateOptions returns only the candidate override; the vm_runtime flag lives in the
		// adapter's base createOptions and is preserved by validate-run.ts's spread, so it isn't repeated
		// here (matching modal-gvisor).
		expect(candidateCreateOptions("modal-vm", refs)).toEqual({
			templateId: "ghcr.io/o/tc:v1-candidate",
		});
	});

	it("points namespace directly at the candidate image", () => {
		expect(candidateCreateOptions("namespace", refs)).toEqual({
			image: "ghcr.io/o/tc:v1-candidate",
		});
	});

	it("points run.cloud directly at the candidate image", () => {
		expect(candidateCreateOptions("runcloud", refs)).toEqual({
			image: "ghcr.io/o/tc:v1-candidate",
		});
	});

	it("points Vercel at the digest-pinned VCR candidate image", () => {
		expect(candidateCreateOptions("vercel", refs)).toEqual({
			templateId: refs.vercelImageCandidate,
		});
	});

	it("points Microsandbox Cloud at the candidate OCI image", () => {
		expect(candidateCreateOptions("microsandbox-cloud", refs)).toEqual({
			templateId: "ghcr.io/o/tc:v1-candidate",
		});
	});
});

// Two release decisions read this classification, and both fail QUIETLY if it is wrong: a bake cell
// resolves the candidate base only when some in-scope provider reads it, and a partial promote demands
// candidate/published identity only when some in-scope provider BAKES its artifact from the base.
describe("baseImageUse", () => {
	// Anything that reads the base ref in candidateCreateOptions must not be classified "none", or the
	// bake cell would skip resolving a digest that provider then boots.
	it("agrees with candidateCreateOptions about who reads the base image ref", () => {
		for (const { id } of PROVIDERS) {
			const readsBase = JSON.stringify(candidateCreateOptions(id, refs)).includes(
				refs.toolchainImageCandidate,
			);
			expect(`${id}:${readsBase}`).toBe(`${id}:${baseImageUse(id) === "boots"}`);
		}
	});
});
