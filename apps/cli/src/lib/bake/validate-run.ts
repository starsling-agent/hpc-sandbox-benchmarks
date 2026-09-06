// Boot each provider's CANDIDATE artifact and run the shared smoke spec against it — the validate-only
// pass. `promote` runs this immediately before the immutable base retag so the published version
// derives from bytes verified again, closing the validate→promote drift window (the candidate tag is
// mutable, so it could have changed since `bake` last validated it). Distinct from `bake`'s loop,
// which bakes AND validates each candidate in one pass; this only validates an already-baked candidate.
import type { ProviderId } from "@sandbox-benchmarks/schema";
import type { ArtifactResolution } from "../driver-run.ts";
import type { ProviderRun, ProviderTarget } from "../providers-run.ts";
import { forEachProviderWithCreds } from "../providers-run.ts";
import type { SmokeOutcome } from "../smoke-run.ts";
import { bootAndSmoke, logChecks, smokeFailureReason, smokeOk } from "../smoke-run.ts";
import type { Log } from "./types.ts";
import type { CandidateRefs } from "./validate.ts";
import { candidateCreateOptions, candidateResolvedArtifact } from "./validate.ts";

function candidateArtifactResolution(id: ProviderId, refs: CandidateRefs): ArtifactResolution {
	const resolved = candidateResolvedArtifact(id, refs);
	if (resolved.kind === "none") return {};
	return { ref: resolved.ref };
}

/** Boot the candidate artifact through the same lane default `bench-suite` would pick. */
export function bootAndSmokeCandidate(
	target: ProviderTarget,
	refs: CandidateRefs,
): Promise<SmokeOutcome> {
	switch (target.kind) {
		case "driver":
			return bootAndSmoke(target, { artifact: candidateArtifactResolution(target.id, refs) });
		case "legacy":
			return bootAndSmoke({
				kind: "legacy",
				id: target.id,
				config: {
					...target.config,
					artifact: candidateResolvedArtifact(target.id, refs),
					createOptions: {
						...target.config.createOptions,
						...candidateCreateOptions(target.id, refs),
					},
				},
			});
		default: {
			const _never: never = target;
			return _never;
		}
	}
}

/** Validate every provider's candidate artifact (boot + smoke), sharing the skip-vs-fail contract. A
 *  provider with no creds skips; one that boots and fails its smoke is `failed`. Never throws.
 *  `only` restricts the pass to a subset (a scoped promote re-validates only the providers it is
 *  about to publish); omitted → every registered provider. */
export function validateCandidates(
	refs: CandidateRefs,
	log: Log,
	only?: readonly ProviderId[],
): Promise<ProviderRun<SmokeOutcome>[]> {
	return forEachProviderWithCreds(
		(target) => {
			log(`>>> ${target.id}: validating candidate (boot + smoke)…`);
			return bootAndSmokeCandidate(target, refs);
		},
		{
			log,
			only,
			ok: smokeOk,
			failureReason: smokeFailureReason,
			onComplete: (run) => {
				if (run.value) logChecks(run.provider, run.value.checks, log);
				const time = run.durationMs !== undefined ? `${run.durationMs.toFixed(0)}ms` : "";
				const counts = run.value
					? `${run.value.checks.filter((c) => c.ok).length}/${run.value.checks.length} checks`
					: "";
				const meta = [time, counts].filter(Boolean).join(", ");
				log(
					`<<< ${run.provider}: ${run.status}${meta ? ` (${meta})` : ""}${run.reason ? ` — ${run.reason}` : ""}`,
				);
			},
		},
	);
}
