import type { ProviderId, SandboxDriver, SandboxRef } from "@sandbox-benchmarks/driver";
import { providerIdSchema } from "@sandbox-benchmarks/schema";
import { type } from "arktype";

const identity = type(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const refSchema = type({ provider: providerIdSchema, id: "string >= 1" });
const base = {
	version: "'1'",
	account: identity,
	attempt: identity,
	cellId: identity,
	planDigest: /^sha256:[a-f0-9]{64}$/,
} as const;
export const accountRecordSchema = type.or(
	type({ ...base, kind: "'intent'" }).onUndeclaredKey("reject"),
	type({ ...base, kind: "'allocated'", ref: refSchema }).onUndeclaredKey("reject"),
	type({ ...base, kind: "'released'", outcome: "'absent'", ref: refSchema }).onUndeclaredKey(
		"reject",
	),
	type({ ...base, kind: "'released'", outcome: "'not-allocated'" }).onUndeclaredKey("reject"),
	type({
		...base,
		kind: "'released'",
		outcome: "'reconciled'",
		evidence: {
			kind: "'completed-create'",
			sourceSha: /^[a-f0-9]{40}$/,
			attemptDigest: /^sha256:[a-f0-9]{64}$/,
			workflowRun: /^[0-9]+$/,
			confirmedAt: "string.date.iso",
			operator: identity,
		},
	}).onUndeclaredKey("reject"),
);
export type AccountRecord = typeof accountRecordSchema.infer;
export interface AccountJournal {
	read(account: string): Promise<readonly AccountRecord[]>;
	append(record: AccountRecord): Promise<void>;
}

/** Queues provide exclusion; this journal preserves ownership facts, never allocation claims. */
export async function recoverAccount(
	account: string,
	drivers: ReadonlyMap<ProviderId, SandboxDriver>,
	journal: AccountJournal,
	signal: AbortSignal,
): Promise<void> {
	const attempts = new Map<string, AccountRecord[]>();
	for (const raw of await withinSignal(signal, () => journal.read(account))) {
		const record = accountRecordSchema.assert(raw);
		if (record.account !== account) throw new Error("account journal identity mismatch");
		const records = attempts.get(record.attempt) ?? [];
		if (records.some((entry) => entry.kind === record.kind))
			throw new Error("conflicting account journal records");
		records.push(record);
		attempts.set(record.attempt, records);
	}
	for (const records of attempts.values()) {
		signal.throwIfAborted();
		const intent = records.find((entry) => entry.kind === "intent");
		const allocated = records.find((entry) => entry.kind === "allocated");
		const released = records.find((entry) => entry.kind === "released");
		if (
			!intent ||
			records.some(
				(entry) => entry.planDigest !== intent.planDigest || entry.cellId !== intent.cellId,
			)
		)
			throw new Error("incomplete account journal provenance");
		if (released) {
			if (
				released.outcome !== "absent"
					? allocated !== undefined
					: !allocated ||
						allocated.ref.provider !== released.ref.provider ||
						allocated.ref.id !== released.ref.id
			)
				throw new Error("account release contradicts allocation evidence");
			continue;
		}
		if (!allocated)
			throw new Error(
				`unresolved create ${intent.attempt}: no durable sandbox identity; vendor-confirmed recovery required (recover-allocated-intent when the retained attempt evidence holds allocation.json)`,
			);
		const driver = drivers.get(allocated.ref.provider);
		if (!driver?.destroyById || !driver.probes)
			throw new Error("interrupted allocation has no recovery driver");
		await confirmRemoval(driver, allocated.ref, signal);
		await withinSignal(signal, () =>
			journal.append({ ...intent, kind: "released", outcome: "absent", ref: allocated.ref }),
		);
	}
}

/** Observed absence or a retained terminal record releases ownership; transport failures do not. */
export async function confirmRemoval(
	driver: SandboxDriver,
	ref: SandboxRef,
	signal: AbortSignal,
): Promise<void> {
	if (!driver.probes || !driver.destroyById)
		throw new Error("driver cannot observe allocation removal");
	const bounded = async <T>(operation: Promise<T>): Promise<T> => {
		signal.throwIfAborted();
		let unsubscribe = () => {};
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					const listener = () => reject(signal.reason);
					signal.addEventListener("abort", listener, { once: true });
					unsubscribe = () => signal.removeEventListener("abort", listener);
					if (signal.aborted) listener();
				}),
			]);
		} finally {
			unsubscribe();
		}
	};
	signal.throwIfAborted();
	if ((await bounded(driver.probes.observe(ref))).state !== "running") return;
	signal.throwIfAborted();
	await bounded(driver.destroyById(ref, { signal }));
	for (;;) {
		signal.throwIfAborted();
		if ((await bounded(driver.probes.observe(ref))).state !== "running") return;
		await bounded(new Promise((resolve) => setTimeout(resolve, 100)));
	}
}

/** Bound observation and persistence; a late operation never authorizes subsequent allocation. */
export async function withinSignal<T>(
	signal: AbortSignal,
	operation: () => Promise<T>,
): Promise<T> {
	signal.throwIfAborted();
	let unsubscribe = () => {};
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return operation();
			}),
			new Promise<never>((_resolve, reject) => {
				const listener = () => reject(signal.reason);
				signal.addEventListener("abort", listener, { once: true });
				unsubscribe = () => signal.removeEventListener("abort", listener);
				if (signal.aborted) listener();
			}),
		]);
	} finally {
		unsubscribe();
	}
}
