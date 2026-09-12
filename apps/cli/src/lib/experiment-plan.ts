import { evidenceDigest, verifyExperimentPlan } from "@sandbox-benchmarks/results";
import type { ExperimentCell, ExperimentPlan } from "@sandbox-benchmarks/schema";
import {
	BENCH_JOB_CEILING_MINUTES,
	experimentCellSchema,
	suiteWave,
} from "@sandbox-benchmarks/schema";

export interface AccountCapacity {
	sandboxes: number;
	vcpus?: number;
	memoryGb?: number;
	gpus?: number;
}

/**
 * Batches per collection round, and therefore the approval unit of a run: a round's batch jobs are
 * created together so one `privileged` approval releases them all, and they then queue on the
 * account's concurrency group. GitHub's `queue: max` holds at most 100 pending jobs per group and
 * cancels the overflow (a cancelled batch is a failed cell), so a released round must stay well under
 * that even when the sibling isolation variant and the smoke/toolchain/GPU lanes share the group.
 *
 * A wave normally plans to ONE batch per provider, so this bound only engages on the pathological
 * dispatches (a very high `--replicas` against a one-sandbox account) that cannot pool.
 */
export const ROUND_BATCH_LIMIT = 64;

// Suite workloads retain their own identities and deadlines inside a concurrent wave.
function allocationIdentity(cell: ExperimentCell): string {
	return evidenceDigest({
		provider: cell.provider,
		quotaDomain: cell.quotaDomain,
		target: cell.target,
		gpu: cell.gpu ?? null,
		artifactIdentity: cell.artifactIdentity,
		environmentRevision: cell.environmentRevision,
		startupMinutes: cell.startupMinutes,
	});
}

/** The job budget one cell reserves: its own lifetime plus the host margin charged per generation. */
function cellBudgetMinutes(cell: ExperimentCell): number {
	return cell.startupMinutes + cell.workloadMinutes + cell.finishMinutes + 15;
}

/**
 * The batch key: cells share a job only when they share an account, a provider, a wave, and an
 * allocation identity.
 *
 * The wave is part of the key so a job is never half synthetic and half real-world. Packing purely by
 * cell count (what run 34672199543 did) filled a provider's first batch with every synthetic cell plus
 * whatever real-world replicates still fit under the cap, which made both of that provider's batches
 * report suite `mixed`: indistinguishable in the job list, in the artifact names, and — because the
 * Namespace token mint is named after the suite — indistinguishable to the credential API, which
 * refused the second mint as `AlreadyExists` and failed every cell behind it.
 */
function batchKey(cell: ExperimentCell): string {
	return [cell.quotaDomain, cell.provider, suiteWave(cell.suite), allocationIdentity(cell)].join(
		"\u0000",
	);
}

/** Pure admission planning. No credential reads, remote calls, or implicit wall-clock input. */
export function planExperiment(
	request: {
		id: string;
		sha: string;
		createdOn: string;
		cells: readonly ExperimentCell[];
		maxPremeasurementRetries?: number;
	},
	policy: Readonly<Record<string, AccountCapacity>> = {},
): ExperimentPlan {
	const cells = request.cells.map((cell) => experimentCellSchema.assert(structuredClone(cell)));
	// Group first, batch second. Plan order is preserved inside a group (provider, then registry suite
	// order, then replicate), so the frozen batch of a given dispatch is reproducible and the heaviest
	// suite of a wave — the one that sets the pool's tail — starts in the first generation.
	const groups = new Map<string, { cap: number; cells: ExperimentCell[] }>();
	for (const cell of cells) {
		if (cell.metrics.every((metric) => cell.exclusions.some((entry) => entry.metricId === metric)))
			continue;
		const capacity = policy[cell.quotaDomain] ?? { sandboxes: 1 };
		if (
			!Number.isSafeInteger(capacity.sandboxes) ||
			capacity.sandboxes < 1 ||
			(capacity.vcpus !== undefined && (!Number.isFinite(capacity.vcpus) || capacity.vcpus <= 0)) ||
			(capacity.memoryGb !== undefined &&
				(!Number.isFinite(capacity.memoryGb) || capacity.memoryGb <= 0))
		) {
			throw new Error(`invalid account capacity: ${cell.quotaDomain}`);
		}
		const cap = Math.min(
			capacity.sandboxes,
			Math.floor((capacity.vcpus ?? Infinity) / cell.target.vcpus),
			Math.floor((capacity.memoryGb ?? Infinity) / cell.target.memoryGb),
			cell.gpu ? Math.floor((capacity.gpus ?? 0) / cell.gpu.count) : Infinity,
		);
		if (cap < 1) throw new Error(`target exceeds account capacity: ${cell.id}`);
		if (cellBudgetMinutes(cell) > BENCH_JOB_CEILING_MINUTES)
			throw new Error(`replicate cannot fit a ${BENCH_JOB_CEILING_MINUTES}-minute job: ${cell.id}`);
		const key = batchKey(cell);
		const group = groups.get(key) ?? { cap, cells: [] };
		group.cap = Math.min(group.cap, cap);
		group.cells.push(cell);
		groups.set(key, group);
	}
	const batches: ExperimentPlan["batches"] = [];
	for (const group of groups.values()) {
		const budget = Math.max(...group.cells.map(cellBudgetMinutes));
		// Generations the whole group needs, against the generations one job can afford. A provider's
		// wave normally lands in ONE batch — the pool refills a slot the moment a replicate finishes, so
		// the shorter suites of a wave stop leaving account capacity idle behind the longest one. Only a
		// dispatch whose replicate count dwarfs its account cap cannot be held that way, and it falls
		// back to single-generation batches rather than to a job that could not finish: serial waves are
		// planned deliberately, here, or not at all.
		const needed = Math.ceil(group.cells.length / group.cap);
		const affordable = Math.floor(BENCH_JOB_CEILING_MINUTES / budget);
		const size = needed <= affordable ? group.cells.length : group.cap;
		for (let offset = 0; offset < group.cells.length; offset += size) {
			const members = group.cells.slice(offset, offset + size);
			const maxConcurrency = Math.min(group.cap, members.length);
			batches.push({
				id: `batch-${batches.length}`,
				quotaDomain: members[0]?.quotaDomain ?? "",
				cells: members.map((cell) => cell.id),
				maxConcurrency,
				budgetMinutes: Math.ceil(members.length / maxConcurrency) * budget,
			});
		}
	}
	const rounds: ExperimentPlan["rounds"] = [];
	for (const quotaDomain of new Set(cells.map((cell) => cell.quotaDomain))) {
		const domainBatches = batches.filter((batch) => batch.quotaDomain === quotaDomain);
		for (let offset = 0; offset < domainBatches.length; offset += ROUND_BATCH_LIMIT)
			rounds.push({
				id: `round-${rounds.length}`,
				quotaDomain,
				batches: domainBatches.slice(offset, offset + ROUND_BATCH_LIMIT).map((batch) => batch.id),
			});
	}
	const accounts = [...new Set(cells.map((cell) => cell.quotaDomain))].map((quotaDomain) => ({
		quotaDomain,
		...(policy[quotaDomain] ?? { sandboxes: 1 }),
	}));
	const body = {
		schemaVersion: "1" as const,
		...request,
		cells,
		batches,
		accounts,
		rounds,
		retryPolicy: "premeasurement-only" as const,
		maxPremeasurementRetries: request.maxPremeasurementRetries ?? 0,
	};
	return verifyExperimentPlan({ ...body, digest: evidenceDigest(body) });
}
