// Legacy bake helpers and evidence utilities. Benchmark execution uses @sandbox-benchmarks/drivers.
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

// Keep the registry join checked while legacy consumers still import this compatibility surface.
assertProviderJoin(
	PROVIDERS.map((meta) => meta.id).filter(isLegacyAdapterId),
	Object.keys(adapters),
);

// An adapter that owns its own create bound must say how large that bound is; the harness's retry
// budget is only honest if it can subtract one attempt's worst case before starting another.
assertCreateCeilingDeclared(adapters);

// All registered providers now run through DriverModule. Keep the empty legacy surface while
// bake helpers and evidence sanitization still use this package.
export const providers: ProviderConfig[] = [];
