import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxDriver } from "@sandbox-benchmarks/driver";
import { evidenceDigest } from "@sandbox-benchmarks/results";
import type { ExperimentAttempt } from "@sandbox-benchmarks/schema";
import type { AccountRecord } from "./account-journal.ts";
import { recoverAccount } from "./account-journal.ts";
import { COMPLETED_CREATE_REVISION, recoverCompletedCreate } from "./completed-create-recovery.ts";
import { rawTreeDigest } from "./experiment-artifacts.ts";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "completed-create-"));
	directories.push(directory);
	const raw = join(directory, "raw");
	mkdirSync(join(raw, "e2b", "memory"), { recursive: true });
	const marker = join(raw, "e2b", "memory", "sandbox-e2b-memory--failed.json");
	writeFileSync(
		marker,
		JSON.stringify({
			provider: "e2b",
			suite: "memory",
			outcome: "failed",
			reason: "Failed to create sandbox: account journal PATCH HTTP 422; allocation blocked",
			cause: {
				kind: "sandbox-create-failed",
				detail: "account journal PATCH HTTP 422; allocation blocked",
			},
		}),
	);
	const run = {
		schemaVersion: "6",
		runId: "123",
		sha: COMPLETED_CREATE_REVISION,
		generatedAt: "2026-09-11T00:00:00Z",
		targetSpec: { vcpus: 4, memoryGb: 8 },
		providers: [],
	};
	writeFileSync(join(directory, "run.json"), JSON.stringify(run));
	const evidence: ExperimentAttempt = {
		schemaVersion: "1",
		id: "attempt-1",
		cellId: "e2b-memory-r0",
		planDigest: `sha256:${"a".repeat(64)}`,
		sha: COMPLETED_CREATE_REVISION,
		workloadRevision: "memory",
		environmentRevision: "env",
		artifactIdentity: "image",
		passes: 2,
		workflowRun: "123",
		workflowAttempt: 1,
		job: "bench",
		sequence: 0,
		outcome: "failed",
		measurementStarted: false,
		retryable: false,
		cleanup: "unresolved",
		completion: "unknown",
		runDigest: evidenceDigest(run),
		rawDigest: rawTreeDigest(raw),
	};
	const save = () => writeFileSync(join(directory, "attempt.json"), JSON.stringify(evidence));
	save();
	const records: AccountRecord[] = [
		{
			version: "1",
			kind: "intent",
			account: "e2b",
			attempt: evidence.id,
			cellId: evidence.cellId,
			planDigest: evidence.planDigest,
		},
	];
	const events: string[] = [];
	const driver: SandboxDriver = {
		create: async () => {
			throw new Error("must not allocate");
		},
		inventory: {
			list: async () => {
				events.push("inventory");
				return { owned: [], foreignCount: 0 };
			},
		},
		probes: { observe: async () => ({ state: "absent" }) },
		destroyById: async () => {},
	};
	const journal = {
		read: async () => records,
		append: async (r: AccountRecord) => {
			events.push("release");
			records.push(r);
		},
	};
	const options = {
		directory,
		provider: "e2b" as const,
		suite: "memory" as const,
		operator: "operator",
		drivers: [{ id: "e2b" as const, driver }],
		journal,
		assertQuiescent: async () => {
			events.push("quiescent");
		},
		signal: AbortSignal.timeout(1000),
	};
	return { options, records, events, evidence, save, marker, driver };
}
test("completed create clearance preserves evidence and requires two complete inventory sweeps", async () => {
	const f = fixture();
	const original = readFileSync(join(f.options.directory, "attempt.json"), "utf8");
	await recoverCompletedCreate(f.options);
	expect(f.events).toEqual(["quiescent", "inventory", "inventory", "quiescent", "release"]);
	expect(f.records.at(-1)).toMatchObject({
		outcome: "reconciled",
		evidence: {
			kind: "completed-create",
			attemptDigest: evidenceDigest(f.evidence),
			operator: "operator",
		},
	});
	expect(readFileSync(join(f.options.directory, "attempt.json"), "utf8")).toBe(original);
	await recoverAccount("e2b", new Map([["e2b", f.driver]]), f.options.journal, f.options.signal);
});
for (const change of [
	"source",
	"measured",
	"digest",
	"marker",
	"identity",
	"allocated",
	"busy",
	"inventory",
	"variant",
] as const) {
	test(`completed-create clearance rejects ${change} without releasing ownership`, async () => {
		const f = fixture();
		switch (change) {
			case "source":
				f.evidence.sha = "c".repeat(40);
				break;
			case "measured":
				f.evidence.measurementStarted = true;
				break;
			case "digest":
				f.evidence.rawDigest = `sha256:${"c".repeat(64)}`;
				break;
			case "marker":
				writeFileSync(f.marker, "{}");
				f.evidence.rawDigest = rawTreeDigest(join(f.options.directory, "raw"));
				break;
			case "identity":
				f.evidence.cellId = "e2b-disk-r0";
				break;
			case "allocated":
				f.records.push({
					version: "1",
					account: "e2b",
					attempt: f.evidence.id,
					cellId: f.evidence.cellId,
					planDigest: f.evidence.planDigest,
					kind: "allocated",
					ref: { provider: "e2b", id: "known" },
				});
				break;
			case "busy":
				f.options.assertQuiescent = async () => {
					throw new Error("workflow running");
				};
				break;
			case "inventory":
				f.options.drivers.splice(0, 1, {
					id: "e2b",
					driver: {
						...f.driver,
						inventory: {
							list: async () => {
								throw new Error("unavailable");
							},
						},
					},
				});
				break;
			case "variant":
				f.options.drivers.push({ id: "e2b", driver: f.driver });
				break;
		}
		f.save();
		await expect(recoverCompletedCreate(f.options)).rejects.toThrow();
		expect(f.records.some((r) => r.kind === "released")).toBe(false);
	});
}
