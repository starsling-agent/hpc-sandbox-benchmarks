import { expect, test } from "bun:test";
import type { SandboxDriver } from "@sandbox-benchmarks/driver";
import {
	formatAccountInventory,
	inventoryAccounts,
	inventoryBlocksAdmission,
} from "./account-inventory.ts";

const capable = (owned: readonly string[], foreignCount: number): SandboxDriver => ({
	create: async () => {
		throw new Error("unused");
	},
	destroyById: async () => {},
	probes: { observe: async () => ({ state: "absent" }) },
	inventory: {
		list: async () => ({
			owned: owned.map((id) => ({ provider: "tama" as const, id })),
			foreignCount,
		}),
	},
});

test("reports every account the way admission sees it and never skips a failure", async () => {
	const rows = await inventoryAccounts(
		["tama", "e2b", "novita", "modal-vm"],
		async (id) => {
			if (id === "tama") return { driver: capable(["machine-a"], 0) };
			if (id === "e2b") return { driver: capable([], 2) };
			if (id === "novita")
				return {
					driver: {
						create: async () => {
							throw new Error("unused");
						},
					},
				};
			throw new Error("MODAL_TOKEN_ID missing");
		},
		(error) => (error instanceof Error ? error.message : String(error)),
	);
	expect(rows.map((row) => `${row.id}:${row.status}`)).toEqual([
		"tama:listed",
		"e2b:listed",
		"novita:unsupported",
		"modal-vm:failed",
	]);
	// Leftovers alone do not block (reconciliation removes them); foreign resources and gaps do.
	expect(inventoryBlocksAdmission(rows.slice(0, 1))).toBe(false);
	expect(inventoryBlocksAdmission(rows.slice(1, 2))).toBe(true);
	expect(inventoryBlocksAdmission(rows)).toBe(true);
	const text = formatAccountInventory(rows);
	expect(text).toContain("tama (account tama): owned=1 [machine-a] foreign=0");
	expect(text).toContain("e2b (account e2b): owned=0 [none] foreign=2");
	expect(text).toContain("novita (account novita): unsupported — driver lacks");
	expect(text).toContain("modal-vm (account modal): failed — MODAL_TOKEN_ID missing");
});
