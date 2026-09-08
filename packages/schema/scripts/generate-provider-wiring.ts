#!/usr/bin/env bun
// Generate marker-delimited provider wiring from the validated metadata registry (ADR-0006).
// Workflows keep their hand-tuned control flow; only mechanical provider choices/input projections
// live here. Adding a provider changes its descriptor and this reviewed output, not six dialects.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderId } from "../src/provider-ids.ts";
import { PROVIDER_IDS } from "../src/provider-ids.ts";
import { REGISTRY } from "../src/provider-meta/index.ts";
import type {
	NormalizedProviderInput,
	ProviderMetaSource,
	ProviderPreAuth,
	ProviderRunnerPolicy,
} from "../src/provider-meta.ts";
import { normalizeProviderInput, PROVIDER_PRE_AUTH_POLICIES } from "../src/provider-meta.ts";
import { validateProviderModules } from "./provider-meta-schema.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const GENERATOR_COMMAND = "bun run generate-provider-wiring";

export interface InputBinding {
	readonly input: NormalizedProviderInput;
	readonly owners: readonly ProviderId[];
}

export interface PreAuthBinding {
	readonly preAuth: ProviderPreAuth;
	readonly owners: readonly ProviderId[];
}

export interface RunnerBinding {
	readonly policy: ProviderRunnerPolicy;
	readonly owners: readonly ProviderId[];
}

export type WiringLane = "matrix" | "release-scope";

export interface DriverMigrationWaiver {
	readonly owner: string;
	readonly reason: string;
	readonly expires: string;
}

export interface DriverFleetProjection {
	readonly moduleIds: readonly ProviderId[];
	readonly waivers: Readonly<Partial<Record<ProviderId, DriverMigrationWaiver>>>;
}

function providerMeta(id: ProviderId): ProviderMetaSource {
	return REGISTRY[id];
}

export interface GeneratedRegion {
	readonly file: string;
	readonly label: string;
	readonly body: string;
}

function generatedStart(region: GeneratedRegion): string {
	const marker = `>>> generated: ${region.label} — ${GENERATOR_COMMAND}`;
	return region.file.endsWith(".md") ? `<!-- ${marker} -->` : `# ${marker}`;
}

function generatedEnd(region: GeneratedRegion): string {
	const marker = `<<< end generated: ${region.label}`;
	return region.file.endsWith(".md") ? `<!-- ${marker} -->` : `# ${marker}`;
}

function exactMarkerIndices(source: string, marker: string): number[] {
	const indices: number[] = [];
	let offset = 0;
	for (const line of source.split("\n")) {
		const indent = line.length - line.trimStart().length;
		if (line.slice(indent) === marker) indices.push(offset + indent);
		offset += line.length + 1;
	}
	return indices;
}

export function replaceGeneratedRegion(source: string, region: GeneratedRegion): string {
	const start = generatedStart(region);
	const end = generatedEnd(region);
	const starts = exactMarkerIndices(source, start);
	const ends = exactMarkerIndices(source, end);
	const startIndex = starts[0];
	const endIndex = ends[0];
	if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
		throw new Error(`${region.file}: missing or malformed generated region ${region.label}`);
	}
	if (starts.length !== 1 || ends.length !== 1) {
		throw new Error(`${region.file}: generated region ${region.label} must occur exactly once`);
	}
	const bodyStart = startIndex + start.length;
	const lineStart = source.lastIndexOf("\n", startIndex - 1) + 1;
	const indent = source.slice(lineStart, startIndex);
	return `${source.slice(0, bodyStart)}\n${region.body}\n${indent}${source.slice(endIndex)}`;
}

export function providerInputBindings(): InputBinding[] {
	const byName = new Map<string, { input: NormalizedProviderInput; owners: ProviderId[] }>();
	for (const id of PROVIDER_IDS) {
		for (const raw of REGISTRY[id].inputs) {
			const input = normalizeProviderInput(raw);
			const existing = byName.get(input.name);
			if (existing === undefined) byName.set(input.name, { input, owners: [id] });
			else existing.owners.push(id);
		}
	}
	return [...byName.values()];
}

export function preAuthBindings(): PreAuthBinding[] {
	const bindings = new Map<ProviderPreAuth, ProviderId[]>(
		PROVIDER_PRE_AUTH_POLICIES.map((preAuth): [ProviderPreAuth, ProviderId[]] => [preAuth, []]),
	);
	for (const id of PROVIDER_IDS) {
		const preAuth = providerMeta(id).preAuth;
		if (preAuth === undefined) continue;
		const owners = bindings.get(preAuth) ?? [];
		owners.push(id);
		bindings.set(preAuth, owners);
	}
	return [...bindings].map(([preAuth, owners]) => ({ preAuth, owners }));
}

export function runnerBindings(): RunnerBinding[] {
	const bindings = new Map<string, { policy: ProviderRunnerPolicy; owners: ProviderId[] }>();
	for (const id of PROVIDER_IDS) {
		const runner = providerMeta(id).runner;
		if (runner === undefined) continue;
		const signature = JSON.stringify(runner);
		const existing = bindings.get(signature);
		if (existing === undefined) bindings.set(signature, { policy: runner, owners: [id] });
		else existing.owners.push(id);
	}
	return [...bindings.values()];
}

function ghaString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function ownerCondition(owners: readonly ProviderId[], lane: WiringLane): string {
	const clauses = owners.map((id) =>
		lane === "matrix"
			? `matrix.provider == ${ghaString(id)}`
			: `contains(fromJSON(needs.plan.outputs.matrix).include.*.provider, ${ghaString(id)})`,
	);
	return clauses.length === 1 ? (clauses[0] ?? "false") : `(${clauses.join(" || ")})`;
}

export function renderPreAuthOwnerCondition(
	owners: readonly ProviderId[],
	lane: WiringLane,
	indent = "        ",
): string {
	if (owners.length === 0) return `${indent}if: \${{ false }}`;
	return `${indent}if: ${ownerCondition(owners, lane)}`;
}

export function renderPreAuthCondition(
	preAuth: ProviderPreAuth,
	lane: WiringLane,
	indent = "        ",
): string {
	const binding = preAuthBindings().find((candidate) => candidate.preAuth === preAuth);
	if (binding === undefined) throw new Error(`unsupported pre-auth policy ${preAuth}`);
	return renderPreAuthOwnerCondition(binding.owners, lane, indent);
}

function inputValue(input: NormalizedProviderInput): string {
	if (input.ciValue !== undefined) return ghaString(input.ciValue);
	switch (input.source.kind) {
		case "secret":
			return `secrets.${input.name}`;
		case "step-env":
			return `steps.${input.source.step}.outcome == 'success' && env.${input.name}`;
		case "step-output":
			return `steps.${input.source.step}.outputs.${input.source.output}`;
		case "variable": {
			// `env` covers pre-auth composites (Vercel), `vars` is the intended ordinary-value home,
			// and `secrets` is a compatibility fallback while existing installations migrate targets and
			// endpoint overrides out of their Environment secret store.
			const candidates = [`env.${input.name}`, `vars.${input.name}`, `secrets.${input.name}`];
			if (input.default !== undefined) candidates.push(ghaString(input.default));
			return candidates.join(" || ");
		}
	}
}

export function renderWorkflowInputs(lane: WiringLane, indent = "          "): string {
	return providerInputBindings()
		.map(({ input, owners }) => {
			if (input.source.kind === "step-output") {
				return `${indent}${input.name}: \${{ ${inputValue(input)} }}`;
			}
			const condition = ownerCondition(owners, lane);
			const value = inputValue(input);
			const selectedValue = value.includes(" || ") ? `(${value})` : value;
			return `${indent}${input.name}: \${{ ${condition} && ${selectedValue} || '' }}`;
		})
		.join("\n");
}

export function renderSmokeProviderOptions(indent = "          "): string {
	return PROVIDER_IDS.map((id) => `${indent}- ${ghaString(id)}`).join("\n");
}

export function renderRunnerSelection(): string {
	const routed = PROVIDER_IDS.filter((id) => providerMeta(id).runner !== undefined);
	const clauses = routed.map(
		(id) =>
			`matrix.provider == ${ghaString(id)} && ${ghaString(providerMeta(id).runner?.label ?? "")}`,
	);
	return `    runs-on: \${{ ${[...clauses, ghaString("ubuntu-24.04")].join(" || ")} }}`;
}

export function renderRunnerNoCache(indent = "          "): string {
	const owners = runnerBindings()
		.filter(({ policy }) => policy.noCache)
		.flatMap(({ owners: policyOwners }) => policyOwners);
	const condition = owners.length === 0 ? "false" : ownerCondition(owners, "matrix");
	return `${indent}no-cache: \${{ ${condition} && 'true' || 'false' }}`;
}

export function renderRunnerLifetime(indent = "          "): string {
	const clauses = runnerBindings().flatMap(({ policy, owners }) =>
		policy.lifetimeMinutes === undefined
			? []
			: [`${ownerCondition(owners, "matrix")} && ${ghaString(String(policy.lifetimeMinutes))}`],
	);
	return `${indent}BENCH_RUNNER_LIFETIME_MINUTES: \${{ ${[...clauses, "''"].join(" || ")} }}`;
}

function oneLineComment(value: string): string {
	return value.replace(/[\r\n]+/g, " ");
}

export function renderDotenvValue(value: string): string {
	if (/^[A-Za-z0-9_./:@+%-]+$/.test(value) && !value.includes("#")) return value;
	return JSON.stringify(value).replaceAll("$", "\\$");
}

export function escapeMarkdownCell(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("|", "&#124;")
		.replaceAll("`", "&#96;")
		.replace(/\r?\n/g, "<br>");
}

export function renderEnvExample(): string {
	const bindings = providerInputBindings();
	const lines: string[] = [];
	for (const id of PROVIDER_IDS) {
		const owned = bindings.filter(({ owners }) => owners[0] === id);
		if (owned.length === 0) continue;
		lines.push(
			`# --- ${oneLineComment(REGISTRY[id].displayName)} (${oneLineComment(REGISTRY[id].website)}) ---`,
		);
		for (const { input, owners } of owned) {
			if (owners.length > 1) {
				lines.push(
					`# Shared by: ${owners.map((owner) => oneLineComment(REGISTRY[owner].displayName)).join(", ")}`,
				);
			}
			if (!input.required)
				lines.push("# Optional override; leave empty to use the provider default.");
			if (input.ciValue !== undefined) {
				lines.push(`# CI injects ${input.ciValue}; set locally only on a compatible runner.`);
			}
			lines.push(
				`${input.name}=${input.default === undefined ? "" : renderDotenvValue(input.default)}`,
			);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export function renderCiSecretTable(): string {
	const rows = providerInputBindings()
		.filter(({ input }) => input.source.kind === "secret")
		.map(({ input, owners }) => {
			const providers = owners.map((id) => escapeMarkdownCell(REGISTRY[id].displayName)).join(", ");
			return `   | \`${input.name}\` | ${providers} provider runtime and validation |`;
		})
		.join("\n");
	return `   | Secret | Used by |\n   | --- | --- |\n${rows}`;
}

export function renderCiVariableTable(): string {
	const rows = providerInputBindings()
		.filter(({ input }) => input.source.kind === "variable" && input.ciValue === undefined)
		.map(({ input, owners }) => {
			const providers = owners.map((id) => escapeMarkdownCell(REGISTRY[id].displayName)).join(", ");
			const defaultValue =
				input.default === undefined ? "—" : `<code>${escapeMarkdownCell(input.default)}</code>`;
			return `   | \`${input.name}\` | ${providers} | ${defaultValue} |`;
		})
		.join("\n");
	return `   | Variable | Used by | Default |\n   | --- | --- | --- |\n${rows}`;
}

export function renderSetupSecretChecklist(): string {
	const names = providerInputBindings()
		.filter(({ input }) => input.source.kind === "secret")
		.map(({ input }) => input.name);
	const chunks: string[][] = [];
	for (let index = 0; index < names.length; index += 4) chunks.push(names.slice(index, index + 4));
	return chunks.map((chunk) => `echo "  ${chunk.join(", ")}"`).join("\n");
}

export function generatedProviderRegions(): GeneratedRegion[] {
	const preAuthRegions = preAuthBindings().flatMap(({ preAuth }) => [
		{
			file: ".github/workflows/bench-suite.yml",
			label: `preauth-${preAuth}-bench`,
			body: renderPreAuthCondition(preAuth, "matrix"),
		},
		{
			file: ".github/workflows/toolchain-image.yml",
			label: `preauth-${preAuth}-bake`,
			body: renderPreAuthCondition(preAuth, "matrix"),
		},
		{
			file: ".github/workflows/toolchain-image.yml",
			label: `preauth-${preAuth}-promote`,
			body: renderPreAuthCondition(preAuth, "release-scope"),
		},
	]);
	return [
		{
			file: ".github/workflows/bench-smoke.yml",
			label: "provider-options",
			body: renderSmokeProviderOptions(),
		},
		{
			file: ".github/workflows/bench-suite.yml",
			label: "provider-runner",
			body: renderRunnerSelection(),
		},
		{
			file: ".github/workflows/bench-suite.yml",
			label: "provider-runner-cache",
			body: renderRunnerNoCache(),
		},
		{
			file: ".github/workflows/bench-suite.yml",
			label: "provider-runner-lifetime",
			body: renderRunnerLifetime(),
		},
		...preAuthRegions,
		{
			file: ".github/workflows/bench-suite.yml",
			label: "provider-inputs-bench",
			body: renderWorkflowInputs("matrix"),
		},
		{
			file: ".github/workflows/toolchain-image.yml",
			label: "provider-inputs-bake",
			body: renderWorkflowInputs("matrix"),
		},
		{
			file: ".github/workflows/toolchain-image.yml",
			label: "provider-inputs-promote",
			body: renderWorkflowInputs("release-scope"),
		},
		{ file: ".env.example", label: "provider-inputs-local", body: renderEnvExample() },
		{ file: "docs/ci-secrets.md", label: "provider-secrets", body: renderCiSecretTable() },
		{ file: "docs/ci-secrets.md", label: "provider-variables", body: renderCiVariableTable() },
		{
			file: "scripts/setup-privileged-environment.sh",
			label: "provider-secret-checklist",
			body: renderSetupSecretChecklist(),
		},
	];
}

interface RootWorkspaceManifest {
	readonly workspaces?: {
		readonly catalogs?: {
			readonly computesdk?: Readonly<Record<string, string>>;
		};
	};
}

function mapping(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a mapping`);
	}
	return value as Record<string, unknown>;
}

function exactVersion(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
			value,
		)
	) {
		throw new Error(`${label} must be an exact semantic version`);
	}
	return value;
}

function providerCatalog(root: string): Readonly<Record<string, string>> {
	const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as
		| RootWorkspaceManifest
		| undefined;
	const catalog = rootManifest?.workspaces?.catalogs?.computesdk;
	if (catalog === undefined || Object.keys(catalog).length === 0) {
		throw new Error("package.json: workspaces.catalogs.computesdk must be a non-empty mapping");
	}
	for (const [name, version] of Object.entries(catalog)) {
		if (name.length === 0) {
			throw new Error("package.json: provider catalog package names must be non-empty");
		}
		exactVersion(version, `package.json: workspaces.catalogs.computesdk[${JSON.stringify(name)}]`);
	}
	return catalog;
}

function catalogVersion(catalog: Readonly<Record<string, string>>, packageName: string): string {
	return exactVersion(
		catalog[packageName],
		`package.json: workspaces.catalogs.computesdk[${JSON.stringify(packageName)}]`,
	);
}

function tamaCliVersion(root: string): string {
	const file = ".github/actions/setup-tama/action.yml";
	const action = mapping(Bun.YAML.parse(readFileSync(resolve(root, file), "utf8")), file);
	const inputs = mapping(action.inputs, `${file}: inputs`);
	const version = mapping(inputs.version, `${file}: inputs.version`);
	return exactVersion(version.default, `${file}: inputs.version.default`);
}

/** Generate runtime provenance from the same exact pins that install each integration. */
export function renderDriversProvenance(root = REPO_ROOT): string {
	const catalog = providerCatalog(root);
	const entries = [
		["E2B", REGISTRY.e2b.sdkPackage, catalogVersion(catalog, REGISTRY.e2b.sdkPackage)],
		[
			"MODAL",
			REGISTRY["modal-vm"].sdkPackage,
			catalogVersion(catalog, REGISTRY["modal-vm"].sdkPackage),
		],
		// Cost-evidence consumers retain their explicit native-SDK provenance alias.
		["MODAL_NATIVE", "modal", catalogVersion(catalog, "modal")],
		["TAMA", "tama CLI", tamaCliVersion(root)],
		["NOVITA", "novita-sandbox", catalogVersion(catalog, "novita-sandbox")],
	] as const;
	const constants = entries
		.map(
			([name, packageName, version]) =>
				`export const ${name}_PROVENANCE = Object.freeze({\n\tpackageName: ${JSON.stringify(packageName)},\n\tversion: ${JSON.stringify(version)},\n});`,
		)
		.join("\n\n");
	return `// GENERATED by packages/schema/scripts/generate-provider-wiring.ts. Do not edit.\n// Versions come from the root provider catalog and the checksum-pinned Tama setup action.\n\n${constants}\n`;
}

export function parseDriverMigrationWaivers(
	value: unknown,
	nowMs = Date.now(),
	file = "packages/drivers/migration-waivers.json",
): Partial<Record<ProviderId, DriverMigrationWaiver>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${file}: expected a provider-id mapping`);
	}
	const knownIds = new Set<string>(PROVIDER_IDS);
	const waivers: Partial<Record<ProviderId, DriverMigrationWaiver>> = {};
	for (const [id, raw] of Object.entries(value)) {
		if (!knownIds.has(id)) throw new Error(`${file}: ${id} is not a registered provider id`);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`${file}: ${id} waiver must be an object`);
		}
		const record = raw as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (keys.join(",") !== "expires,owner,reason") {
			throw new Error(`${file}: ${id} waiver must contain exactly owner, reason, and expires`);
		}
		const { owner, reason, expires } = record;
		if (typeof owner !== "string" || owner.trim().length === 0) {
			throw new Error(`${file}: ${id} waiver owner must be non-empty`);
		}
		if (typeof reason !== "string" || reason.trim().length === 0) {
			throw new Error(`${file}: ${id} waiver reason must be non-empty`);
		}
		if (typeof expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
			throw new Error(`${file}: ${id} waiver expiry must be YYYY-MM-DD`);
		}
		const expiry = new Date(`${expires}T23:59:59.999Z`);
		if (Number.isNaN(expiry.valueOf()) || expiry.toISOString().slice(0, 10) !== expires) {
			throw new Error(`${file}: ${id} waiver expiry must be a real calendar date`);
		}
		if (expiry.valueOf() < nowMs) {
			throw new Error(`${file}: ${id} migration waiver expired on ${expires}`);
		}
		waivers[id as ProviderId] = { owner, reason, expires };
	}
	return waivers;
}

function driverMigrationWaivers(root: string): Partial<Record<ProviderId, DriverMigrationWaiver>> {
	const file = "packages/drivers/migration-waivers.json";
	return parseDriverMigrationWaivers(JSON.parse(readFileSync(resolve(root, file), "utf8")));
}

/**
 * Validate the migration boundary without importing a driver or evaluating a vendor SDK. Every
 * registered id has exactly one state: a concrete default-export module, or a temporary committed
 * waiver. Removing a file therefore fails instead of silently shrinking the generated loader.
 */
export function driverFleetProjection(root = REPO_ROOT): DriverFleetProjection {
	const waivers = driverMigrationWaivers(root);
	const moduleIds = PROVIDER_IDS.filter((id) => waivers[id] === undefined);
	const sourceDirectory = resolve(root, "packages/drivers/src");
	const sourceFiles = new Set(readdirSync(sourceDirectory));
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	for (const id of PROVIDER_IDS) {
		const filename = `${id}.ts`;
		const waived = waivers[id];
		if (waived !== undefined) {
			if (sourceFiles.has(filename)) {
				throw new Error(
					`packages/drivers/src/${filename}: remove the migration waiver now that the module exists`,
				);
			}
			continue;
		}
		if (!sourceFiles.has(filename)) {
			throw new Error(
				`packages/drivers/src/${filename}: missing driver module or migration waiver`,
			);
		}
		const source = readFileSync(resolve(sourceDirectory, filename), "utf8");
		if (!transpiler.scan(source).exports.includes("default")) {
			throw new Error(`packages/drivers/src/${filename}: driver module must default-export`);
		}
	}
	for (const filename of sourceFiles) {
		if (
			filename === "index.ts" ||
			filename.startsWith("_") ||
			filename.endsWith(".test.ts") ||
			!filename.endsWith(".ts")
		) {
			continue;
		}
		const id = filename.slice(0, -3);
		if (!moduleIds.includes(id as ProviderId)) {
			throw new Error(
				`packages/drivers/src/${filename}: public driver filename is not an unwaived ProviderId`,
			);
		}
	}
	return { moduleIds, waivers };
}

function tsProperty(id: ProviderId): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id) ? id : JSON.stringify(id);
}

/** The root entry contains only the correlated lazy loader; every specifier stays statically known. */
export function renderDriversIndex(moduleIds: readonly ProviderId[]): string {
	const map = moduleIds
		.map((id) => `\t${tsProperty(id)}: typeof import("./${id}.ts").default;`)
		.join("\n");
	const loaders = moduleIds
		.map(
			(id) => `\t${tsProperty(id)}: () => import("./${id}.ts").then((module) => module.default),`,
		)
		.join("\n");
	return `// GENERATED by packages/schema/scripts/generate-provider-wiring.ts. Do not edit.\n// Registered providers omitted here must have a live entry in ../migration-waivers.json.\n\nimport type { DriverModule, ProviderId } from "@sandbox-benchmarks/driver";\n\nexport interface DriverModuleMap {\n${map}\n}\n\ntype Assert<Condition extends true> = Condition;\ntype _EveryDriverIdIsRegistered = Assert<keyof DriverModuleMap extends ProviderId ? true : false>;\n\nexport type DriverProviderId = keyof DriverModuleMap;\ntype DriverModuleConformance = {\n\t[P in DriverProviderId]: DriverModuleMap[P] extends DriverModule<P, infer _Handle> ? true : false;\n};\ntype _EveryDriverModuleMatchesItsId = Assert<\n\tDriverModuleConformance[DriverProviderId] extends true ? true : false\n>;\n\nexport const DRIVERS: {\n\treadonly [P in DriverProviderId]: () => Promise<DriverModuleMap[P]>;\n} = Object.freeze({\n${loaders}\n});\n\nexport const loadDriverModule = <P extends DriverProviderId>(id: P): Promise<DriverModuleMap[P]> =>\n\tDRIVERS[id]();\n`;
}

/**
 * The fleet owns every provider SDK while the root catalog owns their exact versions. Project the
 * whole provider catalog into the private fleet package so migrating or adding a driver never adds
 * a fourth handwritten package-manifest edit. The forthcoming new-provider scaffold owns adding a
 * new version pin to the root catalog; this reviewed file is its generated consumer.
 */
export function renderDriversPackage(
	root = REPO_ROOT,
	moduleIds = driverFleetProjection(root).moduleIds,
): string {
	const catalog = providerCatalog(root);

	const file = "packages/drivers/package.json";
	const manifest = JSON.parse(readFileSync(resolve(root, file), "utf8")) as Record<string, unknown>;
	manifest.exports = {
		".": "./src/index.ts",
		...Object.fromEntries(moduleIds.map((id) => [`./${id}`, `./src/${id}.ts`])),
		"./package.json": "./package.json",
	};
	const dependencies: Array<readonly [string, string]> = [
		...Object.keys(catalog).map((name): [string, string] => [name, "catalog:computesdk"]),
		["@sandbox-benchmarks/driver", "workspace:*"],
		["arktype", "catalog:"],
	];
	dependencies.sort((left, right) => left[0].localeCompare(right[0]));
	manifest.dependencies = Object.fromEntries(dependencies);
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderProviderWiringFiles(root = REPO_ROOT): Map<string, string> {
	// The same Tier-3 boundary that guards registry generation runs before wiring emission.
	validateProviderModules(
		Object.fromEntries(PROVIDER_IDS.map((id) => [id, { id, meta: REGISTRY[id] }])) as Record<
			ProviderId,
			unknown
		>,
	);
	const rendered = new Map<string, string>();
	const fleet = driverFleetProjection(root);
	for (const region of generatedProviderRegions()) {
		const source = rendered.get(region.file) ?? readFileSync(resolve(root, region.file), "utf8");
		rendered.set(region.file, replaceGeneratedRegion(source, region));
	}
	rendered.set("packages/drivers/src/_provenance.ts", renderDriversProvenance(root));
	rendered.set("packages/drivers/src/index.ts", renderDriversIndex(fleet.moduleIds));
	rendered.set("packages/drivers/package.json", renderDriversPackage(root, fleet.moduleIds));
	return rendered;
}

export async function generateProviderWiring(root = REPO_ROOT): Promise<void> {
	const rendered = renderProviderWiringFiles(root);
	for (const [file, content] of rendered) {
		await Bun.write(resolve(root, file), content);
	}
	console.log(`✓ generated provider wiring in ${rendered.size} files`);
}

if (import.meta.main) {
	try {
		await generateProviderWiring();
	} catch (error) {
		console.error("generate-provider-wiring failed:", error);
		process.exit(1);
	}
}
