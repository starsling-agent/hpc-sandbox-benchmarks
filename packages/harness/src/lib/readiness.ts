/**
 * Sandbox readiness — the wait between `create()` resolving and the sandbox actually being able to run
 * a command.
 *
 * `create()` resolves when the provider has ALLOCATED the sandbox, which is not the same as the sandbox
 * being able to execute anything. A provider that boots a pre-baked artifact answers its first exec
 * immediately (the image is already resident on their side: e2b/novita templates, Daytona snapshots,
 * Modal's pushed image), so for years the harness got away with treating create-resolve as ready. A
 * provider that cold-pulls an OCI ref AT create time does not: Namespace has no template/snapshot
 * system and takes the toolchain ref straight through `options.image`, so when its handle resolves
 * (~320ms, measured) it is still fetching ~1.5 GiB of image layers from GHCR.
 *
 * Nothing in that SDK can be asked instead of probed — `create` returns as soon as CreateInstance
 * answers, and `getInfo` hardcodes `status: "running"` — so readiness is measured the only way that
 * generalizes: retry a trivial command until the sandbox answers.
 *
 * Each probe is bounded ({@link DEFAULT_READINESS_PROBE_TIMEOUT_MS}) because an exec issued against a
 * not-yet-running container HANGS rather than erroring — Namespace's RunCommandSync blocks server-side
 * for as long as the pull takes — and an unbounded probe would wait out the whole step budget on its
 * first attempt instead of retrying. That is exactly how this surfaced: a 60s `check free disk` timeout
 * that read like a disk problem and was really the image pull.
 *
 * A provider that is ready on the first probe pays one round-trip, so the gate costs the pre-baked
 * providers nothing.
 */
import { withTimeout } from "./execute.ts";

/** The trivial command whose first successful (exitCode 0) return marks the sandbox ready. */
export const READINESS_CMD = "echo ok";

/** Probes per readiness wait before giving up. */
export const DEFAULT_READINESS_ATTEMPTS = 40;
/** Delay between failed probes. */
export const DEFAULT_READINESS_RETRY_DELAY_MS = 250;
/**
 * Per-probe ceiling. Sized to be comfortably longer than a healthy exec round-trip (tens of ms) while
 * still cutting a probe that hangs on a not-yet-running container, so the loop actually gets to retry.
 */
export const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 20_000;

/** Real wall-clock delay between readiness retries; swapped for a no-op in tests. */
const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Clamp a caller-supplied bound: a NaN/Infinity would make the loop never run (or never stop). */
const finiteOr = (value: number | undefined, fallback: number, min: number): number => {
	const raw = value ?? fallback;
	return Number.isFinite(raw) ? Math.max(min, Math.floor(raw)) : fallback;
};

/** The slice of a sandbox a readiness probe needs — structural, so both the suite runner's
 *  `SandboxHandle` and the lifecycle driver's `LifecycleSandbox` satisfy it without a cast. */
export interface ReadinessProbeSandbox {
	runCommand(command: string, options?: { background?: boolean }): Promise<{ exitCode: number }>;
}

export interface WaitUntilReadyOptions {
	/** Probes before giving up. Default {@link DEFAULT_READINESS_ATTEMPTS}. */
	maxAttempts?: number;
	/** Delay between failed probes, in ms. Default {@link DEFAULT_READINESS_RETRY_DELAY_MS}. */
	retryDelayMs?: number;
	/** Per-probe ceiling, in ms. Default {@link DEFAULT_READINESS_PROBE_TIMEOUT_MS}. */
	probeTimeoutMs?: number;
	/** Injectable delay so tests never really sleep. Default real `setTimeout`. */
	delay?: (ms: number) => Promise<void>;
}

/** Why a readiness wait gave up — one phrasing, so both callers report the same thing. */
export function neverReadyReason(maxAttempts: number): string {
	return `sandbox never ready: no successful "${READINESS_CMD}" in ${maxAttempts} attempts`;
}

/** The outcome of a readiness wait, including the bound actually probed. */
export interface ReadinessResult {
	ready: boolean;
	/**
	 * The EFFECTIVE attempt bound — post-normalization, so it is what was really probed rather than
	 * what the caller asked for. Callers report this in {@link neverReadyReason}: a raw override would
	 * let the diagnostic claim "in 0 attempts" (clamped to 1) or "in NaN attempts" (defaulted to
	 * {@link DEFAULT_READINESS_ATTEMPTS}), which is exactly the wrong thing for the one string whose
	 * whole job is to say what was tried.
	 */
	attempts: number;
}

/**
 * Probe until the sandbox answers. Resolves `ready: true` on the first successful probe, `false` once
 * the attempts are exhausted — never throws, so a caller decides whether not-ready is a failed metric
 * (the lifecycle driver) or a dead cell (the suite runner). A probe that throws, or that outlasts
 * `probeTimeoutMs`, counts as not-ready and is retried.
 */
export async function waitUntilReady(
	sandbox: ReadinessProbeSandbox,
	options: WaitUntilReadyOptions = {},
): Promise<ReadinessResult> {
	return waitForReadiness(
		async () => (await sandbox.runCommand(READINESS_CMD)).exitCode === 0,
		options,
	);
}

/** Shared bounded first-success loop; operational driver readiness remains a separate policy. */
export async function waitForReadiness(
	probeReady: () => Promise<boolean>,
	options: WaitUntilReadyOptions = {},
): Promise<ReadinessResult> {
	const maxAttempts = finiteOr(options.maxAttempts, DEFAULT_READINESS_ATTEMPTS, 1);
	const retryDelayMs = finiteOr(options.retryDelayMs, DEFAULT_READINESS_RETRY_DELAY_MS, 0);
	const probeTimeoutMs = finiteOr(options.probeTimeoutMs, DEFAULT_READINESS_PROBE_TIMEOUT_MS, 1);
	const delay = options.delay ?? realDelay;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const probe = probeReady();
			// A timed-out probe leaves its exec dangling: swallow a late rejection here so an abandoned
			// attempt can't surface as an unhandled rejection while the loop is still retrying.
			probe.catch(() => {});
			const result = await withTimeout(
				probe,
				probeTimeoutMs,
				`readiness probe timed out after ${Math.round(probeTimeoutMs / 1000)}s`,
			);
			if (result) return { ready: true, attempts: maxAttempts };
		} catch {
			// Not ready — fall through to the retry.
		}
		if (attempt < maxAttempts) await delay(retryDelayMs);
	}
	return { ready: false, attempts: maxAttempts };
}
