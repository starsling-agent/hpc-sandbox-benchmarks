// Boot a provider's sandbox, run the shared smoke spec inside it, and present the results — the
// body that both `bench-smoke` (boot the published image) and `bake` (boot the just-baked candidate)
// feed to {@link forEachProviderWithCreds}. The probe results are captured INSIDE the lifecycle so a
// teardown-only failure still reports which probes passed instead of looking like nothing ran.
import { withSandbox } from "@sandbox-benchmarks/harness";
import type { SmokeResult } from "@sandbox-benchmarks/templates/smoke";
import { runSmoke } from "@sandbox-benchmarks/templates/smoke";
import type { ArtifactResolution } from "./driver-run.ts";
import { withDriverSandbox } from "./driver-run.ts";
import type { ProviderTarget } from "./providers-run.ts";

/** A smoke run's outcome: the probe results, plus the lifecycle error if boot/teardown threw. */
export interface SmokeOutcome {
	checks: SmokeResult[];
	/** Set iff the boot→smoke→teardown lifecycle threw (bad creds, unreachable image, flaky destroy). */
	error?: unknown;
}

/**
 * Boot a sandbox from `target`, run the smoke spec, and tear it down. Never throws: `checks` are
 * captured before teardown so they survive a destroy failure, and any lifecycle error is returned in
 * `error` rather than thrown — the caller (via {@link smokeOk}) decides pass/fail.
 *
 * Registered ids create through {@link withDriverSandbox}; waived ids through leftover adapters.
 */
export async function bootAndSmoke(
	target: ProviderTarget,
	options: { readonly artifact?: ArtifactResolution } = {},
): Promise<SmokeOutcome> {
	let checks: SmokeResult[] = [];
	try {
		switch (target.kind) {
			case "driver":
				await withDriverSandbox(
					target.id,
					async (sandbox) => {
						checks = await runSmoke(async (cmd) => {
							const result = await sandbox.runCommand(cmd);
							return {
								stdout: result.stdout ?? "",
								stderr: result.stderr ?? "",
								exitCode: result.exitCode,
							};
						});
					},
					options,
				);
				return { checks };
			case "legacy":
				await withSandbox(target.config, async (sandbox) => {
					checks = await runSmoke((cmd) => sandbox.runCommand(cmd));
				});
				return { checks };
			default: {
				const _never: never = target;
				return _never;
			}
		}
	} catch (error) {
		return { checks, error };
	}
}

/** A smoke run passed iff it didn't throw and every probe (at least one) passed. */
export function smokeOk(outcome: SmokeOutcome): boolean {
	return !outcome.error && outcome.checks.length > 0 && outcome.checks.every((c) => c.ok);
}

/** A human reason for a failed smoke run: the lifecycle error, else the failed-probe count. */
export function smokeFailureReason(outcome: SmokeOutcome): string {
	if (outcome.error) {
		return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
	}
	const failed = outcome.checks.filter((c) => !c.ok).length;
	return `${failed}/${outcome.checks.length} checks failed`;
}

/** Last `lines` lines of captured output, indented for the per-check failure detail. */
export function tail(output: string, lines = 5): string {
	return output.trim().split("\n").slice(-lines).join("\n             ");
}

/** Print each probe's pass/fail (with duration) to `log`, and the cmd+output tail on failure. */
export function logChecks(provider: string, checks: SmokeResult[], log: (m: string) => void): void {
	for (const c of checks) {
		log(`    [${c.ok ? "ok" : "FAIL"}] ${provider}/${c.name} (${c.durationMs.toFixed(0)}ms)`);
		if (!c.ok) log(`        cmd: ${c.cmd}\n        out: ${tail(c.output)}`);
	}
}
