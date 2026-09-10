/**
 * Suite-step execution against a live sandbox: the in-sandbox shell preamble, a liveness heartbeat,
 * a per-step timeout, and per-phase wall-time accounting. Two transports, and a capability-driven
 * selector ({@link StepRunner.step}) that picks between them per provider instead of hardcoding one
 * provider's quirks:
 *
 *   - {@link StepRunner.run}: a direct synchronous exec. Fine for short steps, but NOT durable for
 *     long ones on a capped provider: Daytona's synchronous executeCommand returns HTTP 408 on
 *     multi-minute commands while the process keeps running server-side, and computesdk's Daytona
 *     adapter doesn't stream (it ignores onStdout/onStderr).
 *   - {@link StepRunner.runDetached}: starts the step in the background (computesdk's `background:true`,
 *     double-fork daemonized so it detaches even on e2b's envd) writing its output to a log file and
 *     its exit code to a done-file, then polls until the done-file appears — via the sandbox filesystem
 *     when one is exposed, else by `cat`-ing the done-file over `exec`. The poll interval backs off
 *     adaptively so a short step isn't over-charged for polling. This survives the 408-prone exec
 *     round-trip, so multi-minute benchmarks complete on every provider.
 *
 * {@link StepRunner.step} reads the provider's declared {@link ProviderTransport} (via
 * {@link selectTransport}) and dispatches: a step that could outlast the provider's synchronous cap
 * runs detached where the provider supports it; everything else runs synchronously. So Daytona keeps
 * its detached+poll path while an uncapped provider (e.g. Modal) runs the same step directly — the
 * harness adapts to the capability rather than hardcoding one provider's transport.
 */

import { randomUUID } from "node:crypto";
import type { ExecResult, ExecutionPolicy, SandboxSession } from "@sandbox-benchmarks/driver";
import {
	launchDetached,
	redactDiagnosticText,
	selectExecutionRoute,
} from "@sandbox-benchmarks/driver";
import { diagnosticSecretsFromEnv } from "@sandbox-benchmarks/driver/env";
import type { ProviderTransport } from "@sandbox-benchmarks/schema";
import { PTS_STATE_SELECT_SH } from "@sandbox-benchmarks/schema";
import { completionCode, detachedCommand } from "./completion.ts";
import { GapError } from "./gap-cause.ts";

export const MIN = 60_000;

/**
 * Adaptive poll backoff for {@link StepRunner.runDetached} while it waits on a detached step's
 * done-file. Setup steps no-op in ~1s on a pre-baked image, so a fixed quantum charged most of a
 * short run to pure polling overhead (~44% of one measured suite). Start tight, grow geometrically,
 * and cap so a multi-minute benchmark still settles at a cheap steady cadence.
 */
const POLL_START_MS = 1_500;
const POLL_BACKOFF = 1.5;
const POLL_CAP_MS = 10_000;
/** Consecutive failed detached polls before concluding the sandbox itself is gone. One transient
 *  blip must not kill an hour-long benchmark, but a sandbox that stops answering EVERY poll is dead
 *  (e2b was observed orchestrator-stopping sandboxes ~4.5 min in, 2026-07-10), and treating that as
 *  "still running" burned the full command budget — CI cells then sat on a corpse for 60+ minutes
 *  until the runner itself was reclaimed. 12 failures ≈ 2–4 min of continuous unreachability at the
 *  capped poll interval. */
const MAX_CONSECUTIVE_POLL_FAILURES = 12;
/** How much of a timed-out detached step's log to surface — enough to diagnose, not enough to flood. */
const TIMEOUT_LOG_TAIL_LINES = 50;
/** Retry budget for reading a COMPLETED detached step's log — the step's only output. One swallowed
 *  transient fs-API error (Blaxel, 2026-07-19) once turned a finished suite's results into stdout ""
 *  and the run's 4 valid samples were discarded, so mirror the poll loop's philosophy
 *  ({@link MAX_CONSECUTIVE_POLL_FAILURES}): tolerate a blip, fail loudly only on a run of failures. */
const READBACK_ATTEMPTS = 5;
const READBACK_DELAY_MS = 2_000;
/** Done-file sentinel for the no-filesystem cat-poll fallback: printed while the file isn't there yet. */
const RUNNING_SENTINEL = "__RUNNING__";
function observationBudget(deadline: number): number {
	const remaining = deadline - performance.now();
	if (remaining <= 0) throw new Error("step observation deadline exceeded");
	return Math.min(POLL_CAP_MS, remaining);
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type Phase = "create" | "setup" | "benchmark" | "collect";

export interface StepLogEntry {
	phase: Phase;
	label: string;
	ms: number;
	exitCode: number | null;
}

export interface DetachedStepEvidence {
	identity: string;
	label: string;
	phase: Phase;
	state:
		| "launch-pending"
		| "launch-accepted"
		| "running"
		| "observation-unavailable"
		| "completed"
		| "deadline-exceeded"
		| "collection-failed";
	exitCode: number | null;
	lastObservationMs?: number;
	logTail?: string | null;
}

/** The result of one in-sandbox command. */
export interface CommandResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
}

/** Options for one in-sandbox command (a subset of computesdk's RunCommandOptions). */
export interface RunCommandOptions {
	/** Start detached and return immediately, rather than waiting for the command to finish. */
	background?: boolean;
}

/** Which transport {@link StepRunner.step} chose for a step. */
export type TransportKind = "sync" | "detached";

/**
 * Conservative transport profile used when a {@link StepRunner} is built without a declared one (the
 * unit-test fakes). Mirrors a single-round-trip-capped provider: short execs go direct, anything
 * budgeted past ~1 minute detaches — the safe default when a provider's real capability is unknown.
 */
export const DEFAULT_TRANSPORT: ProviderTransport = Object.freeze({
	streaming: false,
	syncCapMs: MIN,
	detachedPoll: true,
});

/**
 * Pick the exec transport for a step from the provider's declared {@link ProviderTransport} and the
 * step's timeout budget. A step runs detached when it could reach or outlast the provider's synchronous
 * cap (`syncCapMs`) AND the provider supports detached+poll; otherwise it runs as a direct synchronous
 * exec. A `null` cap (uncapped) always stays synchronous; a provider without `detachedPoll` has no
 * durable alternative, so it stays synchronous and best-effort even past its cap.
 *
 * The budget is the comparison key (worst case = a step that runs its full timeout), so the choice is
 * deterministic and provider-driven, not a guess about a step's actual runtime. The comparison is `>=`,
 * not `>`: when `syncCapMs` equals a provider's hard limit (E2B's `syncCapMs` *is* its SDK
 * `defaultProcessConnectionTimeout`), a step budgeted at exactly the cap could run right up to it and
 * drop the connection with no margin — so a budget that *reaches* the cap detaches, not just one that
 * exceeds it. `streaming` is modeled on the capability but does not tip this decision today: run.cloud
 * delivers incremental output, while the selector still uses the same conservative synchronous cap.
 */
export function selectTransport(transport: ProviderTransport, timeoutMs: number): TransportKind {
	const couldExceedSyncCap = transport.syncCapMs !== null && timeoutMs >= transport.syncCapMs;
	return couldExceedSyncCap && transport.detachedPoll ? "detached" : "sync";
}

/** The slice of a computesdk sandbox filesystem the detached transport polls (its `filesystem` satisfies this). */
export interface SandboxFilesystem {
	readFile(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
}

/** The slice of a computesdk sandbox the suite runner needs (its `Sandbox` satisfies this). */
export interface SandboxHandle {
	/** Universal ComputeSDK sandbox identity, snapshotted before teardown for cost attribution. */
	readonly sandboxId?: string;
	runCommand(command: string, options?: RunCommandOptions): Promise<CommandResult>;
	destroy(): Promise<unknown>;
	/** Present on real computesdk sandboxes; enables the durable detached transport for long steps. */
	filesystem?: SandboxFilesystem;
}

export interface StepOptions {
	allowFailure?: boolean;
	/** Suppress echoing stdout/stderr (for steps that emit bulk data, e.g. the base64 results tar).
	 *  A silent step that fails still emits its stderr, so failures stay debuggable. */
	silent?: boolean;
}

/**
 * Does this error mean the sandbox has NO filesystem API, as opposed to one that briefly failed?
 *
 * computesdk gives an adapter that declares no `filesystem` table its `UnsupportedFileSystem` stub
 * (@computesdk/provider), which is a truthy object whose every method throws
 * "Filesystem operations are not supported by <provider>'s sandbox environment." So the only way to
 * tell "never going to work" from "wedged for a moment" is the error itself — matched on the stable
 * phrase rather than the provider-interpolated remainder. Getting this wrong is asymmetric, which is
 * why it matches narrowly: a missed match costs the old dead-step failure, while a false match would
 * silently abandon a working filesystem for the (fully supported, slightly chattier) exec poll.
 */
function isUnsupportedFilesystem(err: unknown): boolean {
	return err instanceof Error && /not supported by .*sandbox environment/i.test(err.message);
}

/** Race a promise against a timeout, clearing the timer either way. */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	// The message, or a factory for the error to reject with when the caller wants it classified. A
	// factory rather than message+cause so the wording and its classification are built together and
	// cannot describe different facts (see {@link stepTimeout}).
	message: string | (() => Error),
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(typeof message === "string" ? new Error(message) : message());
				}, ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * The step-timeout failure, worded and classified from one input.
 *
 * Both the synchronous and the detached step paths can time out, and each used to build the sentence and
 * the cause itself — four copies of the same seconds rounding, and two chances for the prose and the
 * data to disagree. This mirrors the `shortfallReason`/`shortfallCause` pairing the results package uses
 * for the same reason.
 */
function stepTimeout(label: string, timeoutMs: number): GapError {
	// Floored at 1: every real step budget is minute-scale, but `gapCauseSchema` requires
	// `timeoutSeconds > 0`, and a sub-500ms budget would round to 0 — a cause the schema refuses,
	// turning a timed-out step into a Run that cannot be normalized at all.
	const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
	return new GapError(`Step "${label}" timed out after ${timeoutSeconds}s`, {
		kind: "step-timeout",
		step: label,
		timeoutSeconds,
	});
}

/** Single-quote a script for safe embedding in `bash -c '<script>'`. */
export function shellQuote(script: string): string {
	return `'${script.replace(/'/g, `'\\''`)}'`;
}

/**
 * The default in-sandbox repeat count (k) applied when a suite pins none: two timed PTS passes per case
 * — the balanced count published comparisons use (PR #129 lowered it from three). A per-suite override
 * (`Suite.ptsTimesToRun`) is threaded through {@link StepRunner}; replicate sandboxes (aggregate.ts),
 * not extra in-sandbox passes, carry the between-machine variance.
 */
export const DEFAULT_PTS_TIMES_TO_RUN = 2;

/**
 * How many timed PTS passes each test case runs INSIDE one sandbox (the within-machine axis). Two modes:
 *
 *  - `fixed` — force exactly `times` passes and disable PTS's own variance policy (the historical
 *    default; a noisy provider can't stretch a suite to 20-40 passes). `times` is a positive integer.
 *  - `converge` — hand the pass count to PTS's built-in statistical convergence (DynamicRunCount): run a
 *    minimum, then keep going while the standard deviation across passes exceeds PTS's threshold, up to
 *    PTS's own cap. This is the "let PTS decide" mode that buys tighter within-machine intervals on noisy
 *    cases at the cost of a variable (and potentially long) runtime.
 *
 * Resolved per run by {@link resolvePtsPassPolicy}: each suite's own default (converge where it declares
 * `Suite.ptsConverge` — cpu-node and memory — else fixed at `Suite.ptsTimesToRun`), which the
 * `BENCH_PTS_PASSES` dispatch input overrides (a number, or `converge`).
 */
export type PtsPassPolicy =
	| { readonly mode: "fixed"; readonly times: number }
	| { readonly mode: "converge" };

/** The fixed default policy (k = {@link DEFAULT_PTS_TIMES_TO_RUN}) — the {@link buildPreamble} /
 *  {@link StepRunner} default and the value the preamble tests pin. */
export const DEFAULT_PTS_PASS_POLICY: PtsPassPolicy = {
	mode: "fixed",
	times: DEFAULT_PTS_TIMES_TO_RUN,
};

/** The literal token the `BENCH_PTS_PASSES` override uses to request PTS's convergence logic. */
export const PTS_CONVERGE_TOKEN = "converge";

/** The slice of a suite {@link resolvePtsPassPolicy} reads to pick its pass policy — its fixed count and
 *  whether it converges by default. Structural so the harness needn't import the whole `Suite` type. */
export interface SuitePassConfig {
	readonly ptsTimesToRun?: number;
	readonly ptsConverge?: boolean;
}

/**
 * Resolve the {@link PtsPassPolicy} for a run from the suite's own default policy and the
 * `BENCH_PTS_PASSES` override (read from `env`, defaulting to `process.env` — the same env-driven seam
 * {@link buildPreamble} uses for `BENCH_PASSES`). Precedence, most specific first:
 *
 *  - `BENCH_PTS_PASSES=converge` (any casing) → converge, forced on EVERY suite (the global override).
 *  - `BENCH_PTS_PASSES=<n>` (a positive integer) → fixed at that many passes, forced on every suite.
 *  - unset/blank → the suite's OWN default: `converge` where the suite declares {@link SuitePassConfig.ptsConverge}
 *    (cpu-node and memory), else fixed at its `ptsTimesToRun` (or {@link DEFAULT_PTS_TIMES_TO_RUN}).
 *
 * So a bare run converges cpu-node + memory (the budget-safe, quick-to-settle suites) while every other
 * suite (the system + I/O + network suites, and realworld) keeps its fixed pass count, and a dispatch can
 * still force one policy across the board. A non-empty override that is neither `converge` nor a positive
 * integer THROWS, so a typo'd dispatch input fails the run loudly instead of silently reverting.
 */
export function resolvePtsPassPolicy(
	suite: SuitePassConfig,
	env: Record<string, string | undefined> = process.env,
): PtsPassPolicy {
	const raw = (env.BENCH_PTS_PASSES ?? "").trim();
	if (raw !== "") {
		// The dispatch override wins over the suite's own default policy, on every suite.
		if (raw.toLowerCase() === PTS_CONVERGE_TOKEN) {
			return { mode: "converge" };
		}
		const times = Number(raw);
		if (!Number.isInteger(times) || times < 1) {
			throw new Error(
				`BENCH_PTS_PASSES must be a positive integer or "${PTS_CONVERGE_TOKEN}"; got "${raw}"`,
			);
		}
		return { mode: "fixed", times };
	}
	// No override: the suite's own policy.
	if (suite.ptsConverge) {
		return { mode: "converge" };
	}
	return { mode: "fixed", times: suite.ptsTimesToRun ?? DEFAULT_PTS_TIMES_TO_RUN };
}

/**
 * The static head of the in-sandbox preamble: env + PATH re-established on every step (each runCommand is
 * a fresh shell). `$SUDO` covers both root images (no prefix) and non-root images with sudo. The
 * toolchain image (packages/templates/images) installs mise globally under /mise, so prefer it when
 * present. The trials + sudo tail is appended by {@link buildPreamble}, which pins the PTS repeat count.
 */
const PREAMBLE_HEAD = [
	"set -eo pipefail",
	"export DEBIAN_FRONTEND=noninteractive",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expansion, not a JS template
	'export HOME="${HOME:-/root}"',
	'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
	'if [ -d /mise ]; then export MISE_DATA_DIR=/mise MISE_CONFIG_DIR=/mise MISE_CACHE_DIR=/mise/cache PATH="/mise/shims:$PATH"; fi',
	// Some sandbox networks reset connections to *.jdx.dev — fetch versions/tools from GitHub instead.
	"export MISE_USE_VERSIONS_HOST=0",
	// Repository mise.toml contains developer-only linters (typos, shellcheck, hadolint, actionlint,
	// zizmor), none of which a benchmark task uses. Never auto-install them when `mise run` resolves a
	// task: stock-image providers fan the matrix out behind one egress IP, and seven concurrent aqua
	// lookups exhaust GitHub's anonymous API quota before a benchmark starts. Suite runtime tools are
	// installed explicitly by setupSteps (node/pnpm/PTS) or by the base-package fallback instead.
	"export MISE_TASK_RUN_AUTO_INSTALL=0",
	// No MISE_DISABLE_TOOLS=python here: baked images ship NO distro python3 — 10-mise.sh symlinks the
	// mise shims into /usr/local/bin, so python3 resolves to the baked mise python (pinned 3.13.14,
	// pre-installed, offline; MISE_DATA_DIR/MISE_CONFIG_DIR are Dockerfile ENV). Disabling the tool
	// turned every python3 into "mise ERROR python3 is not a valid shim" (pybench: zero metrics on
	// every baked provider, green jobs). Stock images resolve distro python3 (installed by setup.ts's
	// base-package fallback), with no jdx.dev download risk — python appears in no active mise config
	// there (the repo mise.toml pins only dev linters) and MISE_TASK_RUN_AUTO_INSTALL=0 stays set.
	// Distro pythons are PEP 668 externally-managed, but PTS profiles pip-install their harness —
	// fine in a throwaway sandbox; the baked image sets the same.
	"export PIP_BREAK_SYSTEM_PACKAGES=1",
	// Keep the root-baked installed profiles shared, but never point an injected unprivileged user at
	// root's mutable PTS state. Canonical snippet — see PTS_STATE_SELECT_SH for the full rationale and
	// for why this must also run at runtime rather than only in the image ENV.
	PTS_STATE_SELECT_SH,
];

/**
 * The trial-count env exports for a step's preamble, chosen by the {@link PtsPassPolicy}:
 *
 *  - contract-verification (`BENCH_PASSES=1`) → nothing; lib/bench.sh forces a single pass. This wins
 *    over any policy so a smoke run stays one pass regardless of the dispatch inputs.
 *  - `converge` → export the `BENCH_PTS_CONVERGE` marker and set NEITHER `FORCE_TIMES_TO_RUN` nor
 *    `PTS_RESPECT_TIMES_TO_RUN`, so PTS's DynamicRunCount governs the pass count. The marker tells
 *    lib/bench.sh's `_configure_pts_batch` NOT to fall back to forcing one pass.
 *  - `fixed` → the historical pins: `PTS_RESPECT_TIMES_TO_RUN=1` (disable PTS's variance policy so a
 *    noisy provider can't stretch a suite to 20-40 passes) + `FORCE_TIMES_TO_RUN=<k>`.
 */
function ptsTrialVars(policy: PtsPassPolicy): string[] {
	if (process.env.BENCH_PASSES === "1") return [];
	if (policy.mode === "converge") {
		return ["export BENCH_PTS_CONVERGE=1"];
	}
	return ["export PTS_RESPECT_TIMES_TO_RUN=1", `export FORCE_TIMES_TO_RUN=${policy.times}`];
}

/**
 * The full preamble string for a step, applying a {@link PtsPassPolicy} for the timed PTS passes per
 * case. Between-sandbox variance is captured by REPLICATE sandboxes (aggregate.ts), not by more
 * in-sandbox passes, and the leaderboard LABELS underpowered comparisons rather than buying significance
 * silently. Suites pin a fixed k per tier (realworld k=1, long synthetic k=2); a dispatch can override
 * to a different fixed count or to `converge` (see {@link resolvePtsPassPolicy}).
 */
export function buildPreamble(policy: PtsPassPolicy = DEFAULT_PTS_PASS_POLICY): string {
	// A non-positive or fractional fixed k would emit `FORCE_TIMES_TO_RUN=0` (a silently empty benchmark)
	// or a bogus value into the shell — fail loudly instead, the same fail-fast posture analysis.ts takes.
	// Validate before the BENCH_PASSES short-circuit so a bad policy is rejected in every mode.
	if (policy.mode === "fixed" && (!Number.isInteger(policy.times) || policy.times < 1)) {
		throw new Error(`buildPreamble() requires a positive integer pass count; got ${policy.times}`);
	}
	return [
		...PREAMBLE_HEAD,
		...ptsTrialVars(policy),
		'if [ "$(id -u)" = 0 ]; then SUDO=""; elif command -v sudo >/dev/null 2>&1; then SUDO="sudo -E"; else SUDO=""; fi',
	].join("; ");
}

/** The preamble at the default fixed repeat count (k = 2) — the StepRunner default and the value the
 *  preamble tests pin; a per-suite policy is threaded through {@link StepRunner}. */
export const PREAMBLE = buildPreamble();

/** Print liveness every 2 min while a long step runs — exec transports buffer output, so without
 *  this a healthy multi-minute benchmark looks hung in the CI log. */
const HEARTBEAT_MS = 2 * MIN;
function startHeartbeat(label: string, startedAt: number, timeoutMs: number): () => void {
	const timer = setInterval(() => {
		const elapsedMin = Math.round((performance.now() - startedAt) / MIN);
		console.log(`    [${label}] still running (${elapsedMin}m of ${Math.round(timeoutMs / MIN)}m)`);
	}, HEARTBEAT_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * Runs suite steps against one sandbox, charging each step's elapsed wall time to the current Phase
 * (`phase` is mutated by the orchestrator as the job progresses). One instance per sandbox/suite job.
 */
/**
 * A completed detached step whose log no transport could read back. Typed so callers that can
 * usefully re-run the whole step (collectResults — tar|base64 is idempotent) can tell this
 * RETRYABLE transport condition apart from a command failure or timeout, which must propagate.
 */
export class LogReadbackError extends Error {}

abstract class StepExecution<Result extends { stdout?: string; stderr?: string }> {
	/** The phase subsequent steps are charged to. */
	phase: Phase = "setup";
	/** Every executed step with its phase, elapsed ms, and exit code. */
	readonly stepLog: StepLogEntry[] = [];
	readonly detachedEvidence: DetachedStepEvidence[] = [];
	/** The in-sandbox preamble prepended to every step, carrying this run's PTS pass policy. */
	private readonly preamble: string;
	/**
	 * The sandbox filesystem WHILE it is usable — cleared for good the first time it proves it isn't.
	 *
	 * "Exposes a filesystem" is not "has a working one": computesdk hands an adapter that declares no
	 * `filesystem` table its UnsupportedFileSystem stub, a present and truthy object that throws on
	 * every call, so a truthiness check picks the fs poll and then every poll throws (live on namespace:
	 * 12 straight failures killed a step the loop could only read as a dead sandbox). Scoped to the
	 * RUNNER, not to one step, because it is a fact about the sandbox — a per-step local would re-probe
	 * and re-announce the same permanent absence on every detached step of the run.
	 */
	private pollFs?: SandboxFilesystem;

	protected constructor(
		filesystem: SandboxFilesystem | undefined,
		private readonly sleep: (ms: number) => Promise<void>,
		passPolicy: PtsPassPolicy,
		private readonly phaseDeadline?: (phase: Phase) => number,
	) {
		this.preamble = buildPreamble(passPolicy);
		this.pollFs = filesystem;
	}

	private boundedTimeout(timeoutMs: number): number {
		const remaining = this.phaseDeadline ? this.phaseDeadline(this.phase) - Date.now() : Infinity;
		if (remaining <= 0) throw new Error(`${this.phase} phase deadline exceeded`);
		return Math.min(timeoutMs, remaining);
	}

	protected abstract execute(command: string): Promise<Result>;
	protected abstract launch(command: string): Promise<void>;
	protected abstract detached(timeoutMs: number): boolean;
	protected abstract exitCode(result: Result): number | null;
	protected abstract describeExit(result: Result): string;
	protected abstract completed(code: number | null, stdout: string, durationMs: number): Result;

	/**
	 * Observe a detached step's completion once: the exit code, or `undefined` while it is still running.
	 *
	 * Prefers the filesystem done-file and degrades PERMANENTLY to the exec `cat` poll the first time the
	 * filesystem proves unsupported — retrying in the same call rather than surfacing a failure, because
	 * an absent capability is a discovery, not evidence the sandbox died. Every other error propagates
	 * untouched to the caller's consecutive-failure policy: a transient fs blip must keep the fs path (a
	 * real Blaxel incident, 2026-07-19), where permanent absence must abandon it, and only the stub's own
	 * error distinguishes the two. A dead sandbox is still caught, because the cat poll will fail too.
	 */
	private async pollDoneOnce(
		donePath: string,
		label: string,
		deadline: number,
	): Promise<number | null | undefined> {
		if (!this.pollFs) return this.pollDoneViaCat(donePath, deadline);
		try {
			return await this.pollDoneViaFs(this.pollFs, donePath, deadline);
		} catch (err) {
			if (!isUnsupportedFilesystem(err)) throw err;
			console.log(
				`    [${label}] this sandbox exposes no working filesystem; ` +
					`falling back to the exec done-file poll`,
			);
			this.pollFs = undefined;
			return this.pollDoneViaCat(donePath, deadline);
		}
	}

	/**
	 * Run a step on the transport the provider's {@link ProviderTransport} calls for: detached+poll when
	 * the step's budget could outlast the provider's synchronous cap and the provider supports it,
	 * otherwise a direct synchronous exec (see {@link selectTransport}). This is the capability-driven
	 * entry point the orchestrator uses for every step whose runtime can reach into the minutes (setup
	 * installs, the benchmark, result collection); trivial sub-second probes can call {@link run}
	 * directly. Both underlying transports populate `result.stdout`, so callers read it identically.
	 */
	async step(
		label: string,
		script: string,
		timeoutMs: number,
		opts: StepOptions = {},
	): Promise<Result> {
		return this.detached(timeoutMs)
			? this.runDetached(label, script, timeoutMs, opts)
			: this.run(label, script, timeoutMs, opts);
	}

	/**
	 * Synchronous foreground exec — for short steps. The timeout is a wait-cap, not a kill: on timeout
	 * the host stops waiting but the in-sandbox process keeps running server-side until job teardown
	 * destroys the sandbox. Use {@link runDetached} for long steps, which can 408 here and which it
	 * best-effort kills on timeout.
	 */
	async run(
		label: string,
		script: string,
		timeoutMs: number,
		opts: StepOptions = {},
	): Promise<Result> {
		timeoutMs = this.boundedTimeout(timeoutMs);
		console.log(`\n=== [${label}] ===`);
		const started = performance.now();
		const stopHeartbeat = startHeartbeat(label, started, timeoutMs);
		let result: Result;
		try {
			result = await withTimeout(
				this.execute(`bash -c ${shellQuote(`${this.preamble}; ${script}`)}`),
				timeoutMs,
				() => stepTimeout(label, timeoutMs),
			);
		} catch (error) {
			this.stepLog.push({
				phase: this.phase,
				label,
				ms: performance.now() - started,
				exitCode: null,
			});
			throw error;
		} finally {
			stopHeartbeat();
		}
		return this.finishStep(label, started, result, opts);
	}

	/**
	 * Run a long step on the durable detached transport: start it in the background (output → log
	 * file, exit code → done-file), then poll until the done-file appears and read both back. Survives
	 * Daytona's 408 on multi-minute synchronous execs. On timeout the detached job is best-effort
	 * killed; the job teardown's `destroy()` is the backstop either way.
	 *
	 * The background launch is double-fork daemonized: a single nohup/setsid still blocks e2b's envd,
	 * which holds the exec open for as long as its direct child lives (probed live), so the direct
	 * child backgrounds the real job via a second nohup and exits at once — the step truly detaches
	 * across providers. Completion is observed through the sandbox filesystem when one is exposed;
	 * otherwise (providers whose adapter has no filesystem API, and the unit-test fakes) it falls back
	 * to reading the done-file with a `cat` exec. The poll interval backs off adaptively
	 * ({@link POLL_START_MS} → ×{@link POLL_BACKOFF}, capped at {@link POLL_CAP_MS}) so a step that
	 * finishes quickly isn't over-charged for polling.
	 */
	async runDetached(
		label: string,
		script: string,
		timeoutMs: number,
		opts: StepOptions = {},
	): Promise<Result> {
		timeoutMs = this.boundedTimeout(timeoutMs);
		console.log(`\n=== [${label}] (detached) ===`);
		const started = performance.now();
		const stopHeartbeat = startHeartbeat(label, started, timeoutMs);
		const tag = `bench-${randomUUID()}`;
		const logPath = `/tmp/${tag}/output.log`;
		const donePath = `/tmp/${tag}/completion.done`;
		const deadline = started + timeoutMs;
		const evidence: DetachedStepEvidence = {
			identity: tag,
			label,
			phase: this.phase,
			state: "launch-pending",
			exitCode: null,
		};
		this.detachedEvidence.push(evidence);
		const logCount = this.stepLog.length;
		const remaining = () => Math.max(1, deadline - performance.now());
		let timeoutEvidenceCaptured = false;
		const recoverTimeoutEvidence = async () => {
			if (timeoutEvidenceCaptured) return;
			timeoutEvidenceCaptured = true;
			evidence.state = "deadline-exceeded";
			const rawTail = await this.readLogTail(this.pollFs, logPath);
			const tail =
				rawTail === null
					? null
					: redactDiagnosticText(rawTail, diagnosticSecretsFromEnv(process.env)).slice(-8192);
			evidence.logTail = tail;
			// Best-effort stop the detached job; don't let a failing kill mask the timeout.
			await withTimeout(
				this.execute(`pkill -f ${shellQuote(tag)} || true`),
				POLL_CAP_MS,
				"stop timed-out step",
			).catch(() => undefined);
			if (tail === null) {
				console.log(
					`--- "${label}" timed out and its log could not be read: output observation is unavailable ` +
						`and the cause is unknown ---`,
				);
			} else if (tail) {
				console.log(`--- last output from "${label}" before timeout ---\n${tail}`);
			}
		};
		try {
			// Start fully detached so the job outlives the (short-lived, 408-prone) exec round-trip.
			// Run preamble+script in a nested `bash -c` so `set -eo pipefail` governs the inner shell:
			// as part of the outer `&&/||` list a `{ … }` group has `set -e` suspended, so a mid-script
			// failure followed by a passing command would exit 0 and be recorded as success. The inner
			// shell aborts on first failure and its real exit code flows through the `&&/||` capture —
			// success writes 0, failure writes the real code.
			const wrapped = detachedCommand(tag, `${this.preamble}; ${script}`);
			await withTimeout(this.launch(wrapped), remaining(), () => stepTimeout(label, timeoutMs));
			evidence.state = "launch-accepted";

			// Poll for the done-file, backing off adaptively so a quick step isn't over-charged for polls.
			let pollDelayMs = POLL_START_MS;
			let consecutivePollFailures = 0;
			for (;;) {
				// A poll that THROWS is different from "not done yet": one blip is transient, but a run of
				// them means the sandbox stopped answering — fail fast instead of sitting on a dead sandbox
				// for the rest of the command budget (see MAX_CONSECUTIVE_POLL_FAILURES).
				let exitCode: number | null | undefined;
				try {
					exitCode = await withTimeout(
						this.pollDoneOnce(donePath, label, deadline),
						remaining(),
						() => stepTimeout(label, timeoutMs),
					);
					evidence.lastObservationMs = Math.round(performance.now() - started);
					evidence.state =
						exitCode === undefined
							? "running"
							: exitCode === null
								? "observation-unavailable"
								: "completed";
					evidence.exitCode = exitCode ?? null;
					consecutivePollFailures = 0;
				} catch (err) {
					if (err instanceof GapError && err.gapCause.kind === "step-timeout") throw err;
					evidence.state = "observation-unavailable";
					consecutivePollFailures++;
					if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
						const reason = err instanceof Error ? err.message : String(err);
						throw new GapError(
							`Step "${label}" lost its sandbox: ${consecutivePollFailures} consecutive detached ` +
								`polls failed (last: ${reason}) — the sandbox stopped responding, not a quiet long step`,
							{ kind: "sandbox-lost", step: label, consecutivePollFailures },
						);
					}
				}
				if (exitCode !== undefined) {
					try {
						// this.pollFs, not the raw capability: once the poll has degraded, the read-back must not
						// re-try the same broken API and burn its whole retry budget rediscovering that.
						let stdout: string;
						try {
							stdout = await withTimeout(
								this.readCompletedLog(this.pollFs, logPath, label, deadline),
								remaining(),
								() => stepTimeout(label, timeoutMs),
							);
						} catch (error) {
							evidence.state = "collection-failed";
							throw error;
						}
						return this.finishStep(
							label,
							started,
							this.completed(exitCode, stdout, performance.now() - started),
							opts,
						);
					} finally {
						// The read-back is done — its contents are in memory — so drop the log/done files
						// now. collectResults re-runs the WHOLE detached step on a transient read-back
						// failure, and each attempt's log holds the entire base64 results tar; leaving stale
						// ones behind would pile large files into the sandbox's /tmp across retries, exactly
						// when the sandbox disk is tight (the case the stdout-streamed collect exists for).
						await this.removeDetachedFiles(logPath, donePath);
					}
				}
				if (performance.now() > deadline) {
					// Recover the detached job's own output BEFORE killing it and tearing the sandbox down.
					// A timed-out step is otherwise a black box: the log lives only inside the sandbox, and
					// a step that hangs is exactly the one whose output we need. Best-effort — a failed read
					// must not mask the timeout.
					await recoverTimeoutEvidence();
					throw stepTimeout(label, timeoutMs);
				}
				await this.sleep(Math.min(pollDelayMs, remaining()));
				pollDelayMs = Math.min(pollDelayMs * POLL_BACKOFF, POLL_CAP_MS);
			}
		} catch (error) {
			if (
				((error instanceof GapError && error.gapCause.kind === "step-timeout") ||
					performance.now() >= deadline) &&
				evidence.state !== "completed" &&
				evidence.state !== "collection-failed"
			) {
				await recoverTimeoutEvidence();
			}
			if (this.stepLog.length === logCount)
				this.stepLog.push({
					phase: this.phase,
					label,
					ms: Math.round(performance.now() - started),
					exitCode: evidence.exitCode,
				});
			throw error;
		} finally {
			stopHeartbeat();
		}
	}

	/** Check the filesystem-backed done-file: its trimmed contents are the exit code, or `undefined`
	 *  while the detached step is still running. */
	private async pollDoneViaFs(
		fs: SandboxFilesystem,
		donePath: string,
		deadline: number,
	): Promise<number | null | undefined> {
		// Bound both fs calls so a hung filesystem API (some adapters go over the network) can't
		// stall the poll loop indefinitely — the outer deadline only advances between iterations.
		// A timeout or fs error THROWS to the poll loop, which tolerates a transient blip but fails
		// fast on a run of them (a dead sandbox); swallowing errors here once made a killed sandbox
		// indistinguishable from a quietly-running step for the entire command budget.
		observationBudget(deadline);
		if (
			!(await withTimeout(fs.exists(donePath), observationBudget(deadline), "done-file fs exists"))
		) {
			return undefined;
		}
		// Empty data cannot establish completion, even if the storage transport reports existence.
		observationBudget(deadline);
		const raw = await withTimeout(
			fs.readFile(donePath),
			observationBudget(deadline),
			"done-file fs read",
		);
		return raw === "" ? undefined : completionCode(raw, donePath.split("/")[2] ?? "");
	}

	/** Poll fallback for providers whose adapter exposes no filesystem API: read the done-file with a
	 *  `cat` exec, treating the {@link RUNNING_SENTINEL} (or empty output) as not-done-yet. */
	private async pollDoneViaCat(
		donePath: string,
		deadline: number,
	): Promise<number | null | undefined> {
		// Bound the exec so a hung `cat` can't outlast the step budget. An exec failure or timeout
		// THROWS to the poll loop (which tolerates transient blips but fails fast on a dead sandbox);
		// an absent done-file is the RUNNING_SENTINEL, not an error.
		observationBudget(deadline);
		const probe = await withTimeout(
			this.execute(
				`bash -c ${shellQuote(`cat ${donePath} 2>/dev/null || echo ${RUNNING_SENTINEL}`)}`,
			),
			observationBudget(deadline),
			"done-file cat poll",
		);
		// The `|| echo RUNNING_SENTINEL` guard makes bash exit 0 whether the done-file is present or
		// absent, so a non-zero code means the shell itself couldn't run — a wedged sandbox, not a
		// missing done-file. THROW so the poll loop's consecutive-failure fast-fail engages, matching
		// pollDoneViaFs; swallowing it as "still running" would sit on a dead sandbox for the whole
		// step budget — the exact failure this detached path exists to catch.
		if (this.exitCode(probe) !== 0) {
			throw new Error(
				`done-file cat poll returned exit ${this.exitCode(probe)} — sandbox not responding`,
			);
		}
		const out = probe.stdout ?? "";
		if (out === "" || out.trim() === RUNNING_SENTINEL) return undefined;
		return completionCode(out, donePath.split("/")[2] ?? "");
	}

	/** The last {@link TIMEOUT_LOG_TAIL_LINES} lines of a detached step's log, or `null` when the log
	 *  could not be read at all. The distinction matters: an empty tail means the step ran quietly,
	 *  whereas an unreadable one means the sandbox stopped answering — a very different diagnosis, and
	 *  collapsing both to "" once sent us hunting a detach bug that was really memory exhaustion.
	 *  Bounded so a runaway log can't flood the CI transcript; never throws. */
	private async readLogTail(
		fs: SandboxFilesystem | undefined,
		logPath: string,
	): Promise<string | null> {
		const text = fs
			? await withTimeout(fs.readFile(logPath), POLL_CAP_MS, "log fs read").catch(() => null)
			: await this.catLogOrNull(logPath);
		if (text === null) return null;
		const lines = text.trimEnd().split("\n");
		return lines.slice(-TIMEOUT_LOG_TAIL_LINES).join("\n");
	}

	/**
	 * Read a COMPLETED detached step's log back — the step's entire output. The primary transport (fs
	 * when exposed, else the exec `cat`) is retried through transient blips ({@link READBACK_ATTEMPTS});
	 * a filesystem API that stays down falls back to the exec transport, which can be healthy while the
	 * fs API is not (observed on Blaxel). When every transport fails, THROW: folding the failure into
	 * stdout `""` handed callers that parse the output (collectResults) an empty string, silently
	 * discarding a finished suite's results while the sandbox was alive and still holding them.
	 */
	private async readCompletedLog(
		fs: SandboxFilesystem | undefined,
		logPath: string,
		label: string,
		deadline: number,
	): Promise<string> {
		let lastFailure = "";
		for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
			observationBudget(deadline);
			if (fs) {
				try {
					return await withTimeout(
						fs.readFile(logPath),
						observationBudget(deadline),
						"log fs read",
					);
				} catch (err) {
					lastFailure = err instanceof Error ? err.message : String(err);
				}
			} else {
				const text = await this.catLogOrNull(logPath, deadline);
				if (text !== null) return text;
				lastFailure = "log cat read failed";
			}
			if (attempt < READBACK_ATTEMPTS)
				await this.sleep(Math.min(READBACK_DELAY_MS, observationBudget(deadline)));
		}
		// Cross-transport fallback: the fs API can be freshly wedged while plain exec still answers —
		// try the other transport before declaring the log unreachable. (No-fs sandboxes already spent
		// every attempt on exec; there is no other transport to try.)
		if (fs) {
			const text = await this.catLogOrNull(logPath, deadline);
			if (text !== null) return text;
			lastFailure = `${lastFailure}; exec fallback also failed`;
		}
		throw new LogReadbackError(
			`Step "${label}" completed but its log could not be read back (transport failure): ` +
				`${READBACK_ATTEMPTS} reads failed (last: ${lastFailure}) — the step's output still exists ` +
				`in the sandbox but no transport could reach it`,
		);
	}

	/** `cat` the log over exec for {@link readLogTail} and {@link readCompletedLog}, preserving a read
	 *  failure as `null` rather than folding it into `""` — an unreadable log (wedged sandbox, dead
	 *  transport) must stay distinguishable from a step that simply printed nothing. */
	private async catLogOrNull(logPath: string, deadline = Infinity): Promise<string | null> {
		// No `|| true`: a failing cat (unreadable/absent log) must surface as null, not as a
		// successful empty read — `|| true` once collapsed exec-transport failure into stdout "",
		// which readCompletedLog then accepted as the step's real (empty) output. Exit 0 with empty
		// stdout remains a legitimate read of a genuinely empty log.
		observationBudget(deadline);
		return withTimeout(
			this.execute(`bash -c ${shellQuote(`cat ${logPath} 2>/dev/null`)}`),
			observationBudget(deadline),
			"log cat read",
		)
			.then((res) => (this.exitCode(res) === 0 ? (res.stdout ?? "") : null))
			.catch(() => null);
	}

	/** Best-effort delete a completed detached step's log + done files once their contents have been
	 *  read back. Bounded so a hung fs can't stall teardown, and it NEVER throws: cleanup must not mask
	 *  the step's real result, and a sandbox on its way to `destroy()` may already be unreachable — a
	 *  failed rm just leaves the same orphaned files the sandbox teardown reclaims anyway. */
	private async removeDetachedFiles(logPath: string, donePath: string): Promise<void> {
		await withTimeout(
			this.execute(
				`bash -c ${shellQuote(`rm -f ${logPath} ${donePath}; rmdir ${donePath.slice(0, donePath.lastIndexOf("/"))}`)}`,
			),
			POLL_CAP_MS,
			"detached file cleanup",
		).catch(() => undefined);
	}

	/** Shared post-step bookkeeping: record the step, echo output (unless silent), enforce exit code. */
	private finishStep(label: string, started: number, result: Result, opts: StepOptions): Result {
		const elapsedMs = Math.round(performance.now() - started);
		const elapsedS = (elapsedMs / 1000).toFixed(1);
		this.stepLog.push({
			phase: this.phase,
			label,
			ms: elapsedMs,
			exitCode: this.exitCode(result),
		});

		if (result.stdout && !opts.silent) {
			const stdout = redactDiagnosticText(result.stdout, diagnosticSecretsFromEnv(process.env));
			process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
		}
		if (result.stderr && !opts.silent) {
			const stderr = redactDiagnosticText(result.stderr, diagnosticSecretsFromEnv(process.env));
			process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
		}
		console.log(`=== [${label}] exit ${this.describeExit(result)} in ${elapsedS}s ===`);

		if (this.exitCode(result) !== 0 && !opts.allowFailure) {
			// A silent step withheld its output above; surface it now so the failure is debuggable. The
			// detached transport merges stderr into stdout (2>&1), so fall back to stdout when no stderr.
			if (opts.silent) {
				const tail = redactDiagnosticText(
					result.stderr || result.stdout || "",
					diagnosticSecretsFromEnv(process.env),
				);
				if (tail) process.stderr.write(tail.endsWith("\n") ? tail : `${tail}\n`);
			}
			const code = this.exitCode(result);
			if (code === null) throw new Error(`Step "${label}" failed: ${this.describeExit(result)}`);
			throw new GapError(`Step "${label}" failed with exit code ${this.describeExit(result)}`, {
				kind: "step-failed",
				step: label,
				exitCode: code,
			});
		}
		return result;
	}
}

/** Legacy execution facade retained until the last provider migration. */
export class StepRunner extends StepExecution<CommandResult> {
	constructor(
		private readonly sandbox: SandboxHandle,
		private readonly transport: ProviderTransport = DEFAULT_TRANSPORT,
		sleep: (ms: number) => Promise<void> = delay,
		passPolicy: PtsPassPolicy = DEFAULT_PTS_PASS_POLICY,
	) {
		super(sandbox.filesystem, sleep, passPolicy);
	}
	protected execute(command: string): Promise<CommandResult> {
		return this.sandbox.runCommand(command);
	}
	protected async launch(command: string): Promise<void> {
		const daemonized = `nohup bash -c ${shellQuote(command)} </dev/null >/dev/null 2>&1 &`;
		const launch = `nohup bash -c ${shellQuote(daemonized)} </dev/null >/dev/null 2>&1 & echo launched`;
		await this.sandbox.runCommand(`bash -c ${shellQuote(launch)}`, { background: true });
	}
	protected detached(timeoutMs: number): boolean {
		return selectTransport(this.transport, timeoutMs) === "detached";
	}
	protected exitCode(result: CommandResult): number {
		return result.exitCode;
	}
	protected describeExit(result: CommandResult): string {
		return String(result.exitCode);
	}
	protected completed(exitCode: number | null, stdout: string): CommandResult {
		return { exitCode: exitCode ?? 1, stdout };
	}
}

/** Runs workload steps directly on a driver session, retaining its full execution result. */
export class SessionStepRunner extends StepExecution<ExecResult> {
	constructor(
		private readonly session: SandboxSession,
		private readonly execution: ExecutionPolicy,
		sleep: (ms: number) => Promise<void> = delay,
		passPolicy: PtsPassPolicy = DEFAULT_PTS_PASS_POLICY,
		phaseDeadline?: (phase: Phase) => number,
	) {
		super(session.files, sleep, passPolicy, phaseDeadline);
	}
	protected execute(command: string): Promise<ExecResult> {
		return this.session.exec(command);
	}
	protected launch(command: string): Promise<void> {
		return launchDetached(this.session, command);
	}
	protected detached(timeoutMs: number): boolean {
		return selectExecutionRoute(this.execution, timeoutMs) === "durable";
	}
	protected exitCode(result: ExecResult): number | null {
		return result.exit.kind === "exited" ? result.exit.code : null;
	}
	protected describeExit(result: ExecResult): string {
		switch (result.exit.kind) {
			case "exited":
				return String(result.exit.code);
			case "signalled":
				return `signal ${result.exit.signal}`;
			case "unknown":
				return `unknown (${result.exit.detail})`;
		}
	}
	protected completed(code: number | null, stdout: string, durationMs: number): ExecResult {
		return {
			exit:
				code === null
					? { kind: "unknown", detail: "invalid detached completion status" }
					: { kind: "exited", code },
			stdout,
			stderr: "",
			durationMs,
			truncated: false,
		};
	}
}
