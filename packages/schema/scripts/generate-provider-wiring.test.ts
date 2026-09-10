import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderId } from "../src/provider-ids.ts";
import { PROVIDER_IDS } from "../src/provider-ids.ts";
import { REGISTRY } from "../src/provider-meta/index.ts";
import type { NormalizedProviderInput } from "../src/provider-meta.ts";
import {
	normalizeProviderInput,
	PROVIDER_PRE_AUTH_CONTRACTS,
	PROVIDER_PRE_AUTH_POLICIES,
} from "../src/provider-meta.ts";
import {
	driverFleetProjection,
	driverModuleLocation,
	escapeMarkdownCell,
	generatedProviderRegions,
	parseDriverMigrationWaivers,
	preAuthBindings,
	providerInputBindings,
	quotaDomainBindings,
	REPO_ROOT,
	renderAccountConcurrencyGroup,
	renderCiSecretTable,
	renderCiVariableTable,
	renderDotenvValue,
	renderDriversIndex,
	renderDriversPackage,
	renderDriversProvenance,
	renderEnvExample,
	renderPreAuthCondition,
	renderPreAuthOwnerCondition,
	renderProviderWiringFiles,
	renderRunnerLifetime,
	renderRunnerNoCache,
	renderRunnerSelection,
	renderSmokeProviderOptions,
	renderWorkflowInputs,
	replaceGeneratedRegion,
} from "./generate-provider-wiring.ts";

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is not a mapping`);
	}
	return value as Record<string, unknown>;
}

function workflowJobSteps(file: string, jobId: string): Record<string, unknown>[] {
	const document = record(Bun.YAML.parse(readFileSync(resolve(REPO_ROOT, file), "utf8")), file);
	const jobs = record(document.jobs, `${file} jobs`);
	const job = record(jobs[jobId], `${file} job ${jobId}`);
	if (!Array.isArray(job.steps)) throw new Error(`${file} job ${jobId} has no steps`);
	return job.steps.map((step, index) => record(step, `${file} job ${jobId} step ${index}`));
}

function workflowDispatchOptions(file: string, inputName: string): unknown[] {
	const document = record(Bun.YAML.parse(readFileSync(resolve(REPO_ROOT, file), "utf8")), file);
	const on = record(document.on, `${file} on`);
	const dispatch = record(on.workflow_dispatch, `${file} workflow_dispatch`);
	const inputs = record(dispatch.inputs, `${file} workflow_dispatch inputs`);
	const input = record(inputs[inputName], `${file} workflow_dispatch input ${inputName}`);
	if (!Array.isArray(input.options)) {
		throw new Error(`${file} workflow_dispatch input ${inputName} has no options`);
	}
	return input.options;
}

describe("provider wiring projections", () => {
	test("deduplicates shared inputs without changing their normalized contract", () => {
		const expected = new Map<string, { input: NormalizedProviderInput; owners: ProviderId[] }>();
		for (const id of PROVIDER_IDS) {
			for (const raw of REGISTRY[id].inputs) {
				const input = normalizeProviderInput(raw);
				const existing = expected.get(input.name);
				if (existing === undefined) expected.set(input.name, { input, owners: [id] });
				else existing.owners.push(id);
			}
		}

		expect(providerInputBindings()).toEqual(
			[...expected.values()].map(({ input, owners }) => ({ input, owners })),
		);
	});

	test("emits the complete provider vocabulary and metadata-owned runner route", () => {
		expect(workflowDispatchOptions(".github/workflows/bench-smoke.yml", "provider")).toEqual([
			...PROVIDER_IDS,
		]);
		const renderedOptions = record(
			Bun.YAML.parse(`options:\n${renderSmokeProviderOptions("  ")}`),
			"rendered provider options",
		);
		expect(renderedOptions.options).toEqual([...PROVIDER_IDS]);
		expect(renderRunnerSelection()).toBe(`    runs-on: \${{ 'ubuntu-24.04' }}`);
		expect(renderRunnerNoCache("")).toBe(`no-cache: \${{ false && 'true' || 'false' }}`);
		expect(renderRunnerLifetime("")).toBe(`BENCH_RUNNER_LIFETIME_MINUTES: \${{ '' }}`);
	});

	test("queues every provider behind its registry quota domain", () => {
		const bindings = quotaDomainBindings();
		// Every provider is charged to exactly one domain; only shared-credential variants share one.
		expect(bindings.flatMap(({ owners }) => owners)).toEqual([...PROVIDER_IDS]);
		expect(bindings.filter(({ owners }) => owners.length > 1)).toEqual([
			{ domain: "daytona", owners: ["daytona-vm", "daytona-container"] },
			{ domain: "modal", owners: ["modal-gvisor", "modal-vm"] },
		]);
		// A provider that shares no credential is its own domain — never a stray custom name.
		expect(
			bindings.filter(({ domain, owners }) => owners.length === 1 && owners[0] !== domain),
		).toEqual([]);
		expect(renderAccountConcurrencyGroup("")).toBe(
			`group: benchmark-account-\${{ (matrix.provider == 'daytona-vm' || matrix.provider == 'daytona-container') && 'daytona' || (matrix.provider == 'modal-gvisor' || matrix.provider == 'modal-vm') && 'modal' || matrix.provider }}`,
		);
	});

	test("scopes secrets, shared inputs, capability literals, and pre-auth values safely", () => {
		const matrix = renderWorkflowInputs("matrix", "");
		expect(matrix).toContain(
			`E2B_API_KEY: \${{ matrix.provider == 'e2b' && secrets.E2B_API_KEY || '' }}`,
		);
		expect(matrix).toContain(
			`DAYTONA_API_KEY: \${{ (matrix.provider == 'daytona-vm' || matrix.provider == 'daytona-container') && secrets.DAYTONA_API_KEY || '' }}`,
		);
		expect(matrix).not.toContain("MICROSANDBOX_LOCAL_BENCH");
		expect(matrix).toContain(`NSC_TOKEN_FILE: \${{ steps.namespace.outputs.token-file }}`);
		expect(matrix).toContain(
			`VERCEL_OIDC_TOKEN: \${{ matrix.provider == 'vercel' && steps.vercel-auth.outcome == 'success' && env.VERCEL_OIDC_TOKEN || '' }}`,
		);
		expect(matrix).not.toContain("vars.VERCEL_OIDC_TOKEN");
		expect(matrix).not.toContain("secrets.VERCEL_OIDC_TOKEN");
	});

	test("uses the release plan to scope every promote input", () => {
		const promote = renderWorkflowInputs("release-scope", "");
		expect(promote).toContain(
			`RUN_CLOUD_API_KEY: \${{ contains(fromJSON(needs.plan.outputs.matrix).include.*.provider, 'runcloud') && secrets.RUN_CLOUD_API_KEY || '' }}`,
		);
		expect(promote).toContain(
			"(contains(fromJSON(needs.plan.outputs.matrix).include.*.provider, 'modal-gvisor') || contains(fromJSON(needs.plan.outputs.matrix).include.*.provider, 'modal-vm')) && secrets.MODAL_TOKEN_ID",
		);
	});

	test("projects all user-facing local, secret, and variable documentation", () => {
		const local = renderEnvExample();
		const secrets = renderCiSecretTable();
		const variables = renderCiVariableTable();
		for (const { input } of providerInputBindings()) {
			expect(local).toContain(`${input.name}=`);
			if (input.source.kind === "secret") expect(secrets).toContain(`\`${input.name}\``);
			if (input.source.kind === "variable" && input.ciValue === undefined) {
				expect(variables).toContain(`\`${input.name}\``);
			}
		}
		expect(variables).not.toContain("MICROSANDBOX_LOCAL_BENCH");
		expect(variables).not.toContain("VERCEL_OIDC_TOKEN");
	});

	test("escapes values for dotenv and Markdown instead of trusting a generic string check", () => {
		expect(renderDotenvValue("https://host/v1#beta")).toBe('"https://host/v1#beta"');
		expect(renderDotenvValue("$EXPAND_ME")).toBe('"\\$EXPAND_ME"');
		expect(escapeMarkdownCell("Vendor | `beta`\nnext")).toBe(
			"Vendor &#124; &#96;beta&#96;<br>next",
		);
	});

	test("keeps every committed managed region byte-identical to the generator", () => {
		for (const [file, expected] of renderProviderWiringFiles()) {
			expect(readFileSync(resolve(REPO_ROOT, file), "utf8"), file).toBe(expected);
		}
	});

	test("keeps the provider-wiring drift check in the required CI job", () => {
		const matches = workflowJobSteps(".github/workflows/ci.yml", "check").filter(
			(step) => step.run === "bun run check:provider-wiring",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.name).toBe("Provider wiring drift");
	});

	test("preserves marker indentation and rejects missing or duplicate markers", () => {
		const region = { file: "fixture.yml", label: "fixture", body: "  generated: true" };
		const source =
			"root:\n  # >>> generated: fixture — bun run generate-provider-wiring\n  old: true\n  # <<< end generated: fixture\n";
		expect(replaceGeneratedRegion(source, region)).toBe(
			"root:\n  # >>> generated: fixture — bun run generate-provider-wiring\n  generated: true\n  # <<< end generated: fixture\n",
		);
		expect(() => replaceGeneratedRegion("root: true\n", region)).toThrow(/missing or malformed/);
		expect(() => replaceGeneratedRegion(`${source}${source}`, region)).toThrow(/exactly once/);
		const prefixed = `${source}# >>> generated: fixture-extra — bun run generate-provider-wiring\n# <<< end generated: fixture-extra\n`;
		expect(replaceGeneratedRegion(prefixed, region)).toContain("generated: true");
	});

	test("requires exact owner-aware pre-auth steps in benchmark, bake, and promote", () => {
		const lanes = [
			{ file: ".github/workflows/bench-suite.yml", job: "bench", lane: "matrix" as const },
			{ file: ".github/workflows/toolchain-image.yml", job: "bake", lane: "matrix" as const },
			{
				file: ".github/workflows/toolchain-image.yml",
				job: "publish",
				lane: "release-scope" as const,
			},
		];
		expect(preAuthBindings().map(({ preAuth }) => preAuth)).toEqual([
			...PROVIDER_PRE_AUTH_POLICIES,
		]);
		for (const binding of preAuthBindings()) {
			const stepId = PROVIDER_PRE_AUTH_CONTRACTS[binding.preAuth].step;
			for (const { file, job, lane } of lanes) {
				const matches = workflowJobSteps(file, job).filter(
					(step) => step.uses === `./.github/actions/${binding.preAuth}`,
				);
				expect(matches, `${binding.preAuth} in ${file} jobs.${job}`).toHaveLength(1);
				expect(matches[0]?.id).toBe(stepId);
				expect(matches[0]?.if).toBe(renderPreAuthCondition(binding.preAuth, lane, "").slice(4));
			}
		}
	});

	test("keeps retired pre-auth actions managed and unconditionally disabled", () => {
		const rendered = renderPreAuthOwnerCondition([], "matrix", "");
		expect(rendered).toBe(`if: \${{ false }}`);
		expect(record(Bun.YAML.parse(rendered), "retired pre-auth condition").if).toBe(`\${{ false }}`);
	});

	test("owns one uniquely labelled region for every generated projection", () => {
		const regions = generatedProviderRegions();
		expect(new Set(regions.map(({ file, label }) => `${file}:${label}`)).size).toBe(regions.length);
		expect(new Set(renderProviderWiringFiles().keys())).toEqual(
			new Set([
				...regions.map(({ file }) => file),
				...renderDriversProvenance().keys(),
				"packages/drivers/src/index.ts",
				"packages/drivers/package.json",
			]),
		);
	});

	test("generates one correlated lazy loader from every unwaived registry id", () => {
		const fleet = driverFleetProjection();
		expect(fleet.moduleIds).toEqual([
			"e2b",
			"daytona-vm",
			"daytona-container",
			"blaxel",
			"modal-gvisor",
			"modal-vm",
			"novita",
			"vercel",
			"tama",
		]);
		expect([...PROVIDER_IDS].filter((id) => fleet.waivers[id] !== undefined)).toEqual([
			"microsandbox-cloud",
			"runloop",
			"namespace",
			"runcloud",
		]);

		const source = renderDriversIndex(fleet.moduleIds);
		const scanned = new Bun.Transpiler({ loader: "ts" }).scan(source);
		expect(scanned.imports.filter(({ kind }) => kind === "import-statement")).toEqual([]);
		expect(scanned.imports).toEqual(
			fleet.moduleIds.map((id) => ({
				kind: "dynamic-import",
				path: driverModuleLocation(id).specifier,
			})),
		);
		for (const id of fleet.moduleIds) {
			expect(source).toContain(`typeof import("${driverModuleLocation(id).specifier}").default`);
			expect(source).toContain(
				`import("${driverModuleLocation(id).specifier}").then((module) => module.default)`,
			);
		}
		for (const id of PROVIDER_IDS) {
			if (fleet.waivers[id] !== undefined)
				expect(source).not.toContain(driverModuleLocation(id).specifier);
		}
	});

	test("rejects digit-shaped waiver expiries that are not real calendar dates", () => {
		const waiver = (expires: string) => ({
			runcloud: { owner: "drivers", reason: "migration pending", expires },
		});
		const beforeLeapDay = Date.UTC(2028, 1, 1);

		expect(() => parseDriverMigrationWaivers(waiver("2026-02-31"), beforeLeapDay)).toThrow(
			/real calendar date/,
		);
		expect(parseDriverMigrationWaivers(waiver("2028-02-29"), beforeLeapDay)).toEqual(
			waiver("2028-02-29"),
		);
	});

	test("projects exact driver provenance from its installation pins", () => {
		const source = [...renderDriversProvenance().values()].join("\n");
		expect(source).toContain("export const E2B_PROVENANCE");
		expect(source).toContain("export const MODAL_PROVENANCE");
		expect(source).toContain("export const TAMA_PROVENANCE");
	});

	test("keeps the fleet manifest free of vendor dependencies and provider subpaths", () => {
		const drivers = record(JSON.parse(renderDriversPackage()), "drivers");
		const dependencies = record(drivers.dependencies, "drivers dependencies");
		expect(dependencies).toEqual(
			Object.fromEntries([
				["@sandbox-benchmarks/driver", "workspace:*"],
				...driverFleetProjection().moduleIds.map((id) => [
					driverModuleLocation(id).packageName,
					"workspace:*",
				]),
			]),
		);
		expect(drivers.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" });
	});
});
