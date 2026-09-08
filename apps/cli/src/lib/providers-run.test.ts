import { describe, expect, test } from "bun:test";
import { PROVIDERS } from "@sandbox-benchmarks/schema";
import { usesDriverSuite } from "./driver-run.ts";
import { forEachProviderWithCreds } from "./providers-run.ts";

describe("forEachProviderWithCreds `only`", () => {
	test("visits only the requested provider (a matrix cell reports just its own)", async () => {
		const bodyRan: string[] = [];
		const runs = await forEachProviderWithCreds(
			async (target) => {
				bodyRan.push(target.id);
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
		const kinds: string[] = [];
		const runs = await forEachProviderWithCreds(
			async (target) => {
				kinds.push(target.kind);
				return "smoked";
			},
			{
				only: ["daytona-vm"],
				env: { DAYTONA_API_KEY: "present" },
			},
		);
		expect(runs.map((r) => r.provider)).toEqual(["daytona-vm"]);
		expect(runs[0]?.status).toBe("ok");
		expect(runs[0]?.value).toBe("smoked");
		expect(kinds).toEqual(["driver"]);
	});

	test("without `only`, drives every schema provider in registry order", async () => {
		const runs = await forEachProviderWithCreds(async () => null, { env: {} });
		expect(runs.map((r) => r.provider)).toEqual(PROVIDERS.map((meta) => meta.id));
		expect(runs.every((run) => run.status === "skipped")).toBe(true);
	});

	// `[]` is truthy, so without a guard it would select nothing, validate nothing, and still exit 0 —
	// a release that baked nothing looking exactly like one that passed.
	test("an empty `only` throws rather than silently validating zero providers", async () => {
		await expect(forEachProviderWithCreds(async () => null, { only: [], env: {} })).rejects.toThrow(
			/empty list/,
		);
	});

	test("a registered DriverModule id is visited on the driver lane, not thrown", async () => {
		const kinds: string[] = [];
		const runs = await forEachProviderWithCreds(
			async (target) => {
				kinds.push(`${target.kind}:${target.id}`);
				return "driver";
			},
			{ only: ["e2b"], env: { E2B_API_KEY: "e2b_test" } },
		);
		expect(runs.map((r) => r.provider)).toEqual(["e2b"]);
		expect(runs[0]?.status).toBe("ok");
		expect(kinds).toEqual(["driver:e2b"]);
		expect(usesDriverSuite("e2b")).toBe(true);
	});

	test("a registered id without creds skips rather than inventing a leftover adapter", async () => {
		const bodyRan: string[] = [];
		const runs = await forEachProviderWithCreds(
			async (target) => {
				bodyRan.push(target.id);
				return null;
			},
			{ only: ["e2b"], env: {} },
		);
		expect(runs.map((r) => r.provider)).toEqual(["e2b"]);
		expect(runs[0]?.status).toBe("skipped");
		expect(runs[0]?.reason).toMatch(/E2B_API_KEY/);
		expect(bodyRan).toEqual([]);
	});

	test("mixed only keeps registry order and splits driver vs leftover lanes", async () => {
		const kinds: Record<string, string> = {};
		const runs = await forEachProviderWithCreds(
			async (target) => {
				kinds[target.id] = target.kind;
				return target.kind;
			},
			{
				only: ["tama", "daytona-vm"],
				env: { TAMA_TOKEN: "tok", DAYTONA_API_KEY: "key" },
			},
		);
		expect(runs.map((r) => r.provider)).toEqual(["daytona-vm", "tama"]);
		expect(kinds).toEqual({ "daytona-vm": "driver", tama: "driver" });
		expect(usesDriverSuite("tama")).toBe(true);
		expect(usesDriverSuite("daytona-vm")).toBe(true);
	});
});
