import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SandboxDriver, SandboxRef } from "@sandbox-benchmarks/driver";
import { describeDriverFailure, isFailedCreateCleanupError } from "@sandbox-benchmarks/driver";
import { diagnosticSecretsFromEnv } from "@sandbox-benchmarks/driver/env";
import { executeSuite } from "@sandbox-benchmarks/harness";
import {
	evaluateExperiment,
	evidenceDigest,
	verifyExperimentPlan,
} from "@sandbox-benchmarks/results";
import type {
	ExperimentAttempt,
	ExperimentPlan,
	ProviderId,
	SuiteName,
} from "@sandbox-benchmarks/schema";
import {
	experimentAttemptSchema,
	PROVIDERS,
	quotaDomain,
	SUITES,
	TARGET_SPEC,
} from "@sandbox-benchmarks/schema";
import type { AccountJournal, AccountRecord } from "./account-journal.ts";
import { recoverAccount, withinSignal } from "./account-journal.ts";
import { reconcileAccount } from "./account-reconciliation.ts";
import { logInfo } from "./actions-log.ts";
import {
	concurrentSandboxAdmissionDetail,
	isConcurrentSandboxAdmissionError,
} from "./admission-capacity.ts";
import type { OpenedDriver } from "./driver-run.ts";
import { isDriverProviderId, openDriver } from "./driver-run.ts";
import {
	rawTreeDigest,
	readAttemptReceipts,
	readExperimentAttempt,
	writeImmutableJson,
} from "./experiment-artifacts.ts";
import type { ExperimentStore } from "./experiment-store.ts";
import { runReplicate } from "./run-replicate.ts";

export interface BatchExecution {
	plan: ExperimentPlan;
	batchId: string;
	root: string;
	workflowAttempt: number;
	job: string;
	journal: AccountJournal;
	store: Pick<ExperimentStore, "upload">;
	open?: (provider: ProviderId) => Promise<OpenedDriver>;
}

/** One account-owned wave. Ownership is durable before create, and lasts through observed removal. */
export async function executeExperimentBatch(
	options: BatchExecution,
): Promise<ExperimentAttempt[]> {
	const plan = verifyExperimentPlan(options.plan);
	const batch = plan.batches.find((entry) => entry.id === options.batchId);
	if (!batch) throw new Error("batch is absent from experiment plan");
	const cells = batch.cells.map((id) => {
		const cell = plan.cells.find((entry) => entry.id === id);
		if (!cell || quotaDomain(cell.provider) !== batch.quotaDomain)
			throw new Error("batch account mismatch");
		return cell;
	});
	if (cells.length > batch.maxConcurrency) throw new Error("batch exceeds frozen concurrency");
	const account = plan.accounts.find((entry) => entry.quotaDomain === batch.quotaDomain);
	if (!account) throw new Error("batch quota domain missing from frozen account capacity");
	logInfo(
		`admission ${batch.quotaDomain}: declared sandboxes=${account.sandboxes} batchCells=${cells.length} maxConcurrency=${batch.maxConcurrency}`,
	);
	if (batch.maxConcurrency > account.sandboxes)
		throw new Error(
			`frozen batch maxConcurrency ${batch.maxConcurrency} exceeds declared sandboxes ${account.sandboxes} for ${batch.quotaDomain}`,
		);
	const startupDeadline =
		Date.now() + Math.min(...cells.map((cell) => cell.startupMinutes)) * 60_000;
	const drivers = new Map<ProviderId, OpenedDriver>();
	let admissionFailure: unknown;
	let history: readonly AccountRecord[] = [];
	const startupSignal = AbortSignal.timeout(Math.max(1, startupDeadline - Date.now()));
	try {
		for (const { id } of PROVIDERS.filter(
			(provider) => quotaDomain(provider.id) === batch.quotaDomain,
		)) {
			if (!isDriverProviderId(id) && !options.open)
				throw new Error(`${id}: managed driver admission is unavailable`);
			const opened = await withinSignal(startupSignal, () =>
				options.open
					? options.open(id)
					: isDriverProviderId(id)
						? openDriver(id)
						: Promise.reject(new Error("driver unavailable")),
			);
			if (!opened.driver.inventory || !opened.driver.destroyById || !opened.driver.probes)
				throw new Error(`${id}: managed inventory and recovery are required`);
			drivers.set(id, opened);
		}
		const recoveryMs = startupDeadline - Date.now();
		if (recoveryMs <= 0) throw new Error("startup deadline exceeded before account recovery");
		const signal = AbortSignal.timeout(recoveryMs);
		await recoverAccount(
			batch.quotaDomain,
			new Map([...drivers].map(([id, opened]) => [id, opened.driver])),
			options.journal,
			signal,
		);
		history = await withinSignal(startupSignal, () => options.journal.read(batch.quotaDomain));
		await reconcileAccount(
			[...drivers].map(([id, opened]) => ({ id, driver: opened.driver })),
			{ timeoutMs: Math.max(1, startupDeadline - Date.now()), signal },
		);
	} catch (error) {
		admissionFailure = error;
	}
	const results = await Promise.allSettled(
		cells.map(async (cell) => {
			const id = `${cell.id}-a${options.workflowAttempt}-${randomUUID()}`;
			const directory = join(options.root, id);
			const raw = join(directory, "raw");
			mkdirSync(raw, { recursive: true });
			const intent: AccountRecord = {
				version: "1",
				kind: "intent",
				account: cell.quotaDomain,
				attempt: id,
				cellId: cell.id,
				planDigest: plan.digest,
			};
			let createStarted = false;
			let createRejectedCleanly = false;
			let allocated: SandboxRef | undefined;
			let allocationRecorded = false;
			let failure = admissionFailure;
			let runDigest: string | undefined;
			try {
				if (
					history.some((record) => record.planDigest === plan.digest && record.cellId === cell.id)
				)
					throw new Error(
						"this planned cell already has an attempt; retries require an authorized lineage or a fresh experiment",
					);
				if (failure !== undefined) throw failure;
				const opened = drivers.get(cell.provider);
				if (!opened) throw new Error("driver was not admitted");
				if (!(cell.suite in SUITES)) throw new Error("suite was not admitted");
				const suite = SUITES[cell.suite as SuiteName];
				if (
					cell.gpu !== undefined ||
					evidenceDigest(opened.artifact) !== cell.artifactIdentity ||
					cell.environmentRevision !== plan.sha ||
					evidenceDigest({ sha: plan.sha, suite, passes: cell.passes }) !== cell.workloadRevision ||
					evidenceDigest(cell.target) !== evidenceDigest(TARGET_SPEC)
				)
					throw new Error("resolved execution inputs differ from frozen plan");
				if (Date.now() >= startupDeadline)
					throw new Error("startup deadline exceeded before allocation");
				await withinSignal(startupSignal, () => options.journal.append(intent));
				const driver: SandboxDriver = {
					...opened.driver,
					async create(request, createOptions) {
						createOptions?.signal?.throwIfAborted();
						if (Date.now() >= startupDeadline)
							throw new Error("startup deadline exceeded before create");
						createStarted = true;
						const session = await opened.driver.create(request, createOptions).catch((error) => {
							// Drivers throw FailedCreateCleanupError only when cleanup could not prove
							// absence. Any other create failure has already reconciled or never allocated.
							createRejectedCleanly = !isFailedCreateCleanupError(error);
							if (isConcurrentSandboxAdmissionError(error)) {
								throw new Error(
									concurrentSandboxAdmissionDetail(error, {
										quotaDomain: batch.quotaDomain,
										declaredSandboxes: account.sandboxes,
										batchConcurrency: batch.maxConcurrency,
									}),
									{ cause: error },
								);
							}
							throw error;
						});
						allocated = session.sandboxRef;
						try {
							const allocation: AccountRecord = {
								...intent,
								kind: "allocated",
								ref: session.sandboxRef,
							};
							// Preserve vendor identity for operator recovery even if the durable append fails.
							// This artifact is evidence only; it never substitutes for journal admission.
							writeImmutableJson(join(raw, "allocation.json"), allocation);
							await withinSignal(startupSignal, () => options.journal.append(allocation));
							allocationRecorded = true;
						} catch (error) {
							// The harness has not received this session yet. Retain the original journal failure.
							try {
								const signal = AbortSignal.timeout(15_000);
								await withinSignal(signal, () => session.destroy({ signal }));
							} catch {
								/* journal stays unresolved */
							}
							throw error;
						}
						return session;
					},
				};
				const outcome = await runReplicate({
					provider: cell.provider,
					suite: cell.suite,
					runId: plan.id,
					sha: plan.sha,
					rawRoot: raw,
					outFile: join(directory, "run.json"),
					replicateIndex: cell.replicate,
					required: [cell.provider],
					execute: async (runOptions) =>
						executeSuite({
							allocation: {
								module: opened.module,
								driver,
								request: { spec: cell.target, artifact: opened.artifact },
							},
							runId: plan.id,
							replicateIndex: cell.replicate,
							suiteName: cell.suite as SuiteName,
							resultsDir: runOptions.resultsDir,
							// The remaining finish allowance covers teardown, cleanup observation and cost evidence.
							managed: {
								sourceRevision: plan.sha,
								passes: cell.passes,
								startupDeadline,
								workloadMs: cell.workloadMinutes * 60_000,
								collectionMs: Math.max(1, cell.finishMinutes * 60_000 - 120_000),
							},
						}),
				});
				if (outcome.run) runDigest = evidenceDigest(outcome.run);
				if (outcome.failed) failure = new Error(outcome.detail ?? "suite failed");
			} catch (error) {
				failure = error;
			}
			let receipts: ReturnType<typeof readAttemptReceipts> = {};
			try {
				receipts = readAttemptReceipts(raw);
			} catch (error) {
				failure ??= error;
			}
			const cleanup =
				receipts.cleanup?.completed && receipts.cleanup.confirmedAbsent
					? "confirmed"
					: createStarted && !createRejectedCleanly
						? "unresolved"
						: "not-allocated";
			try {
				if (allocationRecorded && allocated && cleanup === "confirmed")
					await options.journal.append({
						...intent,
						kind: "released",
						outcome: "absent",
						ref: allocated,
					});
				// Close only intents known to have no remaining allocation; ambiguous create failures stay open.
				else if (
					(!createStarted || createRejectedCleanly) &&
					admissionFailure === undefined &&
					drivers.has(cell.provider)
				) {
					const records = await options.journal.read(cell.quotaDomain);
					if (records.some((entry) => entry.kind === "intent" && entry.attempt === id))
						await options.journal.append({ ...intent, kind: "released", outcome: "not-allocated" });
				}
			} catch (error) {
				failure ??= error;
			}
			const diagnostic =
				failure === undefined
					? undefined
					: describeDriverFailure(failure, diagnosticSecretsFromEnv(process.env));
			writeImmutableJson(join(raw, "attempt-diagnostic.json"), { diagnostic: diagnostic ?? null });
			const measurementStarted =
				!!receipts.execution?.steps.some((step) => step.phase === "benchmark") ||
				!!receipts.execution?.detached.some((step) => step.phase === "benchmark");
			const evidence = experimentAttemptSchema.assert({
				schemaVersion: "1",
				id,
				cellId: cell.id,
				planDigest: plan.digest,
				sha: plan.sha,
				workloadRevision: cell.workloadRevision,
				environmentRevision: cell.environmentRevision,
				artifactIdentity: cell.artifactIdentity,
				passes: cell.passes,
				workflowRun: plan.id,
				workflowAttempt: options.workflowAttempt,
				job: options.job,
				sequence: 0,
				outcome: failure === undefined && cleanup === "confirmed" ? "completed" : "failed",
				measurementStarted,
				retryable: false,
				cleanup,
				completion:
					failure === undefined && measurementStarted
						? "known-success"
						: receipts.execution?.steps.some(
									(step) => step.exitCode !== null && step.exitCode !== 0,
								)
							? "known-failure"
							: "unknown",
				...(runDigest ? { runDigest } : {}),
				rawDigest: rawTreeDigest(raw),
				...(diagnostic ? { diagnostic } : {}),
			});
			writeImmutableJson(join(directory, "attempt.json"), evidence);
			await withinSignal(AbortSignal.timeout(5 * 60_000), () =>
				options.store.upload(`experiment-attempt-${plan.id}-${id}`, directory),
			);
			return evidence;
		}),
	);
	const failedUpload = results.find((result) => result.status === "rejected");
	if (failedUpload?.status === "rejected") throw failedUpload.reason;
	return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

export function batchIsComplete(
	plan: ExperimentPlan,
	root: string,
	attempts: readonly ExperimentAttempt[],
): boolean {
	const report = evaluateExperiment(
		plan,
		attempts.map((attempt) => readExperimentAttempt(join(root, attempt.id))),
	);
	return (
		report.conflicts.length === 0 &&
		report.cells
			.filter((cell) => attempts.some((attempt) => attempt.cellId === cell.id))
			.every((cell) => cell.status === "complete")
	);
}
