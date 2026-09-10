// Tier-1 provider metadata authoring contract (ADR-0006). This module is intentionally runtime
// dependency-free: committed metadata is trusted, type-checked source. Arktype validation belongs to
// generators and process boundaries, not to provider registration imports.

import type { ProviderId } from "./provider-ids.ts";
import type { ProviderPricing } from "./provider-pricing.ts";
import type {
	ProviderMaturity,
	ProviderRuntimeIdentity,
	ProviderTransport,
	SpecPinning,
} from "./providers.ts";

export type IsolationClass = "microVM" | "container" | "userspace" | "unknown";

export type ProviderArtifact =
	| { readonly kind: "none" }
	| { readonly kind: "image" }
	| { readonly kind: "baked"; readonly nameSuffix?: `-${string}` }
	| { readonly kind: "mirror"; readonly repository: string }
	| { readonly kind: "built"; readonly recipe: string };

export type ProviderInputSource =
	| { readonly kind: "secret" }
	| { readonly kind: "variable" }
	| { readonly kind: "step-env"; readonly step: string }
	| { readonly kind: "step-output"; readonly step: string; readonly output: string };

export interface ProviderInputDescriptor {
	readonly name: string;
	readonly source?: ProviderInputSource;
	readonly required?: boolean;
	readonly default?: string;
	/** Fixed value injected only by generated CI wiring (for runner capability opt-ins). */
	readonly ciValue?: string;
}

/** String shorthand means a required secret. */
export type ProviderInput = string | ProviderInputDescriptor;

export interface NormalizedProviderInput {
	readonly name: string;
	readonly source: ProviderInputSource;
	readonly required: boolean;
	readonly default?: string;
	readonly ciValue?: string;
}

/** Supported pre-auth actions and the exact provider input each one produces. */
export const PROVIDER_PRE_AUTH_CONTRACTS = {
	"namespace-token": {
		step: "namespace",
		input: {
			name: "NSC_TOKEN_FILE",
			source: { kind: "step-output", output: "token-file" },
		},
	},
	"vercel-auth": {
		step: "vercel-auth",
		input: {
			name: "VERCEL_OIDC_TOKEN",
			source: { kind: "step-env" },
		},
	},
} as const;

export type ProviderPreAuth = keyof typeof PROVIDER_PRE_AUTH_CONTRACTS;

export const PROVIDER_PRE_AUTH_POLICIES = Object.freeze(
	Object.keys(PROVIDER_PRE_AUTH_CONTRACTS) as ProviderPreAuth[],
);

export interface ProviderRunnerPolicy {
	readonly label: string;
	/** setup-bun cache policy for this runner label; explicit so routing cannot drift from setup. */
	readonly noCache: boolean;
	/** Hard runner reaping window, when shorter than the Actions job timeout. */
	readonly lifetimeMinutes?: number;
}

/** The inert object authored in `provider-meta/<id>.ts`. */
export interface ProviderMetaSource {
	readonly displayName: string;
	readonly vendor: string;
	/**
	 * The vendor account whose quota and credentials this provider consumes. Isolation variants that
	 * share credentials share one domain (ADR-0010) — it names the Actions concurrency group, the
	 * account journal branch and the plan's batches, so it must stay stable once provisioned.
	 * Omitted means the provider id is its own domain.
	 */
	readonly quotaDomain?: string;
	readonly website: string;
	readonly sdkPackage: string;
	readonly artifact: ProviderArtifact;
	readonly inputs: readonly ProviderInput[];
	readonly isolation: {
		readonly technology: string;
		readonly class: IsolationClass;
		readonly notes?: string;
	};
	readonly pricing: ProviderPricing;
	readonly maturity: ProviderMaturity;
	readonly specPinning: SpecPinning;
	readonly transport: ProviderTransport;
	readonly runtimeIdentity?: ProviderRuntimeIdentity;
	readonly runner?: ProviderRunnerPolicy;
	readonly preAuth?: ProviderPreAuth;
}

export interface ProviderMetaModule<
	P extends ProviderId,
	M extends ProviderMetaSource = ProviderMetaSource,
> {
	readonly id: P;
	readonly meta: M;
}

/** Preserve provider and metadata literals; validation is deliberately a generator concern. */
export function defineProviderMeta<const P extends ProviderId, const M extends ProviderMetaSource>(
	id: P,
	meta: M,
): ProviderMetaModule<P, M> {
	return { id, meta };
}

export function normalizeProviderInput(input: ProviderInput): NormalizedProviderInput {
	if (typeof input === "string") {
		return { name: input, source: { kind: "secret" }, required: true };
	}
	return {
		name: input.name,
		source: input.source ?? { kind: "secret" },
		required: input.required ?? input.default === undefined,
		...(input.default === undefined ? {} : { default: input.default }),
		...(input.ciValue === undefined ? {} : { ciValue: input.ciValue }),
	};
}
