import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId, SandboxDriver, SandboxRef } from "@sandbox-benchmarks/driver";
import type { AccountJournal, AccountRecord } from "./account-journal.ts";
import { accountRecordSchema, confirmRemoval, withinSignal } from "./account-journal.ts";
import { readExperimentAttempt } from "./experiment-artifacts.ts";

/**
 * Identity-based recovery of an allocation whose durable journal append failed.
 *
 * A create can return after the account journal rejects its `allocated` append. The harness never
 * receives that session, so no execution receipt carries the vendor identity; instead the executor
 * retains the identity-bound record in the attempt's raw tree before appending it. That retained
 * record — not an inventory sweep — is what makes the intent resolvable: ownership is released by
 * observing the removal of that exact sandbox, the same evidence the ordinary release path requires.
 *
 * Unlike the historical completed-create clearance, this recovers a known resource, so it records an
 * ordinary `released/absent` receipt rather than an audited account clearance. It remains an explicit
 * operator command under exclusive account ownership; it is never part of admission.
 */
export async function recoverAllocatedIntent(options: {
	directory: string;
	/** Opens the driver for the provider the retained allocation names, and no other. */
	openDriver: (provider: ProviderId) => Promise<SandboxDriver>;
	journal: AccountJournal;
	/** Recheck that the original workflow terminated and no allocating workflows can run. */
	assertQuiescent: (workflowRun: string, sourceSha: string) => Promise<void>;
	signal: AbortSignal;
}): Promise<SandboxRef> {
	const { evidence, execution, cleanup } = readExperimentAttempt(options.directory);
	// The journal-append failure happens before the harness owns the session: an attempt that
	// measured anything, or that produced its own receipts, is a different failure with different
	// evidence and must not be cleared here.
	if (
		evidence.outcome !== "failed" ||
		evidence.measurementStarted ||
		evidence.cleanup !== "unresolved" ||
		!evidence.rawDigest ||
		execution ||
		cleanup
	)
		throw new Error("attempt does not prove an unresolved allocation");
	const allocation = accountRecordSchema.assert(
		JSON.parse(readFileSync(join(options.directory, "raw", "allocation.json"), "utf8")),
	);
	if (
		allocation.kind !== "allocated" ||
		allocation.attempt !== evidence.id ||
		allocation.cellId !== evidence.cellId ||
		allocation.planDigest !== evidence.planDigest
	)
		throw new Error("retained allocation does not identify this attempt");
	const account = allocation.account;
	const driver = await withinSignal(options.signal, () =>
		options.openDriver(allocation.ref.provider),
	);
	if (!driver.destroyById || !driver.probes)
		throw new Error("retained allocation has no recovery driver");
	// The journal stays authoritative: recover only an intent that is still unresolved. Recovery
	// replays the append that was lost rather than skipping it — a bare `released/absent` without its
	// allocation would contradict the journal's own consistency rule and wedge admission again.
	const readRecords = async (expected: readonly AccountRecord["kind"][]) => {
		const records = (await withinSignal(options.signal, () => options.journal.read(account)))
			.map((record) => accountRecordSchema.assert(record))
			.filter((record) => record.attempt === evidence.id);
		const intent = records[0];
		if (
			records.length !== expected.length ||
			records.some((record, index) => record.kind !== expected[index]) ||
			intent?.kind !== "intent" ||
			intent.account !== account ||
			intent.cellId !== evidence.cellId ||
			intent.planDigest !== evidence.planDigest
		)
			throw new Error("recovery requires a matching unresolved intent without a release");
		return intent;
	};
	const intent = await readRecords(["intent"]);
	await options.assertQuiescent(evidence.workflowRun, evidence.sha);
	// Restoring the allocation first is what makes an interrupted recovery safe: intent+allocated is
	// the ordinary interrupted-allocation state, which admission already recovers on its own.
	await withinSignal(options.signal, () => options.journal.append(allocation));
	await confirmRemoval(driver, allocation.ref, options.signal);
	await options.assertQuiescent(evidence.workflowRun, evidence.sha);
	await readRecords(["intent", "allocated"]);
	options.signal.throwIfAborted();
	await withinSignal(options.signal, () =>
		options.journal.append(
			accountRecordSchema.assert({
				...intent,
				kind: "released",
				outcome: "absent",
				ref: allocation.ref,
			}),
		),
	);
	return allocation.ref;
}
