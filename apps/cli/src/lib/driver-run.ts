import { executeSuite, measureLifecycleOperation } from "@sandbox-benchmarks/harness";
// The driver composition root (ADR-0007 §1).
//
// The kit deliberately splits three trust boundaries that a single `config` object used to blur:
// loading a driver module reads no ambient env, resolving an artifact imports no vendor SDK, and the
// driver never decides whether a run boots a candidate or a published artifact. This module owns
// those three small functions and nothing else, so `apps/cli` stays the only place the fleet and the
// harness meet.
//
// It also owns the two adapters that let a `SandboxSession` drive today's harness while
// `packages/harness` still speaks the legacy `SandboxHandle` shape. Both are deliberately thin and
// both disappear when the harness flips to the port.

import { resolve } from "node:path";
import type {
	CreateRequest,
	DriverModule,
	ExecResult,
	ResolvedArtifact,
	SandboxDriver,
	SandboxSession,
} from "@sandbox-benchmarks/driver";
import {
	isRetryableDriverCreate,
	launchDetached,
	readTextFile,
	succeeded,
	writeTextFile,
} from "@sandbox-benchmarks/driver";
import {
	driverReadinessBudgetMs,
	verifyDriverReadiness,
} from "@sandbox-benchmarks/driver/conformance";
import { missingDriverEnvNames, parseDriverEnv } from "@sandbox-benchmarks/driver/env";
import type { DriverProviderId } from "@sandbox-benchmarks/drivers";
import { DRIVERS, loadDriverModule } from "@sandbox-benchmarks/drivers";
import type {
	BenchmarkLifecycleOptions,
	LifecycleBenchmark,
	LifecycleCompute,
	RunSuiteOptions,
	SandboxHandle,
} from "@sandbox-benchmarks/harness";
import {
	benchmarkLifecycleCompute,
	CREATE_FAILURE_PREFIX,
	createOwnedSandbox,
	createSuiteSandboxFromPlan,
	recordSuiteGap,
	releaseOwnedSandbox,
	runSuiteOnSandbox,
	SUITE_CREATE_ATTEMPT_TIMEOUT_MS,
	SuiteUsageError,
	withCleanupPreservingPrimaryError,
} from "@sandbox-benchmarks/harness";
import type {
	ArtifactPhase,
	ProviderArtifact,
	ProviderId,
	ProviderTransport,
} from "@sandbox-benchmarks/schema";
import {
	bakedArtifactName,
	isBakedProviderId,
	REGISTRY,
	SUITE_NAMES,
	SUITES,
	TARGET_SPEC,
} from "@sandbox-benchmarks/schema";
import { toolchainImageRef } from "@sandbox-benchmarks/schema/toolchain";

/** Optional overrides a caller may supply instead of the registry-derived defaults. */
export interface ArtifactResolution {
	/** Which published phase the lane targets. Defaults to the immutable version. */
	readonly phase?: ArtifactPhase;
	/** Explicit ref, for validating an unpublished artifact without editing the registry. */
	readonly ref?: string;
}

/**
 * Resolve one provider's registry artifact descriptor to the concrete ref its driver will boot.
 *
 * This is the lane decision ADR-0007 keeps out of drivers: the registry says *what kind* of artifact
 * a provider boots, the composition root says *which one*. Every branch derives from a schema leaf,
 * so adding a provider needs no edit here — only a `built` recipe, whose resolver is provider-side
 * work by definition, must be supplied explicitly.
 */
export function resolveDriverArtifact(
	id: ProviderId,
	resolution: ArtifactResolution = {},
): ResolvedArtifact {
	return resolveArtifactDescriptor(id, REGISTRY[id].artifact, resolution);
}

/**
 * The exhaustive descriptor→ref mapping, taking the descriptor as a parameter.
 *
 * Deliberately not a `const` narrowed from `REGISTRY[id]`: that narrows the union to the kinds the
 * registry happens to declare today, so the first provider to register a new artifact kind would
 * silently fall through instead of failing the exhaustiveness check here.
 */
function resolveArtifactDescriptor(
	id: ProviderId,
	descriptor: ProviderArtifact,
	resolution: ArtifactResolution,
): ResolvedArtifact {
	const phase = resolution.phase ?? "version";
	const override = resolution.ref;
	switch (descriptor.kind) {
		case "none":
			// A provider that boots stock has nothing to resolve; an override would be a silent lie.
			if (override !== undefined) {
				throw new Error(`${id} declares artifact kind "none" and cannot boot ref ${override}`);
			}
			return { kind: "none" };
		case "image":
			return { kind: "image", ref: override ?? toolchainImageRef(phase) };
		case "baked": {
			if (override !== undefined) return { kind: "baked", ref: override };
			// The descriptor kind and the id partition are two views of one registry fact; the guard
			// carries that correlation across the type boundary rather than casting it away.
			if (!isBakedProviderId(id)) {
				throw new Error(`${id} declares a baked artifact but is not in the baked partition`);
			}
			return { kind: "baked", ref: bakedArtifactName(id, phase) };
		}
		case "mirror":
			// The mirrored ref is namespace-scoped configuration, never a registry constant.
			if (override === undefined) {
				throw new Error(`${id} boots a mirrored artifact; pass an explicit ref to resolve it`);
			}
			return { kind: "mirror", ref: override };
		case "built":
			// Building the artifact is release-lane work (ADR-0007 §7); this lane only boots its result.
			if (override === undefined) {
				throw new Error(
					`${id} boots a built artifact from recipe ${descriptor.recipe}; pass the built ref`,
				);
			}
			return { kind: "built", ref: override };
	}
}

/**
 * Project a driver module's execution policy onto the transport the current `StepRunner` reads.
 *
 * This is the seam that makes the policy load-bearing rather than decorative: `syncCapMs` crosses
 * unchanged, and `detachedPoll` is exactly "the module declared a durable route". `streaming` has no
 * transport consumer (ADR-0008 excludes it from the conformance inventory), so it is reported false
 * rather than invented.
 */
export function driverTransport(
	execution: DriverModule<ProviderId>["execution"],
): ProviderTransport {
	return {
		streaming: false,
		syncCapMs: execution.syncCapMs,
		detachedPoll: execution.durable !== "none",
	};
}

/**
 * Adapt a port session to the harness's legacy sandbox shape.
 *
 * Two properties are load-bearing. First, `filesystem` is present only when the session actually
 * exposes a working one — capability-by-presence, so the detached transport's poll can never select
 * a stub that throws (the namespace incident behind ADR-0008). Second, a background request routes
 * through `launchDetached`, which uses the driver's native `launch` when it has one and the kit's
 * `nohup` fallback when it does not, instead of fabricating a `CommandResult` for work that has not
 * finished.
 */
export function sessionHandle(session: SandboxSession): SandboxHandle {
	const handle: SandboxHandle = {
		sandboxId: session.sandboxRef.id,
		runCommand: async (command, options) => {
			if (options?.background === true) {
				await launchDetached(session, command);
				// A launch has no outcome yet. The harness observes completion through the done-file,
				// so the only honest placeholder is a success-shaped envelope with no output.
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			return commandResult(await session.exec(command));
		},
		destroy: (options?: { readonly signal?: AbortSignal }) => session.destroy(options),
	};
	const files = session.files;
	if (files === undefined) return handle;
	return {
		...handle,
		filesystem: {
			readFile: (path) => files.readFile(path),
			exists: (path) => files.exists(path),
		},
	};
}

/**
 * Collapse a port `ExecResult` onto the harness's `CommandResult`.
 *
 * The port models a withheld exit code as evidence (`kind: "unknown"`); the legacy shape has only a
 * number. A non-`exited` outcome therefore becomes a nonzero code with the reason preserved on
 * stderr, so the detail survives into the step log rather than being flattened into a bare `1`.
 */
function commandResult(result: ExecResult): { stdout: string; stderr: string; exitCode: number } {
	if (result.exit.kind === "exited") {
		return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exit.code };
	}
	const detail =
		result.exit.kind === "signalled"
			? `command terminated by signal ${result.exit.signal}`
			: `command exit status unavailable: ${result.exit.detail}`;
	const stderr = result.stderr.length > 0 ? `${result.stderr}\n${detail}` : detail;
	return { stdout: result.stdout, stderr, exitCode: 1 };
}

/**
 * Everything the composition root produced for one provider, before any sandbox exists.
 *
 * `module` is widened to the id-erased `DriverModule` because a caller holding a *runtime*
 * `ProviderId` cannot retain the correlation the generated map expresses for literal ids. The
 * handle type is erased with it — which is exactly ADR-0007's rule that a caller with a runtime id
 * receives the safe union and ignores `native`.
 */
export interface OpenedDriver {
	readonly module: DriverModule<ProviderId>;
	readonly driver: SandboxDriver;
	readonly artifact: ResolvedArtifact;
	readonly transport: ProviderTransport;
}

/** A live driver session whose process ownership can be explicitly handed to the operator. */
export interface OwnedDriverSession extends SandboxSession {
	/** Stop the process-exit drain from destroying this session. Intended only for `--keep`. */
	releaseOwnership(): boolean;
}

/**
 * Create a port session under the harness's process-level owner.
 *
 * Registration happens before provider create starts, so signals and failed-create cleanup records
 * cannot fall through the validation lane. The returned adapter delegates every method to the raw
 * session while routing destroy through the owner's idempotent release boundary.
 */
export async function createOwnedDriverSession(
	driver: SandboxDriver,
	request: CreateRequest,
): Promise<OwnedDriverSession> {
	const session = await createOwnedSandbox((signal) => driver.create(request, { signal }), {
		destroy: (providerDestroy, options) => providerDestroy(options),
	});
	const launch = session.launch?.bind(session);
	return {
		sandboxRef: session.sandboxRef,
		artifact: session.artifact,
		native: session.native,
		exec: (command, options) => session.exec(command, options),
		destroy: (options) => session.destroy(options),
		releaseOwnership: () => releaseOwnedSandbox(session),
		...(session.files === undefined ? {} : { files: session.files }),
		...(launch === undefined ? {} : { launch }),
	};
}

/**
 * Registry inputs whose value replaces the resolved artifact ref for a registered DriverModule.
 *
 * The leftover lane honors the same variable through its config gatekeeper (`config.e2bTemplate`),
 * and CI forwards it on every e2b cell, so defaulting e2b to the driver lane must not quietly drop
 * it: an ignored override boots the published template while the operator believes they pinned a
 * debug one. Keyed by id on purpose — "this input names an artifact" is a fact about the provider's
 * artifact descriptor, not something the registry's input descriptors declare, so there is nothing
 * honest to infer it from.
 */
const ARTIFACT_REF_OVERRIDE_ENV = {
	e2b: "E2B_TEMPLATE",
} as const satisfies Partial<Record<DriverProviderId, string>>;

/**
 * Which artifact ref this open should resolve: an explicit caller ref, else the operator's override.
 *
 * A caller-supplied ref (bake candidate validation) is the more specific request and wins. The
 * override is read from the PARSED driver env, so CI's "set but empty" spelling of an unconfigured
 * variable is already normalized to absent and cannot resolve an empty artifact ref.
 */
export function driverArtifactResolution(
	id: DriverProviderId,
	env: Readonly<Record<string, unknown>>,
	resolution: ArtifactResolution = {},
): ArtifactResolution {
	if (resolution.ref !== undefined) return resolution;
	const name: string | undefined = ARTIFACT_REF_OVERRIDE_ENV[
		id as keyof typeof ARTIFACT_REF_OVERRIDE_ENV
	] as string | undefined;
	const override = name === undefined ? undefined : env[name];
	return typeof override === "string" && override.length > 0
		? { ...resolution, ref: override }
		: resolution;
}

/**
 * Run ADR-0007's composition flow for one provider: load, parse, resolve, construct.
 *
 * Deliberately ordered so nothing vendor-specific evaluates until the module is selected, and
 * nothing ambient is read until the module has been loaded.
 */
export async function openDriver<P extends DriverProviderId>(
	id: P,
	options: {
		readonly artifact?: ArtifactResolution;
		readonly env?: Readonly<Record<string, string | undefined>>;
	} = {},
): Promise<OpenedDriver> {
	// Erase the correlation here, once, rather than at every downstream use. `loadDriverModule` and
	// the generated map already prove `id`'s module is the one whose literal id matches (see the
	// `_EveryDriverModuleMatchesItsId` assertion in packages/drivers/src/index.ts); TypeScript cannot
	// carry that through a generic parameter, and this is the single place that gap is crossed.
	const module = (await loadDriverModule(id)) as DriverModule<ProviderId>;
	const env = parseDriverEnv(id, options.env ?? process.env);
	const artifact = resolveDriverArtifact(id, driverArtifactResolution(id, env, options.artifact));
	// The context's three members are exactly what the registry declares for this id: the descriptor
	// and the resolved artifact both derive from REGISTRY[id], so they agree by construction.
	const driver = module.driver({
		env,
		artifact: REGISTRY[id].artifact,
		resolvedArtifact: artifact,
	} as Parameters<DriverModule<ProviderId>["driver"]>[0]);
	return { module, driver, artifact, transport: driverTransport(module.execution) };
}

/** True when `value` is a registered DriverModule id (`Object.keys(DRIVERS)`). */
export function isDriverProviderId(value: string): value is DriverProviderId {
	return Object.hasOwn(DRIVERS, value);
}

/**
 * Default lane selection: a registered DriverModule id uses {@link loadDriverModule} /
 * {@link runDriverSuite} / {@link withDriverSandbox} without `--driver-path`. Waived/unknown ids stay on the legacy `packages/providers` path
 * unless the flag forces the driver lane (which then errors rather than inventing a module).
 */
export function usesDriverSuite(providerId: string, driverPathFlag = false): boolean {
	return driverPathFlag || isDriverProviderId(providerId);
}

/** Providers whose consumers have moved to declarative session operations in the migration stack. */
export function usesSessionOperations(id: DriverProviderId): boolean {
	return id === "e2b" || id === "tama" || id === "modal-gvisor";
}

/**
 * Split a module's declared create budget into the three numbers the harness and the request need.
 *
 * A module that owns its bound (`owner: "driver"`) turns the harness race OFF (`timeoutMs: null`) and
 * declares the ceiling instead, so the retry loop can still subtract one attempt's worst case before
 * starting another — the same pair `assertCreateCeilingDeclared` enforces on leftover adapters.
 * Either way the request deadline is whatever actually bounds an attempt, so the driver and the loop
 * cannot disagree about how long one create may take.
 */
function createBudgetOf(module: DriverModule<ProviderId>): {
	readonly timeoutMs: number | null;
	readonly attemptCeilingMs: number | undefined;
	readonly requestDeadlineMs: number;
} {
	const budget = module.createBudget;
	if (budget?.owner === "driver") {
		return {
			timeoutMs: null,
			attemptCeilingMs: budget.attemptCeilingMs,
			requestDeadlineMs: budget.attemptCeilingMs,
		};
	}
	const timeoutMs = budget?.timeoutMs ?? SUITE_CREATE_ATTEMPT_TIMEOUT_MS;
	return { timeoutMs, attemptCeilingMs: undefined, requestDeadlineMs: timeoutMs };
}

/** The pinned create request the composition root issues for an already-opened driver. */
export function openedDriverCreateRequest(opened: OpenedDriver): CreateRequest {
	return benchmarkCreateRequest(opened.artifact, createBudgetOf(opened.module).requestDeadlineMs);
}

/**
 * Boot one DriverModule sandbox, run `fn` against its harness handle, and always tear it down.
 * Smoke and bake-validate use this so registered ids create through {@link loadDriverModule}.
 */
export async function withDriverSandbox<T>(
	id: DriverProviderId,
	fn: (sandbox: SandboxHandle) => Promise<T>,
	options: {
		readonly artifact?: ArtifactResolution;
		readonly env?: Readonly<Record<string, string | undefined>>;
	} = {},
): Promise<T> {
	const opened = await openDriver(id, options);
	const session = await createOwnedDriverSession(opened.driver, openedDriverCreateRequest(opened));
	return withCleanupPreservingPrimaryError(
		() => fn(sessionHandle(session)),
		() => session.destroy(),
		(error) =>
			console.error(
				`withDriverSandbox (${id}): teardown failed after the operation failed:`,
				error,
			),
	);
}

/**
 * Project an opened DriverModule onto the structural {@link LifecycleCompute} the harness times.
 *
 * Create goes through {@link SandboxDriver.create}. Control-plane info uses `probes.describe` when
 * present, otherwise `probes.observe` (the return value is never inspected — it is a latency probe).
 *
 * `list` and `snapshot` are capability-by-presence, and none of the four registered modules declares
 * either today, so both record a skip rather than a measurement. That is deliberate: a projection
 * that reached around the port to call a vendor list would time a call the driver does not own, and
 * ADR-0008's whole premise is that a declared capability must be the one the driver actually
 * exercises. The recorded skip says exactly that — "the integration under measurement exposes no
 * such operation" — not that the vendor SDK lacks one. Wiring `probes.list` (and a snapshot
 * capability) onto the registered modules restores those metrics without touching this projection.
 */
export function driverLifecycleCompute(opened: OpenedDriver): LifecycleCompute {
	const request = openedDriverCreateRequest(opened);
	const probes = opened.driver.probes;
	const describe = probes?.describe?.bind(probes);
	const observe = probes?.observe?.bind(probes);
	const list = probes?.list?.bind(probes);
	return {
		sandbox: {
			create: async () => {
				const session = await opened.driver.create(request);
				const handle = sessionHandle(session);
				const info = describe
					? () => describe(session.sandboxRef)
					: observe
						? () => observe(session.sandboxRef)
						: undefined;
				return {
					sandboxId: session.sandboxRef.id,
					runCommand: (command, options) => handle.runCommand(command, options),
					destroy: () => session.destroy(),
					...(info === undefined ? {} : { getInfo: info }),
				};
			},
			...(list === undefined
				? {}
				: {
						list: async () => {
							const rows = await list();
							if (!Array.isArray(rows)) {
								throw new Error("driver list probe did not return an array");
							}
							return rows;
						},
					}),
		},
	};
}

/** Cold-start / control-plane measurement against a registered DriverModule. */
export async function benchmarkDriverLifecycle(
	id: DriverProviderId,
	options: BenchmarkLifecycleOptions = {},
): Promise<LifecycleBenchmark> {
	const opened = await openDriver(id);
	if (usesSessionOperations(id))
		return measureLifecycleOperation(
			{
				module: opened.module,
				driver: opened.driver,
				request: { spec: TARGET_SPEC, artifact: opened.artifact },
			},
			options,
		);
	return benchmarkLifecycleCompute(id, driverLifecycleCompute(opened), options);
}

/**
 * Run one real benchmark cell through a registered DriverModule.
 *
 * Default `bench-suite <id>` selects this for every registered DriverModule id. An unregistered
 * (waived) provider is rejected here instead of inventing a driver or falling back — the legacy
 * `runSuite` path still serves those ids. The shared harness still owns create retry budgeting,
 * failure markers, result collection, teardown, and Run v6 artifact evidence.
 */
export async function runDriverSuite(options: RunSuiteOptions): Promise<void> {
	const suiteName = SUITE_NAMES.find((name) => name === options.suiteName);
	if (suiteName === undefined) {
		throw new SuiteUsageError(
			`Unknown suite "${options.suiteName}". Known suites: ${SUITE_NAMES.join(", ")}`,
		);
	}
	if (!isDriverProviderId(options.providerName)) {
		throw new SuiteUsageError(
			`${options.providerName} has no DriverModule (migrated: ${Object.keys(DRIVERS).join(", ")})`,
		);
	}

	const providerName = options.providerName;
	const resultsDir = resolve(options.resultsDir);
	const env = options.env ?? process.env;
	const missing = missingDriverEnvNames(providerName, env);
	if (missing.length > 0) {
		const reason = `Missing credentials: ${missing.join(", ")}`;
		console.log(`SKIPPED ${providerName}/${suiteName}: ${reason}`);
		recordSuiteGap({
			resultsDir,
			providerName,
			suiteName,
			outcome: "skipped",
			reason,
			cause: { kind: "missing-credentials", variables: [...missing] },
		});
		return;
	}

	let opened: OpenedDriver;
	try {
		opened = await openDriver(providerName, { env });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// This matches the legacy boundary: constructing the selected adapter is part of sandbox create,
		// and a failure here must leave a raw-tree fact rather than normalize as "never scheduled". Like
		// the shared create boundary, marker persistence is best-effort: a read-only/full results tree
		// must not replace the driver-construction error that explains why the cell failed.
		try {
			recordSuiteGap({
				resultsDir,
				providerName,
				suiteName,
				outcome: "failed",
				reason: `${CREATE_FAILURE_PREFIX}${message}`,
				cause: { kind: "sandbox-create-failed", detail: message },
			});
		} catch (markerError) {
			console.error(
				`Could not write the driver-construction gap marker (${
					markerError instanceof Error ? markerError.message : String(markerError)
				}); the driver-construction error below is unaffected`,
			);
		}
		throw error;
	}

	if (usesSessionOperations(providerName)) {
		await executeSuite({
			allocation: {
				module: opened.module,
				driver: opened.driver,
				request: { spec: TARGET_SPEC, artifact: opened.artifact },
			},
			runId: options.runId,
			...(options.replicateIndex === undefined ? {} : { replicateIndex: options.replicateIndex }),
			suiteName,
			resultsDir,
		});
		return;
	}

	const suite = SUITES[suiteName];
	const createBudget = createBudgetOf(opened.module);
	let session: SandboxSession | undefined;
	const sandbox = await createSuiteSandboxFromPlan(
		{
			create: async (signal) => {
				session = await opened.driver.create(
					benchmarkCreateRequest(opened.artifact, createBudget.requestDeadlineMs),
					{ signal },
				);
				return sessionHandle(session);
			},
			// Typed DriverError rule (code + retryable mark and/or vendorHttpStatus 429). Do not regex
			// vendor prose here — that is the legacy drift ADR-0008 dropped retryableCreatePatterns to end.
			isRetryable: isRetryableDriverCreate,
			destroy: (destroy, destroyOptions) => destroy(destroyOptions),
		},
		{
			suite,
			suiteName,
			providerName,
			resultsDir,
			createTimeoutMs: createBudget.timeoutMs,
			...(createBudget.attemptCeilingMs === undefined
				? {}
				: { createAttemptCeilingMs: createBudget.attemptCeilingMs }),
		},
	);

	await runSuiteOnSandbox(sandbox, {
		runId: options.runId,
		...(options.replicateIndex === undefined ? {} : { replicateIndex: options.replicateIndex }),
		suite,
		suiteName,
		providerName,
		artifact: opened.artifact,
		resultsDir,
		transport: opened.transport,
		...(opened.module.costEvidence === undefined
			? {}
			: { costEvidence: opened.module.costEvidence }),
		driverReadiness: {
			timeoutMs: driverReadinessBudgetMs(opened.module),
			verify: async ({ signal }) => {
				if (session === undefined) {
					return { ready: false, detail: "driver create returned no retained session" };
				}
				const result = await verifyDriverReadiness(opened.module, session, { signal });
				return { ready: result.status === "pass", detail: result.detail };
			},
		},
	});
}

/** The benchmark's pinned target, as a create request. Exported so callers cannot drift from it. */
export function benchmarkCreateRequest(
	artifact: ResolvedArtifact,
	deadlineMs: number,
): CreateRequest {
	return { spec: TARGET_SPEC, artifact, deadlineMs };
}

export { readTextFile, succeeded, writeTextFile };
