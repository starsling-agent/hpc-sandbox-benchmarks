// Promote the validated candidate to the immutable public version — the ONLY step that writes
// public-facing artifacts. Run after `bake` validates the candidate.
//
// The order makes the immutable base tag the COMMIT POINT, so a mid-promote failure is clean — with one
// documented exception under `--force`, called out at step 3 and in the step-3 abort:
//   1. Refuse if the public version tag already exists — it is immutable; bump to republish (or pass
//      `--force`, wired only to a manual force_republish dispatch, to deliberately regenerate in place).
//   2. Re-validate the candidate (boot + smoke) right now, so the bytes we publish are verified again
//      (the candidate tag is mutable and may have changed since `bake`). Abort on a required failure;
//      a failed best-effort provider is reported and its version artifact is not built.
//   3. Build each provider's version-named artifact FROM the candidate base (the just-revalidated
//      bytes), so the public artifact provably derives from validated bytes — BEFORE touching the base.
//   3b. Required-providers gate: if `--require`/`REQUIRE_PROVIDERS` names providers a skipped one
//      did not promote (a pure skip is not a `failed`), abort BEFORE the base is written — so the
//      gap can't be detected only post-hoc in bake.ts after the immutable base is already tagged.
//   4. LAST: retag the candidate base → the public version (registry-side). Reached only when every
//      prior step succeeded, so a failure never leaves a published version with missing/stale artifacts.
//
// A PARTIAL promote (`--provider <subset>`, the scoped backfill a dispatch asks for when it adds one
// provider to a version the rest of the fleet already runs) reshapes the same four steps: step 1 wants
// the version to ALREADY exist, steps 2–3 work from the published version base rather than the mutable
// candidate, and step 4 does not happen at all. See {@link PromoteOptions.partial}.
//
// A rerun after a mid-promote failure is clean (the version tag was never written); once published it
// is refused at step 1 — bump the version, or force_republish, to publish again. Under `--force` the
// version's artifacts already exist, and step 3 regenerates them in place: the image retag and e2b
// `template create` publish a new artifact over the old name (the prior one stands until the new one
// lands), but daytona has no snapshot overwrite — it deletes, then creates. So a forced republish whose
// daytona create fails leaves that snapshot ABSENT, not stale. Recovery is a rerun with force_republish
// (a plain rerun is refused at step 1, since the base image is still there).
import { requiredProviders, unmetRequirements } from "@sandbox-benchmarks/harness";
import { config } from "@sandbox-benchmarks/providers/config";
import type { ProviderId } from "@sandbox-benchmarks/schema";
import { PROVIDERS } from "@sandbox-benchmarks/schema";
import { isPartialScope } from "../matrix.ts";
import type { ProviderRun } from "../providers-run.ts";
import { forEachProviderWithCreds } from "../providers-run.ts";
import { IMAGE_REPORT, isBlockingFailure } from "./gates.ts";
import {
	imageDigest,
	imageExistsInRegistry,
	promoteImage,
	releaseBaseTag,
	resolveImageDigestRef,
} from "./image.ts";
import {
	buildBakedProviderArtifact,
	isBakedProviderId,
	isMirroredProviderId,
	nonBakedArtifactAction,
	promoteMirroredProviderArtifact,
} from "./provider-artifacts.ts";
import type { BakeReport, Log } from "./types.ts";
import type { CandidateRefs } from "./validate.ts";
import { baseImageUse } from "./validate.ts";
import { validateCandidates } from "./validate-run.ts";

export interface PromoteOptions {
	/** `--force`: deliberately regenerate an already-published version in place (see step 1). Manual
	 *  force_republish dispatch only, and never valid together with a partial scope. */
	force?: boolean;
	/**
	 * Restrict the transaction to these providers (`--provider`). Omitted → every registered provider.
	 *
	 * A STRICT SUBSET (see {@link isPartialScope}) makes this a PARTIAL promote: it BACKFILLS those
	 * providers' version artifacts onto a version the rest of the fleet already runs. Two inversions
	 * follow from that, both handled below:
	 *
	 *   • Step 1 flips from "refuse if the version exists" to "refuse UNLESS it exists": nothing here
	 *     overwrites the immutable base, and a backfill with no published base to attach to would
	 *     publish a provider artifact for a version that doesn't exist.
	 *   • The base every version artifact is built from is the PUBLISHED version, not the mutable
	 *     candidate — the new provider must get the same bytes the others are already running, and the
	 *     candidate tag may have moved on since the version was cut.
	 *
	 * Step 4 (the base retag) is then skipped entirely: the base is already published and correct, and
	 * rewriting it is exactly the blast radius a scoped release exists to avoid. Partial is DERIVED
	 * here rather than passed alongside `only`, so the two can never describe different releases.
	 */
	only?: readonly ProviderId[];
}

/** Promotion diagnostics plus the transaction outcome. Optional-provider failures remain visible in
 * `reports`, while `ok` records whether the requested publish transaction itself committed. */
export interface PromoteResult {
	reports: BakeReport[];
	ok: boolean;
}

/** Finalize a full promotion after the immutable image retag attempt. Provider diagnostics do not
 * decide the transaction status; the image commit point does. */
export function fullPromotionResult(reports: BakeReport[]): PromoteResult {
	return {
		reports,
		ok:
			reports.some((report) => report.provider === IMAGE_REPORT && report.status === "ok") &&
			!reports.some((report) => report.provider === IMAGE_REPORT && report.status === "failed"),
	};
}

/**
 * Select the providers whose version artifacts may be built after candidate re-validation. A
 * best-effort provider is allowed to fail without blocking the shared image publish, but that must
 * never turn into permission to publish an unvalidated provider artifact. Failed/skipped validations
 * are carried into the promote report so the missing artifact remains visible to CI and operators.
 */
export function promotionScopeAfterValidation(
	requested: readonly ProviderId[],
	runs: readonly Pick<ProviderRun<unknown>, "provider" | "status" | "reason" | "durationMs">[],
): { eligible: ProviderId[]; rejected: BakeReport[] } {
	const byProvider = new Map(runs.map((run) => [run.provider, run]));
	const eligible: ProviderId[] = [];
	const rejected: BakeReport[] = [];
	for (const provider of requested) {
		const run = byProvider.get(provider);
		if (run?.status === "ok") {
			eligible.push(provider);
			continue;
		}
		rejected.push({
			provider,
			status: run?.status ?? "failed",
			reason: run?.reason ?? "candidate re-validation produced no result",
			...(run?.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		});
	}
	return { eligible, rejected };
}

/** A scoped promote is an explicit request to publish every named provider, so that scope is required
 * even for a direct local invocation that did not also pass `--require`. Preserve any configured
 * requirements as well so a typo or contradictory invocation still fails closed. */
export function effectivePromotionRequirements(
	configured: readonly string[],
	only: readonly ProviderId[] | undefined,
): string[] {
	return [...new Set([...configured, ...(isPartialScope(only) ? (only ?? []) : [])])];
}

export async function promoteAll(log: Log, options: PromoteOptions = {}): Promise<PromoteResult> {
	const { force = false, only } = options;
	const partial = isPartialScope(only);
	const reports: BakeReport[] = [];
	const scope = only ? only.join(", ") : "every provider";
	/** Record a refusal/abort as a structured `image` failure and stop — the shape every early exit
	 *  below returns, so the refusal contract is written once. */
	const refuse = (reason: string, verb = "refused"): PromoteResult => {
		log(`<<< promote ${verb} — ${reason}`);
		reports.push({ provider: IMAGE_REPORT, status: "failed", reason });
		return { reports, ok: false };
	};
	// Only a REQUIRED provider gates the release (Option 1): a best-effort variant that shares a required
	// variant's credentials — daytona-container ↔ daytona-vm, modal-vm ↔ modal-gvisor — runs rather than
	// skips, so its re-validation or artifact failure is recorded but must NOT abort a full publish.
	// A scoped backfill is inherently strict: every provider explicitly named is required even if a
	// direct local caller omitted the redundant `--require` flag.
	const required = effectivePromotionRequirements(requiredProviders(), only);
	const blocks = (report: { provider: string; status: string }): boolean =>
		isBlockingFailure(report, required);

	// 1. Refuse to overwrite the immutable public version (D2b). Checked first, before any mutation, so
	//    a refused promote leaves everything untouched. A registry error here (auth/network) is NOT
	//    "not published" — refuse rather than risk overwriting an existing :v1 we couldn't see.
	//    `force` (manual dispatch only — see toolchain-image.yml) deliberately republishes over an
	//    existing version for dev iteration; automated push-to-main never sets it, so the invariant
	//    holds in production. The image retag and e2b `template create` overwrite by name, replacing
	//    the artifact only once the new one is built. Daytona does NOT: it deletes the existing
	//    snapshot before creating, so a forced republish drops the published snapshot for the length
	//    of the rebuild, and leaves it absent if the rebuild fails. Forced republish is therefore a
	//    destructive regenerate, and is why `force` is manual-dispatch-only.
	//    A PARTIAL promote inverts the same probe: it attaches to an existing version instead of
	//    creating one, so the base MUST already be there. Both polarities share the refuse-on-uncertain
	//    posture — an unreadable registry is not evidence either way, so we decline rather than act blind.
	if (force) {
		log(
			`>>> force-republish: regenerating ${config.toolchainImageVersion}, overwriting if present ` +
				`(daytona: both ${config.daytonaSnapshotDefault} and ${config.daytonaContainerSnapshotDefault} ` +
				`are deleted and rebuilt, so each is briefly absent — and left absent if its rebuild fails)`,
		);
	} else {
		let alreadyPublished: boolean;
		try {
			alreadyPublished = await imageExistsInRegistry(config.toolchainImageVersion);
		} catch (err) {
			return refuse(
				`could not verify whether ${config.toolchainImageVersion} is published, so refusing to ` +
					`${partial ? "backfill onto it" : "publish"}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		// A full release needs the version ABSENT (it is about to create it); a backfill needs it PRESENT
		// (it is attaching to it). One probe, opposite expectations — named so the comparison below
		// reads as intent rather than as a bare inequality between two unrelated-looking booleans.
		const expectsPublishedBase = partial;
		if (alreadyPublished !== expectsPublishedBase) {
			return refuse(
				partial
					? `${config.toolchainImageVersion} is not published, so there is nothing to backfill ${scope} onto — a scoped promote adds providers to an existing version and never writes the base; run a full release first`
					: `${config.toolchainImageVersion} already exists — the public version is immutable; bump the version or dispatch with force_republish to publish again`,
			);
		}
		if (partial) {
			log(
				`>>> partial promote: backfilling ${scope} onto the published ${config.toolchainImageVersion}; ` +
					"the public base is NOT rewritten and no other provider's artifact is touched",
			);
		}
	}

	// 2. Re-validate the candidate immediately before publishing, so the bytes we promote are verified
	//    again (the candidate tag is mutable). Required failures abort the whole promote; a failed
	//    best-effort provider is excluded from step 3 and remains visible in the final report.
	//    A PARTIAL promote pins the PUBLISHED version instead: it is not cutting a new version, it is
	//    attaching a provider to the one already live, so the base under test must be that one.
	const baseTag = releaseBaseTag(partial);
	let pinnedBaseImage: string;
	try {
		pinnedBaseImage = await resolveImageDigestRef(baseTag);
	} catch (err) {
		return refuse(
			`could not resolve immutable digest for ${baseTag}: ${err instanceof Error ? err.message : String(err)} (nothing published)`,
			"aborted",
		);
	}

	// 2b. A backfill verifies each provider's CANDIDATE artifact (step 2) but builds its version artifact
	//     from the PUBLISHED base (step 3). For a provider that BAKES its artifact from the base —
	//     e2b/novita templates, daytona snapshots — those are the same bytes only while the candidate
	//     base still IS the published version; if a later `build: full` moved the candidate on, the run
	//     would verify one image and publish an artifact built from another. Require that identity when
	//     such a provider is in scope. The rest don't bake from the base at all (vercel's version artifact
	//     is a retag of the exact candidate step 2 just booted; modal/namespace/microsandbox boot the
	//     published base directly), so a drifted candidate tag is simply
	//     irrelevant to them.
	const bakesFromBase = (only ?? PROVIDERS.map((p) => p.id)).filter(
		(id) => baseImageUse(id) === "bakes",
	);
	if (partial && bakesFromBase.length > 0) {
		let pinnedCandidate: string;
		try {
			pinnedCandidate = await resolveImageDigestRef(config.toolchainImageCandidate);
		} catch (err) {
			return refuse(
				`could not resolve immutable digest for ${config.toolchainImageCandidate}, which ${bakesFromBase.join(", ")} bake their version artifact from: ${err instanceof Error ? err.message : String(err)}`,
				"aborted",
			);
		}
		if (imageDigest(pinnedCandidate) !== imageDigest(pinnedBaseImage)) {
			return refuse(
				`the candidate base has drifted from the published version (${pinnedCandidate} vs ${pinnedBaseImage}), so a backfill of ${bakesFromBase.join(", ")} would verify one image and publish an artifact built from another. Bump TOOLCHAIN_VERSION and cut a full release`,
				"aborted",
			);
		}
	}
	const candidateRefs: CandidateRefs = {
		e2bTemplateCandidate: config.e2bTemplateCandidate,
		daytonaSnapshotCandidate: config.daytonaSnapshotCandidate,
		daytonaContainerSnapshotCandidate: config.daytonaContainerSnapshotCandidate,
		novitaTemplateCandidate: config.novitaTemplateCandidate,
		runloopBlueprintCandidate: config.runloopBlueprintCandidate,
		toolchainImageCandidate: pinnedBaseImage,
		vercelImageCandidate: config.vercelImageCandidate,
		daytonaVmTarget: config.daytonaVm.target,
		daytonaContainerTarget: config.daytonaContainer.target,
	};
	log(`>>> re-validating ${scope} against ${pinnedBaseImage} before promote…`);
	const validateRuns = await validateCandidates(candidateRefs, log, only);
	if (validateRuns.some(blocks)) {
		log(
			"<<< promote aborted — a required provider's candidate re-validation failed (nothing published)",
		);
		for (const run of validateRuns) {
			reports.push({
				provider: run.provider,
				status: run.status,
				...(run.reason ? { reason: run.reason } : {}),
				...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
			});
		}
		return { reports, ok: false };
	}
	const requested = only ?? PROVIDERS.map((provider) => provider.id);
	const promotionScope = promotionScopeAfterValidation(requested, validateRuns);
	reports.push(...promotionScope.rejected);

	// 3. Build each in-scope provider's version-named artifact FROM the base we just revalidated (the
	//    candidate base, or the published version base on a partial promote). Built BEFORE the base
	//    retag, so a failure here leaves the version base unwritten and a rerun is clean. Shares the
	//    skip-vs-fail loop with bake.
	//    Under `--force` these names already exist and are live. e2b/image replace on success; daytona
	//    deletes first (no snapshot overwrite in the SDK), so a failed daytona create removes the
	//    published snapshot — `bakeDaytonaSnapshot` says so in its error, which lands in the report's
	//    `reason`. The base is still never written, so the version tag itself stays consistent.
	const runs =
		promotionScope.eligible.length === 0
			? []
			: await forEachProviderWithCreds(
					async (provider) => {
						if (isBakedProviderId(provider.name)) {
							log(`>>> ${provider.name}: building version artifact from ${pinnedBaseImage}…`);
							await buildBakedProviderArtifact(provider.name, "version", pinnedBaseImage, (m) =>
								log(`    ${m}`),
							);
						} else if (isMirroredProviderId(provider.name)) {
							log(`>>> ${provider.name}: ${nonBakedArtifactAction(provider.name, "version")}…`);
							await promoteMirroredProviderArtifact(provider.name, (m) => log(`    ${m}`));
						} else {
							log(`>>> ${provider.name}: ${nonBakedArtifactAction(provider.name, "version")}`);
						}
					},
					{
						log,
						only: promotionScope.eligible,
						onComplete: (run) => {
							const time = run.durationMs !== undefined ? ` (${run.durationMs.toFixed(0)}ms)` : "";
							log(
								`<<< ${run.provider}: ${run.status}${time}${run.reason ? ` — ${run.reason}` : ""}`,
							);
						},
					},
				);

	for (const run of runs) {
		reports.push({
			provider: run.provider,
			status: run.status,
			...(run.reason ? { reason: run.reason } : {}),
			...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		});
	}

	// After a forced republish aborts, the previous version's base image is still tagged, so step 1 would
	// refuse a plain rerun — recovery has to re-force. A partial promote is already re-runnable as-is
	// (it never wrote the base, and its step 1 wants the version to exist). Shared by both aborts below.
	// `scope` (not `only`) so the hint can't render "undefined": partial is derived FROM `only`, but only
	// the value is proof of that, not the type. `--provider` trims around commas, so it pastes as-is.
	const rerunHint = partial
		? `Fix the cause and rerun the scoped release (\`--provider "${scope}"\`); nothing needs unwinding.`
		: force
			? "Fix the cause and rerun with force_republish — a plain rerun is refused because the base image already exists."
			: "Fix the cause and rerun `bake --promote`.";
	// Both aborts below stop before step 4. On a partial promote there is no step 4 to stop before, so
	// say what is actually true rather than implying the base was about to move.
	const baseUntouched = partial
		? `the public base ${config.toolchainImageVersion} is untouched (a scoped promote never writes it).`
		: "the public base was NOT written.";

	// A REQUIRED provider's artifact failed → do NOT publish the base. The version tag stays unwritten,
	// so a rerun (after fixing the cause) reconciles cleanly. Nothing public was half-written — EXCEPT
	// under `--force`, where step 3 regenerates already-published artifacts in place and daytona's
	// delete-then-create can leave its published snapshot absent (the report's `reason` says so).
	if (reports.some(blocks)) {
		log(
			`!!! promote aborted before publish: a required ${config.toolchainImageVersion} provider artifact failed; ` +
				`${baseUntouched} ` +
				(force
					? "This was a forced republish, so the failed provider's already-published artifact may have " +
						"been regenerated — or, for daytona, deleted and not recreated (see its reason above). "
					: "") +
				rerunHint,
		);
		return { reports, ok: false };
	}

	// Required-providers gate (D1), enforced HERE — before step 4 writes the immutable base — not
	// post-hoc in bake.ts. At the publish boundary CI passes `--require e2b,daytona-vm,modal-gvisor`; a required
	// provider whose version artifact was skipped (missing/misnamed secret) or failed is `skipped`/
	// `failed`, so the artifact-failed check above does NOT catch a pure skip. Were the base published
	// first and the gap detected only in bake.ts, the immutable `:v1` would already be tagged and a
	// fixed rerun would be refused at step 1 — forcing a version bump to recover. Gating before publish
	// keeps the base unwritten so a rerun reconciles cleanly. (Lenient locally: nothing required.)
	const unmet = unmetRequirements(reports, required);
	if (required.length > 0 && unmet.length > 0) {
		const reason = `required providers did not promote: ${unmet.join(", ")} (--require / REQUIRE_PROVIDERS)`;
		// A required provider that merely *skipped* never built anything, so unlike the artifact-failed
		// abort above there is no half-regenerated artifact to warn about — only the rerun differs.
		log(`!!! promote aborted before publish: ${reason}; ${baseUntouched} ${rerunHint}`);
		// Push a structured failure (like the step-1 and step-4 aborts) so the emitted JSON is
		// self-describing — a consumer sees the failed promote without re-deriving it from `--require`.
		reports.push({ provider: IMAGE_REPORT, status: "failed", reason });
		return { reports, ok: false };
	}

	// 4. LAST: publish the candidate base as the immutable public version — the commit point. A partial
	//    promote has none: the version it backfilled onto is already published, and its providers'
	//    artifacts (step 3) were the whole transaction. Returning here is what keeps a scoped release
	//    from touching the fleet everyone else is already running on.
	if (partial) {
		log(
			`>>> partial promote complete: ${scope} now published for ${config.toolchainImageVersion}; ` +
				"the public base and every other provider's artifact are unchanged",
		);
		return { reports, ok: true };
	}
	log(`>>> promoting image ${pinnedBaseImage} → ${config.toolchainImageVersion}…`);
	const imageStart = performance.now();
	try {
		await promoteImage(log, pinnedBaseImage);
		reports.push({
			provider: IMAGE_REPORT,
			status: "ok",
			durationMs: performance.now() - imageStart,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		log(`<<< image: promote failed — ${reason}`);
		reports.push({
			provider: IMAGE_REPORT,
			status: "failed",
			reason,
			durationMs: performance.now() - imageStart,
		});
	}

	return fullPromotionResult(reports);
}
