import { describe, expect, it } from "bun:test";
import type { ProviderMeta, ProviderPricing } from "./index.ts";
import {
	getProvider,
	hourlyCostAtTargetSpec,
	isoDateSchema,
	PROVIDERS,
	pricingQuantityAtTargetSpec,
	pricingQuantityRuleSchema,
	providerPricingSchema,
	TARGET_SPEC,
} from "./index.ts";

const published = (id: string) => {
	const pricing = getProvider(id)?.pricing;
	expect(pricing?.model).toBe("published");
	return pricing as Extract<ProviderPricing, { model: "published" }>;
};

const component = (id: string, componentId: string) => {
	const value = published(id).components.find((entry) => entry.id === componentId);
	expect(value).toBeDefined();
	return value as NonNullable<typeof value>;
};

const referenceQuantity = (id: string, componentId: string) =>
	pricingQuantityAtTargetSpec(component(id, componentId), TARGET_SPEC);

const at = <T>(values: readonly T[], index: number): T => {
	const value = values[index];
	if (value === undefined) throw new Error(`fixture is missing item ${index}`);
	return value;
};

const fixture: ProviderMeta = {
	...getProvider("e2b"),
	displayName: "Fixture",
	pricing: {
		model: "published",
		components: [
			{
				id: "cpu",
				resource: "cpu",
				billingBasis: "provisioned",
				vendorUnit: "unit",
				usdPerUnitHour: 0.05,
				quantityRule: { kind: "linear", dimension: "vcpus", unitsPerTargetUnit: 1 },
			},
			{
				id: "memory",
				resource: "memory",
				billingBasis: "provisioned",
				vendorUnit: "unit",
				usdPerUnitHour: 0.01,
				quantityRule: { kind: "linear", dimension: "memoryGb", unitsPerTargetUnit: 1 },
			},
		],
		targetHourlyCost: { kind: "exact", componentIds: ["cpu", "memory"] },
		notes: "fixture",
		sources: [{ label: "fixture", url: "https://example.com", checkedAt: "2026-08-08" }],
	},
};

describe("@sandbox-benchmarks/schema providers", () => {
	it("pins the registered provider id set", () => {
		expect(PROVIDERS.map((provider) => provider.id).sort()).toEqual([
			"blaxel",
			"daytona-container",
			"daytona-vm",
			"e2b",
			"microsandbox-cloud",
			"modal-gvisor",
			"modal-vm",
			"namespace",
			"novita",
			"runcloud",
			"runloop",
			"tama",
			"vercel",
		]);
	});

	it("keeps identity and transport records well formed", () => {
		const ids = PROVIDERS.map((provider) => provider.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const provider of PROVIDERS) {
			expect(provider.requiredEnvVars.length).toBeGreaterThan(0);
			expect(getProvider(provider.id)?.id).toBe(provider.id);
			expect(typeof provider.transport.streaming).toBe("boolean");
			if (provider.transport.syncCapMs !== null) {
				expect(Number.isFinite(provider.transport.syncCapMs)).toBe(true);
				expect(provider.transport.syncCapMs).toBeGreaterThan(0);
				expect(provider.transport.detachedPoll).toBe(true);
			}
		}
	});

	it("deep-freezes the registry and resolves legacy aliases", () => {
		expect(Object.isFrozen(PROVIDERS)).toBe(true);
		expect(Object.isFrozen(PROVIDERS[0]?.pricing)).toBe(true);
		expect(Object.isFrozen(PROVIDERS[0]?.artifact)).toBe(true);
		expect(Object.isFrozen(PROVIDERS[0]?.inputs)).toBe(true);
		expect(getProvider("modal")?.id).toBe("modal-gvisor");
		expect(getProvider("daytona")?.id).toBe("daytona-vm");
		expect(getProvider("not-a-provider")).toBeUndefined();
	});

	it("directly prices multiple supplied target specs from component quantity rules", () => {
		expect(hourlyCostAtTargetSpec(fixture)).toBeCloseTo(0.05 * 4 + 0.01 * 8);
		expect(hourlyCostAtTargetSpec(fixture, { vcpus: 2, memoryGb: 8 })).toBeCloseTo(
			0.05 * 2 + 0.01 * 8,
		);
		expect(hourlyCostAtTargetSpec(fixture, { vcpus: 7, memoryGb: 3, diskGb: 99 })).toBeCloseTo(
			0.05 * 7 + 0.01 * 3,
		);
	});

	it("models linear and max quantity rules and rejects invalid conversion factors", () => {
		expect(
			pricingQuantityRuleSchema.allows({
				kind: "linear",
				dimension: "memoryGb",
				unitsPerTargetUnit: 1,
			}),
		).toBe(true);
		expect(
			pricingQuantityRuleSchema.allows({
				kind: "max",
				terms: [
					{ dimension: "vcpus", unitsPerTargetUnit: 1 },
					{ dimension: "memoryGb", unitsPerTargetUnit: 0.5 },
				],
			}),
		).toBe(true);
		expect(
			pricingQuantityRuleSchema.allows({
				kind: "linear",
				dimension: "vcpus",
				unitsPerTargetUnit: 1,
				hiddenScale: 4,
			}),
		).toBe(false);
		expect(
			pricingQuantityRuleSchema.allows({
				kind: "max",
				terms: [
					{ dimension: "vcpus", unitsPerTargetUnit: 1 },
					{ dimension: "memoryGb", unitsPerTargetUnit: 0.5 },
				],
				hiddenScale: 4,
			}),
		).toBe(false);
		for (const unitsPerTargetUnit of [0, -1, Number.POSITIVE_INFINITY]) {
			expect(
				pricingQuantityRuleSchema.allows({
					kind: "linear",
					dimension: "vcpus",
					unitsPerTargetUnit,
				}),
			).toBe(false);
		}
		expect(
			pricingQuantityRuleSchema.allows({
				kind: "max",
				terms: [{ dimension: "vcpus", unitsPerTargetUnit: 1 }],
			}),
		).toBe(false);
	});

	it("accepts ISO source dates without pinning the field type to one research day", () => {
		for (const value of ["2026-08-08", "2024-02-29"])
			expect(isoDateSchema.allows(value)).toBe(true);
		for (const value of ["2026-8-08", "2026-02-30", "not-a-date"]) {
			expect(isoDateSchema.allows(value)).toBe(false);
		}
		// Every citation carries a REAL date, not one hardcoded research day: rates are re-checked per
		// provider (a provider added later is cited on the day its rate was actually read), so pinning
		// the data to a single literal would force a new entry to backdate its evidence.
		for (const provider of PROVIDERS) {
			if (provider.pricing.model !== "published") continue;
			for (const source of provider.pricing.sources) {
				expect(isoDateSchema.allows(source.checkedAt)).toBe(true);
			}
		}
	});

	it("enforces pricing shape and cross-field invariants at the schema boundary", () => {
		const valid = structuredClone(fixture.pricing);
		expect(providerPricingSchema.allows(valid)).toBe(true);
		if (valid.model !== "published") throw new Error("fixture must use published pricing");

		const duplicate = structuredClone(valid);
		at(duplicate.components, 1).id = at(duplicate.components, 0).id;
		expect(providerPricingSchema.allows(duplicate)).toBe(false);

		const unknownReference = structuredClone(valid);
		unknownReference.targetHourlyCost = { kind: "exact", componentIds: ["missing"] };
		expect(providerPricingSchema.allows(unknownReference)).toBe(false);

		const duplicateReference = structuredClone(valid);
		duplicateReference.targetHourlyCost = { kind: "exact", componentIds: ["cpu", "cpu"] };
		expect(providerPricingSchema.allows(duplicateReference)).toBe(false);

		const emptyExact = structuredClone(valid);
		emptyExact.targetHourlyCost = { kind: "exact", componentIds: [] };
		expect(providerPricingSchema.allows(emptyExact)).toBe(false);

		const impossibleDate = structuredClone(valid);
		at(impossibleDate.sources, 0).checkedAt = "2026-02-30";
		expect(providerPricingSchema.allows(impossibleDate)).toBe(false);

		const nonHttpSource = structuredClone(valid);
		at(nonHttpSource.sources, 0).url = "ftp://example.com/pricing";
		expect(providerPricingSchema.allows(nonHttpSource)).toBe(false);

		const infiniteRate = structuredClone(valid);
		at(infiniteRate.components, 0).usdPerUnitHour = Number.POSITIVE_INFINITY;
		expect(providerPricingSchema.allows(infiniteRate)).toBe(false);

		const zeroConversion = structuredClone(valid);
		const zeroRule = at(zeroConversion.components, 0).quantityRule;
		if (zeroRule.kind !== "linear") throw new Error("fixture must use a linear quantity rule");
		zeroRule.unitsPerTargetUnit = 0;
		expect(providerPricingSchema.allows(zeroConversion)).toBe(false);

		const legacyTargetQuantity = structuredClone(valid) as typeof valid & {
			components: Array<(typeof valid.components)[number] & { targetQuantity?: number }>;
		};
		at(legacyTargetQuantity.components, 0).targetQuantity = 4;
		expect(providerPricingSchema.allows(legacyTargetQuantity)).toBe(false);

		const emptyUnit = structuredClone(valid);
		at(emptyUnit.components, 0).vendorUnit = "";
		expect(providerPricingSchema.allows(emptyUnit)).toBe(false);

		const emptyReason = {
			...valid,
			targetHourlyCost: { kind: "usage_dependent", reason: "" },
		};
		expect(providerPricingSchema.allows(emptyReason)).toBe(false);
	});

	it("pins exact target costs and shared isolation-variant pricing", () => {
		const expected: Record<string, number> = {
			e2b: 0.3312,
			"daytona-vm": 0.3312,
			"daytona-container": 0.3312,
			novita: 0.23328,
			runloop: 0.6336,
		};
		for (const [id, cost] of Object.entries(expected)) {
			expect(hourlyCostAtTargetSpec(getProvider(id) as ProviderMeta)).toBeCloseTo(cost, 12);
		}
		expect(getProvider("modal-vm")?.pricing).toBe(getProvider("modal-gvisor")?.pricing);
		expect(hourlyCostAtTargetSpec(getProvider("modal-gvisor"))).toBeNull();
		expect(hourlyCostAtTargetSpec(getProvider("modal-vm"))).toBeNull();
		expect(getProvider("daytona-container")?.pricing).toBe(getProvider("daytona-vm")?.pricing);
	});

	it("records Daytona storage—not memory—allowance and excludes disk from exact cost", () => {
		const pricing = published("daytona-vm");
		expect(pricing.adjustments).toContainEqual(
			expect.objectContaining({ resource: "disk", quantity: 5, scope: "per_sandbox" }),
		);
		expect(pricing.adjustments?.some((entry) => entry.resource === "memory")).toBe(false);
		expect(pricing.targetHourlyCost).toEqual({ kind: "exact", componentIds: ["cpu", "memory"] });
		expect(component("daytona-vm", "disk").usdPerUnitHour).toBeCloseTo(0.00000003 * 3600);
	});

	it("maps Modal's requested capped CPU and memory one-to-one", () => {
		const cpu = component("modal-gvisor", "cpu");
		const memory = component("modal-gvisor", "memory");
		expect(cpu.vendorUnit).toContain("physical-core rate");
		expect(cpu.billingBasis).toBe("max_request_or_usage");
		expect(cpu.quantityRule).toEqual({
			kind: "linear",
			dimension: "vcpus",
			unitsPerTargetUnit: 1,
		});
		expect(cpu.usdPerUnitHour).toBeCloseTo(0.00003942 * 3600);
		expect(cpu.notes).toContain("provider-observed usage");
		expect(memory.usdPerUnitHour).toBeCloseTo(0.00000667 * 3600);
		expect(pricingQuantityAtTargetSpec(memory, { vcpus: 3, memoryGb: 11 })).toBe(11);
	});

	it("derives Namespace compute units from the dominant CPU or memory term", () => {
		const prepaid = component("namespace", "prepaid");
		expect(prepaid.quantityRule).toBe(component("namespace", "overage").quantityRule);
		expect(pricingQuantityAtTargetSpec(prepaid, { vcpus: 7, memoryGb: 4 })).toBe(7);
		expect(pricingQuantityAtTargetSpec(prepaid, { vcpus: 2, memoryGb: 14 })).toBe(7);
		expect(pricingQuantityAtTargetSpec(prepaid, { vcpus: 3, memoryGb: 10 })).toBe(5);
	});

	it("retains published dynamic and plan rates without emitting a scalar", () => {
		for (const id of ["blaxel", "microsandbox-cloud", "namespace", "vercel", "runcloud"]) {
			expect(published(id).components.length).toBeGreaterThan(0);
			expect(hourlyCostAtTargetSpec(getProvider(id) as ProviderMeta)).toBeNull();
		}
	});

	it("pins cited unranked reference values and allowance scopes", () => {
		expect(
			component("blaxel", "active-compute").usdPerUnitHour *
				referenceQuantity("blaxel", "active-compute"),
		).toBeCloseTo(0.3312);
		expect(
			component("microsandbox-cloud", "cpu-overage").usdPerUnitHour *
				referenceQuantity("microsandbox-cloud", "cpu-overage") +
				component("microsandbox-cloud", "memory-overage").usdPerUnitHour *
					referenceQuantity("microsandbox-cloud", "memory-overage"),
		).toBeCloseTo(0.3296);
		expect(
			component("namespace", "prepaid").usdPerUnitHour * referenceQuantity("namespace", "prepaid"),
		).toBeCloseTo(0.24);
		expect(
			component("namespace", "overage").usdPerUnitHour * referenceQuantity("namespace", "overage"),
		).toBeCloseTo(0.36);
		expect(
			component("vercel", "active-cpu").usdPerUnitHour * referenceQuantity("vercel", "active-cpu") +
				component("vercel", "memory").usdPerUnitHour * referenceQuantity("vercel", "memory"),
		).toBeCloseTo(0.6816);
		expect(
			component("runcloud", "cpu-floor").usdPerUnitHour *
				referenceQuantity("runcloud", "cpu-floor") +
				component("runcloud", "memory").usdPerUnitHour * referenceQuantity("runcloud", "memory"),
		).toBeCloseTo(0.0593784);
		expect(
			published("microsandbox-cloud").adjustments?.every((entry) => entry.scope === "monthly"),
		).toBe(true);
		expect(published("vercel").adjustments).toContainEqual(
			expect.objectContaining({ scope: "monthly" }),
		);
	});
});
