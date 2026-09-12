import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDigest } from "@sandbox-benchmarks/results";
import { providerIdSchema, quotaDomain, suiteNameSchema } from "@sandbox-benchmarks/schema";
import { type } from "arktype";
import type { AccountJournal } from "./account-journal.ts";
import { accountRecordSchema } from "./account-journal.ts";
import type { AccountDriver } from "./account-reconciliation.ts";
import { reconcileAccount } from "./account-reconciliation.ts";
import { readExperimentAttempt } from "./experiment-artifacts.ts";

// At this reviewed revision, this exact premeasurement failure can only occur AFTER SDK create
// returned: the intent append happens outside runReplicate, the allocation append inside create.
// New revisions persist allocation.json instead and use identity-based recovery.
export const COMPLETED_CREATE_REVISION = "b061d9f201d787e3c87045c1fe2a1db24122691e";
const failedMarker = type({
	provider: providerIdSchema,
	suite: suiteNameSchema,
	outcome: "'failed'",
	reason: "'Failed to create sandbox: account journal PATCH HTTP 422; allocation blocked'",
	cause: {
		kind: "'sandbox-create-failed'",
		detail: "'account journal PATCH HTTP 422; allocation blocked'",
	},
});

/** Explicit operator recovery under exclusive account ownership; never part of normal admission. */
export async function recoverCompletedCreate(options: {
	directory: string;
	provider: typeof providerIdSchema.infer;
	suite: typeof suiteNameSchema.infer;
	operator: string;
	drivers: readonly AccountDriver[];
	journal: AccountJournal;
	/** Recheck that the original workflow terminated and no allocating workflows can run. */
	assertQuiescent: (workflowRun: string, sourceSha: string) => Promise<void>;
	signal: AbortSignal;
}): Promise<void> {
	const { evidence, execution, cleanup } = readExperimentAttempt(options.directory);
	if (
		evidence.sha !== COMPLETED_CREATE_REVISION ||
		evidence.outcome !== "failed" ||
		evidence.measurementStarted ||
		evidence.cleanup !== "unresolved" ||
		!evidence.rawDigest ||
		!evidence.runDigest ||
		execution ||
		cleanup
	)
		throw new Error("attempt does not prove the reviewed completed-create failure");
	const marker = failedMarker.assert(
		JSON.parse(
			readFileSync(
				join(
					options.directory,
					"raw",
					options.provider,
					options.suite,
					`sandbox-${options.provider}-${options.suite}--failed.json`,
				),
				"utf8",
			),
		),
	);
	if (
		marker.provider !== options.provider ||
		marker.suite !== options.suite ||
		!evidence.cellId.startsWith(`${marker.provider}-${marker.suite}-r`)
	)
		throw new Error("recovery marker identity mismatch");
	const account = quotaDomain(options.provider);
	// This historical incident affected single-provider accounts only. Do not silently extend
	// the clearance to a quota domain whose other variants were not reconciled.
	if (
		account !== options.provider ||
		options.drivers.length !== 1 ||
		options.drivers[0]?.id !== options.provider
	)
		throw new Error("completed-create recovery requires the complete single-provider account");
	const readIntent = async () => {
		const records = (await options.journal.read(account))
			.map((r) => accountRecordSchema.assert(r))
			.filter((r) => r.attempt === evidence.id);
		const intent = records[0];
		if (
			records.length !== 1 ||
			intent?.kind !== "intent" ||
			intent.account !== account ||
			intent.cellId !== evidence.cellId ||
			intent.planDigest !== evidence.planDigest
		)
			throw new Error("recovery requires a matching unresolved intent without allocation evidence");
		return intent;
	};
	await readIntent();
	await options.assertQuiescent(evidence.workflowRun, evidence.sha);
	const reconciliation = await reconcileAccount(options.drivers, {
		timeoutMs: 180_000,
		signal: options.signal,
	});
	await options.assertQuiescent(evidence.workflowRun, evidence.sha);
	const intent = await readIntent();
	options.signal.throwIfAborted();
	await options.journal.append(
		accountRecordSchema.assert({
			...intent,
			kind: "released",
			outcome: "reconciled",
			evidence: {
				kind: "completed-create",
				sourceSha: evidence.sha,
				attemptDigest: evidenceDigest(evidence),
				workflowRun: evidence.workflowRun,
				confirmedAt: reconciliation.confirmedAt,
				operator: options.operator,
			},
		}),
	);
}
