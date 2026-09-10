// Daytona deactivates a snapshot that has not been used for a while, and a create against one is
// rejected outright: `Failed to create Daytona sandbox: Snapshot <name> is inactive`. Nothing is
// allocated, nothing is wrong with the artifact, and the documented remedy is one API call
// (`snapshot.activate`) — but until something makes that call EVERY create keeps failing, so the
// deactivation takes out every daytona cell of a matrix run at once. That is what happened to run
// 33712242440: `sandbox-benchmarks-toolchain-v8` was last used by the previous matrix run on
// 2026-08-19, sat unused for fifteen days, and all 54 daytona-vm replicates died on it.
//
// This is deliberately NOT a nested retry loop. The harness already owns one — patient, budgeted, and
// tested — and an inactive snapshot satisfies exactly what it asks for: transient, and provably
// nothing allocated. So the recovery is "start the activation, then hand the harness a marked error"
// and the existing 2-minute backoff both spaces the attempts and gives the activation time to land.
// A create that fails for any OTHER reason is passed through untouched.

import type { SandboxMethods } from "@computesdk/provider";
import { Daytona } from "@daytonaio/sdk";
import type { DaytonaConfig } from "../config.ts";
import { patchableManager } from "./patch-manager.ts";
import { markRetryableCreate } from "./retryable-create.ts";
import type { DirectProvider } from "./types.ts";

type DaytonaSandboxMethods = SandboxMethods<unknown, unknown>;

/** The control plane's own wording, reached through @computesdk/daytona's `Failed to create Daytona
 *  sandbox: ` wrapper. Anchored on the state rather than the snapshot name so it holds for the
 *  candidate and container snapshots too, and narrow enough that no other create failure matches. */
const INACTIVE_SNAPSHOT = /snapshot\s+\S+\s+is\s+inactive/i;

/**
 * In-flight activations, keyed by the region and snapshot the activation is actually scoped to.
 *
 * A cell drives R replicates from ONE process (12 for a realworld suite) and builds a fresh wrapper
 * per create attempt, so without this every replicate fires its own activation for the same snapshot
 * in the same second — hence module scope, not a closure variable. The entry is dropped once settled
 * rather than cached: a failed activation must be retryable on the next attempt, and a snapshot that
 * reports inactive again after a successful one is telling us something a cache would hide.
 *
 * The region belongs in the key even though today's two variants both default to us-west-2:
 * DAYTONA_TARGET and DAYTONA_CONTAINER_TARGET are independent overrides, so a shared key would let
 * one region's activation satisfy the other's wait and cost that cell a retry before it activated
 * its own. The API key does NOT belong there — both variants read the same DAYTONA_API_KEY by
 * construction, so it can never discriminate, and a credential makes a poor map key.
 */
const activating = new Map<string, Promise<void>>();

/** Ask Daytona to reactivate the snapshot, at most once per (region, snapshot) at a time. */
function activateOnce(cfg: DaytonaConfig): Promise<void> {
	const key = `${cfg.target ?? ""}:${cfg.snapshot}`;
	const inFlight = activating.get(key);
	if (inFlight) return inFlight;
	/** The activation itself: read the snapshot, and wake it unless another caller already did. */
	const started = (async () => {
		// Explicit target, not the DAYTONA_TARGET pin daytonaClientTarget uses: this client is ours and
		// is constructed here, so the region can be passed the way the SDK actually documents.
		const daytona = new Daytona({ apiKey: cfg.apiKey, target: cfg.target });
		const snapshot = await daytona.snapshot.get(cfg.snapshot);
		if (snapshot.state === "active") return;
		await daytona.snapshot.activate(snapshot);
	})();
	// set BEFORE chaining the cleanup: a `.finally` that ran first would delete an entry that was
	// never published, stranding the next one and silencing activation for the rest of the process.
	activating.set(key, started);
	return started.finally(() => activating.delete(key));
}

/**
 * Wrap one Daytona provider so a create rejected for an inactive snapshot starts the reactivation and
 * comes back marked retryable, leaving the harness's create-retry budget to re-issue it.
 *
 * Apply OUTSIDE {@link daytonaClientTarget}: this wraps the already-region-pinned create, and its own
 * activation client carries the region explicitly.
 */
export function daytonaActivateSnapshot(
	provider: DirectProvider,
	cfg: DaytonaConfig,
): DirectProvider {
	const manager = patchableManager<Pick<DaytonaSandboxMethods, "create">>(provider, {
		pkg: "daytona",
		adapter: "snapshot-activation",
		methods: ["create"],
	});
	const { create } = manager.methods;
	/**
	 * The wrapped create: pass every outcome through untouched except the one this module exists for.
	 * An inactive snapshot starts the reactivation and comes back marked, so the harness re-issues it;
	 * anything else — success or another failure — is returned exactly as the wrapper produced it.
	 */
	const activatingCreate: DaytonaSandboxMethods["create"] = async (config, options) => {
		try {
			return await create(config, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!INACTIVE_SNAPSHOT.test(message)) throw error;
			// Best-effort: a failed activation must not replace the control plane's own diagnosis with
			// this helper's. The create error is the one the gap marker should carry either way, and the
			// mark is still correct — a rejected create allocated nothing, so re-issuing is safe.
			await activateOnce(cfg).catch(() => undefined);
			throw markRetryableCreate(error);
		}
	};
	manager.methods = { ...manager.methods, create: activatingCreate };
	return provider;
}
