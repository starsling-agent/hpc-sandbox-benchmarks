import { evidenceDigest, verifyExperimentPlan } from "@sandbox-benchmarks/results";
import type { ExperimentCell, ExperimentPlan } from "@sandbox-benchmarks/schema";
import { experimentCellSchema } from "@sandbox-benchmarks/schema";

export interface AccountCapacity {
	sandboxes: number;
	vcpus?: number;
	memoryGb?: number;
	gpus?: number;
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
	const batches: ExperimentPlan["batches"] = [];
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
		const budgetMinutes = cell.startupMinutes + cell.workloadMinutes + cell.finishMinutes + 15;
		if (budgetMinutes > 180) throw new Error(`replicate cannot fit a 180-minute job: ${cell.id}`);
		// A batch is one simultaneous wave of identical requests. Never hide serial waves in a job.
		const previous = batches.at(-1);
		const first = cells.find((entry) => entry.id === previous?.cells[0]);
		if (
			previous &&
			first &&
			previous.quotaDomain === cell.quotaDomain &&
			previous.cells.length < cap &&
			first.provider === cell.provider &&
			first.suite === cell.suite &&
			evidenceDigest({ ...first, id: "", replicate: 0 }) ===
				evidenceDigest({ ...cell, id: "", replicate: 0 })
		) {
			previous.cells.push(cell.id);
		} else {
			batches.push({
				id: `batch-${batches.length}`,
				quotaDomain: cell.quotaDomain,
				cells: [cell.id],
				maxConcurrency: cap,
				budgetMinutes,
			});
		}
	}
	const rounds: ExperimentPlan["rounds"] = [];
	for (const quotaDomain of new Set(cells.map((cell) => cell.quotaDomain))) {
		const domainBatches = batches.filter((batch) => batch.quotaDomain === quotaDomain);
		for (let offset = 0; offset < domainBatches.length; offset += 256)
			rounds.push({
				id: `round-${rounds.length}`,
				quotaDomain,
				batches: domainBatches.slice(offset, offset + 256).map((batch) => batch.id),
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
