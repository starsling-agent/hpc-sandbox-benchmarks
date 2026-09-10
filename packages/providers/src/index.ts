// Public surface of @sandbox-benchmarks/providers.
// Depends on @sandbox-benchmarks/schema (provider identity) and computesdk + the @computesdk/*
// wrappers (the unified provider runtime). Each provider is wired via its @computesdk/* factory;
// `providers` is the schema identity joined with those adapters.
import { PROVIDERS } from "@sandbox-benchmarks/schema";
import { adapters, isLegacyAdapterId, MIGRATED_DRIVER_IDS } from "./lib/adapters.ts";
import { assertCreateCeilingDeclared, assertProviderJoin } from "./lib/join.ts";
import type { ProviderConfig } from "./lib/types.ts";

// The runtime configuration gatekeeper — the single validated config object consumers import.
export { config } from "./config.ts";
export type { LegacyAdapterId, MigratedDriverId } from "./lib/adapters.ts";
export { sanitizeEvidenceDetail, sanitizeProviderResponse } from "./lib/cost-evidence.ts";
// Novita's E2B-compat surface: the pinned regional domain + connection the bake pipeline reuses,
// and the compat factory (exported for tests and for anyone driving Novita outside the harness join).
export { NOVITA_E2B_DOMAIN, novitaCompute, novitaConnection } from "./lib/novita.ts";
// How an adapter reports a create failure the harness should wait out rather than fail on.
export { isRetryableCreateError, markRetryableCreate } from "./lib/retryable-create.ts";
export type {
	CostEvidenceCaptureInput,
	DirectProvider,
	ProviderAdapter,
	ProviderConfig,
	ProviderCostEvidenceCapability,
	SandboxTeardownResult,
} from "./lib/types.ts";
export { isLegacyAdapterId, MIGRATED_DRIVER_IDS };

/**
 * Unmigrated provider benchmark configurations: each remaining schema provider's identity joined
 * with its harness adapter, in schema declaration order. The four registered DriverModule ids are
 * omitted — default `bench-suite` loads those via `loadDriverModule`.
 *
 * Compile-time honesty is `Record<LegacyAdapterId, ProviderAdapter>`: a waived provider added to
 * the schema without an adapter here is a type error. The runtime {@link assertProviderJoin} backs
 * that for any path the type-checker never saw (published/installed build, cross-version drift).
 *
 * The expected set subtracts only {@link MIGRATED_DRIVER_IDS} — a list that owes nothing to
 * `adapters` — so a schema id that lost its adapter is still reported as a one-sided join instead
 * of quietly filtering itself out of both sides of the comparison.
 */
assertProviderJoin(
	PROVIDERS.map((meta) => meta.id).filter(isLegacyAdapterId),
	Object.keys(adapters),
);

// An adapter that owns its own create bound must say how large that bound is; the harness's retry
// budget is only honest if it can subtract one attempt's worst case before starting another.
assertCreateCeilingDeclared(adapters);

export const providers: ProviderConfig[] = PROVIDERS.flatMap((meta) => {
	if (!isLegacyAdapterId(meta.id)) return [];
	const adapter = adapters[meta.id];
	return [
		{
			...adapter,
			name: meta.id,
			// The adapter may refine the required credentials at runtime (daytona's per-region key var);
			// otherwise the schema ProviderMeta's static list stands.
			requiredEnvVars: adapter.requiredEnvVars ?? meta.requiredEnvVars,
			// Transport capability is schema-owned (a static fact of the @computesdk/* integration), so it
			// rides the same id-keyed join — the harness reads it to pick sync vs detached per step.
			transport: meta.transport,
		},
	];
});
