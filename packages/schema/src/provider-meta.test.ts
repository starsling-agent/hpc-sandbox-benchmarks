import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderId } from "./provider-ids.ts";
import { PROVIDER_IDS } from "./provider-ids.ts";
import e2bModule from "./provider-meta/e2b.ts";
import type { BakedProviderId, StockProviderId } from "./provider-meta/index.ts";
import { REGISTRY } from "./provider-meta/index.ts";
import tamaModule from "./provider-meta/tama.ts";
import type { ProviderMetaModule } from "./provider-meta.ts";
import { PROVIDERS } from "./providers.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const META_DIR = resolve(SRC, "provider-meta");
const transpiler = new Bun.Transpiler({ loader: "ts" });

const REQUIRED_INPUTS = {
	e2b: ["E2B_API_KEY"],
	"daytona-vm": ["DAYTONA_API_KEY"],
	"daytona-container": ["DAYTONA_API_KEY"],
	blaxel: ["BL_API_KEY", "BL_WORKSPACE"],
	"microsandbox-cloud": ["MSB_API_KEY"],
	"modal-gvisor": ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
	"modal-vm": ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
	novita: ["NOVITA_API_KEY"],
	runloop: ["RUNLOOP_API_KEY"],
	namespace: ["NSC_TOKEN_FILE"],
	vercel: ["VERCEL_OIDC_TOKEN"],
	runcloud: ["RUN_CLOUD_API_KEY"],
	tama: ["TAMA_TOKEN"],
} as const satisfies Record<ProviderId, readonly string[]>;

const ARTIFACT_KINDS = {
	e2b: "baked",
	"daytona-vm": "baked",
	"daytona-container": "baked",
	blaxel: "none",
	"microsandbox-cloud": "image",
	"modal-gvisor": "image",
	"modal-vm": "image",
	novita: "baked",
	runloop: "baked",
	namespace: "image",
	vercel: "mirror",
	runcloud: "image",
	tama: "image",
} as const satisfies Record<ProviderId, (typeof REGISTRY)[ProviderId]["artifact"]["kind"]>;

const BAKED = {
	e2b: true,
	"daytona-vm": true,
	"daytona-container": true,
	novita: true,
	runloop: true,
} as const satisfies Record<BakedProviderId, true>;

function localRuntimeDependency(importer: string, specifier: string): string | undefined {
	if (specifier.startsWith(".")) return resolve(dirname(importer), specifier);
	if (specifier.startsWith("node:")) return undefined;
	throw new Error(
		`${importer} pulls package ${specifier} into the provider metadata runtime graph`,
	);
}

async function metadataRuntimeGraph(): Promise<Set<string>> {
	const pending = [resolve(META_DIR, "index.ts")];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);
		for (const imported of transpiler.scanImports(await Bun.file(file).text())) {
			const local = localRuntimeDependency(file, imported.path);
			if (local !== undefined) pending.push(local);
		}
	}
	return visited;
}

describe("provider metadata authoring", () => {
	test("one correlated module exists for every provider id", async () => {
		const files = (await readdir(META_DIR))
			.filter((file) => !file.startsWith("_") && file !== "index.ts")
			.sort();
		expect(files).toEqual(PROVIDER_IDS.map((id) => `${id}.ts`).sort());

		for (const id of PROVIDER_IDS) {
			const module = (await import(`./provider-meta/${id}.ts`)) as {
				default: ProviderMetaModule<typeof id>;
			};
			expect(module.default.id).toBe(id);
			expect(module.default.meta).toBe(REGISTRY[id]);
		}
	});

	test("the compatibility projection preserves every existing required-input gate", () => {
		expect(PROVIDERS.map((provider) => provider.id)).toEqual([...PROVIDER_IDS]);
		for (const provider of PROVIDERS) {
			expect(provider.requiredEnvVars).toEqual([...REQUIRED_INPUTS[provider.id]]);
			expect(provider.artifact.kind).toBe(ARTIFACT_KINDS[provider.id]);
		}
	});

	test("normalizes shorthand, optional variables, defaults, and step outputs once", () => {
		expect(PROVIDERS.find((provider) => provider.id === "e2b")?.inputs).toEqual([
			{ name: "E2B_API_KEY", source: { kind: "secret" }, required: true },
			{ name: "E2B_TEMPLATE", source: { kind: "variable" }, required: false },
		]);
		expect(
			PROVIDERS.find((provider) => provider.id === "daytona-container")?.inputs,
		).toContainEqual({
			name: "DAYTONA_CONTAINER_TARGET",
			source: { kind: "variable" },
			required: false,
			default: "us-west-2",
		});
		expect(PROVIDERS.find((provider) => provider.id === "namespace")?.inputs).toEqual([
			{
				name: "NSC_TOKEN_FILE",
				source: { kind: "step-output", step: "namespace", output: "token-file" },
				required: true,
			},
		]);
	});

	test("derives exact artifact partitions and makes no-op bakers unrepresentable", () => {
		expect(Object.keys(BAKED)).toEqual([
			"e2b",
			"daytona-vm",
			"daytona-container",
			"novita",
			"runloop",
		]);
		const acceptBaked = (id: BakedProviderId) => id;
		const acceptStock = (id: StockProviderId) => id;
		expect(acceptBaked("e2b")).toBe("e2b");
		expect(acceptStock("blaxel")).toBe("blaxel");
		// @ts-expect-error blaxel's stock image cannot acquire a no-op baker.
		acceptBaked("blaxel");
		// @ts-expect-error a baked provider cannot enter the stock-image partition.
		acceptStock("e2b");
	});

	test("pins provider-id correlation at compile time", () => {
		const acceptE2b = (module: ProviderMetaModule<"e2b">) => module.id;
		expect(acceptE2b(e2bModule)).toBe("e2b");
		// @ts-expect-error a module declaring tama cannot occupy the e2b registry key.
		acceptE2b(tamaModule);
	});

	test("keeps the complete metadata runtime graph SDK- and arktype-free", async () => {
		const graph = await metadataRuntimeGraph();
		expect([...graph].some((file) => file.endsWith("provider-meta.ts"))).toBe(true);
		expect([...graph].some((file) => file.endsWith("toolchain.ts"))).toBe(true);
	});

	test("package subpaths cannot bypass the metadata-runtime fence", () => {
		for (const specifier of [
			"arktype",
			"arktype/internal",
			"@computesdk/e2b",
			"microsandbox",
			"some-sdk-wrapper",
		]) {
			expect(() => localRuntimeDependency("e2b.ts", specifier)).toThrow(
				/into the provider metadata runtime graph/,
			);
		}
		expect(localRuntimeDependency("index.ts", "node:path")).toBeUndefined();
	});
});
