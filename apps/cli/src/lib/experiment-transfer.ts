import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExperimentPlan } from "@sandbox-benchmarks/schema";
import type { AccountJournal } from "./account-journal.ts";
import {
	readExperimentAttempt,
	readExperimentPlan,
	writeImmutableJson,
} from "./experiment-artifacts.ts";
import type { ExperimentStore } from "./experiment-store.ts";

export async function downloadExperimentPlan(
	store: ExperimentStore,
	id: string,
	root: string,
): Promise<ExperimentPlan> {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("invalid experiment identity");
	const artifacts = (await store.list({ name: `experiment-plan-${id}` })).filter(
		(entry) => entry.name === `experiment-plan-${id}`,
	);
	if (artifacts.length !== 1 || !artifacts[0])
		throw new Error("one immutable experiment plan is required");
	prepareDownloadDirectory(root);
	await store.download(artifacts[0], root);
	const plan = readExperimentPlan(join(root, "plan.json"));
	if (plan.id !== id || String(artifacts[0].workflow_run.id) !== id)
		throw new Error("plan artifact workflow provenance mismatch");
	return plan;
}

/** Recover every attempt, including launch intents whose worker disappeared before terminal upload. */
export async function downloadExperimentAttempts(
	store: ExperimentStore,
	journal: AccountJournal,
	plan: ExperimentPlan,
	root: string,
): Promise<void> {
	prepareDownloadDirectory(root);
	const terminals = new Map<string, ReturnType<typeof readExperimentAttempt>>();
	for (const artifact of await store.list({ prefix: `experiment-attempt-${plan.id}-` })) {
		const directory = join(root, String(artifact.id));
		await store.download(artifact, directory);
		const attempt = readExperimentAttempt(directory);
		const { evidence } = attempt;
		if (
			evidence.planDigest !== plan.digest ||
			artifact.name !== `experiment-attempt-${plan.id}-${evidence.id}` ||
			String(artifact.workflow_run.id) !== plan.id ||
			terminals.has(evidence.id)
		)
			throw new Error("attempt artifact provenance conflict");
		terminals.set(evidence.id, attempt);
	}
	for (const account of plan.accounts) {
		const records = await journal.read(account.quotaDomain);
		for (const attempt of terminals.values()) {
			const cell = plan.cells.find((cell) => cell.id === attempt.evidence.cellId);
			if (cell?.quotaDomain !== account.quotaDomain || attempt.evidence.outcome !== "completed")
				continue;
			const owned = records.filter((record) => record.attempt === attempt.evidence.id);
			const intent = owned.find((record) => record.kind === "intent");
			const allocated = owned.find((record) => record.kind === "allocated");
			const released = owned.find((record) => record.kind === "released");
			if (
				owned.length !== 3 ||
				!intent ||
				!allocated ||
				!released ||
				released.outcome !== "absent" ||
				owned.some(
					(record) =>
						record.planDigest !== plan.digest ||
						record.cellId !== cell.id ||
						record.account !== cell.quotaDomain,
				) ||
				allocated.ref.id !== released.ref.id ||
				allocated.ref.provider !== released.ref.provider ||
				allocated.ref.provider !== cell.provider ||
				allocated.ref.id !== attempt.execution?.sandboxId
			)
				throw new Error("completed attempt lacks durable allocation and release evidence");
		}

		for (const record of records.filter(
			(record) => record.kind === "intent" && record.planDigest === plan.digest,
		)) {
			if (terminals.has(record.attempt)) continue;
			const directory = join(root, `interrupted-${record.attempt}`);
			mkdirSync(directory, { recursive: true });
			writeImmutableJson(join(directory, "intent.json"), record);
		}
	}
}

/** A download must never inherit evidence from an earlier collection or partial extraction. */
function prepareDownloadDirectory(root: string): void {
	mkdirSync(root, { recursive: true });
	if (lstatSync(root).isSymbolicLink() || readdirSync(root).length !== 0)
		throw new Error("artifact download requires an empty regular directory");
}
