// Provider identity & economics — the static facts the comparison surfaces next to results:
// isolation technology, pricing model, maturity, and whether the SDK can pin a target spec.
// Provider identity itself lives in the dependency-free `provider-ids.ts` leaf; this registry owns
// the metadata keyed by that identity. The harness adapter joins against it and refuses any
// one-sided provider.
//
// Validation status is deliberately NOT declared here: a provider is "validated" exactly when a
// committed run carries real metrics for it (computed downstream), "pending" otherwise.

import type { ProviderId } from "./provider-ids.ts";
import { PROVIDER_IDS } from "./provider-ids.ts";
import { REGISTRY } from "./provider-meta/index.ts";
import type {
	NormalizedProviderInput,
	ProviderArtifact,
	ProviderMetaSource,
	ProviderPreAuth,
	ProviderRunnerPolicy,
} from "./provider-meta.ts";
import { normalizeProviderInput } from "./provider-meta.ts";
import type { PricingComponent, PricingQuantityTerm, ProviderPricing } from "./provider-pricing.ts";

export type { ArtifactPhase, BaseImageUse } from "./provider-artifacts.ts";
export {
	bakedArtifactName,
	baseImageUse,
	isBakedProviderId,
	isMirroredProviderId,
} from "./provider-artifacts.ts";
export type { ProviderId } from "./provider-ids.ts";
export { PROVIDER_IDS } from "./provider-ids.ts";
export type {
	BakedProviderId,
	BuiltProviderId,
	ImageProviderId,
	MirroredProviderId,
	StockProviderId,
} from "./provider-meta/index.ts";
export { REGISTRY } from "./provider-meta/index.ts";
export type {
	IsolationClass,
	NormalizedProviderInput,
	ProviderArtifact,
	ProviderInput,
	ProviderInputDescriptor,
	ProviderInputSource,
	ProviderPreAuth,
	ProviderRunnerPolicy,
} from "./provider-meta.ts";
export { PROVIDER_PRE_AUTH_CONTRACTS, PROVIDER_PRE_AUTH_POLICIES } from "./provider-meta.ts";
export * from "./provider-pricing.ts";

import type { TargetSpec } from "./target-spec.ts";
import { TARGET_SPEC } from "./target-spec.ts";

export type { TargetSpec } from "./target-spec.ts";
export { TARGET_SPEC } from "./target-spec.ts";

/**
 * Canonical provider ids — the single vocabulary every registry joins on. Adding an id forces a
 * matching {@link REGISTRY} entry (the Record type below makes a missing or extra id a compile
 * error) and, downstream, a harness adapter in @sandbox-benchmarks/providers.
 */

/** Can the SDK request a pinned target spec (vCPU / memory) at create() time? */
export type SpecPinning = "settable" | "fixed" | "unknown";

/**
 * How a provider's command-exec transport behaves *through its ComputeSDK adapter* — the facts the
 * harness needs to pick a per-step transport instead of hardcoding one provider's quirks (the original
 * sin this models away: the harness forced Daytona's detached+poll on every provider). Owned here
 * alongside the other declared capabilities ({@link SpecPinning}, isolation, maturity) because it is a
 * static, comparable property of the integration, and the schema already names the `@computesdk/*`
 * adapter via {@link ProviderMeta.sdkPackage}.
 *
 * Three independent capabilities, each load-bearing for transport selection:
 *
 *   - `streaming` — does the adapter deliver stdout/stderr incrementally (computesdk's
 *     `onStdout`/`onStderr`)? Most shipped adapters drop those callbacks, so a long synchronous exec
 *     buffers silently; run.cloud's native SDK adapter passes them through. Modeled because a streaming
 *     path keeps a connection productive past an idle gateway cap.
 *   - `syncCapMs` — the configured durability threshold for a single *synchronous* exec round-trip,
 *     or `null` when validated as uncapped. It may encode a vendor-enforced limit or a conservative
 *     repository policy where long-lived synchronous transport has not been validated. The harness
 *     compares each step's timeout budget against it: a step that could reach it must not go
 *     synchronous. Daytona returns a
 *     server-side HTTP 408 on multi-minute synchronous execs while the process keeps running
 *     (`docs/evidence/daytona-exec-transport.md`); E2B's `commands.run` defaults to a 60s command
 *     timeout the computesdk wrapper never overrides.
 *   - `detachedPoll` — can the provider run a step fully detached (background exec + OBSERVABLE
 *     completion), the durable path for steps that would outlast `syncCapMs`? Without it there is no
 *     alternative, so such a step stays synchronous and best-effort.
 *
 *     Observable does NOT require a filesystem API. `StepRunner.runDetached` polls the done-file over
 *     the sandbox filesystem where one works and `cat`s it over exec where none does, so an adapter
 *     with no `filesystem` table still detaches. Reading this as "needs a filesystem" is what produced
 *     namespace's wrong `detachedPoll: false` — which stranded a 55-minute benchmark on a synchronous
 *     exec that its own server cut at ~4m19s. If a provider can background a command and answer a
 *     later exec, it can detach.
 */
export interface ProviderTransport {
	/** Does the ComputeSDK adapter stream stdout/stderr chunks (`onStdout`/`onStderr`)? */
	streaming: boolean;
	/** Conservative bound (ms) on a safe single synchronous exec round-trip; `null` when uncapped. */
	syncCapMs: number | null;
	/** Can a step run detached (background exec + observable completion — filesystem poll where exposed,
	 *  `cat` over exec otherwise), the durable long-step path? */
	detachedPoll: boolean;
}

/** Isolation technology a provider runs sandboxes under. */
export interface ProviderIsolation {
	/** e.g. "Firecracker microVM", "gVisor container", "unknown". */
	technology: string;
	/** Stable declared class used by figures and normalization; never inferred from display text. */
	class: "microVM" | "container" | "userspace" | "unknown";
	notes?: string;
}

/** How production-ready a provider's integration is. */
export interface ProviderMaturity {
	status: "ga" | "beta" | "unknown";
	notes?: string;
}

/**
 * Which identity a provider's benchmark lane runs as INSIDE the sandbox.
 *
 * `"unprivileged"` deliberately does not name the user: the point is the privilege level, which is
 * what the toolchain has to accommodate (separate PTS state, no writes to root-owned trees). The
 * account name is the provider's business and has changed without notice.
 */
export type ProviderRuntimeIdentity = "root" | "unprivileged";

/** The static description of a sandbox provider, owned by the schema. */
export interface ProviderMeta {
	/** Stable identifier joined against the harness adapter map; one of {@link ProviderId}. */
	id: ProviderId;
	displayName: string;
	/** Stable vendor label shared by isolation variants. */
	vendor: string;
	/** The account whose quota this provider consumes; see {@link quotaDomain}. */
	quotaDomain: string;
	website: string;
	/** The npm package the harness adapter wraps, e.g. "@computesdk/e2b". */
	sdkPackage: string;
	/** Artifact lifecycle declared independently of vendor API syntax. */
	artifact: ProviderArtifact;
	/** Normalized provider inputs; consumers never handle descriptor shorthand. */
	inputs: readonly NormalizedProviderInput[];
	/** Compatibility view for the current harness; derived from required inputs. */
	requiredEnvVars: string[];
	isolation: ProviderIsolation;
	pricing: ProviderPricing;
	maturity: ProviderMaturity;
	specPinning: SpecPinning;
	/** How the provider's exec transport behaves — the harness selects sync vs detached from this. */
	transport: ProviderTransport;
	/** Optional GitHub runner route plus its coupled setup-cache and reaping-budget policy. */
	runner?: ProviderRunnerPolicy;
	/** Optional CI authentication preparation owned by generated wiring. */
	preAuth?: ProviderPreAuth;
	/**
	 * Identity the benchmark lane runs as in-sandbox. Omitted means `"root"`: setup, the baked PTS
	 * state and every adapter target root, and the providers that DO inject an unprivileged user are
	 * the exception worth declaring — e2b and novita each pin their exec back to root explicitly
	 * (e2b-root.ts), so only a provider with no such lever is `"unprivileged"`.
	 *
	 * This exists so the job summary flags DRIFT rather than a supported configuration: a hardcoded
	 * "expected root" marks every Runloop replicate anomalous on a perfectly healthy run, which trains
	 * readers to ignore the warning that was added to catch a real identity change.
	 */
	runtimeIdentity?: ProviderRuntimeIdentity;
}

/**
 * The pinned cross-provider target spec: 4 vCPU, 8 GiB RAM, 40 GB disk. Every provider is created at
 * this exact shape so the numbers are like-for-like. 8 GiB RAM fits inside every provider's
 * reproducible envelope (E2B caps sandbox RAM at 8 GiB). vCPU is pinned at 4 because Blaxel couples
 * CPU to RAM (cores = memory_MB / 2048, no independent knob), so 8 GiB RAM there forces exactly 4
 * vCPU — targeting 4 lets Blaxel match on every axis instead of carrying a permanent comparability
 * caveat, while the others set 4 vCPU directly (Modal per-create; e2b/daytona/novita at bake time).
 * This assumes every provider can provision 4 vCPU at 8 GiB; one that can't would flip to mismatched,
 * so re-verify each provider's observed vCPU after a bump. Disk, by contrast, is sized for the
 * realworld suites' working set: a cold monorepo install + full build needs ~30 GiB free (mastra's
 * `minDiskGb`), and at 20 GB a
 * Daytona sandbox had only 16.7 GiB free, silently skipping mastra/openclaw. Disk is NOT a comparison
 * axis and is excluded from {@link hourlyCostAtTargetSpec}, so a larger disk can't bias the ranking.
 *
 * Providers that expose a per-sandbox/snapshot disk get 40 GiB (Daytona, via the snapshot's
 * `resources.disk`); Modal has no disk knob but its gVisor root reports effectively unbounded disk,
 * so it clears the gate anyway. Blaxel's sandbox root is a RAM-derived tmpfs with no independent disk
 * knob, so it mounts a 40 GiB volume at the PTS data dir where the heavy suites write (see
 * packages/providers/src/lib/blaxel-volume.ts) — clearing the gate like the others. Only e2b/novita
 * (the `@e2b/cli` `template create` takes only `--cpu-count`/`--memory-mb`), namespace
 * (`NamespaceConfig` has no disk field at all), and Vercel (resources exposes only vCPUs) still
 * CANNOT express disk:
 * they run with actuals recorded and the heavy suites skip there, surfaced as an explicit coverage gap
 * in the leaderboard, never silently dropped.
 */
/** Recursively freeze a value so the shared registry can't be mutated by a downstream consumer. */
function deepFreeze<T>(value: T): T {
	for (const key of Object.getOwnPropertyNames(value)) {
		const child = (value as Record<string, unknown>)[key];
		if (child !== null && typeof child === "object") {
			deepFreeze(child);
		}
	}
	Object.freeze(value);
	return value;
}

/**
 * Every provider the benchmark knows about, in declaration order. Derived from {@link REGISTRY} so
 * the `id` and its key can never disagree, and deep-frozen so a downstream consumer can't mutate
 * shared pricing/identity at runtime. @sandbox-benchmarks/providers binds an adapter to each id via
 * a matching `Record<ProviderId, …>`, so adding a provider here without an adapter there (or vice
 * versa) is a compile error in that package — the two registries cannot drift.
 */
export const PROVIDERS: readonly ProviderMeta[] = deepFreeze(
	PROVIDER_IDS.map((id) => {
		const source = REGISTRY[id];
		const inputs = source.inputs.map(normalizeProviderInput);
		return {
			id,
			...source,
			quotaDomain: quotaDomain(id),
			inputs,
			requiredEnvVars: inputs.filter((input) => input.required).map((input) => input.name),
		};
	}),
);

/**
 * The vendor account a provider's sandboxes are charged to and queued behind. Isolation variants
 * that share credentials share one domain (daytona-vm and daytona-container → `daytona`); every
 * other provider is its own. This one lookup names the Actions concurrency group (generated wiring),
 * the account journal branch and the experiment plan's batches, so they cannot disagree.
 */
export function quotaDomain(id: ProviderId): string {
	// Widen from the descriptor's literal type: most descriptors omit the field, so it is not on the
	// registry's union type, only on the declared source shape.
	const meta: ProviderMetaSource = REGISTRY[id];
	return meta.quotaDomain ?? id;
}

/**
 * Retired provider ids that committed run documents still carry, each mapped to the current variant
 * that subsumed it. When a provider is split into isolation variants its pre-split runs keep the old
 * `providerId`; this table lets {@link getProvider} still resolve them to the variant that inherited
 * the old behaviour, so a historical leaderboard keeps its display names and economics instead of
 * degrading to a bare id. New runs always write a current variant id, so the aliases only ever match
 * old data.
 */
export const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = Object.freeze({
	// `modal` → modal-gvisor, NOT modal-vm: pre-split `modal` ran Modal's default gVisor runtime
	// (scalableSandboxes, no vm_runtime); the VM runtime is a later, separate variant. Every committed
	// `modal` run predates that switch, so its data is gVisor. (The single `modal` entry on the base
	// branch shows "VM" only because this stack sits on top of that later change — that is the current
	// adapter config, not the runtime the historical runs were collected under.)
	modal: "modal-gvisor",
	daytona: "daytona-vm",
});

/**
 * Look up a provider's metadata by id. A known {@link ProviderId} literal always resolves; an
 * arbitrary string (e.g. an id read back from a run document) may not — but a retired id in
 * {@link LEGACY_PROVIDER_ALIASES} resolves to the variant that subsumed it.
 */
export function getProvider(id: ProviderId): ProviderMeta;
export function getProvider(id: string): ProviderMeta | undefined;
export function getProvider(id: string): ProviderMeta | undefined {
	// A linear scan over a handful of frozen entries — no module-load Map to drift out of sync, and
	// the entries are immutable, so returning the reference directly is safe.
	const canonical = LEGACY_PROVIDER_ALIASES[id] ?? id;
	return PROVIDERS.find((p) => p.id === canonical);
}

/**
 * The identity a provider is EXPECTED to run its benchmark lane as. Unknown ids (a run document from
 * a retired provider) fall back to `"root"`, the toolchain's default.
 */
export function expectedRuntimeIdentity(providerId: string): ProviderRuntimeIdentity {
	return getProvider(providerId)?.runtimeIdentity ?? "root";
}

/**
 * Does an OBSERVED in-sandbox user contradict what the provider declares?
 *
 * Compares privilege level, not account name: a provider declared `"unprivileged"` may run as `user`,
 * `sandbox`, or anything else and that is not news. What IS news either way is a switch — an
 * unprivileged identity where root was expected (setup and the baked PTS state assume root) or root
 * where an unprivileged user was expected (a provider silently gained privileges).
 *
 * An absent observation is never drift: not every provider's probe reports a user.
 */
export function isUnexpectedRuntimeUser(providerId: string, user: string | undefined): boolean {
	if (!user) return false;
	return (user === "root" ? "root" : "unprivileged") !== expectedRuntimeIdentity(providerId);
}

/** Derive one pricing component's vendor billing-unit quantity from a supplied Run target shape. */
export function pricingQuantityAtTargetSpec(
	component: PricingComponent,
	targetSpec: TargetSpec,
): number {
	const quantityFor = ({ dimension, unitsPerTargetUnit }: PricingQuantityTerm): number => {
		const targetUnits = targetSpec[dimension];
		if (targetUnits === undefined) {
			throw new Error(`cannot derive ${component.id} quantity without targetSpec.${dimension}`);
		}
		return targetUnits * unitsPerTargetUnit;
	};

	const rule = component.quantityRule;
	return rule.kind === "linear" ? quantityFor(rule) : Math.max(...rule.terms.map(quantityFor));
}

/**
 * Complete deterministic CPU + memory cost at a target spec. Published rates remain
 * inspectable when this returns `null`: usage- and plan-dependent totals are not headline scalars.
 */
export function hourlyCostAtTargetSpec(
	meta: ProviderMeta,
	targetSpec: TargetSpec = TARGET_SPEC,
): number | null {
	const pricing = meta.pricing;
	if (pricing.model !== "published" || pricing.targetHourlyCost.kind !== "exact") return null;
	const components = new Map(pricing.components.map((component) => [component.id, component]));
	return pricing.targetHourlyCost.componentIds.reduce((total, id) => {
		// Registry initialization has already established referential integrity.
		const component = components.get(id) as PricingComponent;
		return total + component.usdPerUnitHour * pricingQuantityAtTargetSpec(component, targetSpec);
	}, 0);
}
