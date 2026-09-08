#!/usr/bin/env bun
// `bench-suite` — run a benchmark suite on a provider sandbox, collect the raw results into a
// data/raw tree, and normalize them into a validated Run document. Missing provider credentials are
// recorded as a skip (the provider stays `pending` in the Run), so this is runnable without secrets.
// Logging and results go through @actions/core (groups, debug, annotations, job summary) so the
// nested "<suite> / <provider>" cell is metadata-rich in the Actions UI.
//
// `--replicates <indices>` drives the WHOLE between-machine fan-out for this (provider, suite) cell
// from one process: R sandboxes concurrently, one shard Run each. That is what lets a single GitHub
// Actions runner own a cell — a bench runner is ~100% idle waiting on its sandbox, so the old
// runner-per-replicate matrix billed R idle runners to do one runner's work (see ../lib/replicates.ts).
// Every replicate is run to completion regardless of its peers' outcomes and its shard is written
// either way, so one flaky sandbox can't discard the rest of the fleet's results.

import { join } from "node:path";
import * as core from "@actions/core";
import {
	CREATE_FAILURE_PREFIX,
	exitAfterSandboxCleanup,
	requiredProviders,
	runSuite,
	SuiteUsageError,
	shutdownOwnedSandboxes,
	unmetRequirements,
} from "@sandbox-benchmarks/harness";
import { writeNormalizedRun } from "@sandbox-benchmarks/results";
import type { Run, SuiteName } from "@sandbox-benchmarks/schema";
import {
	expectedRuntimeIdentity,
	isUnexpectedRuntimeUser,
	SUITES,
} from "@sandbox-benchmarks/schema";
import type { CellKind, SummaryRow } from "../lib/actions-log.ts";
import {
	escapeHtml,
	fail,
	inActions,
	logInfo,
	logProviderStatuses,
	logWarning,
	providerSummaryRows,
	renderCell,
	setGroupingEnabled,
	withGroup,
	writeJobSummary,
} from "../lib/actions-log.ts";
import { handleDiscovery } from "../lib/discovery.ts";
import { runDriverSuite, usesDriverSuite } from "../lib/driver-run.ts";
import { installLineTagging, withLineTag } from "../lib/log-prefix.ts";
import {
	fleetBudgetError,
	lastFlagValue,
	parseReplicateIndex,
	parseReplicatesFlag,
	replicatePaths,
	resolveCellBudgetMinutes,
	resolveMaxConcurrency,
	resolveRunnerLifetimeMinutes,
	runnerLifetimeError,
	runPooled,
} from "../lib/replicates.ts";
import { suiteMetricSummaryRows, suiteTaskSummaryRows } from "../lib/suite-summary.ts";
import type { SuiteTaskPlan } from "../lib/suite-tasks.ts";
import { describeSuiteTasks } from "../lib/suite-tasks.ts";

function plural(n: number, singular: string, pluralForm: string = `${singular}s`): string {
	return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Job-summary rendering for the observed effective user, with a visible warning on contract drift.
 *
 * The expectation is per-provider ({@link isUnexpectedRuntimeUser}), NOT a hardcoded "root": Runloop
 * runs its lane as an unprivileged user by design, so a fixed expectation would mark all twelve of its
 * replicates anomalous on a healthy run and bury the identity change this column exists to surface.
 */
export function runtimeUserSummary(providerId: string, user: string | undefined): string {
	if (!user) return "—";
	if (!isUnexpectedRuntimeUser(providerId, user)) return user;
	return `⚠ ${user} (expected ${expectedRuntimeIdentity(providerId)})`;
}

function miseTaskSummary(plan: SuiteTaskPlan): string {
	const commands = plan.tasks.filter((t) => t.role === "command").length;
	const leaves = plan.tasks.filter((t) => t.role === "leaf").length;
	if (leaves === 0) return plural(commands, "task");
	return `${plural(commands, "command")} → ${plural(leaves, "leaf task")}`;
}

/** The Actions-visible name of a (suite, provider) cell — the job-summary heading, the annotation
 *  title, and the log line, all of which have to agree for a reader to connect them. */
function cellTitle(suite: string, provider: string): string {
	return `${suite} / ${provider}`;
}

/** Agent-facing usage; bare invocation keeps the daytona-vm/cpu-node local-dev default. Every provider
 *  named here is a canonical {@link ProviderId} — the positional argument is matched against the
 *  registry exactly, so a copied example that said "daytona" or "modal" would fail as unknown. */
export const HELP = `bench-suite — run a benchmark suite on a provider sandbox and normalize it into a Run document.

usage: bench-suite [provider] [suite] [runId]
       bench-suite [--help] [--list-providers] [--list-suites] [--json]

  provider                Provider to run on (default: daytona-vm). See --list-providers.
  suite                   Suite to run (default: cpu-node). See --list-suites.
  runId                   Run identifier for the data/ tree (default: local-<timestamp>).
  --replicates <indices>  Drive the whole replicate fan-out from THIS process: a JSON array
                          ("[0,1,2]", what plan-replicates emits) or a comma-separated list ("0,1,2").
                          Each index gets its own sandbox, raw tree (data/raw/<runId>/r<idx>/) and
                          shard (data/runs/<runId>-r<idx>.json); they run concurrently and every one
                          is run to completion even if a peer fails. This is the CI matrix's form.
  --max-concurrency <n>   Cap the replicate sandboxes in flight (default: all at once). Also read from
                          BENCH_MAX_CONCURRENCY. Lower it when a provider's quota makes a wide fan-out
                          spend its create-retry budget queueing. A cap runs the fleet in ceil(R / n)
                          serial waves; under CI (BENCH_CELL_BUDGET_MINUTES) a cap whose waves cannot
                          fit the job budget is rejected up front rather than cancelled mid-fan-out.
  --replicate <idx>       Run ONE replicate (a non-negative integer), stamped onto the shard Run so
                          the aggregate folds ≥2 replicates of one suite together. Writes the
                          un-suffixed data/runs/<runId>.json — the single-sandbox/local form.
  --require <ids>         Comma-separated providers that MUST reach "validated"; exit 1 otherwise.
                          Also read from REQUIRE_PROVIDERS. CI sets this so a missing secret fails loudly.
  --driver-path           Force the DriverModule path. Registered ids (e2b, tama, modal-gvisor,
                          modal-vm) already use it by default; unmigrated providers fail as a
                          usage error rather than falling back to packages/providers.
  --list-providers        List the registered providers.
  --list-suites           List the registered suites and their dimensions/metrics.
  --json                  Emit --list-* output as JSON instead of human-readable lines.
  --help, -h              Show this help.

Missing provider credentials are recorded as a skip (the provider stays "pending"), so this is
runnable without secrets. Writes the shard Run(s) under data/runs/ and updates data/index.json.

examples:
  bench-suite daytona-vm cpu-node                 # one suite locally, auto runId
  bench-suite modal-vm memory ci-1234             # a specific cell + runId
  bench-suite e2b memory --require e2b            # fail (don't skip) if E2B_API_KEY is absent
  bench-suite e2b system spike-1                  # registered ids use DriverModule by default
  bench-suite e2b system spike-1 --driver-path    # redundant for registered ids; errors if unmigrated
  bench-suite e2b memory ci-1 --replicates 0,1,2  # 3 replicate sandboxes from this one process
  bench-suite --list-suites                       # discover the suite names first

Next: render the Run with \`leaderboard data/runs/<runId>.json\`.`;

/** What one replicate produced. Returned, never exited on: a replicate that dies must not take its
 *  peers' sandboxes down with it, so the fleet driver decides the process exit code once, at the end. */
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

/** Elapsed wall clock, rendered for a summary cell: sub-minute stays in seconds, longer reads as
 *  `m` + `s` so a straggler is legible against a job budget quoted in minutes. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

/** A short, stable label for one replicate in logs and summary tables. */
function replicateLabel(index: number | undefined): string {
	return index === undefined ? "single" : `r${index}`;
}

/**
 * Parse `--replicate <idx>` / `--replicate=<idx>` into a non-negative integer, or `undefined` when the
 * flag is absent. A dangling or non-integer value fails loudly rather than silently defaulting the shard
 * to replicate 0 — a wrong index would collide two sandboxes into one replicate slot at aggregate time.
 * Exported so the parsing is unit-testable without spawning a process. (The CI fan-out uses the plural
 * `--replicates`; this is the single-sandbox spelling, sharing its validation.)
 */
export function parseReplicateFlag(argv: readonly string[]): number | undefined {
	const raw = lastFlagValue(argv, "replicate");
	if (raw === undefined) return undefined;
	return parseReplicateIndex(raw);
}

/** Identity of the cell being reported, shared by both reporters below. */
interface CellIdentity {
	provider: string;
	suite: string;
	runId: string;
	sha: string;
	/** The suite's resolved task plan, absent when discovery failed (the summary then omits it). */
	taskPlan?: SuiteTaskPlan;
}

/**
 * The half of a cell's job summary that does NOT depend on how many sandboxes ran: heading, cell
 * identity, the suite's task plan, and the annotation wiring. `fields`/`tables` are appended to it —
 * that is the only place the single-sandbox and fleet reports legitimately differ, so a change to the
 * shared half can no longer land in one reporter and miss the other. (They drifted exactly that way
 * once, when the fleet report shipped without the per-sandbox CPU/spec columns.)
 */
async function writeCellSummary(
	opts: CellIdentity & {
		failed: boolean;
		/** Report-specific field rows, rendered after the cell identity. */
		fields: Array<[label: string, value: string, kind: CellKind]>;
		/** Report-specific tables, rendered before the task-plan tables. */
		tables: Array<{ heading: string; rows: SummaryRow[] }>;
		detail?: string;
		annotationMessage: string;
	},
): Promise<void> {
	const title = cellTitle(opts.suite, opts.provider);
	const plan = opts.taskPlan;
	await writeJobSummary({
		heading: title,
		fields: [
			["Status", opts.failed ? "failure" : "success", "plain"],
			["Suite", opts.suite, "code"],
			["Provider", opts.provider, "code"],
			["Run id", opts.runId, "code"],
			["SHA", opts.sha, "code"],
			...opts.fields,
			["Harness commands", plan?.commands.join(" · ") ?? "", "code"],
			["Mise tasks", plan ? miseTaskSummary(plan) : "", "plain"],
		],
		tables: [
			...opts.tables,
			...(plan
				? [
						{ heading: "Mise tasks", rows: suiteTaskSummaryRows(plan) },
						{ heading: "Declared metrics", rows: suiteMetricSummaryRows(plan) },
					]
				: []),
		],
		detail: opts.detail,
		annotation: { failed: opts.failed, title, message: opts.annotationMessage },
	});
}

/**
 * The single-sandbox report: ONE cell, described in full. Deliberately richer per-provider than
 * {@link reportFleet} rather than a special case of it — this is what a human reads after a local run
 * or an explicit `--replicate <idx>`, so it keeps the whole-Run provider table (every registered
 * provider, with the skipped/failed gap split) that a fleet's one-row-per-replicate table has no room
 * for, and names the target provider's validation state in the annotation itself. CI no longer reaches
 * it: both dispatch lanes go through the reusable cell, which always passes `--replicates`.
 */
async function reportCell(
	opts: CellIdentity & {
		outFile: string;
		run?: Run;
		failed: boolean;
		detail?: string;
		durationMs: number;
	},
): Promise<void> {
	const provider = opts.run?.providers.find((p) => p.providerId === opts.provider);
	await writeCellSummary({
		// Identity + failed/detail ride through as-is; `outFile`/`run` are spent on the rows below.
		...opts,
		fields: [
			["Artifact", opts.outFile, "code"],
			["Duration", formatDuration(opts.durationMs), "plain"],
			["Validation", provider?.validationStatus ?? (opts.run ? "absent" : ""), "plain"],
			["Metrics", provider ? String(provider.metrics.length) : "", "plain"],
			["Suites covered", provider ? String(provider.suitesCovered.length) : "", "plain"],
			["Gaps", provider ? String(provider.gaps.length) : "", "plain"],
			["Cost evidence", provider ? String(provider.costEvidence?.length ?? 0) : "", "plain"],
			["Runtime user", runtimeUserSummary(opts.provider, provider?.observedSpecs.user), "plain"],
			["Observed CPU", provider?.observedSpecs.cpuModel ?? "", "code"],
			[
				"Spec matched",
				provider?.specMatched === undefined ? "" : String(provider.specMatched),
				"plain",
			],
		],
		tables: opts.run ? [{ heading: "Provider status", rows: providerSummaryRows(opts.run) }] : [],
		annotationMessage:
			opts.detail ??
			(provider
				? `${provider.providerId} ${provider.validationStatus} metrics=${provider.metrics.length}`
				: cellTitle(opts.suite, opts.provider)),
	});
}

/**
 * How many failing replicates the ANNOTATION names before deferring to the job summary. GitHub
 * truncates a long annotation message, and the fan-out axis reaches R=12 today with the dispatch
 * `replicas` knob able to push it far higher — pasting 40+ multi-sentence failure reasons into one
 * annotation produces an unreadable wall that the runner may cut mid-reason anyway. The job summary
 * keeps EVERY failure verbatim (it has a far larger budget and is the right place to read them), so
 * this cap costs no information; it only decides how much the annotations panel previews.
 */
const ANNOTATION_FAILURE_LIMIT = 3;

/** The complete, one-line-per-failure detail for the job summary — never truncated. */
export function fleetFailureDetail(failures: readonly ReplicateOutcome[]): string {
	return failures.map((o) => `${replicateLabel(o.index)}: ${o.detail ?? "failed"}`).join("\n");
}

/**
 * The annotation message for a fan-out cell: a count first (the fact a reader needs at a glance),
 * then at most {@link ANNOTATION_FAILURE_LIMIT} failure reasons, then a pointer to the job summary
 * for the rest. Bounded by design — see {@link ANNOTATION_FAILURE_LIMIT}.
 */
export function fleetAnnotationMessage(
	failures: readonly ReplicateOutcome[],
	total: number,
	validated: number,
): string {
	if (failures.length === 0) return `${validated}/${total} replicate(s) validated`;
	const shown = failures.slice(0, ANNOTATION_FAILURE_LIMIT);
	const remaining = failures.length - shown.length;
	return (
		`${failures.length}/${total} replicate(s) failed — ${fleetFailureDetail(shown)}` +
		(remaining > 0 ? `\n…and ${remaining} more (see the job summary)` : "")
	);
}

/** One row per replicate: what each sandbox produced, so a 12-way fan-out is legible at a glance
 *  without opening 12 job logs (which is what the per-replicate matrix cells used to be). Exported
 *  so the table is testable at the fan-out widths the `replicas` dispatch knob allows. */
export function replicateSummaryRows(
	provider: string,
	outcomes: readonly ReplicateOutcome[],
): SummaryRow[] {
	const header: SummaryRow = [
		{ data: "Replicate", header: true },
		{ data: "Status", header: true },
		// The column the collapsed runner axis owes the reader: R replicates share ONE job duration
		// now, so without this the report cannot say which sandbox was slow — and the slowest is what
		// sets the cell's wall clock against a `timeout-minutes` that costs every shard when missed.
		{ data: "Duration", header: true },
		{ data: "Validation", header: true },
		{ data: "Metrics", header: true },
		{ data: "Suites", header: true },
		{ data: "Gaps", header: true },
		{ data: "Cost evidence", header: true },
		{ data: "Runtime user", header: true },
		// Per-SANDBOX, not per-cell, and that is the point: R replicates exist to measure a provider's
		// fleet variation, and a replicate that landed on different host hardware (or off the target
		// spec) is the single most likely explanation for an outlier. reportCell surfaces these for a
		// single sandbox; dropping them here would have left the CI path — the one that feeds the
		// dataset — unable to see per-replicate heterogeneity without downloading the shard artifacts.
		// `specMatched` is also what drives the leaderboard's Comparability warning.
		{ data: "Observed CPU", header: true },
		{ data: "Region", header: true },
		{ data: "Spec", header: true },
		{ data: "Shard", header: true },
	];
	const rows = outcomes.map((outcome) => {
		const run = outcome.run?.providers.find((p) => p.providerId === provider);
		return [
			renderCell(replicateLabel(outcome.index), "code"),
			escapeHtml(outcome.failed ? "failure" : "success"),
			escapeHtml(formatDuration(outcome.durationMs)),
			escapeHtml(run?.validationStatus ?? (outcome.run ? "absent" : "—")),
			escapeHtml(run ? String(run.metrics.length) : "—"),
			escapeHtml(run ? String(run.suitesCovered.length) : "—"),
			escapeHtml(run ? String(run.gaps.length) : "—"),
			escapeHtml(run ? String(run.costEvidence?.length ?? 0) : "—"),
			escapeHtml(runtimeUserSummary(provider, run?.observedSpecs.user)),
			renderCell(run?.observedSpecs.cpuModel || "—", "code"),
			escapeHtml(run?.observedSpecs.region || "—"),
			escapeHtml(run?.specMatched === undefined ? "—" : String(run.specMatched)),
			renderCell(outcome.outFile, "code"),
		];
	});
	return [header, ...rows];
}

/**
 * The whole-fleet report for a `--replicates` run: ONE job summary + ONE annotation covering every
 * replicate this runner drove. Deliberately not R separate reports — R annotations per cell would
 * bury the run's annotation panel, and the failures a reader needs are the ones named in `detail`.
 */
async function reportFleet(
	opts: CellIdentity & { outcomes: readonly ReplicateOutcome[] },
): Promise<void> {
	const failures = opts.outcomes.filter((o) => o.failed);
	const byDuration = [...opts.outcomes].sort((a, b) => a.durationMs - b.durationMs);
	const fastest = byDuration[0];
	const slowest = byDuration[byDuration.length - 1];
	// Complete for the summary; the annotation gets the bounded preview from fleetAnnotationMessage.
	const detail = fleetFailureDetail(failures);
	const validated = opts.outcomes.filter(
		(o) =>
			o.run?.providers.find((p) => p.providerId === opts.provider)?.validationStatus ===
			"validated",
	).length;
	const unexpectedRuntimeUsers = opts.outcomes.filter((outcome) =>
		isUnexpectedRuntimeUser(
			opts.provider,
			outcome.run?.providers.find((provider) => provider.providerId === opts.provider)
				?.observedSpecs.user,
		),
	).length;
	await writeCellSummary({
		// Identity rides through as-is; `outcomes` is spent on the counts and the table below.
		...opts,
		failed: failures.length > 0,
		fields: [
			["Replicates", String(opts.outcomes.length), "plain"],
			["Validated replicates", `${validated}/${opts.outcomes.length}`, "plain"],
			["Failed replicates", String(failures.length), "plain"],
			[
				"Unexpected runtime users",
				unexpectedRuntimeUsers > 0
					? `${unexpectedRuntimeUsers}/${opts.outcomes.length} sandbox(es) (expected ${expectedRuntimeIdentity(opts.provider)})`
					: "",
				"plain",
			],
			// The cell's wall clock IS its slowest replicate, so that number — not the mean — is what
			// to compare against the job budget, and the spread next to it says whether one sandbox
			// dragged the cell or the whole fleet was slow.
			[
				"Slowest replicate",
				slowest ? `${replicateLabel(slowest.index)} ${formatDuration(slowest.durationMs)}` : "—",
				"plain",
			],
			[
				"Fastest replicate",
				fastest ? `${replicateLabel(fastest.index)} ${formatDuration(fastest.durationMs)}` : "—",
				"plain",
			],
		],
		tables: [{ heading: "Replicates", rows: replicateSummaryRows(opts.provider, opts.outcomes) }],
		...(detail ? { detail } : {}),
		annotationMessage: fleetAnnotationMessage(failures, opts.outcomes.length, validated),
	});
}

/** Everything one replicate needs; `replicateIndex` undefined is the single un-indexed run. */
interface ReplicateContext {
	provider: string;
	suite: string;
	runId: string;
	sha: string;
	rawRoot: string;
	outFile: string;
	indexFile: string;
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
		cellTitle(suite, provider) +
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
			const executeSuite = usesDriverSuite(provider, ctx.driverPath === true)
				? runDriverSuite
				: runSuite;
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
			logWarning(
				`Suite "${suite}" threw on ${provider} — will normalize any failed marker into a gap: ${
					err instanceof Error ? err.message : String(err)
				}`,
				{ title: cell },
			);
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
			normalizeError instanceof Error
				? normalizeError.message
				: normalizeError
					? String(normalizeError)
					: "normalize produced no Run document";
		return { ...base, failed: true, detail };
	}
	const normalized = run;

	if (suiteError) {
		const message = suiteError instanceof Error ? suiteError.message : String(suiteError);
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

if (import.meta.main) {
	const argv = process.argv.slice(2);
	// Flags that consume a separate operand — one source of truth so the discovery filter and the
	// positional-skip loop below can never enumerate different sets.
	const VALUE_FLAGS = ["--require", "--replicate", "--replicates", "--max-concurrency"];
	const discovery = handleDiscovery(argv, HELP, VALUE_FLAGS);
	if (discovery !== null) {
		if (discovery.ok) {
			process.stdout.write(`${discovery.text}\n`);
			process.exit(0);
		}
		fail(discovery.text, { properties: { title: "bench-suite discovery" }, exitCode: 2 });
	}

	// Filter flags out before positional resolution so a trailing/misplaced flag (e.g.
	// `bench-suite daytona-vm cpu-node --json`) never gets captured as the runId. The VALUE_FLAGS above
	// are the ones that take a separate operand, so consume that operand too — otherwise
	// `--require daytona-vm` would leave `daytona-vm` behind to be read as the runId.
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		// Only the space-separated spelling needs the skip: `--require=<ids>`/`--replicates=<idx>` are
		// single tokens already dropped by the leading-`-` guard below.
		if (VALUE_FLAGS.includes(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		positionals.push(arg);
	}
	const provider = positionals[0] ?? "daytona-vm";
	const suite = positionals[1] ?? "cpu-node";
	const runId = positionals[2] ?? `local-${Date.now()}`;
	const driverPath = argv.includes("--driver-path");
	const sha = process.env.GITHUB_SHA ?? "local";
	const cell = cellTitle(suite, provider);

	// A malformed replicate axis must fail the cell before a single sandbox is created: a fan-out that
	// silently collapsed to one sandbox (or to none) would publish a shard set the aggregate reads as a
	// smaller, quieter experiment than the one that was dispatched.
	let replicateIndices: number[] | undefined;
	let maxConcurrency = Number.POSITIVE_INFINITY;
	let singleReplicate: number | undefined;
	let cellBudgetMinutes: number | undefined;
	let runnerLifetimeMinutes: number | undefined;
	try {
		replicateIndices = parseReplicatesFlag(argv);
		maxConcurrency = resolveMaxConcurrency(argv);
		singleReplicate = parseReplicateFlag(argv);
		cellBudgetMinutes = resolveCellBudgetMinutes();
		runnerLifetimeMinutes = resolveRunnerLifetimeMinutes();
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err), {
			properties: { title: "bench-suite usage" },
			exitCode: 2,
		});
	}
	if (replicateIndices && singleReplicate !== undefined) {
		fail("pass either --replicates or --replicate, not both", {
			properties: { title: "bench-suite usage" },
			exitCode: 2,
		});
	}

	// A concurrency cap trades wall clock for peak provider load, and the cell has a FIXED job budget to
	// pay that clock out of — so a cap can be small enough that the fan-out is cancelled mid-flight,
	// losing every shard of the cell rather than just slowing it down. Reject that combination here,
	// alongside the other malformed-axis guards and before a single sandbox exists. An unregistered
	// suite is left alone: `describeSuiteTasks` below owns that error, and guessing a budget for a suite
	// with no declared one would report the wrong problem.
	const suiteBudget = suite in SUITES ? SUITES[suite as SuiteName].timeoutMinutes : undefined;
	if (replicateIndices && cellBudgetMinutes !== undefined && suiteBudget !== undefined) {
		const budgetError = fleetBudgetError({
			replicates: replicateIndices.length,
			maxConcurrency,
			suite,
			suiteTimeoutMinutes: suiteBudget,
			budgetMinutes: cellBudgetMinutes,
		});
		if (budgetError) {
			fail(budgetError, { properties: { title: "bench-suite usage" }, exitCode: 2 });
		}
	}

	// Same class of guard, one level lower: the JOB budget above is enforced by GitHub and ends in a
	// cancelled job with logs, whereas an ephemeral self-hosted runner is simply reaped — the cell hangs
	// `in_progress`, never reaches its upload step, and the loss has no record at all. Applies to every
	// dispatch shape (single or fan-out), because one replicate is already enough to outlive the runner.
	if (runnerLifetimeMinutes !== undefined && suiteBudget !== undefined) {
		const lifetimeError = runnerLifetimeError({
			suite,
			suiteTimeoutMinutes: suiteBudget,
			runnerLifetimeMinutes,
		});
		if (lifetimeError) {
			fail(lifetimeError, { properties: { title: "bench-suite usage" }, exitCode: 2 });
		}
	}

	// The local newest-first Run index, shared by every replicate of this cell — one entry per SHARD,
	// keyed by (runId, replicateIndex) and by the file each entry names, so a fan-out lists all R
	// sandboxes instead of the last one to normalize evicting its peers, while the single-sandbox lane
	// (which rewrites ONE un-suffixed file whatever index it was given) keeps exactly one. A local
	// convenience only (`leaderboard data/runs/<id>.json` discovery). Nothing downstream reads it: the
	// aggregate is handed explicit shard paths, and commit-dataset.yml globs the shard files by run id.
	// Writes are synchronous (writeNormalizedRun), so concurrent replicates cannot interleave a
	// read-modify-write and corrupt it.
	//
	// `data/index.json`, NOT `data/runs/index.json`: a Run index sits at the ROOT of the tree holding
	// its Runs (the same shape `aggregate` and `promote` write, and the shape RunIndex entry paths are
	// derived for). Nested inside `runs/` it could only ever emit entries the schema rejects, which
	// failed every local run at the final write — after the benchmark had already succeeded.
	const indexFile = join("data", "index.json");
	// The single-sandbox tree/shard, hoisted so the debug payload below can name them. They are the
	// diagnostic an artifact-path failure is read with — which tree the results were pulled into,
	// which file they normalized to — and on this path nothing else reports rawRoot at all.
	const singleRawRoot = join("data", "raw", runId);
	const singleOutFile = join("data", "runs", `${runId}.json`);
	// Pass the sliced argv explicitly rather than letting it default to `process.argv` (which also
	// carries the bun executable and script path), so the flag this bin parses is the flag the require
	// gate inside every replicate reads.
	const required = requiredProviders(argv);

	logInfo(`Benchmark cell ${cell}`);
	if (inActions()) {
		core.debug(
			JSON.stringify({
				provider,
				suite,
				runId,
				sha,
				replicates: replicateIndices ?? [singleReplicate ?? null],
				maxConcurrency: Number.isFinite(maxConcurrency) ? maxConcurrency : "unbounded",
				driverPath,
				// Per-mode, because a fan-out has no single pair to report: name every shard it will
				// write, so a missing artifact can be traced to the path that was expected.
				...(replicateIndices
					? { shards: replicateIndices.map((index) => replicatePaths(runId, index).outFile) }
					: { rawRoot: singleRawRoot, outFile: singleOutFile }),
				require: required,
			}),
		);
	}

	// Resolve the precise mise tasks + PTS pins ONCE before any sandbox runs, so the job summary can
	// name what this cell planned to execute (schema commands → mise task info → run_task leaves). It
	// is a property of the suite, not of a replicate, so every replicate of this cell shares it.
	let taskPlan: SuiteTaskPlan | undefined;
	await withGroup(`Discover suite tasks (${suite})`, async () => {
		try {
			taskPlan = await describeSuiteTasks(suite);
			logInfo(`commands: ${taskPlan.commands.join(" · ")}`);
			for (const task of taskPlan.tasks) {
				const pts = task.ptsProfile ? ` pts=${task.ptsProfile}` : "";
				const prefix = task.resultsPrefix ? ` prefix=${task.resultsPrefix}` : "";
				logInfo(
					`${task.role} ${task.task}${task.description ? ` — ${task.description}` : ""}${pts}${prefix}`,
				);
			}
			if (inActions()) {
				for (const metric of taskPlan.metrics) {
					core.debug(
						`metric ${metric.id} label=${metric.label}` +
							(metric.ptsTest ? ` pts.test=${metric.ptsTest}` : ""),
					);
				}
			}
		} catch (err) {
			const msg = `Could not describe suite tasks for "${suite}": ${err instanceof Error ? err.message : String(err)}`;
			logWarning(msg, { title: cell });
		}
	});

	if (replicateIndices === undefined) {
		// Single-sandbox path (local dev and an explicit `--replicate <idx>`): one shard at the
		// un-suffixed `data/runs/<runId>.json`, which commit-dataset.yml's legacy glob names directly —
		// so the filename is a contract, not the `-r<idx>` convention minus a suffix. No CI lane takes
		// this path any more: both dispatch lanes go through the reusable cell, which always passes
		// `--replicates`, so a smoke is `[0]` on the fan-out path rather than a bare single run.
		//
		// Kept as its own path rather than "the fan-out with one replicate", deliberately. The audience
		// differs, and so does the useful report: this is a human reading ONE cell, who wants the
		// whole-Run provider table (every registered provider, skipped/failed gaps split out), which a
		// fleet report has no room for — its table is one row per replicate. What the two DO share —
		// heading, cell identity, task plan, annotation wiring — is shared for real, in writeCellSummary.
		//
		// The fan-out path DOES carry one `length === 1` branch: it keeps foldable groups and skips line
		// tagging at R=1, because those exist purely to disentangle concurrent replicates and a lone one
		// has nothing to disentangle. That is the whole special case, and it is worth it — a smoke
		// dispatch lands on the fan-out path at R=1 and would otherwise read as an untagged-problem's
		// tagged transcript. The summary shape is deliberately NOT special-cased back: a required
		// provider that skipped still names its gaps verbatim in the fleet failure detail and the
		// annotation, which is the diagnostic that actually matters when a cell produces nothing.
		const outcome = await runReplicate({
			provider,
			suite,
			runId,
			sha,
			rawRoot: singleRawRoot,
			outFile: singleOutFile,
			indexFile,
			...(singleReplicate !== undefined ? { replicateIndex: singleReplicate } : {}),
			driverPath,
			required,
		});
		await reportCell({
			provider,
			suite,
			runId,
			sha,
			outFile: outcome.outFile,
			...(outcome.run ? { run: outcome.run } : {}),
			failed: outcome.failed,
			durationMs: outcome.durationMs,
			...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
			...(taskPlan ? { taskPlan } : {}),
		});
		if (outcome.failed) {
			await shutdownOwnedSandboxes();
			fail(outcome.detail ?? `Cell ${cell} failed`, { annotate: false });
		}
		await exitAfterSandboxCleanup(0);
	}
	if (replicateIndices === undefined) throw new Error("unreachable after sandbox cleanup exit");

	// Fan-out path: R replicate sandboxes, all from this process. Foldable groups are turned off and
	// every line is tagged with its replicate instead — Actions groups are a single ordered stream, so
	// R concurrent replicates opening and closing them produces folds containing other replicates'
	// output. The tag is what keeps an interleaved 12-way transcript attributable.
	//
	// Neither applies at R=1: one replicate cannot interleave with itself, so turning groups off and
	// tagging every line would cost a readable transcript to solve a problem that doesn't exist. This
	// is not hypothetical tidiness — bench-smoke.yml reaches this path with `--replicates "[0]"` (the
	// reusable cell always passes the flag), so the lane whose whole output is read by a human would
	// otherwise lose its foldable sections to a fan-out concern it never has.
	if (replicateIndices.length > 1) {
		setGroupingEnabled(false);
		installLineTagging();
	}
	logInfo(
		`Driving ${replicateIndices.length} replicate sandbox(es) [${replicateIndices.join(", ")}] ` +
			`for ${cell}` +
			(Number.isFinite(maxConcurrency) ? ` (max ${maxConcurrency} in flight)` : ""),
	);

	// When each replicate started, so the pool's error backstop can still report a duration for one
	// that threw before runReplicate could time itself. Written at dispatch, not at queue time: under
	// a --max-concurrency cap a later wave's replicate waits, and charging it that queue time would
	// misreport it as the straggler.
	const startedAt = new Map<number, number>();
	const outcomes = await runPooled(
		replicateIndices,
		maxConcurrency,
		async (replicateIndex) => {
			startedAt.set(replicateIndex, Bun.nanoseconds());
			const paths = replicatePaths(runId, replicateIndex);
			return withLineTag(`[${replicateLabel(replicateIndex)}] `, () =>
				runReplicate({
					provider,
					suite,
					runId,
					sha,
					rawRoot: paths.rawRoot,
					outFile: paths.outFile,
					indexFile,
					replicateIndex,
					driverPath,
					required,
				}),
			);
		},
		// runReplicate is written to be total, but this is the backstop that makes that irrelevant: an
		// unexpected throw becomes THIS replicate's failure instead of unwinding the pool and stranding
		// its peers mid-suite with no report written. The peers keep running, every shard that can be
		// written still is, and reportFleet names the thrower.
		(error, replicateIndex) => ({
			index: replicateIndex,
			outFile: replicatePaths(runId, replicateIndex).outFile,
			failed: true,
			durationMs: Math.round(
				(Bun.nanoseconds() - (startedAt.get(replicateIndex) ?? Bun.nanoseconds())) / 1e6,
			),
			detail: `replicate threw outside the reporting path: ${
				error instanceof Error ? (error.stack ?? error.message) : String(error)
			}`,
		}),
	);

	await reportFleet({
		provider,
		suite,
		runId,
		sha,
		outcomes,
		...(taskPlan ? { taskPlan } : {}),
	});

	const failures = outcomes.filter((o) => o.failed);
	if (failures.length > 0) {
		// reportFleet already annotated with every failure's detail; exit non-zero without a second one.
		await shutdownOwnedSandboxes();
		fail(`${failures.length}/${outcomes.length} replicate(s) of ${cell} failed`, {
			annotate: false,
		});
	}
	logInfo(`Cell ${cell}: ${outcomes.length}/${outcomes.length} replicate(s) succeeded`);
	// Exit explicitly, matching the single-sandbox path above. The bounded ownership drain waits for a
	// late create long enough to destroy it without letting a wedged provider keep the cell alive forever.
	await exitAfterSandboxCleanup(0);
}
