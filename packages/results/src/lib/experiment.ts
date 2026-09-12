import { createHash } from "node:crypto";
import type {
	CleanupReceipt,
	ExecutionReceipt,
	ExperimentAttempt,
	ExperimentPlan,
	Run,
} from "@sandbox-benchmarks/schema";
import {
	artifactVerified,
	BENCH_JOB_CEILING_MINUTES,
	canonicalJsonString,
	cleanupReceiptSchema,
	effectiveArtifact,
	executionReceiptSchema,
	experimentAttemptSchema,
	experimentPlanSchema,
	getProvider,
	parseRun,
	providerReportedNothing,
} from "@sandbox-benchmarks/schema";
import { aggregateRuns } from "./aggregate.ts";

export function evidenceDigest(value: unknown): string {
	// Full experiment/Run envelopes are larger than individual vendor response diagnostics.
	return `sha256:${createHash("sha256")
		.update(
			canonicalJsonString(value, {
				maxBytes: 32 * 1024 * 1024,
				maxDepth: 64,
				maxNodes: 1_000_000,
				maxArrayLength: 100_000,
				maxObjectKeys: 10_000,
				maxStringLength: 1024 * 1024,
				maxKeyLength: 1024,
			}),
		)
		.digest("hex")}`;
}

export function verifyExperimentPlan(value: unknown): ExperimentPlan {
	const plan = experimentPlanSchema.assert(value);
	const { digest, ...body } = plan;
	if (evidenceDigest(body) !== digest) throw new Error("experiment plan digest mismatch");
	const validDate = (date: string) => {
		const parsed = new Date(`${date}T00:00:00Z`);
		return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
	};
	if (!validDate(plan.createdOn)) throw new Error("invalid experiment creation date");
	const cells = new Map(plan.cells.map((cell) => [cell.id, cell]));
	const quotaDomains = new Map<string, string>();
	for (const cell of plan.cells) {
		if (evidenceDigest(cell.target) !== evidenceDigest(plan.cells[0]?.target))
			throw new Error("a published experiment requires one target resource specification");
		const vendor = getProvider(cell.provider).vendor;
		if (quotaDomains.has(vendor) && quotaDomains.get(vendor) !== cell.quotaDomain)
			throw new Error(`shared provider credentials require one quota domain: ${vendor}`);
		quotaDomains.set(vendor, cell.quotaDomain);
	}
	if (cells.size !== plan.cells.length) throw new Error("duplicate experiment cell");
	const logical = new Set(
		plan.cells.map((cell) => `${cell.provider}/${cell.suite}/${cell.replicate}`),
	);
	if (logical.size !== cells.size) throw new Error("duplicate logical replicate");
	const assigned = new Set<string>();
	const eligibleCells = plan.cells.filter((cell) =>
		cell.metrics.some((metric) => !cell.exclusions.some((entry) => entry.metricId === metric)),
	);
	if (eligibleCells.length === 0) throw new Error("experiment has no eligible work");
	const accounts = new Map(plan.accounts.map((account) => [account.quotaDomain, account]));
	if (accounts.size !== plan.accounts.length) throw new Error("duplicate quota domain");
	const batchIds = new Set<string>();
	for (const batch of plan.batches) {
		const account = accounts.get(batch.quotaDomain);
		// A batch is a POOL of at most `maxConcurrency` simultaneous allocations, not a single
		// simultaneous wave: a wave holding more replicates than the account may run at once refills
		// freed slots inside the same job. What must hold is that the pool never exceeds the account's
		// admission and that the job's declared budget covers every generation it will have to run —
		// serial waves are accounted for here rather than hidden.
		if (
			!account ||
			batch.maxConcurrency > account.sandboxes ||
			batch.budgetMinutes > BENCH_JOB_CEILING_MINUTES
		) {
			throw new Error(`invalid account batch capacity: ${batch.id}`);
		}
		if (batchIds.has(batch.id)) throw new Error("duplicate experiment batch");
		batchIds.add(batch.id);
		for (const id of batch.cells) {
			const cell = cells.get(id);
			if (
				!cell ||
				!eligibleCells.includes(cell) ||
				assigned.has(id) ||
				cell.quotaDomain !== batch.quotaDomain
			) {
				throw new Error(`invalid batch assignment: ${id}`);
			}
			assigned.add(id);
		}
		const members = batch.cells.map((id) => cells.get(id)).filter((cell) => cell !== undefined);
		// Peak occupancy, not the batch total: only `maxConcurrency` members hold resources at once, so
		// the account's vCPU/memory/GPU allowances are charged against the largest member that many
		// times. For a single-generation batch this is the old whole-batch sum or stricter, never looser.
		const peak = (claim: (cell: (typeof members)[number]) => number): number =>
			batch.maxConcurrency * Math.max(0, ...members.map(claim));
		const cellBudget = (cell: (typeof members)[number]): number =>
			cell.startupMinutes + cell.workloadMinutes + cell.finishMinutes + 15;
		const generations = Math.ceil(members.length / batch.maxConcurrency);
		if (
			peak((cell) => cell.gpu?.count ?? 0) > (account.gpus ?? 0) ||
			peak((cell) => cell.target.vcpus) > (account.vcpus ?? Infinity) ||
			peak((cell) => cell.target.memoryGb) > (account.memoryGb ?? Infinity) ||
			generations * Math.max(0, ...members.map(cellBudget)) > batch.budgetMinutes
		) {
			throw new Error(`batch exceeds resource or time budget: ${batch.id}`);
		}
	}
	if (assigned.size !== eligibleCells.length)
		throw new Error("experiment cells missing from batches");
	const scheduled = new Set<string>();
	const roundIds = new Set<string>();
	for (const round of plan.rounds) {
		if (roundIds.has(round.id) || round.batches.length > 256)
			throw new Error(`invalid collection round: ${round.id}`);
		roundIds.add(round.id);
		for (const id of round.batches) {
			const batch = plan.batches.find((entry) => entry.id === id);
			if (!batch || batch.quotaDomain !== round.quotaDomain || scheduled.has(id))
				throw new Error(`invalid round assignment: ${id}`);
			scheduled.add(id);
		}
	}
	if (scheduled.size !== plan.batches.length)
		throw new Error("batches missing from collection rounds");
	const cohorts = new Map<string, string>();
	for (const cell of cells.values()) {
		const cohort = cell.suite;
		const eligibility = evidenceDigest({
			workloadRevision: cell.workloadRevision,
			metrics: cell.metrics.toSorted(),
			exclusions: cell.exclusions.toSorted((a, b) => a.metricId.localeCompare(b.metricId)),
			environmentRevision: cell.environmentRevision,
			passes: cell.passes,
		});
		if (cohorts.has(cohort) && cohorts.get(cohort) !== eligibility)
			throw new Error(`inconsistent comparison cohort: ${cohort}`);
		cohorts.set(cohort, eligibility);
		if (new Set(cell.metrics).size !== cell.metrics.length)
			throw new Error("duplicate required metric");
		const excluded = new Set<string>();
		for (const exclusion of cell.exclusions) {
			if (
				!validDate(exclusion.expires) ||
				exclusion.workloadRevision !== cell.workloadRevision ||
				!cell.metrics.includes(exclusion.metricId) ||
				exclusion.expires <= plan.createdOn ||
				excluded.has(exclusion.metricId)
			) {
				throw new Error(`invalid or expired exclusion: ${cell.id}/${exclusion.metricId}`);
			}
			excluded.add(exclusion.metricId);
		}
	}
	return plan;
}

export interface AttemptWithRun {
	evidence: ExperimentAttempt;
	run?: Run;
	execution?: ExecutionReceipt;
	cleanup?: CleanupReceipt;
}

export interface CoverageReport {
	planDigest: string;
	complete: boolean;
	selectedAttempts: string[];
	cells: Array<{
		id: string;
		status: "complete" | "missing" | "failed" | "cancelled" | "excluded";
		missingMetrics: string[];
		excludedMetrics: string[];
	}>;
	conflicts: string[];
}

/**
 * The harness logs one entry per ATTEMPT of a step (retried setup steps, re-collected results), so
 * a step is judged by its final attempt: an earlier failure that a later attempt superseded is
 * evidence of a retry, not of a failed run. Keyed by phase + label because the same label can name
 * different work in different phases.
 */
function finalAttempts<T extends { phase: string; label: string }>(entries: readonly T[]): T[] {
	return [...new Map(entries.map((entry) => [`${entry.phase}\0${entry.label}`, entry])).values()];
}

/** A step succeeded, or was declared tolerant of failure AND actually reported an exit code — the
 *  tolerance covers a non-zero exit, never a step whose completion was not observed. */
function stepAccepted(step: { exitCode: number | null; allowFailure?: boolean }): boolean {
	return step.exitCode === 0 || (step.allowFailure === true && step.exitCode !== null);
}

/** Evaluate whole attempts against the frozen denominator. Artifact order never selects a sample. */
export function evaluateExperiment(
	input: unknown,
	attempts: readonly AttemptWithRun[],
): CoverageReport {
	const plan = verifyExperimentPlan(input);
	const report: CoverageReport = {
		planDigest: plan.digest,
		complete: false,
		selectedAttempts: [],
		cells: [],
		conflicts: [],
	};
	const ids = new Set<string>();
	const knownCells = new Set(plan.cells.map((cell) => cell.id));
	for (const { evidence: raw, run } of attempts.toSorted((a, b) =>
		a.evidence.id.localeCompare(b.evidence.id),
	)) {
		const evidence = experimentAttemptSchema.assert(raw);
		if (run) parseRun(run);
		if (ids.has(evidence.id)) report.conflicts.push(`duplicate attempt: ${evidence.id}`);
		ids.add(evidence.id);
		if (
			!knownCells.has(evidence.cellId) ||
			evidence.workflowRun !== plan.id ||
			evidence.planDigest !== plan.digest ||
			evidence.sha !== plan.sha
		) {
			report.conflicts.push(`attempt provenance mismatch: ${evidence.id}`);
		}
		const cell = plan.cells.find((entry) => entry.id === evidence.cellId);
		if (
			cell &&
			(evidence.workloadRevision !== cell.workloadRevision ||
				evidence.environmentRevision !== cell.environmentRevision ||
				evidence.artifactIdentity !== cell.artifactIdentity ||
				evidence.passes !== cell.passes)
		) {
			report.conflicts.push(`attempt execution policy mismatch: ${evidence.id}`);
		}
		if (
			run &&
			(!cell ||
				run.sha !== plan.sha ||
				run.runId !== plan.id ||
				evidenceDigest(run.targetSpec) !== evidenceDigest(cell?.target) ||
				evidenceDigest(run) !== evidence.runDigest)
		) {
			report.conflicts.push(`attempt shard mismatch: ${evidence.id}`);
		}
	}
	for (const cell of plan.cells) {
		const lineage = attempts
			.filter(({ evidence }) => evidence.cellId === cell.id)
			.toSorted(
				(a, b) =>
					a.evidence.sequence - b.evidence.sequence || a.evidence.id.localeCompare(b.evidence.id),
			);
		const excludedMetrics = cell.exclusions.map((exclusion) => exclusion.metricId);
		const eligible = cell.metrics.filter((id) => !excludedMetrics.includes(id));
		if (eligible.length === 0) {
			if (lineage.length > 0)
				report.conflicts.push(`unexpected execution of excluded cell: ${cell.id}`);
			report.cells.push({ id: cell.id, status: "excluded", missingMetrics: [], excludedMetrics });
			continue;
		}
		let validLineage = lineage.length <= plan.maxPremeasurementRetries + 1;
		for (let index = 0; index < lineage.length; index++) {
			const current = lineage[index]?.evidence;
			const previous = lineage[index - 1]?.evidence;
			if (
				!current ||
				current.sequence !== index ||
				(previous
					? current.previousAttempt !== previous.id ||
						previous.outcome !== "failed" ||
						previous.measurementStarted ||
						!previous.retryable ||
						previous.cleanup === "unresolved"
					: current.previousAttempt !== undefined)
			)
				validLineage = false;
		}
		if (!validLineage) report.conflicts.push(`unauthorized retry lineage: ${cell.id}`);
		const selected = lineage.at(-1);
		const provider = selected?.run?.providers.find((entry) => entry.providerId === cell.provider);
		const artifact = provider?.artifactEvidence?.find(
			(entry) => entry.cell.suite === cell.suite && entry.cell.replicateIndex === cell.replicate,
		);
		const measured = new Set(provider?.metrics.map((metric) => metric.metricId) ?? []);
		const missingMetrics = eligible.filter((id) => !measured.has(id));
		const evidence = selected?.evidence;
		const execution = selected?.execution && executionReceiptSchema.assert(selected.execution);
		const cleanup = selected?.cleanup && cleanupReceiptSchema.assert(selected.cleanup);
		const receiptsConfirmSuccess =
			execution !== undefined &&
			cleanup !== undefined &&
			execution.runId === plan.id &&
			execution.provider === cell.provider &&
			execution.suite === cell.suite &&
			execution.replicateIndex === cell.replicate &&
			cleanup.executionId === execution.executionId &&
			cleanup.completed &&
			cleanup.confirmedAbsent &&
			execution.primaryFailure === null &&
			execution.steps.some((step) => step.phase === "benchmark") &&
			execution.steps.some((step) => step.phase === "collect") &&
			finalAttempts(execution.steps).every(stepAccepted) &&
			finalAttempts(execution.detached).every(
				(step) => step.state === "completed" && stepAccepted(step),
			) &&
			artifact?.sandboxId === execution.sandboxId;
		const completed =
			receiptsConfirmSuccess &&
			evidence?.outcome === "completed" &&
			evidence.completion === "known-success" &&
			evidence.measurementStarted &&
			evidence.cleanup === "confirmed" &&
			evidence.rawDigest !== undefined &&
			selected?.run?.providers.every(
				(entry) => entry.providerId === cell.provider || providerReportedNothing(entry),
			) &&
			artifact !== undefined &&
			// Stock boots have no artifact to verify, matching driver conformance. Named
			// artifacts still require observed attribution, never the request alone.
			(artifact.provenance.requested.kind === "none" || artifactVerified(artifact)) &&
			evidenceDigest(effectiveArtifact(artifact.provenance)) === cell.artifactIdentity &&
			selected?.run?.replicateIndex === cell.replicate &&
			provider?.suitesCovered.includes(cell.suite) &&
			missingMetrics.length === 0 &&
			!provider.gaps.some((gap) => {
				if (gap.scope !== "suite" || gap.id !== cell.suite) return true;
				return (
					gap.cause?.kind !== "metrics-unrecorded" ||
					gap.cause.metricIds.some((id) => !excludedMetrics.includes(id))
				);
			});
		const status = !selected
			? "missing"
			: completed && validLineage
				? "complete"
				: evidence?.outcome === "cancelled"
					? "cancelled"
					: "failed";
		report.cells.push({ id: cell.id, status, missingMetrics, excludedMetrics });
		if (status === "complete" && evidence) report.selectedAttempts.push(evidence.id);
	}
	report.complete =
		report.conflicts.length === 0 &&
		report.cells.every((cell) => cell.status === "complete" || cell.status === "excluded");
	return report;
}

export interface ExperimentAggregation {
	coverage: CoverageReport;
	/** Present only when coverage is complete: the one Run carrying verified experiment linkage. */
	run?: Run;
}

/**
 * Only this path creates a Run with verified experiment linkage. It evaluates coverage itself (a
 * caller-supplied report could not be trusted) and hands that report back, so a caller that must
 * persist coverage whether or not publication proceeds evaluates exactly once.
 */
export function aggregateExperiment(
	plan: ExperimentPlan,
	attempts: readonly AttemptWithRun[],
): ExperimentAggregation {
	const coverage = evaluateExperiment(plan, attempts);
	if (!coverage.complete) return { coverage };
	const selected = new Set(coverage.selectedAttempts);
	const runs = attempts
		.filter(({ evidence }) => selected.has(evidence.id))
		.toSorted((a, b) => a.evidence.cellId.localeCompare(b.evidence.cellId))
		.map(({ run, evidence }) => {
			if (!run || Number(run.schemaVersion) < 6)
				throw new Error("experiment publication requires artifact-attributed shards");
			const cell = plan.cells.find((entry) => entry.id === evidence.cellId);
			const eligible = new Set(
				cell?.metrics.filter((id) => !cell.exclusions.some((entry) => entry.metricId === id)),
			);
			return {
				...run,
				providers: run.providers.map((provider) => ({
					...provider,
					metrics: provider.metrics.filter((metric) => eligible.has(metric.metricId)),
				})),
			};
		});
	const merged = aggregateRuns(runs);
	const cohorts = [
		...new Map(
			plan.cells.map((cell) => [
				cell.suite,
				{
					suite: cell.suite,
					target: cell.target,
					workloadRevision: cell.workloadRevision,
					environmentRevision: cell.environmentRevision,
					passes: cell.passes,
					metrics: cell.metrics
						.filter((id) => !cell.exclusions.some((entry) => entry.metricId === id))
						.toSorted(),
				},
			]),
		).values(),
	].toSorted((a, b) => a.suite.localeCompare(b.suite));
	const run = parseRun({
		...merged,
		schemaVersion: "7",
		experiment: {
			planDigest: plan.digest,
			cohortDigest: evidenceDigest(cohorts),
			attemptIds: coverage.selectedAttempts,
		},
	});
	return { coverage, run };
}
