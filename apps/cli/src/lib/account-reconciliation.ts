import type {
	InventorySnapshot,
	ProviderId,
	SandboxDriver,
	SandboxRef,
} from "@sandbox-benchmarks/driver";
import { accountInventoryScope } from "./account-policy.ts";

export interface AccountDriver {
	id: ProviderId;
	driver: SandboxDriver;
}

export interface ReconciliationEvidence {
	confirmedAt: string;
	removed: SandboxRef[];
}

/** Must run under the account's workflow queue, before any new allocation. */
export async function reconcileAccount(
	drivers: readonly AccountDriver[],
	options: { timeoutMs: number; signal?: AbortSignal; pollMs?: number },
): Promise<ReconciliationEvidence> {
	if (drivers.length === 0) throw new Error("account reconciliation requires at least one driver");
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
		throw new Error("invalid reconciliation budget");
	for (const { id, driver } of drivers) {
		if (!driver.inventory || !driver.destroyById || !driver.probes)
			throw new Error(`${id} has no complete managed inventory/recovery capability`);
	}
	const controller = new AbortController();
	const abort = () =>
		controller.abort(options.signal?.reason ?? new Error("account reconciliation cancelled"));
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(
		() =>
			controller.abort(
				new Error("account reconciliation deadline exceeded; allocation remains blocked"),
			),
		options.timeoutMs,
	);
	const removed: SandboxRef[] = [];
	const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
		controller.signal.throwIfAborted();
		let unsubscribe = () => {};
		try {
			return await Promise.race([
				Promise.resolve().then(() => {
					controller.signal.throwIfAborted();
					return operation();
				}),
				new Promise<never>((_resolve, reject) => {
					const listener = () => reject(controller.signal.reason);
					controller.signal.addEventListener("abort", listener, { once: true });
					unsubscribe = () => controller.signal.removeEventListener("abort", listener);
					if (controller.signal.aborted) listener();
				}),
			]);
		} finally {
			unsubscribe();
		}
	};
	const list = async ({ id, driver }: AccountDriver): Promise<InventorySnapshot> => {
		const inventory = driver.inventory;
		if (!inventory) throw new Error(`${id} inventory disappeared`);
		const snapshot = await bounded(() => inventory.list({ signal: controller.signal }));
		if (
			!Number.isSafeInteger(snapshot.foreignCount) ||
			snapshot.foreignCount < 0 ||
			!Array.isArray(snapshot.owned)
		)
			throw new Error(`${id} returned invalid account inventory`);
		if (snapshot.foreignCount > 0 && accountInventoryScope(id) === "account")
			throw new Error(
				`${id} account-scoped inventory contains unowned resources; allocation blocked`,
			);
		const ids = new Set<string>();
		for (const ref of snapshot.owned) {
			if (ref.provider !== id || typeof ref.id !== "string" || ref.id === "" || ids.has(ref.id))
				throw new Error(`${id} inventory returned invalid or duplicate ownership`);
			ids.add(ref.id);
		}
		return snapshot;
	};
	try {
		// Inspect every variant before destructive recovery. An incomplete view of one variant
		// cannot authorize deleting resources found through another variant's inventory.
		const snapshots = [];
		for (const entry of drivers) snapshots.push({ entry, snapshot: await list(entry) });
		for (const { entry, snapshot } of snapshots) {
			const { driver } = entry;
			const destroy = driver.destroyById;
			const probes = driver.probes;
			if (!destroy || !probes) throw new Error("managed recovery capability disappeared");
			for (const ref of snapshot.owned) {
				await bounded(() => destroy.call(driver, ref, { signal: controller.signal }));
				// Only the control plane's own observation releases the loop, never the delete response.
				// `absent` and `terminal` both qualify: a terminated sandbox holds no allocation, and some
				// vendors (Modal, run.cloud) retain terminated records forever, so absence never arrives.
				while ((await bounded(() => probes.observe(ref))).state === "running") {
					await bounded(
						() => new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000)),
					);
				}
				removed.push(ref);
			}
		}
		for (const entry of drivers) {
			if ((await list(entry)).owned.length > 0)
				throw new Error(`${entry.id} inventory changed during reconciliation; allocation blocked`);
		}
		return { removed, confirmedAt: new Date().toISOString() };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
