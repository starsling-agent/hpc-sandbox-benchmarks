import { join } from "node:path";
import { describeDriverFailure as projectDriverFailure } from "@sandbox-benchmarks/driver";
import { diagnosticSecretsFromEnv } from "@sandbox-benchmarks/driver/env";
import {
	CREATE_FAILURE_PREFIX,
	runSuite,
	SuiteUsageError,
	unmetRequirements,
} from "@sandbox-benchmarks/harness";
import { writeNormalizedRun } from "@sandbox-benchmarks/results";
import type { Run } from "@sandbox-benchmarks/schema";
import { logInfo, logProviderStatuses, logWarning, withGroup } from "./actions-log.ts";
import { isConcurrentSandboxAdmissionError } from "./admission-capacity.ts";
import { runDriverSuite, usesDriverSuite } from "./driver-run.ts";

const describeDriverFailure = (error: unknown): string =>
	projectDriverFailure(error, diagnosticSecretsFromEnv(process.env));

export interface ReplicateOutcome {
	/** The replicate index, or undefined for the single un-indexed run (local/smoke). */
	index?: number;
	/** Where this replicate's shard Run belongs. Always set — including on a failure that never got as
	 *  far as writing it — so the fleet table can name the missing shard rather than blanking the cell. */
	outFile: string;
	/** The normalized shard Run, absent when normalization itself failed. */
	run?: Run;
	failed: boolean;
	/** Why it failed (or a note about a recorded gap) — the annotation/summary text. */
	detail?: string;
	/**
	 * Wall-clock milliseconds this replicate took, end to end.
	 *
	 * Recorded because collapsing the runner axis DELETED it: when every replicate was its own job,
	 * the Actions UI listed R durations for free, and a straggler was obvious. Driven from one runner
	 * they share a single job duration, so without this a report cannot say which sandbox was slow —
	 * and a straggler is precisely what puts the cell near its `timeout-minutes`, where the whole
	 * fleet's shards are lost at once rather than one replicate's.
	 */
	durationMs: number;
}

export function replicateLabel(index: number | undefined): string {
	return index === undefined ? "single" : `r${index}`;
}

/** Everything one replicate needs; `replicateIndex` undefined is the single un-indexed run. */
interface ReplicateContext {
	execute?: typeof runSuite;
	provider: string;
	suite: string;
	runId: string;
	sha: string;
	rawRoot: string;
	outFile: string;
	indexFile?: string;
	replicateIndex?: number;
	/** Force the DriverModule path. Registered ids already take that path; waived ids error. */
	driverPath?: boolean;
	/** Providers that must reach "validated" for this replicate to count as a success. */
	required: readonly string[];
}

/**
 * Run ONE replicate end to end — suite → normalize → gap verification → require gate — and report
 * what happened. Total by construction: it never throws and never exits, because a `--replicates`
 * fan-out has R of these in flight and one replicate's failure must not abort its peers or skip
 * their shard writes (the per-replicate matrix cells had `fail-fast: false` for the same reason).
 */
export async function runReplicate(ctx: ReplicateContext): Promise<ReplicateOutcome> {
	const { provider, suite, runId, sha, rawRoot, outFile, indexFile, replicateIndex } = ctx;
	// Annotations are emitted as `::warning::` workflow commands, which bypass the `[rN]` line tagging
	// by necessity (a tagged command stops being an annotation). So the replicate has to ride in the
	// TITLE instead — otherwise a 12-way fan-out puts up to 12 byte-identical warnings in the panel
	// with nothing saying which sandbox each came from.
	const cell =
		`${suite} / ${provider}` +
		(replicateIndex === undefined ? "" : ` ${replicateLabel(replicateIndex)}`);
	const startedAt = Bun.nanoseconds();
	// A getter, so every `...base` spread below stamps the elapsed time AT ITS OWN return rather than
	// freezing it here, before the suite has even started.
	const base = {
		index: replicateIndex,
		outFile,
		get durationMs() {
			return Math.round((Bun.nanoseconds() - startedAt) / 1e6);
		},
	};

	// A suite that RAN AND BROKE is a result — the harness has already written its `--failed.json` marker
	// into the raw tree — so the error is held, not thrown. Normalizing anyway is what turns that marker
	// into a recorded `failed` gap on this shard's Run document; rethrowing here would skip the write, the
	// shard would contribute nothing for the aggregate to merge, and the only trace of the failure would
	// die inside the CI artifact. The replicate still reports failed at the bottom of this block.
	let suiteError: unknown;
	let usageError: string | undefined;
	await withGroup(`Run suite ${suite} on ${provider}`, async () => {
		try {
			const executeSuite =
				ctx.execute ??
				(usesDriverSuite(provider, ctx.driverPath === true) ? runDriverSuite : runSuite);
			await executeSuite({
				runId,
				replicateIndex,
				providerName: provider,
				suiteName: suite,
				// Tag the raw tree by suite: `<rawRoot>/<provider>/<suite>/`. The normalizer reads each suite
				// subdirectory independently and rejects any catalogued metric a suite emits off its declared
				// Dimensions (the runtime half of the suite↔dimension↔metric contract).
				resultsDir: join(rawRoot, provider, suite),
			});
			logInfo(`Suite "${suite}" completed on ${provider}`);
		} catch (err) {
			// A usage error (unknown provider/suite) produced no raw tree and no marker: there is nothing to
			// normalize, and pretending otherwise would write an empty Run for a cell that never existed.
			if (err instanceof SuiteUsageError) {
				usageError = err.message;
				return;
			}
			suiteError = err;
			if (isConcurrentSandboxAdmissionError(err)) {
				logWarning(
					`Suite "${suite}" hit a vendor concurrent sandbox limit on ${provider} — admission capacity must be reconciled; not a measurement gap: ${describeDriverFailure(
						err,
					)}`,
					{ title: cell },
				);
			} else {
				logWarning(
					`Suite "${suite}" threw on ${provider} — will normalize any failed marker into a gap: ${describeDriverFailure(
						err,
					)}`,
					{ title: cell },
				);
			}
		}
	});
	if (usageError !== undefined) return { ...base, failed: true, detail: usageError };

	let run: Run | undefined;
	let normalizeError: unknown;
	await withGroup("Normalize Run document", async () => {
		try {
			run = writeNormalizedRun({
				rawRoot,
				runId,
				sha,
				outFile,
				updateIndexFile: indexFile,
				...(replicateIndex !== undefined ? { replicateIndex } : {}),
			});
			logInfo(`Normalized Run ${runId} → ${outFile}`);
			// Already inside withGroup — don't nest another ::group::.
			await logProviderStatuses(run, { grouped: false });
		} catch (err) {
			// Prefer the suite failure that caused a bad tree; otherwise keep the normalize error.
			normalizeError = suiteError ?? err;
		}
	});
	if (!run) {
		const detail =
			normalizeError === undefined
				? "normalize produced no Run document"
				: describeDriverFailure(normalizeError);
		return { ...base, failed: true, detail };
	}
	const normalized = run;

	if (suiteError) {
		const message = describeDriverFailure(suiteError);
		// Verify before claiming: the harness writes the failed marker, but a throw can predate it (or
		// the marker can be lost before normalize), leaving this shard's Run EMPTY for the cell. Saying
		// "recorded as a failed gap" then would launder the loss — the aggregate would show a bare
		// pending provider while every job log claims the gap exists — so check the normalized Run itself.
		//
		// Match the gap's REASON against THIS run's error, not just its (scope, id, outcome): the harness
		// records the marker reason verbatim (`message`) for a post-run failure, or under the
		// `Failed to create sandbox: ` prefix for a creation failure. A bare shape check would also accept
		// a stale `--failed.json` from an earlier error, or an independently-derived suite gap (a disk
		// shortfall, a dedup twin) — none of which prove the marker THIS run tried to write survived.
		const gapRecorded = normalized.providers
			.find((p) => p.providerId === provider)
			?.gaps.some(
				(g) =>
					g.scope === "suite" &&
					g.id === suite &&
					g.outcome === "failed" &&
					(g.reason === message || g.reason === `${CREATE_FAILURE_PREFIX}${message}`),
			);
		const detail = gapRecorded
			? `Suite "${suite}" failed on ${provider} — recorded as a failed gap in ${outFile}: ${message}`
			: `Suite "${suite}" failed on ${provider} but no gap could be recorded in ${outFile} ` +
				`(no failed marker survived into the raw tree; this job log is the only trace): ${message}`;
		return { ...base, run: normalized, failed: true, detail };
	}

	// Missing credentials (and an unusable sandbox) are recorded as a skip, not a throw — the lenient
	// local-dev default. That would make a smoke run whose secret is missing/misnamed exit 0 having
	// benchmarked nothing, so CI passes `--require <provider>` (or REQUIRE_PROVIDERS) to assert the
	// provider actually reached `validated` — i.e. produced at least one catalogued metric.
	if (ctx.required.length > 0) {
		const reports = normalized.providers.map((p) => ({
			provider: p.providerId,
			status: p.validationStatus === "validated" ? "ok" : p.validationStatus,
		}));
		const unmet = unmetRequirements(reports, ctx.required);
		if (unmet.length > 0) {
			const details: string[] = [];
			for (const providerId of unmet) {
				// The gaps ARE the explanation for "no metrics", and their outcome is the important half of
				// it: a required provider that skipped on a precondition is a configuration problem, one that
				// failed is an outage, and the operator reading this line needs to know which they have.
				const gaps = normalized.providers.find((p) => p.providerId === providerId)?.gaps ?? [];
				const gapDetail = gaps.map((g) => `${g.id} ${g.outcome}: ${g.reason}`).join("; ");
				const line = `Required provider "${providerId}" produced no metrics${gapDetail ? ` — ${gapDetail}` : " and was absent from the Run"}`;
				details.push(line);
			}
			return { ...base, run: normalized, failed: true, detail: details.join("\n") };
		}
	}

	logInfo(`Cell ${cell} succeeded → ${outFile}`);
	return { ...base, run: normalized, failed: false };
}
