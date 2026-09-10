// Public surface of @sandbox-benchmarks/schema — the bottom of the dependency DAG.
// Depends only on arktype. Every other package imports its shared types from here.
import { type } from "arktype";
import { rawRunSchema } from "./lib/internal.ts";

// Pure analysis over retained Samples: the Aggregates distribution and how it's computed.
export * from "./analysis.ts";
// Sandbox-attributed artifact provenance: which toolchain booted, and what established that.
export * from "./artifact-evidence.ts";
// Bounded canonical JSON shared by evidence producers and deterministic consumers.
export * from "./canonical-json.ts";
// The Metric Catalog — the registry of rankable Metrics, plus lookup helpers.
export * from "./catalog.ts";
// Sandbox-attributed provider cost evidence and complete-total semantics.
export * from "./cost-evidence.ts";
// The derived economics Dimension ($/run): its MetricDefs, the pricing-driven derivation, and the
// pure cost models (burst vs fixed-infra amortization) they build on.
export * from "./economics.ts";
export * from "./experiment.ts";
// The non-PTS, harness-measured Metric slice (lifecycle + control-plane) and its operation→id contract.
export * from "./harness-metrics.ts";
// Canonical persisted identifiers shared by Run and evidence schemas.
export * from "./identifiers.ts";
// Metric vocabulary: Dimension, Direction and the MetricDef shape every Metric declares.
export * from "./metrics.ts";
// Pure artifact lifecycle projections used by release composition roots.
export * from "./provider-artifacts.ts";
// Provider identity, declarative inputs/artifacts, and economics registry.
export * from "./providers.ts";
// The hand-authored curation layer over the generated PTS catalog (label/headline/dimension).
export * from "./pts-overrides.ts";
// The raw-file naming contract shared by the producers and the results extractor.
export * from "./raw-files.ts";
// The canonical Run dataset model (Run/ProviderRun/MetricResult/…) and its validators.
export * from "./run.ts";
// The suite↔dimension↔metric contract checker (fail-fast at load) and its violation types.
export * from "./suite-contract.ts";
// The benchmark suite registry — shared by the harness and CI matrix planning.
export * from "./suites.ts";
// Canonical toolchain image identity (name + version), shared by the build pins and runtime config.
export * from "./toolchain.ts";

/**
 * A single raw, un-normalized benchmark run as emitted by the harness.
 * Inferred from {@link rawRunSchema} so the runtime schema stays the single source of truth.
 */
export type RawRun = typeof rawRunSchema.infer;

/** Validate an unknown value as a {@link RawRun} using the arktype schema. */
export function parseRawRun(value: unknown): RawRun {
	const out = rawRunSchema(value);
	if (out instanceof type.errors) {
		throw new Error(`invalid RawRun: ${out.summary}`);
	}
	return out;
}
