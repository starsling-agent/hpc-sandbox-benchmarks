#!/usr/bin/env bun
// `bench-smoke` — boot each provider's sandbox from the baked toolchain image, run the shared smoke
// spec inside it, and assert the toolchain survived that provider's packaging (e2b envd injection,
// daytona snapshot, modal fromRegistry). Providers whose credentials are absent are SKIPPED, not
// failed — the e2e surface is CI-with-secrets. Exits non-zero iff a provider that actually ran failed.
//
// The provider loop, skip-vs-fail contract, and boot+smoke lifecycle are shared with `bake` (see
// providers-run.ts / smoke-run.ts); this bin only wires logging + the JSON summary.
//
// Observability: a per-provider/per-check log goes to stderr (with durations and, on failure, the
// captured output); the machine-readable summary is the JSON on stdout. bun auto-loads .env, so
// local creds in a .env file are picked up.
import {
	exitAfterSandboxCleanup,
	requiredProviders,
	unmetRequirements,
} from "@sandbox-benchmarks/harness";
import { anyFailed, forEachProviderWithCreds } from "../lib/providers-run.ts";
import { bootAndSmoke, logChecks, smokeFailureReason, smokeOk } from "../lib/smoke-run.ts";

if (import.meta.main) {
	const log = (m: string) => console.error(m);

	const runs = await forEachProviderWithCreds(
		(target) => {
			log(`>>> ${target.id}: booting sandbox…`);
			return bootAndSmoke(target);
		},
		{
			log,
			ok: smokeOk,
			failureReason: smokeFailureReason,
			// Log each provider's checks + result as it settles, so output stays interleaved with boots.
			onComplete: (run) => {
				if (run.value) logChecks(run.provider, run.value.checks, log);
				const passed = run.value ? run.value.checks.filter((c) => c.ok).length : 0;
				const total = run.value?.checks.length ?? 0;
				const time = run.durationMs ? `${run.durationMs.toFixed(0)}ms, ` : "";
				log(`<<< ${run.provider}: ${run.status} (${time}${passed}/${total} checks)`);
			},
		},
	);

	const summary = runs.map((run) => ({
		provider: run.provider,
		status: run.status,
		...(run.reason ? { reason: run.reason } : {}),
		...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		...(run.value && run.value.checks.length > 0 ? { checks: run.value.checks } : {}),
	}));
	console.log(JSON.stringify({ summary }, null, 2));

	// Skips never fail the run; only a provider that ran and broke does.
	if (anyFailed(runs)) await exitAfterSandboxCleanup(1);

	// D1: at the CI/publish boundary a *required* provider that didn't run-and-pass — skipped for a
	// missing/misnamed secret, or failed — must fail the lane loudly, so a green run can't hide that
	// a provider was never actually smoked. Locally, with nothing required, skips stay green.
	const required = requiredProviders();
	const unmet = unmetRequirements(runs, required);
	if (required.length > 0 && unmet.length > 0) {
		log(
			`error: required providers did not pass: ${unmet.join(", ")} (--require / REQUIRE_PROVIDERS)`,
		);
		await exitAfterSandboxCleanup(1);
	}
	await exitAfterSandboxCleanup(0);
}
