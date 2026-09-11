import { describe, expect, test } from "bun:test";
import type { DriverModuleMap, DriverProviderId } from "./index.ts";
import { DRIVERS, loadDriverModule } from "./index.ts";

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
			? true
			: false
		: false;
type Expect<Condition extends true> = Condition;

describe("generated driver loader", () => {
	test("exposes exactly the unwaived provider modules without eager vendor evaluation", () => {
		expect(Object.keys(DRIVERS)).toEqual([
			"e2b",
			"daytona-vm",
			"daytona-container",
			"blaxel",
			"microsandbox-cloud",
			"modal-gvisor",
			"modal-vm",
			"novita",
			"runloop",
			"namespace",
			"vercel",
			"runcloud",
			"tama",
		]);
		expect(Object.values(DRIVERS).every((load) => typeof load === "function")).toBe(true);
		expect(Object.isFrozen(DRIVERS)).toBe(true);
	});

	test("retains the literal module and native-handle type through a correlated load", async () => {
		const module_ = await loadDriverModule("e2b");
		type _module = Expect<Equal<typeof module_, typeof import("@sandbox-benchmarks/e2b").default>>;
		expect(module_.id).toBe("e2b");
	});

	test("returns the safe module union for a runtime provider id", () => {
		const loadRuntimeProvider = (id: DriverProviderId) => loadDriverModule(id);
		type _module = Expect<
			Equal<Awaited<ReturnType<typeof loadRuntimeProvider>>, DriverModuleMap[DriverProviderId]>
		>;
		expect(loadRuntimeProvider).toBeFunction();
	});

	test("rejects unregistered provider ids", () => {
		// @ts-expect-error — Unknown ids cannot enter the driver loader
		const loadWaivedProvider = () => loadDriverModule("not-a-provider");
		void loadWaivedProvider;
		expect(true).toBe(true);
	});
});
