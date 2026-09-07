// The single source of truth for "does this bake/promote report block the release?" — shared by the
// candidate bake loop, the promote transaction, and the job-summary renderer so the three can never
// disagree about what a red build means.
//
// The rule the whole release lane turns on:
//   • A failed report for a NON-provider sentinel (the `image` base-retag commit point, or any
//     pre-publish abort that reports under a synthetic id) ALWAYS blocks — those are the release
//     itself failing, never a best-effort provider.
//   • A failed report for a real provider blocks IFF that provider is `required`. Non-required
//     ("best-effort") providers — daytona-container, modal-vm, novita, blaxel until a committed run
//     proves them — are recorded and warned, but must never fail a release whose required set passed.
//   • A required provider that SKIPS also blocks: a release cannot claim a required integration passed
//     when missing credentials or another prerequisite prevented it from running.
//   • Locally (nothing required) any failure blocks, as a safety net for a hand-run bake/promote.
//
// This is deliberately NOT `reports.some(r => r.status === "failed")`: that blunt check is what made
// run 29896891577's promote job go red AFTER it had already published :v5 — a non-required
// daytona-container failure was counted as fatal even though the release intentionally shipped without
// it. Gate on the helpers below instead, everywhere the exit code is decided.
import { PROVIDER_IDS } from "@sandbox-benchmarks/schema/providers";

/** Registered provider ids. A failed report whose provider is NOT one of these is a synthetic sentinel
 *  (e.g. `image`) that always blocks — it can only mean the release plumbing failed. */
const REGISTERED_PROVIDER_IDS: ReadonlySet<string> = new Set(PROVIDER_IDS);

/** Synthetic id used for promotion's release-plumbing outcomes (including the image commit point). */
export const IMAGE_REPORT = "image";

/** Required ids that are not registered providers. Keep this check separate from per-cell scoping so
 * a typo cannot disappear merely because the current matrix cell runs a different provider. */
export function unknownProviderIds(ids: readonly string[]): string[] {
	return [...new Set(ids.filter((id) => !REGISTERED_PROVIDER_IDS.has(id)))];
}

/** The minimal report shape the gate reads — structural so both a bake/promote {@link
 *  import("./types.ts").BakeReport} and a raw provider-run fit without coupling. */
export interface GateReport {
	provider: string;
	status: string;
}

/** True when this report is a failure that must fail the job (block the release). See the module note. */
export function isBlockingFailure(report: GateReport, required: readonly string[]): boolean {
	return report.status === "failed" && isBlockingId(report.provider, required);
}

/** True when a report outcome blocks the release. In addition to blocking failures, an explicitly
 * required provider that skipped (normally because credentials were unavailable) must fail closed. */
export function isBlockingReport(report: GateReport, required: readonly string[]): boolean {
	return (
		isBlockingFailure(report, required) ||
		(report.status === "skipped" && required.includes(report.provider))
	);
}

/** The failed reports that block the release (see {@link isBlockingFailure}). Empty ⇒ safe to exit 0. */
export function blockingFailures<T extends GateReport>(
	reports: readonly T[],
	required: readonly string[],
): T[] {
	return reports.filter((r) => isBlockingFailure(r, required));
}

/** All report outcomes that block: blocking failures plus skips by explicitly required providers. */
export function blockingReports<T extends GateReport>(
	reports: readonly T[],
	required: readonly string[],
): T[] {
	return reports.filter((r) => isBlockingReport(r, required));
}

/** The failed PROVIDER reports that are best-effort (non-blocking): a real provider that failed but is
 *  not required. These are surfaced as warnings, never as a job failure. Excludes sentinels (which
 *  always block) and — in the local default — is empty, since there every failure blocks. */
export function nonBlockingFailures<T extends GateReport>(
	reports: readonly T[],
	required: readonly string[],
): T[] {
	return reports.filter((r) => r.status === "failed" && !isBlockingFailure(r, required));
}

/** Whether a failure of this report's id WOULD block — independent of its current status. Lets the
 *  summary label an `ok`/`skipped` row as "blocking" vs "best-effort" the same way a failure is judged. */
export function isBlockingId(provider: string, required: readonly string[]): boolean {
	if (!REGISTERED_PROVIDER_IDS.has(provider)) return true;
	return required.length === 0 || required.includes(provider);
}
