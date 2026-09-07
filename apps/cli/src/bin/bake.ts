#!/usr/bin/env bun
// `bake` — create each provider's CANDIDATE toolchain artifact and immediately validate it end-to-end
// by booting a sandbox from the just-baked artifact and running the shared smoke spec. This is the
// iteration loop: edit Dockerfile/templates → `bake --build-push` → `bake` → repeat. Everything hits
// the mutable candidate (`:v1-candidate`, `…-v1-candidate`); the public `:v1` is untouched until
// `promote` (next PR). Providers without credentials are skipped. In release CI, only required
// providers block; best-effort failures stay visible as warnings. Locally, with no required set, any
// failure remains fatal. bun auto-loads .env, so local creds are picked up.
//
// The provider loop + skip-vs-fail contract is shared with bench-smoke/promote (providers-run.ts);
// the boot+smoke lifecycle (probe results captured before teardown) is shared too (smoke-run.ts).
import { writeFileSync } from "node:fs";
import {
	exitAfterSandboxCleanup,
	requiredProviders,
	unmetRequirements,
} from "@sandbox-benchmarks/harness";
import type { ProviderConfig } from "@sandbox-benchmarks/providers";
import { config } from "@sandbox-benchmarks/providers";
import type { ProviderId } from "@sandbox-benchmarks/schema";
import { PROVIDERS } from "@sandbox-benchmarks/schema";
import { logWarning } from "../lib/actions-log.ts";
import {
	blockingFailures,
	blockingReports,
	nonBlockingFailures,
	unknownProviderIds,
} from "../lib/bake/gates.ts";
import { buildAndPushCandidate, resolveImageDigestRef } from "../lib/bake/image.ts";
import { effectivePromotionRequirements, promoteAll } from "../lib/bake/promote.ts";
import {
	buildBakedProviderArtifact,
	isBakedProviderId,
	nonBakedArtifactAction,
} from "../lib/bake/provider-artifacts.ts";
import type { BakeReport, Log } from "../lib/bake/types.ts";
import {
	baseImageUse,
	candidateCreateOptions,
	candidateResolvedArtifact,
} from "../lib/bake/validate.ts";
import { isPartialScope, selectProviders } from "../lib/matrix.ts";
import { forEachProviderWithCreds } from "../lib/providers-run.ts";
import { bootAndSmoke, logChecks, smokeFailureReason, smokeOk } from "../lib/smoke-run.ts";

/**
 * Emit the bake/promote report JSON. To `$BAKE_REPORT_FILE` when set — the provider CLIs (e2b) and
 * docker inherit stdout, so a `bun bake.ts … > report.json` redirect would splice their chatter into
 * the report and corrupt the diagnostic. Writing the JSON to a file keeps the captured artifact clean
 * regardless. Falls back to stdout locally (no env var) so the bin stays runnable by hand.
 */
function writeReport(report: unknown): void {
	const json = `${JSON.stringify(report, null, 2)}\n`;
	const file = process.env.BAKE_REPORT_FILE;
	if (file) writeFileSync(file, json);
	else process.stdout.write(json);
}

/** Emit one real Actions warning per failed best-effort provider (stderr locally). */
function warnNonBlocking(
	reports: readonly BakeReport[],
	required: readonly string[],
	verb: string,
): void {
	for (const report of nonBlockingFailures(reports, required)) {
		logWarning(
			`${report.provider} did not ${verb} — recorded, not blocking the release: ${report.reason ?? "failed"}`,
			{ title: `Non-required provider did not ${verb}` },
		);
	}
}

/**
 * The provider ids a `--provider <ids>` (or `--provider=<ids>`) flag restricts the bake+validate loop
 * to — a comma-separated list, so the CI matrix passes one id per cell (`--provider e2b`) and each
 * provider bakes in its own job. Absent → undefined (drive every registered provider, the local
 * default). The argv scan mirrors `--require` (harness `requiredProviders`); the CSV is split and
 * validated against the registry by the shared {@link selectProviders} (which dedups, is
 * case-insensitive, returns registry order, and throws a registry-derived message on an unknown id).
 * It restricts `--promote` too: a scoped promote publishes only those providers' version artifacts,
 * onto an already-published version, and leaves the public base alone (see promote.ts, PromoteOptions).
 *
 * A PRESENT-but-valueless flag (`--provider`, `--provider=`, `--provider --force`) THROWS rather than
 * falling through to the all-providers default. `selectProviders` treats a blank list as "every
 * provider", which is the right default for an *absent* dispatch input but exactly wrong here: a matrix
 * cell whose value failed to interpolate would silently bake every provider instead of its one, and
 * those cells would race on the same artifact names. Asking to restrict and getting everything is a
 * failure, so it is reported as one.
 */
export function requestedProviders(argv: string[]): ProviderId[] | undefined {
	let raw: string | undefined;
	const eq = argv.find((a) => a.startsWith("--provider="));
	if (eq) {
		raw = eq.slice("--provider=".length);
	} else {
		const i = argv.indexOf("--provider");
		// The flag is present, so a missing or flag-like next arg is a typo, not "no restriction" —
		// record it as an empty request and let the blank check below reject it.
		if (i !== -1) {
			const next = argv[i + 1];
			raw = next !== undefined && !next.startsWith("-") ? next : "";
		}
	}
	if (raw === undefined) return undefined;
	if (raw.trim() === "") {
		throw new Error("--provider requires at least one provider id (e.g. --provider e2b)");
	}
	return selectProviders(raw);
}

/**
 * Optional immutable/shared base ref for the bake phase. CI always supplies the release plan's
 * resolved source: the just-built candidate digest for a full release, or the published version for
 * a scoped backfill. Local runs omit it and retain the mutable candidate default.
 */
export function requestedBaseImage(argv: string[]): string | undefined {
	let raw: string | undefined;
	const eq = argv.find((arg) => arg.startsWith("--base-image="));
	if (eq) {
		raw = eq.slice("--base-image=".length);
	} else {
		const i = argv.indexOf("--base-image");
		if (i !== -1) {
			const next = argv[i + 1];
			raw = next !== undefined && !next.startsWith("-") ? next : "";
		}
	}
	if (raw === undefined) return undefined;
	if (raw.trim() === "") {
		throw new Error("--base-image requires a non-empty image reference");
	}
	return raw;
}

if (import.meta.main) {
	const log: Log = (m) => console.error(m);

	// Optional per-provider restriction. On the bake path it is the CI matrix fan-out (one cell per
	// provider); on the promote path it scopes the transaction to a backfill. Parsed before any build
	// or registry call so a typo'd id fails fast (clean message, no stack) before anything is touched.
	let only: ProviderId[] | undefined;
	let baseImageRef: string = config.toolchainImageCandidate;
	try {
		only = requestedProviders(process.argv);
		baseImageRef = requestedBaseImage(process.argv) ?? config.toolchainImageCandidate;
	} catch (err) {
		log(`error: ${err instanceof Error ? err.message : String(err)}`);
		await exitAfterSandboxCleanup(2);
	}
	const configuredRequired = requiredProviders();
	const unknownRequired = unknownProviderIds(configuredRequired);
	if (unknownRequired.length > 0) {
		log(`error: unknown required provider(s): ${unknownRequired.join(", ")}`);
		await exitAfterSandboxCleanup(2);
	}

	// Promote is the release step: publish the already-validated candidate as the public version.
	if (process.argv.includes("--promote")) {
		// `--force` republishes over an existing (immutable) version — dev regeneration, set only by a
		// manual toolchain-image.yml dispatch. Automated pushes never pass it, so :v1 stays immutable there.
		const force = process.argv.includes("--force");
		// A scoped promote is a backfill onto an existing version, which is the opposite of what --force
		// does (regenerate the whole version in place, destructively for daytona). Refuse the combination
		// rather than pick a winner: whichever we picked would silently not be what the operator asked for.
		if (isPartialScope(only) && force) {
			log(
				"error: --force cannot be combined with a scoped --provider promote — a scoped promote " +
					"backfills providers onto an already-published version, while --force regenerates the " +
					"whole version in place. Pick one.",
			);
			await exitAfterSandboxCleanup(2);
		}
		const promoted = await promoteAll(log, { force, only });
		writeReport({
			// The scope is recorded alongside the version names because those names are the FULL set the
			// version owns — on a partial promote most of them were not touched, and the payload has to
			// say which run this was rather than leave a reader to infer it from `reports`.
			scope: only ?? PROVIDERS.map((p) => p.id),
			partial: isPartialScope(only),
			version: {
				image: config.toolchainImageVersion,
				e2bTemplate: config.e2bTemplateVersion,
				daytonaSnapshot: config.daytonaSnapshotDefault,
				daytonaContainerSnapshot: config.daytonaContainerSnapshotDefault,
				novitaTemplate: config.novitaTemplateVersion,
				runloopBlueprint: config.runloopBlueprintVersion,
			},
			reports: promoted.reports,
		});
		const required = effectivePromotionRequirements(configuredRequired, only);
		warnNonBlocking(promoted.reports, required, "promote");
		if (!promoted.ok) {
			const blocking = blockingReports(promoted.reports, required);
			log(
				`error: promote failed${blocking.length > 0 ? ` — blocking: ${blocking.map((r) => r.provider).join(", ")}` : ""}`,
			);
		}
		// The transaction outcome is separate from its diagnostics: an optional provider can fail and stay
		// visible in the report without turning a successfully published shared version red after commit.
		await exitAfterSandboxCleanup(promoted.ok ? 0 : 1);
	}

	if (only) log(`>>> restricting bake+validate to: ${only.join(", ")}`);

	if (process.argv.includes("--build-push")) {
		log(">>> building + pushing candidate image…");
		try {
			await buildAndPushCandidate(log);
		} catch (err) {
			log(`<<< build/push failed — ${err instanceof Error ? err.message : String(err)}`);
			await exitAfterSandboxCleanup(1);
		}
	}

	// Modal's registry importer, like the remote E2B-compatible builders, may cache a mutable tag.
	// Resolve once after the push and validate the exact candidate bytes by immutable digest. This also
	// makes a tag change between provider bakes unable to redirect Modal's validation to different bytes.
	//
	// Only providers that actually reference the base need it: vercel boots its own VCR mirror while
	// blaxel boots a vendor stock image, so a cell restricted to either must not die on a base candidate it
	// never reads — under `build: skip` that ref may legitimately be stale or absent, and failing there
	// would break the one flow the scoped release exists for.
	const needsBase = (only ?? PROVIDERS.map((p) => p.id)).some((id) => baseImageUse(id) !== "none");
	let pinnedBaseImage = baseImageRef;
	if (needsBase) {
		try {
			pinnedBaseImage = await resolveImageDigestRef(baseImageRef);
			log(`>>> base image pinned for validation: ${pinnedBaseImage}`);
		} catch (err) {
			log(
				`<<< could not resolve base image digest for ${baseImageRef} — ${err instanceof Error ? err.message : String(err)}`,
			);
			await exitAfterSandboxCleanup(1);
		}
	} else {
		log(`>>> no provider in scope reads ${baseImageRef} — not resolving it`);
	}
	const candidateRefs = {
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

	const runs = await forEachProviderWithCreds(
		async (provider) => {
			if (isBakedProviderId(provider.name)) {
				log(`>>> ${provider.name}: baking candidate…`);
				await buildBakedProviderArtifact(provider.name, "candidate", pinnedBaseImage, (m) =>
					log(`    ${m}`),
				);
			} else {
				log(`>>> ${provider.name}: ${nonBakedArtifactAction(provider.name, "candidate")}`);
			}

			log(`>>> ${provider.name}: validating (boot + smoke)…`);
			// Boot the just-baked candidate (override the registry adapter's version create-options).
			const validateConfig: ProviderConfig = {
				...provider,
				artifact: candidateResolvedArtifact(provider.name, candidateRefs),
				createOptions: {
					...provider.createOptions,
					...candidateCreateOptions(provider.name, candidateRefs),
				},
			};
			return bootAndSmoke(validateConfig);
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

	const reports: BakeReport[] = runs.map((run) => ({
		provider: run.provider,
		status: run.status,
		...(run.reason ? { reason: run.reason } : {}),
		...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		...(run.value && run.value.checks.length > 0 ? { checks: run.value.checks } : {}),
	}));

	writeReport({
		candidate: {
			image: pinnedBaseImage,
			e2bTemplate: config.e2bTemplateCandidate,
			daytonaSnapshot: config.daytonaSnapshotCandidate,
			daytonaContainerSnapshot: config.daytonaContainerSnapshotCandidate,
			novitaTemplate: config.novitaTemplateCandidate,
			runloopBlueprint: config.runloopBlueprintCandidate,
		},
		reports,
	});

	const required = configuredRequired;
	warnNonBlocking(reports, required, "pass bake/verify");

	// A required failure blocks; a best-effort failure warns and exits zero. With no explicit required
	// set (the local default), every failure remains fatal as a hand-run safety net.
	const blocking = blockingFailures(reports, required);
	if (blocking.length > 0) {
		log(`error: bake failed — blocking: ${blocking.map((r) => r.provider).join(", ")}`);
		await exitAfterSandboxCleanup(1);
	}

	// D1: a required provider skipped for a missing/misnamed secret must fail loudly. CI hands every
	// matrix cell the full required set, so scope the absence check to this invocation's provider(s): a
	// cell is not responsible for required providers it never ran.
	const scopedRequired = only ? required.filter((id) => only.includes(id as ProviderId)) : required;
	const unmet = unmetRequirements(reports, scopedRequired);
	if (scopedRequired.length > 0 && unmet.length > 0) {
		log(
			`error: required providers did not pass: ${unmet.join(", ")} (--require / REQUIRE_PROVIDERS)`,
		);
		await exitAfterSandboxCleanup(1);
	}
	await exitAfterSandboxCleanup(0);
}
