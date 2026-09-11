import type { InventorySnapshot, ProviderId, SandboxDriver } from "@sandbox-benchmarks/driver";
import { quotaDomain } from "@sandbox-benchmarks/schema";
import { accountInventoryScope } from "./account-policy.ts";

export type AccountInventoryRow = {
	readonly id: ProviderId;
	/** The quota domain the provider is charged to: the account reconciliation actually sweeps. */
	readonly account: string;
} & (
	| { readonly status: "listed"; readonly snapshot: InventorySnapshot }
	| { readonly status: "unsupported" | "failed"; readonly detail: string }
);

/**
 * Observe every requested provider's account exactly as admission will: reconciliation refuses a
 * driver without inventory, destroy-by-id and probes. Foreign resources block account-scoped admission;
 * benchmark-scoped admission retains foreign counts without authorizing deletion.
 * Nothing here allocates or deletes, and a failed open or listing is reported, never skipped.
 */
export async function inventoryAccounts<P extends ProviderId>(
	ids: readonly P[],
	open: (id: P) => Promise<{ readonly driver: SandboxDriver }>,
	describe: (error: unknown) => string,
): Promise<AccountInventoryRow[]> {
	const rows: AccountInventoryRow[] = [];
	for (const id of ids) {
		const account = quotaDomain(id);
		try {
			const { driver } = await open(id);
			if (!driver.inventory || !driver.destroyById || !driver.probes) {
				rows.push({
					id,
					account,
					status: "unsupported",
					detail: "driver lacks inventory, destroy-by-id, or probes",
				});
				continue;
			}
			rows.push({ id, account, status: "listed", snapshot: await driver.inventory.list() });
		} catch (error) {
			rows.push({ id, account, status: "failed", detail: describe(error) });
		}
	}
	return rows;
}

/** Benchmark-scoped exceptions permit foreign resources, never unavailable inventory. */
export function inventoryBlocksAdmission(rows: readonly AccountInventoryRow[]): boolean {
	return rows.some(
		(row) =>
			row.status !== "listed" ||
			(row.snapshot.foreignCount > 0 && accountInventoryScope(row.id) === "account"),
	);
}

export function formatAccountInventory(rows: readonly AccountInventoryRow[]): string {
	return rows
		.map((row) => {
			const head = `${row.id} (account ${row.account}):`;
			if (row.status !== "listed") return `${head} ${row.status} — ${row.detail}`;
			const owned =
				row.snapshot.owned.length === 0
					? "none"
					: row.snapshot.owned.map((ref) => ref.id).join(", ");
			return `${head} owned=${row.snapshot.owned.length} [${owned}] foreign=${row.snapshot.foreignCount} scope=${accountInventoryScope(row.id)}`;
		})
		.join("\n");
}
