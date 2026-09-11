// Each schema provider id maps to a ComputeSDK factory plus benchmark create-time policy. Prefer the
// maintained @computesdk wrappers. Vercel uses its native SDK because the published wrapper still
// pins Sandbox v1; run.cloud also uses its native SDK because no @computesdk wrapper is published.

import type { ProviderId } from "@sandbox-benchmarks/schema";
import { PROVIDER_IDS } from "@sandbox-benchmarks/schema";
import type { ProviderAdapter } from "./types.ts";

/**
 * Provider ids whose production path is a registered DriverModule, not a `packages/providers`
 * adapter. Must stay in lockstep with `Object.keys(DRIVERS)` — the CLI partition test proves it.
 *
 * Deliberately a standalone list rather than anything derived from {@link adapters}: this is the
 * only reason an id may be absent from the join below, so reading it off the adapter table would
 * make {@link assertProviderJoin} tautological and hide the missing-adapter drift it exists to
 * catch. `packages/drivers` cannot be imported here either — the dependency DAG (ADR-0002) points
 * the other way, and this package must not pull a fleet of vendor SDKs into its load.
 */
export const MIGRATED_DRIVER_IDS = [
	"e2b",
	"modal-gvisor",
	"modal-vm",
	"tama",
	"novita",
	"daytona-vm",
	"daytona-container",
	"vercel",
	"blaxel",
	"microsandbox-cloud",
	"runloop",
	"runcloud",
	"namespace",
] as const satisfies readonly ProviderId[];

/** A schema id served by a registered DriverModule. Derived from the list, so the two cannot drift. */
export type MigratedDriverId = (typeof MIGRATED_DRIVER_IDS)[number];
/** Schema ids still served by this package's ComputeSDK adapters. */
export type LegacyAdapterId = Exclude<ProviderId, MigratedDriverId>;

/**
 * Harness adapters for providers not yet on DriverModule. The `Record<LegacyAdapterId, …>` type
 * forces exactly one adapter per unmigrated schema id, so a waived provider added to the schema
 * without an adapter here — or an adapter with a typo'd / unknown id — is a compile error. The four
 * registered DriverModule ids are omitted on purpose; default bench-suite loads them via
 * `loadDriverModule`, and a CLI partition test proves this set and `DRIVERS` are disjoint and
 * jointly complete.
 */
export const adapters: Record<LegacyAdapterId, ProviderAdapter> = {};

/**
 * Whether `id` is a schema provider this package is still expected to serve.
 *
 * Answers from the schema registry and the migrated-id list — never from `adapters` itself. A
 * membership test against the table would report "not ours" for a waived provider whose adapter is
 * simply MISSING, which is exactly the drift {@link assertProviderJoin} must still be able to see.
 */
export function isLegacyAdapterId(id: string): id is LegacyAdapterId {
	return (
		(PROVIDER_IDS as readonly string[]).includes(id) &&
		!(MIGRATED_DRIVER_IDS as readonly string[]).includes(id)
	);
}
