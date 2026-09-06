#!/usr/bin/env bun
// `bench-lifecycle` — measure each provider's lifecycle (spawn→exec→snapshot→teardown) and
// control-plane (sandbox info/list) timings directly in the harness, the axes PTS cannot see. Each
// provider runs `--iterations` cold-start cycles; per-Metric distributions are aggregated and reported.
//
// Providers whose credentials are absent are SKIPPED, not failed (the e2e surface is CI-with-secrets);
// a provider that can't even spawn FAILS. Exits non-zero iff a provider that ran failed, or a
// `--require`d provider didn't run-and-pass — mirroring `bench-smoke`.
//
// Observability: a per-provider timing log goes to stderr; the machine-readable summary is JSON on
// stdout. bun auto-loads .env, so local creds in a .env file are picked up.
import {
	benchmarkLifecycle,
	exitAfterSandboxCleanup,
	requiredProviders,
	unmetRequirements,
} from "@sandbox-benchmarks/harness";
import { benchmarkDriverLifecycle } from "../lib/driver-run.ts";
import type { LifecycleMetricSummary } from "../lib/lifecycle-summary.ts";
import {
	formatLifecycleLines,
	lifecycleFailureReason,
	lifecycleOk,
	summarizeLifecycleAggregates,
} from "../lib/lifecycle-summary.ts";
import { anyFailed, forEachProviderWithCreds } from "../lib/providers-run.ts";

/** A positive integer flag (`--flag N`), falling back when absent or malformed. */
function intFlag(argv: string[], flag: string, fallback: number): number {
	const i = argv.indexOf(flag);
	const raw = i === -1 ? undefined : argv[i + 1];
	// parseInt yields NaN for absent/garbage input, and `NaN > 0` is false — so this also rejects those.
	const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	return value > 0 ? value : fallback;
}

if (import.meta.main) {
	const log = (m: string) => console.error(m);

	const iterations = intFlag(process.argv, "--iterations", 3);
	const controlPlaneSamples = intFlag(process.argv, "--control-plane-samples", 5);
	const snapshot = !process.argv.includes("--no-snapshot");

	log(
		`>>> lifecycle: ${iterations} cold-start cycle(s)/provider, ` +
			`${controlPlaneSamples} control-plane probe(s)/cycle, snapshot=${snapshot}`,
	);

	// Summarize each provider's aggregates once, as it settles, then reuse for both the stderr log and the
	// stdout JSON below. Skipped providers never settle through onComplete and carry no metrics.
	const metricsByProvider = new Map<string, LifecycleMetricSummary[]>();
	const runs = await forEachProviderWithCreds(
		(target) => {
			log(`>>> ${target.id}: measuring lifecycle…`);
			switch (target.kind) {
				case "driver":
					return benchmarkDriverLifecycle(target.id, { iterations, controlPlaneSamples, snapshot });
				case "legacy":
					return benchmarkLifecycle(target.config, { iterations, controlPlaneSamples, snapshot });
				default: {
					const _never: never = target;
					return _never;
				}
			}
		},
		{
			log,
			// A provider that spawns but never captures the honest cold start (readiness never succeeds, or
			// spawn throws every cycle) returns without throwing — mark it failed so a green run and
			// `--require` can't hide that the benchmark's headline metric was never measured.
			ok: lifecycleOk,
			failureReason: lifecycleFailureReason,
			onComplete: (run) => {
				if (run.value) {
					const metrics = summarizeLifecycleAggregates(run.value.aggregates);
					metricsByProvider.set(run.provider, metrics);
					for (const line of formatLifecycleLines(metrics)) log(line);
					for (const gap of run.value.gaps) log(`    [${gap.outcome}] ${gap.id}: ${gap.reason}`);
				}
				const time = run.durationMs ? `${run.durationMs.toFixed(0)}ms` : "";
				const why = run.status === "failed" && run.reason ? ` — ${run.reason}` : "";
				log(`<<< ${run.provider}: ${run.status}${time ? ` (${time})` : ""}${why}`);
			},
		},
	);

	const summary = runs.map((run) => ({
		provider: run.provider,
		status: run.status,
		...(run.reason ? { reason: run.reason } : {}),
		...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		...(run.value
			? {
					metrics: metricsByProvider.get(run.provider) ?? [],
					gaps: run.value.gaps,
				}
			: {}),
	}));
	console.log(JSON.stringify({ summary }, null, 2));

	// Skips (missing creds) never fail the run; only a provider that ran and broke does.
	if (anyFailed(runs)) await exitAfterSandboxCleanup(1);

	// At the CI/publish boundary a *required* provider that didn't run-and-pass must fail the lane loudly,
	// so a green run can't hide that a provider was never actually measured.
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
