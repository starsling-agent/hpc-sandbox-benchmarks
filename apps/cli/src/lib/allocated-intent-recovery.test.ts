import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxDriver } from "@sandbox-benchmarks/driver";
import type { ExperimentAttempt } from "@sandbox-benchmarks/schema";
import type { AccountRecord } from "./account-journal.ts";
import { recoverAccount } from "./account-journal.ts";
import { recoverAllocatedIntent } from "./allocated-intent-recovery.ts";
import { rawTreeDigest } from "./experiment-artifacts.ts";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REF = { provider: "e2b", id: "sb-orphan-1" } as const;
const PLAN_DIGEST = `sha256:${"a".repeat(64)}`;
const SHA = "b".repeat(40);

function fixture(
	overrides: {
		evidence?: Partial<ExperimentAttempt>;
		allocation?: Partial<AccountRecord> | null;
	} = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "allocated-intent-"));
	directories.push(directory);
	const raw = join(directory, "raw");
	mkdirSync(raw, { recursive: true });
	const intent: AccountRecord = {
		version: "1",
		kind: "intent",
		account: "e2b",
		attempt: "attempt-1",
		cellId: "e2b-memory-r0",
		planDigest: PLAN_DIGEST,
	};
	if (overrides.allocation !== null)
		writeFileSync(
			join(raw, "allocation.json"),
			JSON.stringify({ ...intent, kind: "allocated", ref: REF, ...overrides.allocation }),
		);
	const evidence: ExperimentAttempt = {
		schemaVersion: "1",
		id: "attempt-1",
		cellId: "e2b-memory-r0",
		planDigest: PLAN_DIGEST,
		sha: SHA,
		workloadRevision: "memory",
		environmentRevision: "env",
		artifactIdentity: "image",
		passes: 2,
		workflowRun: "4242",
		workflowAttempt: 1,
		job: "bench",
		sequence: 0,
		outcome: "failed",
		measurementStarted: false,
		retryable: false,
		cleanup: "unresolved",
		completion: "unknown",
		rawDigest: rawTreeDigest(raw),
		...overrides.evidence,
	};
	writeFileSync(join(directory, "attempt.json"), JSON.stringify(evidence));

	const records: AccountRecord[] = [intent];
	const observed: string[] = [];
	let running = true;
	const driver: SandboxDriver = {
		async destroyById() {
			observed.push("destroy");
			running = false;
		},
		probes: {
			async observe() {
				return { state: running ? "running" : "absent" };
			},
		},
	} as unknown as SandboxDriver;
	return {
		directory,
		records,
		observed,
		options: {
			directory,
			openDriver: async () => driver,
			journal: {
				async read() {
					return records;
				},
				async append(record: AccountRecord) {
					records.push(record);
				},
			},
			assertQuiescent: async () => {
				observed.push("quiescent");
			},
			signal: AbortSignal.timeout(5000),
		},
	};
}

test("releases an unresolved intent after confirming the retained allocation is gone", async () => {
	const f = fixture();
	expect(await recoverAllocatedIntent(f.options)).toEqual(REF);
	// The lost append is replayed, so the release is backed by its allocation.
	expect(f.records.at(-2)).toEqual({
		version: "1",
		kind: "allocated",
		account: "e2b",
		attempt: "attempt-1",
		cellId: "e2b-memory-r0",
		planDigest: PLAN_DIGEST,
		ref: REF,
	});
	expect(f.records.at(-1)).toEqual({
		version: "1",
		kind: "released",
		account: "e2b",
		attempt: "attempt-1",
		cellId: "e2b-memory-r0",
		planDigest: PLAN_DIGEST,
		outcome: "absent",
		ref: REF,
	});
	// Quiescence is rechecked after removal, and the sandbox is actually destroyed.
	expect(f.observed).toEqual(["quiescent", "destroy", "quiescent"]);
	// The account is admissible again.
	await recoverAccount(
		"e2b",
		new Map([
			[
				"e2b",
				{
					destroyById: async () => {},
					probes: { observe: async () => ({ state: "absent" }) },
				} as unknown as SandboxDriver,
			],
		]),
		f.options.journal,
		AbortSignal.timeout(1000),
	);
});

test("refuses an attempt whose measurement started", async () => {
	const f = fixture({ evidence: { measurementStarted: true } });
	expect(recoverAllocatedIntent(f.options)).rejects.toThrow(
		"attempt does not prove an unresolved allocation",
	);
});

test("refuses an attempt whose cleanup was already confirmed", async () => {
	const f = fixture({ evidence: { cleanup: "confirmed" } });
	expect(recoverAllocatedIntent(f.options)).rejects.toThrow(
		"attempt does not prove an unresolved allocation",
	);
});

test("refuses a retained allocation belonging to another attempt", async () => {
	const f = fixture({ allocation: { attempt: "attempt-2" } });
	expect(recoverAllocatedIntent(f.options)).rejects.toThrow(
		"retained allocation does not identify this attempt",
	);
});

test("refuses when the journal already resolved the intent", async () => {
	const f = fixture();
	f.records.push({
		version: "1",
		kind: "allocated",
		account: "e2b",
		attempt: "attempt-1",
		cellId: "e2b-memory-r0",
		planDigest: PLAN_DIGEST,
		ref: REF,
	});
	f.records.push({
		version: "1",
		kind: "released",
		account: "e2b",
		attempt: "attempt-1",
		cellId: "e2b-memory-r0",
		planDigest: PLAN_DIGEST,
		outcome: "absent",
		ref: REF,
	});
	expect(recoverAllocatedIntent(f.options)).rejects.toThrow(
		"recovery requires a matching unresolved intent without a release",
	);
});

test("does not release ownership when quiescence fails", async () => {
	const f = fixture();
	expect(
		recoverAllocatedIntent({
			...f.options,
			assertQuiescent: async () => {
				throw new Error("repository has in_progress workflows; stop writers before recovery");
			},
		}),
	).rejects.toThrow("stop writers before recovery");
	expect(f.records).toHaveLength(1);
});

test("an interrupted recovery leaves the ordinary interrupted-allocation state", async () => {
	const f = fixture();
	// Recovery dies after replaying the allocation but before releasing it.
	expect(
		recoverAllocatedIntent({
			...f.options,
			assertQuiescent: async () => {
				if (f.records.some((record) => record.kind === "allocated")) throw new Error("worker lost");
			},
		}),
	).rejects.toThrow("worker lost");
	await Bun.sleep(10);
	expect(f.records.map((record) => record.kind)).toEqual(["intent", "allocated"]);
	// Admission recovers that state on its own, with no operator command at all.
	const driver = {
		destroyById: async () => {},
		probes: { observe: async () => ({ state: "absent" }) },
	} as unknown as SandboxDriver;
	await recoverAccount(
		"e2b",
		new Map([["e2b", driver]]),
		f.options.journal,
		AbortSignal.timeout(1000),
	);
	expect(f.records.map((record) => record.kind)).toEqual(["intent", "allocated", "released"]);
});
