import { expect, test } from "bun:test";
import type { ProviderId, SandboxDriver, SandboxRef } from "@sandbox-benchmarks/driver";
import { reconcileAccount } from "./account-reconciliation.ts";

const ref: SandboxRef = { provider: "tama", id: "machine-owned" };

for (const id of ["daytona-vm", "daytona-container", "novita"] as const) {
	test(`${id} permits foreign churn but removes only benchmark-owned sandboxes`, async () => {
		const owned: SandboxRef = { provider: id, id: "benchmark-owned" };
		const deleted: SandboxRef[] = [];
		let scans = 0;
		const candidate = driver({
			inventory: {
				list: async () => ({
					owned: deleted.length === 0 ? [owned] : [],
					foreignCount: ++scans * 10,
				}),
			},
			destroyById: async (ref) => {
				deleted.push(ref);
			},
			probes: { observe: async () => ({ state: "absent" }) },
		});
		const result = await reconcileAccount([{ id, driver: candidate }], { timeoutMs: 100 });
		expect(deleted).toEqual([owned]);
		expect(result.removed).toEqual([owned]);
		expect(scans).toBe(2);
	});
}

test("benchmark-scoped admission still reject malformed inventory, uncertain cleanup and new owned allocations", async () => {
	const id = "novita";
	const owned: SandboxRef = { provider: id, id: "benchmark-owned" };
	for (const candidate of [
		driver({ inventory: { list: async () => ({ owned: [], foreignCount: -1 }) } }),
		driver({ inventory: { list: async () => ({ owned: [ref], foreignCount: 5 }) } }),
		driver({ inventory: { list: async () => ({ owned: [owned, owned], foreignCount: 5 }) } }),
		driver({
			inventory: { list: async () => ({ owned: [owned], foreignCount: 5 }) },
			destroyById: async () => {},
			probes: { observe: async () => ({ state: "running" }) },
		}),
		driver({
			inventory: { list: async () => ({ owned: [owned], foreignCount: 5 }) },
			probes: { observe: async () => ({ state: "absent" }) },
		}),
	]) {
		await expect(
			reconcileAccount([{ id, driver: candidate }], { timeoutMs: 20, pollMs: 1 }),
		).rejects.toThrow();
	}
});

test("foreign resources still block every account-scoped inventory before any deletion", async () => {
	const accountScoped: ProviderId[] = [
		"e2b",
		"modal-gvisor",
		"modal-vm",
		"tama",
		"blaxel",
		"microsandbox-cloud",
		"runloop",
		"runcloud",
		"namespace",
		"vercel",
	];
	let deletes = 0;
	for (const id of accountScoped) {
		const candidate = driver({
			inventory: {
				list: async () => ({ owned: [{ provider: id, id: "owned" }], foreignCount: 1 }),
			},
			destroyById: async () => {
				deletes++;
			},
		});
		await expect(reconcileAccount([{ id, driver: candidate }], { timeoutMs: 100 })).rejects.toThrow(
			"account-scoped inventory contains unowned resources",
		);
	}
	expect(deletes).toBe(0);
});
function driver(overrides: Partial<SandboxDriver> = {}): SandboxDriver {
	let present = true;
	return {
		create: async () => {
			throw new Error("reconciliation must never allocate");
		},
		inventory: { list: async () => ({ owned: present ? [ref] : [], foreignCount: 0 }) },
		destroyById: async () => {
			present = false;
		},
		probes: { observe: async () => ({ state: present ? "running" : "absent" }) },
		...overrides,
	};
}
test("reconciles owned allocations and confirms absence before admission", async () => {
	const result = await reconcileAccount([{ id: "tama", driver: driver() }], { timeoutMs: 100 });
	expect(result.removed).toEqual([ref]);
});
test("unavailable inventory, foreign resources and uncertain destroy block admission", async () => {
	for (const candidate of [
		driver({ inventory: undefined }),
		driver({
			inventory: {
				list: async () => {
					throw new Error("list unavailable");
				},
			},
		}),
		driver({ inventory: { list: async () => ({ owned: [], foreignCount: 1 }) } }),
		driver({
			destroyById: async () => {
				throw new Error("delete outcome unknown");
			},
		}),
	])
		await expect(
			reconcileAccount([{ id: "tama", driver: candidate }], { timeoutMs: 100 }),
		).rejects.toThrow();
});
test("a successful delete response cannot replace the control plane's observation", async () => {
	const candidate = driver({
		destroyById: async () => {},
		probes: { observe: async () => ({ state: "running" }) },
	});
	await expect(
		reconcileAccount([{ id: "tama", driver: candidate }], { timeoutMs: 15, pollMs: 1 }),
	).rejects.toThrow("deadline exceeded");
});
test("a terminal observation confirms removal where the vendor retains terminated records", async () => {
	// Modal and run.cloud keep a terminated sandbox observable forever; it holds no allocation.
	let present = true;
	const candidate = driver({
		inventory: { list: async () => ({ owned: present ? [ref] : [], foreignCount: 0 }) },
		destroyById: async () => {
			present = false;
		},
		probes: { observe: async () => ({ state: present ? "running" : "terminal" }) },
	});
	const result = await reconcileAccount([{ id: "tama", driver: candidate }], {
		timeoutMs: 100,
		pollMs: 1,
	});
	expect(result.removed).toEqual([ref]);
});
test("cancellation cannot turn an unobserved account into an admitted one", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	await expect(
		reconcileAccount([{ id: "tama", driver: driver() }], {
			timeoutMs: 100,
			signal: controller.signal,
		}),
	).rejects.toThrow("cancelled");
});

test("an unavailable variant blocks deletion through every other variant", async () => {
	let deletes = 0;
	await expect(
		reconcileAccount(
			[
				{
					id: "tama",
					driver: driver({
						destroyById: async () => {
							deletes++;
						},
					}),
				},
				{
					id: "novita",
					driver: driver({
						inventory: {
							list: async () => {
								throw new Error("second inventory unavailable");
							},
						},
					}),
				},
			],
			{ timeoutMs: 100 },
		),
	).rejects.toThrow("second inventory unavailable");
	expect(deletes).toBe(0);
});

test("a resource appearing after deletion prevents admission", async () => {
	let scans = 0;
	const candidate = driver({
		inventory: {
			list: async () => ({
				owned: [scans++ === 0 ? ref : { ...ref, id: "late-allocation" }],
				foreignCount: 0,
			}),
		},
	});
	await expect(
		reconcileAccount([{ id: "tama", driver: candidate }], { timeoutMs: 100 }),
	).rejects.toThrow("inventory changed");
});
