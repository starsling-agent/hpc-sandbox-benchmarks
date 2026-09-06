import { describe, expect, test } from "bun:test";
import { forEachProviderWithCreds } from "./providers-run.ts";

describe("forEachProviderWithCreds `only`", () => {
	test("visits only the requested provider (a matrix cell reports just its own)", async () => {
		const bodyRan: string[] = [];
		const runs = await forEachProviderWithCreds(
			async (provider) => {
				bodyRan.push(provider.name);
				return null;
			},
			// No creds for daytona in this env → it skips, but nothing else is even considered.
			{ only: ["daytona-vm"], env: {} },
		);
		expect(runs.map((r) => r.provider)).toEqual(["daytona-vm"]);
		expect(runs[0]?.status).toBe("skipped");
		expect(bodyRan).toEqual([]); // skipped: the body never runs
	});

	test("runs the body for a selected provider whose creds are present", async () => {
		const runs = await forEachProviderWithCreds(async () => "smoked", {
			only: ["daytona-vm"],
			env: { DAYTONA_API_KEY: "present" },
		});
		expect(runs.map((r) => r.provider)).toEqual(["daytona-vm"]);
		expect(runs[0]?.status).toBe("ok");
		expect(runs[0]?.value).toBe("smoked");
	});

	test("without `only`, drives every registered provider (unchanged default)", async () => {
		const runs = await forEachProviderWithCreds(async () => null, { env: {} });
		// All registered providers are visited (all skipped here for want of creds).
		expect(runs.map((r) => r.provider)).toEqual([
			"daytona-vm",
			"daytona-container",
			"blaxel",
			"microsandbox-local",
			"microsandbox-cloud",
			"novita",
			"runloop",
			"namespace",
			"vercel",
			"runcloud",
		]);
	});

	// `[]` is truthy, so without a guard it would select nothing, validate nothing, and still exit 0 —
	// a release that baked nothing looking exactly like one that passed.
	test("an empty `only` throws rather than silently validating zero providers", async () => {
		await expect(forEachProviderWithCreds(async () => null, { only: [], env: {} })).rejects.toThrow(
			/empty list/,
		);
	});

	test("a migrated DriverModule id in `only` throws rather than visiting nothing", async () => {
		await expect(
			forEachProviderWithCreds(async () => null, { only: ["e2b"], env: {} }),
		).rejects.toThrow(/no legacy adapter/);
	});
});
