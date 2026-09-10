// Tier-3 provider metadata validation. This deliberately lives beside the generator: committed
// descriptor modules stay inert and arktype-free, while generation pays the boundary-schema cost
// once and refuses to emit wiring from malformed metadata (ADR-0006).
import { type } from "arktype";
import type { ProviderId } from "../src/provider-ids.ts";
import { PROVIDER_IDS } from "../src/provider-ids.ts";
import type { NormalizedProviderInput, ProviderMetaModule } from "../src/provider-meta.ts";
import {
	normalizeProviderInput,
	PROVIDER_PRE_AUTH_CONTRACTS,
	PROVIDER_PRE_AUTH_POLICIES,
} from "../src/provider-meta.ts";
import { providerPricingSchema } from "../src/provider-pricing.ts";

const nonemptyStringSchema = type("string >= 1");
const singleLineStringSchema = nonemptyStringSchema.narrow((value, ctx) =>
	/[\r\n]/.test(value) ? ctx.mustBe("a non-empty single-line string") : true,
);
const environmentNameSchema = nonemptyStringSchema.narrow((value, ctx) =>
	/^[A-Z][A-Z0-9_]*$/.test(value)
		? true
		: ctx.mustBe("an uppercase environment variable name (for example PROVIDER_API_KEY)"),
);
const stepPropertySchema = nonemptyStringSchema.narrow((value, ctx) =>
	/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)
		? true
		: ctx.mustBe("a GitHub Actions step/output property name"),
);
// Names an Actions concurrency group and a journal branch, so it carries the identifier grammar the
// experiment plan already enforces on its quota domains.
const quotaDomainSchema = nonemptyStringSchema.narrow((value, ctx) =>
	/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
		? true
		: ctx.mustBe("a quota domain identifier (letters, digits, '.', '_', '-')"),
);
const finitePositiveNumberSchema = type("number > 0").narrow(Number.isFinite);
const httpUrlSchema = type("string.url").narrow((value) => {
	const protocol = new URL(value).protocol;
	return protocol === "http:" || protocol === "https:";
});

const secretInputSourceSchema = type({ kind: "'secret'" }).onUndeclaredKey("reject");
const variableInputSourceSchema = type({ kind: "'variable'" }).onUndeclaredKey("reject");
const stepEnvInputSourceSchema = type({
	kind: "'step-env'",
	step: stepPropertySchema,
}).onUndeclaredKey("reject");
const stepOutputInputSourceSchema = type({
	kind: "'step-output'",
	step: stepPropertySchema,
	output: stepPropertySchema,
}).onUndeclaredKey("reject");
const inputSourceSchema = secretInputSourceSchema
	.or(variableInputSourceSchema)
	.or(stepEnvInputSourceSchema)
	.or(stepOutputInputSourceSchema);
const inputDescriptorSchema = type({
	name: environmentNameSchema,
	"source?": inputSourceSchema,
	"required?": "boolean",
	"default?": singleLineStringSchema,
	"ciValue?": singleLineStringSchema,
}).onUndeclaredKey("reject");
const providerInputSchema = environmentNameSchema.or(inputDescriptorSchema);

const noArtifactSchema = type({ kind: "'none'" }).onUndeclaredKey("reject");
const imageArtifactSchema = type({ kind: "'image'" }).onUndeclaredKey("reject");
const bakedNameSuffixSchema = nonemptyStringSchema.narrow((suffix, ctx) => {
	if (!/^-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suffix)) {
		return ctx.mustBe("a lowercase kebab-case suffix beginning with '-' (for example -container)");
	}
	if (suffix.endsWith("-candidate")) {
		return ctx.mustBe("a suffix whose final segment is not the reserved word 'candidate'");
	}
	return true;
});
const bakedArtifactSchema = type({
	kind: "'baked'",
	"nameSuffix?": bakedNameSuffixSchema,
}).onUndeclaredKey("reject");
const mirrorArtifactSchema = type({
	kind: "'mirror'",
	repository: nonemptyStringSchema,
}).onUndeclaredKey("reject");
const builtArtifactSchema = type({
	kind: "'built'",
	recipe: nonemptyStringSchema,
}).onUndeclaredKey("reject");
const providerArtifactSchema = noArtifactSchema
	.or(imageArtifactSchema)
	.or(bakedArtifactSchema)
	.or(mirrorArtifactSchema)
	.or(builtArtifactSchema);

export const providerMetaSourceSchema = type({
	displayName: nonemptyStringSchema,
	vendor: nonemptyStringSchema,
	"quotaDomain?": quotaDomainSchema,
	website: httpUrlSchema,
	sdkPackage: nonemptyStringSchema,
	artifact: providerArtifactSchema,
	inputs: providerInputSchema.array().atLeastLength(1),
	isolation: type({
		technology: nonemptyStringSchema,
		class: "'microVM' | 'container' | 'userspace' | 'unknown'",
		"notes?": nonemptyStringSchema,
	}).onUndeclaredKey("reject"),
	pricing: providerPricingSchema,
	maturity: type({
		status: "'ga' | 'beta' | 'unknown'",
		"notes?": nonemptyStringSchema,
	}).onUndeclaredKey("reject"),
	specPinning: "'settable' | 'fixed' | 'unknown'",
	transport: type({
		streaming: "boolean",
		syncCapMs: finitePositiveNumberSchema.or("null"),
		detachedPoll: "boolean",
	}).onUndeclaredKey("reject"),
	"runtimeIdentity?": "'root' | 'unprivileged'",
	"runner?": type({
		label: singleLineStringSchema,
		noCache: "boolean",
		"lifetimeMinutes?": "number.integer > 0",
	}).onUndeclaredKey("reject"),
	"preAuth?": type.enumerated(...PROVIDER_PRE_AUTH_POLICIES),
})
	.onUndeclaredKey("reject")
	.narrow((meta, ctx) => {
		const names = new Set<string>();
		for (const raw of meta.inputs) {
			const name = typeof raw === "string" ? raw : raw.name;
			if (names.has(name)) {
				return ctx.mustBe(`provider inputs whose names are unique (duplicate: ${name})`);
			}
			names.add(name);
			if (typeof raw === "string") continue;
			const sourceKind = raw.source?.kind ?? "secret";
			if (raw.default !== undefined) {
				if (sourceKind !== "variable") {
					return ctx.mustBe(
						`provider inputs whose defaults belong only to variable sources (${name})`,
					);
				}
				if (raw.required === true) {
					return ctx.mustBe(`provider inputs that are not both required and defaulted (${name})`);
				}
			}
			if (raw.ciValue !== undefined && sourceKind !== "variable") {
				return ctx.mustBe(
					`provider inputs whose ciValue belongs only to variable sources (${name})`,
				);
			}
		}
		return true;
	});

const providerMetaModuleSchema = type({
	id: type.enumerated(...PROVIDER_IDS),
	meta: providerMetaSourceSchema,
}).onUndeclaredKey("reject");

export type CorrelatedProviderModules = {
	[P in ProviderId]: ProviderMetaModule<P>;
};

type StepProvidedInput = Omit<NormalizedProviderInput, "source"> & {
	readonly source: Extract<
		NormalizedProviderInput["source"],
		{ readonly kind: "step-env" | "step-output" }
	>;
};

const SHARED_VARIANT_GROUPS = [
	["daytona-vm", "daytona-container"],
	["modal-gvisor", "modal-vm"],
] as const;

export function assertProviderIdSyntax(ids: readonly string[] = PROVIDER_IDS): void {
	for (const id of ids) {
		if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
			throw new Error(
				`${id}: provider ids must be lowercase kebab-case so argv, env, and generated YAML share one spelling`,
			);
		}
	}
}

/** Parse all discovered modules and enforce the few cross-module invariants identity cannot express. */
export function validateProviderModules(
	modules: Readonly<Record<ProviderId, unknown>>,
): CorrelatedProviderModules {
	assertProviderIdSyntax();
	const parsed = {} as Record<ProviderId, ProviderMetaModule<ProviderId>>;
	for (const expectedId of PROVIDER_IDS) {
		const result = providerMetaModuleSchema(modules[expectedId]);
		if (result instanceof type.errors) {
			throw new Error(`${expectedId}: invalid provider metadata: ${result.summary}`);
		}
		if (result.id !== expectedId) {
			throw new Error(
				`${expectedId}: metadata module declares id ${result.id}; filename, generated key, and id must match`,
			);
		}
		parsed[expectedId] = result as ProviderMetaModule<ProviderId>;
	}

	for (const group of SHARED_VARIANT_GROUPS) {
		const [first, ...rest] = group;
		for (const id of rest) {
			if (parsed[first].meta.pricing !== parsed[id].meta.pricing) {
				throw new Error(`${group.join("/")}: isolation variants must share one pricing object`);
			}
		}
	}

	// Baked artifacts share one canonical base name. Separate vendors own separate control-plane
	// namespaces and may safely reuse it (e2b/Novita/Runloop do); variants of the same vendor do not.
	// Their declared suffix is therefore the collision key that keeps bake/promote from overwriting a
	// sibling artifact while validating a different one.
	const bakedNamesByVendor = new Map<string, Map<string, ProviderId>>();
	for (const id of PROVIDER_IDS) {
		const { artifact, vendor } = parsed[id].meta;
		if (artifact.kind !== "baked") continue;
		const suffix = artifact.nameSuffix ?? "";
		const names = bakedNamesByVendor.get(vendor) ?? new Map<string, ProviderId>();
		const existing = names.get(suffix);
		if (existing !== undefined) {
			throw new Error(
				`${existing}/${id}: baked artifacts for vendor ${vendor} derive the same release name; ` +
					`give ${id} a unique artifact.nameSuffix`,
			);
		}
		names.set(suffix, id);
		bakedNamesByVendor.set(vendor, names);
	}

	// Runner behavior belongs to the runner label, not the first provider that happened to use it.
	// Sharing a label with a different cache or reaping policy would route both jobs to the same host
	// while giving them contradictory setup/budget behavior.
	const runnersByLabel = new Map<string, { owner: ProviderId; signature: string }>();
	for (const id of PROVIDER_IDS) {
		const runner = parsed[id].meta.runner;
		if (runner === undefined) continue;
		const signature = JSON.stringify({
			noCache: runner.noCache,
			lifetimeMinutes: runner.lifetimeMinutes,
		});
		const existing = runnersByLabel.get(runner.label);
		if (existing !== undefined && existing.signature !== signature) {
			throw new Error(
				`${existing.owner}/${id}: shared runner ${runner.label} must use one cache/lifetime policy`,
			);
		}
		runnersByLabel.set(runner.label, existing ?? { owner: id, signature });
	}

	// One input name is one cross-consumer contract. Shared credentials across isolation variants
	// must normalize identically or generated CI would have to pick one owner's source/default policy.
	const inputsByName = new Map<string, { owner: ProviderId; signature: string }>();
	// One credential is one vendor account (ADR-0010): providers that share a secret draw on the same
	// quota, so they must queue behind the same domain or the account concurrency group lets them
	// race each other's allocations.
	const secretDomains = new Map<string, { owner: ProviderId; domain: string }>();
	for (const id of PROVIDER_IDS) {
		const { preAuth } = parsed[id].meta;
		const domain = parsed[id].meta.quotaDomain ?? id;
		const stepInputs: StepProvidedInput[] = [];
		for (const raw of parsed[id].meta.inputs) {
			const input = normalizeProviderInput(raw);
			if (input.source.kind === "step-env" || input.source.kind === "step-output") {
				stepInputs.push({ ...input, source: input.source });
			}
			if (input.source.kind === "secret") {
				const shared = secretDomains.get(input.name);
				if (shared !== undefined && shared.domain !== domain) {
					throw new Error(
						`${shared.owner}/${id}: providers sharing secret ${input.name} must declare one quotaDomain (${shared.domain} vs ${domain})`,
					);
				}
				secretDomains.set(input.name, shared ?? { owner: id, domain });
			}
			const signature = JSON.stringify({
				source: input.source,
				required: input.required,
				default: input.default,
				ciValue: input.ciValue,
			});
			const existing = inputsByName.get(input.name);
			if (existing !== undefined && existing.signature !== signature) {
				throw new Error(
					`${existing.owner}/${id}: shared provider input ${input.name} must use one source/default/required policy`,
				);
			}
			inputsByName.set(input.name, existing ?? { owner: id, signature });
		}
		if (preAuth === undefined) {
			if (stepInputs.length > 0) {
				throw new Error(`${id}: step-provided inputs require a declared preAuth policy`);
			}
			continue;
		}
		const contract = PROVIDER_PRE_AUTH_CONTRACTS[preAuth];
		const [actual] = stepInputs;
		const sourceMatches =
			actual !== undefined &&
			actual.name === contract.input.name &&
			actual.source.step === contract.step &&
			actual.source.kind === contract.input.source.kind &&
			(actual.source.kind !== "step-output" ||
				(contract.input.source.kind === "step-output" &&
					actual.source.output === contract.input.source.output));
		if (stepInputs.length !== 1 || !sourceMatches) {
			const output =
				contract.input.source.kind === "step-output"
					? ` output ${contract.input.source.output}`
					: "";
			throw new Error(
				`${id}: preAuth ${preAuth} must produce ${contract.input.name} from ${contract.input.source.kind} step ${contract.step}${output}`,
			);
		}
		// A pre-auth step exists to mint a credential. If the input it produces is optional, a
		// failed pre-auth degrades into an empty value that the provider only discovers at create
		// time, long after the workflow could have failed on it. Keep that failure at the boundary.
		if (actual?.required !== true) {
			throw new Error(
				`${id}: preAuth ${preAuth} input ${contract.input.name} must be required so a failed pre-auth fails the workflow`,
			);
		}
	}
	return parsed as CorrelatedProviderModules;
}
