import { expect, test } from "bun:test";
import type { SandboxDriver } from "@sandbox-benchmarks/driver";
import type { AccountRecord } from "./account-journal.ts";
import { recoverAccount } from "./account-journal.ts";

const intent = {
	version: "1",
	kind: "intent",
	account: "tama",
	attempt: "attempt-1",
	cellId: "tama-system-r0",
	planDigest: `sha256:${"a".repeat(64)}`,
} as const;
const ref = { provider: "tama", id: "sandbox-1" } as const;
function fixture(records: AccountRecord[]) {
	let present = true;
	const events: string[] = [];
	const driver: SandboxDriver = {
		create: async () => {
			throw new Error("recovery must not allocate");
		},
		probes: {
			observe: async () => {
				events.push("observe");
				return { state: present ? "running" : "absent" };
			},
		},
		destroyById: async () => {
			events.push("destroy");
			present = false;
		},
	};
	const journal = {
		read: async () => records,
		append: async (record: AccountRecord) => {
			records.push(record);
			events.push("release");
		},
	};
	return { driver, journal, events };
}
test("interrupted known allocation is released only after observed removal", async () => {
	const records: AccountRecord[] = [intent, { ...intent, kind: "allocated", ref }];
	const { driver, journal, events } = fixture(records);
	await recoverAccount("tama", new Map([["tama", driver]]), journal, AbortSignal.timeout(1000));
	expect(events).toEqual(["observe", "destroy", "observe", "release"]);
	expect(records.at(-1)).toMatchObject({ kind: "released", outcome: "absent", ref });
});
test("an empty inventory cannot resolve an interrupted create without identity", async () => {
	const { driver, journal, events } = fixture([intent]);
	await expect(
		recoverAccount("tama", new Map([["tama", driver]]), journal, AbortSignal.timeout(1000)),
	).rejects.toThrow("vendor-confirmed recovery required");
	expect(events).toEqual([]);
});
test("conflicting release and allocation evidence blocks admission", async () => {
	const { driver, journal } = fixture([
		intent,
		{ ...intent, kind: "allocated", ref },
		{ ...intent, kind: "released", outcome: "not-allocated" },
	]);
	await expect(
		recoverAccount("tama", new Map([["tama", driver]]), journal, AbortSignal.timeout(1000)),
	).rejects.toThrow("contradicts");
});
test("unavailable observation does not append a release", async () => {
	const { driver, journal, events } = fixture([intent, { ...intent, kind: "allocated", ref }]);
	const unavailable = {
		...driver,
		probes: {
			observe: async () => {
				throw new Error("observation unavailable");
			},
		},
	};
	await expect(
		recoverAccount("tama", new Map([["tama", unavailable]]), journal, AbortSignal.timeout(1000)),
	).rejects.toThrow("unavailable");
	expect(events).toEqual([]);
});
