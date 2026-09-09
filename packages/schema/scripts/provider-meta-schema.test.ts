import { describe, expect, test } from "bun:test";
import type { ProviderId } from "../src/provider-ids.ts";
import { PROVIDER_IDS } from "../src/provider-ids.ts";
import { REGISTRY } from "../src/provider-meta/index.ts";
import { assertProviderIdSyntax, validateProviderModules } from "./provider-meta-schema.ts";

const VALID_MODULES = Object.fromEntries(
	PROVIDER_IDS.map((id) => [id, { id, meta: REGISTRY[id] }]),
) as Record<ProviderId, unknown>;

function replacing(id: ProviderId, module: unknown): Record<ProviderId, unknown> {
	return { ...VALID_MODULES, [id]: module };
}

function meta(id: ProviderId, replacement: Record<string, unknown>): Record<ProviderId, unknown> {
	return replacing(id, { id, meta: { ...REGISTRY[id], ...replacement } });
}

describe("Tier-3 provider metadata schema", () => {
	test("accepts every correlated committed descriptor", () => {
		expect(validateProviderModules(VALID_MODULES)).toBeDefined();
	});

	test("rejects a module whose declared id differs from its generated key", () => {
		expect(() =>
			validateProviderModules(replacing("e2b", { id: "tama", meta: REGISTRY.e2b })),
		).toThrow(/e2b: metadata module declares id tama/);
	});

	test("rejects provider ids that cannot round-trip through generated YAML and argv", () => {
		expect(() => assertProviderIdSyntax(["valid-id", "bad # id"])).toThrow(
			/provider ids must be lowercase kebab-case/,
		);
		expect(() => assertProviderIdSyntax(["Uppercase"])).toThrow(/lowercase kebab-case/);
	});

	test("rejects empty artifact evidence, runner names, and invalid pre-auth policies", () => {
		expect(() =>
			validateProviderModules(meta("vercel", { artifact: { kind: "mirror", repository: "" } })),
		).toThrow(/repository/);
		expect(() =>
			validateProviderModules(meta("microsandbox-cloud", { runner: { label: "", noCache: true } })),
		).toThrow(/label/);
		expect(() => validateProviderModules(meta("vercel", { preAuth: "custom-auth" }))).toThrow(
			/preAuth/,
		);
	});

	test("rejects a pre-auth credential that is declared optional", () => {
		// A pre-auth step mints the credential. Declaring its input optional would let a failed
		// pre-auth pass an empty value to the provider instead of failing the workflow.
		expect(() =>
			validateProviderModules(
				meta("vercel", {
					inputs: [
						{
							name: "VERCEL_OIDC_TOKEN",
							source: { kind: "step-env", step: "vercel-auth" },
							required: false,
						},
					],
				}),
			),
		).toThrow(/VERCEL_OIDC_TOKEN must be required/);
		expect(() =>
			validateProviderModules(
				meta("namespace", {
					inputs: [
						{
							name: "NSC_TOKEN_FILE",
							source: { kind: "step-output", step: "namespace", output: "token-file" },
							required: false,
						},
					],
				}),
			),
		).toThrow(/NSC_TOKEN_FILE must be required/);
	});

	test("rejects malformed, reserved, and same-vendor colliding baked suffixes", () => {
		expect(() =>
			validateProviderModules(
				meta("daytona-container", { artifact: { kind: "baked", nameSuffix: "container" } }),
			),
		).toThrow(/lowercase kebab-case suffix/);
		expect(() =>
			validateProviderModules(
				meta("daytona-container", {
					artifact: { kind: "baked", nameSuffix: "-container-candidate" },
				}),
			),
		).toThrow(/reserved word 'candidate'/);
		expect(() =>
			validateProviderModules(meta("daytona-container", { artifact: { kind: "baked" } })),
		).toThrow(/daytona-vm\/daytona-container.*derive the same release name/);
	});

	test("rejects duplicate, secret-defaulted, and required-defaulted inputs", () => {
		expect(() =>
			validateProviderModules(meta("e2b", { inputs: ["E2B_API_KEY", "E2B_API_KEY"] })),
		).toThrow(/names are unique/);
		expect(() =>
			validateProviderModules(
				meta("e2b", {
					inputs: [{ name: "E2B_TEMPLATE", source: { kind: "secret" }, default: "template" }],
				}),
			),
		).toThrow(/defaults belong only to variable sources/);
		expect(() =>
			validateProviderModules(
				meta("e2b", {
					inputs: [
						{
							name: "E2B_TEMPLATE",
							source: { kind: "variable" },
							required: true,
							default: "template",
						},
					],
				}),
			),
		).toThrow(/not both required and defaulted/);
		expect(() =>
			validateProviderModules(
				meta("e2b", {
					inputs: [{ name: "E2B_API_KEY", source: { kind: "secret" }, ciValue: "fixed" }],
				}),
			),
		).toThrow(/ciValue belongs only to variable sources/);
	});

	test("rejects input names and emitted values that could corrupt workflow expressions", () => {
		expect(() => validateProviderModules(meta("e2b", { inputs: ["bad-name"] }))).toThrow(
			/uppercase environment variable name/,
		);
		expect(() =>
			validateProviderModules(
				meta("e2b", {
					inputs: [
						{
							name: "E2B_TEMPLATE",
							source: { kind: "variable" },
							default: "line one\nline two",
						},
					],
				}),
			),
		).toThrow(/single-line string/);
		expect(() =>
			validateProviderModules(
				meta("vercel", {
					inputs: [
						{
							name: "VERCEL_OIDC_TOKEN",
							source: { kind: "step-env", step: "bad }} || secrets.ESCAPE" },
						},
					],
				}),
			),
		).toThrow(/step\/output property name/);
	});

	test("requires shared input names to use one normalized policy", () => {
		expect(() =>
			validateProviderModules(
				meta("daytona-container", {
					inputs: [
						{ name: "DAYTONA_API_KEY", source: { kind: "variable" } },
						...REGISTRY["daytona-container"].inputs.slice(1),
					],
				}),
			),
		).toThrow(/shared provider input DAYTONA_API_KEY must use one source/);
	});

	test("requires step-provided inputs to match the provider's declared pre-auth step", () => {
		expect(() =>
			validateProviderModules(
				meta("vercel", {
					inputs: [
						{
							name: "VERCEL_OIDC_TOKEN",
							source: { kind: "step-env", step: "namespace" },
						},
					],
				}),
			),
		).toThrow(/preAuth vercel-auth must produce VERCEL_OIDC_TOKEN/);
		expect(() =>
			validateProviderModules(
				meta("e2b", {
					inputs: [
						{
							name: "E2B_API_KEY",
							source: { kind: "step-output", step: "auth", output: "token" },
						},
					],
				}),
			),
		).toThrow(/step-provided inputs require a declared preAuth policy/);
		expect(() =>
			validateProviderModules(meta("vercel", { inputs: ["VERCEL_OIDC_TOKEN"] })),
		).toThrow(/preAuth vercel-auth must produce VERCEL_OIDC_TOKEN/);
		expect(() =>
			validateProviderModules(
				meta("namespace", {
					inputs: [
						{
							name: "NSC_TOKEN_FILE",
							source: { kind: "step-output", step: "namespace", output: "missing" },
						},
					],
				}),
			),
		).toThrow(/preAuth namespace-token must produce NSC_TOKEN_FILE.*output token-file/);
		expect(() =>
			validateProviderModules(
				meta("vercel", {
					inputs: [
						{
							name: "ACME_TOKEN",
							source: { kind: "step-env", step: "vercel-auth" },
						},
					],
				}),
			),
		).toThrow(/preAuth vercel-auth must produce VERCEL_OIDC_TOKEN/);
	});

	test("requires providers sharing a runner label to share its complete policy", () => {
		const modules = meta("e2b", {
			runner: { label: "shared-runner", noCache: false, lifetimeMinutes: 70 },
		});
		modules["microsandbox-cloud"] = {
			id: "microsandbox-cloud",
			meta: {
				...REGISTRY["microsandbox-cloud"],
				runner: { label: "shared-runner", noCache: true, lifetimeMinutes: 70 },
			},
		};
		expect(() => validateProviderModules(modules)).toThrow(
			/shared runner shared-runner must use one cache\/lifetime policy/,
		);
	});

	test("rejects malformed transport and pricing before generation", () => {
		expect(() =>
			validateProviderModules(
				meta("e2b", {
					transport: { streaming: false, syncCapMs: Number.POSITIVE_INFINITY, detachedPoll: true },
				}),
			),
		).toThrow(/syncCapMs/);
		expect(() =>
			validateProviderModules(
				meta("e2b", {
					pricing: { ...REGISTRY.e2b.pricing, components: [] },
				}),
			),
		).toThrow(/components/);
	});

	test("requires isolation variants to share pricing by object identity", () => {
		expect(() =>
			validateProviderModules(
				meta("daytona-container", {
					pricing: structuredClone(REGISTRY["daytona-container"].pricing),
				}),
			),
		).toThrow(/daytona-vm\/daytona-container: isolation variants must share one pricing object/);
	});
});
