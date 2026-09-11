// Runloop is a native SDK module over @runloop/api-client. The published @computesdk/runloop
// wrapper swallows get/list/destroy errors and reports the stale create response as live status,
// which the legacy adapter already had to replace; this module keeps that hardening and adds what
// account admission needs: an ownership marker on every create, a whole-account inventory, and a
// canonical-id teardown that converges only on the SDK's typed not-found.
//
// Devboxes run commands as their unprivileged Blueprint user (registry `runtimeIdentity`); there is
// no root lever, so nothing here asks for one — the toolchain accommodates it instead.

import { randomUUID } from "node:crypto";
import type { Runloop } from "@runloop/api-client";
import {
	AuthenticationError,
	BadRequestError,
	NotFoundError,
	RateLimitError,
	RunloopSDK,
} from "@runloop/api-client";
import type { DriverContext } from "@sandbox-benchmarks/driver";
import { shellQuote } from "@sandbox-benchmarks/driver";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { matchesAnyCause } from "@sandbox-benchmarks/driver/errors";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import { RUNLOOP_PROVENANCE } from "./provenance.ts";

export { RUNLOOP_PROVENANCE };

type DevboxView = Runloop.Devboxes.DevboxView;
/** The control-plane slice this module drives; tests inject a fake, production the real SDK. */
export type RunloopClient = Pick<RunloopSDK, "api">;

/** Exact shape observed on live Devbox ids (`dbx_` plus the vendor's opaque suffix). */
export const RUNLOOP_SANDBOX_ID = type(/^dbx_[A-Za-z0-9]+$/);
/** Every benchmark create stamps both keys; inventory and recovery key on them. */
export const RUNLOOP_OWNER_METADATA_KEY = "sandbox-benchmarks";
export const RUNLOOP_ATTEMPT_METADATA_KEY = "sandbox-benchmarks-attempt";
export const RUNLOOP_BENCHMARK_NAME_PREFIX = "benchmark-";
/** Past the longest suite plus setup/collection margin, so a leaked Devbox still self-expires. */
export const RUNLOOP_KEEP_ALIVE_SECONDS = 3 * 60 * 60;
/**
 * Create resolves only once the Devbox is `running`, so a cold Blueprint boot happens inside it.
 * This is both the SDK long-poll ceiling and the harness-owned create budget, so the two cannot
 * disagree about how long one attempt may take.
 */
export const RUNLOOP_CREATE_TIMEOUT_MS = 20 * 60_000;
/** One control-plane round-trip; long polls carry their own overall ceiling on top. */
export const RUNLOOP_CONTROL_TIMEOUT_MS = 30_000;
/**
 * Synchronous commands complete through Runloop's execute-and-await long poll. The harness routes
 * every step budgeted at or past the sync cap to the durable path, so this ceiling only backstops
 * a command the harness already gave up on; the harness's own wait-cap binds first.
 */
export const RUNLOOP_SYNC_EXEC_TIMEOUT_MS = 10 * 60_000;
export const RUNLOOP_RECOVERY_CONFIRMATION_MS = 2_000;
export const RUNLOOP_RECOVERY_MAX_ATTEMPTS = 4;
export const RUNLOOP_READINESS = Object.freeze({ startup: "create-returns-ready" as const });
export const RUNLOOP_EXECUTION = Object.freeze({
	syncCapMs: 60_000,
	durable: "native-launch" as const,
});
/**
 * `custom_disk_size` provisions the root disk, but a filesystem never exposes its whole device: a
 * 40 GB request has reported a few hundred MiB less as capacity. Allow that overhead and no more.
 */
export const RUNLOOP_DISK_CAPACITY_ALLOWANCE_GB = 1;

type RunloopCreateOptions = Runloop.Devboxes.DevboxCreateParams & { name: string };

/**
 * Runloop never forgets a Devbox: `retrieve` and `list` keep returning `shutdown` and `failure`
 * records indefinitely. Both are terminal — nothing runs, nothing can be resumed, no command can
 * be sent — so neither is an allocation the account holds. Inventory counts neither as owned nor
 * foreign, and observation reports a `shutdown` record as `absent` (the allocation is gone; only
 * the label remains) and a `failure` record as `terminal`.
 */
function isTerminalRecord(status: DevboxView["status"]): boolean {
	return status === "shutdown" || status === "failure";
}

function ownedByBenchmark(devbox: DevboxView): boolean {
	const metadata = devbox.metadata;
	if (metadata === null || typeof metadata !== "object") return false;
	return (
		metadata[RUNLOOP_OWNER_METADATA_KEY] === "runloop" ||
		(typeof metadata[RUNLOOP_ATTEMPT_METADATA_KEY] === "string" &&
			metadata[RUNLOOP_ATTEMPT_METADATA_KEY].startsWith(RUNLOOP_BENCHMARK_NAME_PREFIX))
	);
}

function requestOptions(signal: AbortSignal | undefined) {
	return {
		timeout: RUNLOOP_CONTROL_TIMEOUT_MS,
		...(signal === undefined ? {} : { signal }),
	};
}

/**
 * Run one command to completion. A missing exit status is evidence the kit records as an unknown
 * exit, never a fabricated zero; truncated output is a failure, because a synchronous step whose
 * stdout carries data (observed specs, marker-bounded collects) cannot be trusted once cut.
 */
export async function execRunloopCommand(
	client: RunloopClient,
	devboxId: string,
	command: string,
	options: { readonly signal?: AbortSignal } = {},
): Promise<{ readonly exitCode?: number; readonly stdout: string; readonly stderr: string }> {
	options.signal?.throwIfAborted();
	const result = await client.api.devboxes.executeAndAwaitCompletion(
		devboxId,
		{ command },
		{
			...requestOptions(options.signal),
			longPoll: { timeoutMs: RUNLOOP_SYNC_EXEC_TIMEOUT_MS },
		},
	);
	if (result.status !== "completed") {
		throw new Error(`Runloop execution ${result.execution_id} ended in status ${result.status}`);
	}
	if (result.stdout_truncated || result.stderr_truncated) {
		throw new Error("Runloop truncated the command output; the step needs the durable route");
	}
	const exitStatus = result.exit_status;
	return {
		...(typeof exitStatus === "number" && Number.isSafeInteger(exitStatus)
			? { exitCode: exitStatus }
			: {}),
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/** Background execution succeeds only after Runloop returns a genuine execution handle. */
export async function launchRunloopCommand(
	client: RunloopClient,
	devboxId: string,
	command: string,
	options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
	options.signal?.throwIfAborted();
	const execution = await client.api.devboxes.executeAsync(
		devboxId,
		{ command },
		requestOptions(options.signal),
	);
	if (typeof execution.execution_id !== "string" || execution.execution_id.length === 0) {
		throw new Error("Runloop background execution returned no execution id");
	}
}

/** Forced shutdown is deterministic even while a snapshot finalizes (Runloop's 409 otherwise). */
async function shutdownDevbox(
	client: RunloopClient,
	devboxId: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	await client.api.devboxes.shutdown(devboxId, { force: "true" }, requestOptions(signal));
}

/** Drain the account, one Stainless cursor page at a time; a partial listing rejects. */
async function* liveDevboxes(
	client: RunloopClient,
	signal: AbortSignal | undefined,
): AsyncGenerator<DevboxView> {
	for await (const devbox of client.api.devboxes.list(
		{ include_total_count: false, limit: 100 },
		requestOptions(signal),
	)) {
		signal?.throwIfAborted();
		if (isTerminalRecord(devbox.status)) continue;
		yield devbox;
	}
}

export function runloopSpec(
	{ env, resolvedArtifact }: DriverContext<"runloop">,
	createClient: (options: ConstructorParameters<typeof RunloopSDK>[0]) => RunloopClient = (
		options,
	) => new RunloopSDK(options),
) {
	// Constructing the SDK performs no I/O; one client per spec keeps the credential in one place.
	const client = createClient({
		bearerToken: env.RUNLOOP_API_KEY,
		timeout: RUNLOOP_CONTROL_TIMEOUT_MS,
		maxRetries: 2,
	});
	const compute = nativeSdkCompute(
		async (options: RunloopCreateOptions, operation) => {
			const created = await client.api.devboxes.create(options, requestOptions(operation.signal));
			try {
				return await client.api.devboxes.awaitRunning(created.id, {
					...requestOptions(operation.signal),
					longPoll: { timeoutMs: RUNLOOP_CREATE_TIMEOUT_MS },
				});
			} catch (error) {
				// The allocation was accepted and is billable; shut it down before surfacing why it never
				// ran. The bridge's marker recovery independently confirms absence afterwards.
				try {
					await shutdownDevbox(client, created.id, undefined);
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						`Runloop Devbox ${created.id} failed to reach running and its shutdown failed`,
					);
				}
				throw error;
			}
		},
		(native) => ({
			sandboxId: native.id,
			runCommand: (command: string, options) =>
				execRunloopCommand(client, native.id, command, options ?? {}),
			destroy: () => shutdownDevbox(client, native.id, undefined),
			filesystem: {
				readFile: (path: string) =>
					client.api.devboxes.readFileContents(
						native.id,
						{ file_path: path },
						requestOptions(undefined),
					),
				exists: async (path: string) =>
					(await execRunloopCommand(client, native.id, `test -e ${shellQuote(path)}`)).exitCode ===
					0,
				writeFile: async (path: string, content: string) => {
					const result = await client.api.devboxes.writeFileContents(
						native.id,
						{ file_path: path, contents: content },
						requestOptions(undefined),
					);
					if (result.exit_status !== 0) {
						throw new Error(`Runloop file write exited ${result.exit_status}: ${result.stderr}`);
					}
				},
			},
		}),
	);
	return computeSdkSpec(compute, {
		sandboxId: RUNLOOP_SANDBOX_ID,
		createOptions: {
			coverage: {
				spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
				artifact: "context",
				deadlineMs: "harness",
				gpu: { model: "unsupported", count: "unsupported" },
				env: "unsupported",
			},
			map: (request, unsupported) => {
				if (request.artifact.kind !== "baked" || request.artifact.ref !== resolvedArtifact.ref)
					unsupported("request artifact differs from the resolved Runloop Blueprint");
				const name = `${RUNLOOP_BENCHMARK_NAME_PREFIX}${randomUUID()}`;
				return {
					name,
					metadata: {
						[RUNLOOP_OWNER_METADATA_KEY]: "runloop",
						[RUNLOOP_ATTEMPT_METADATA_KEY]: name,
					},
					blueprint_name: resolvedArtifact.ref,
					launch_parameters: {
						resource_size_request: "CUSTOM_SIZE" as const,
						custom_cpu_cores: request.spec.vcpus,
						custom_gb_memory: request.spec.memoryGb,
						...(request.spec.diskGb === undefined ? {} : { custom_disk_size: request.spec.diskGb }),
						keep_alive_time_seconds: RUNLOOP_KEEP_ALIVE_SECONDS,
					},
				};
			},
		},
		commands: {
			exec: (_sandbox, command, options, ref) =>
				execRunloopCommand(client, ref.id, command, options ?? {}),
			launch: (_sandbox, command, options, ref) =>
				launchRunloopCommand(client, ref.id, command, options ?? {}),
		},
		lifecycle: {
			destroy: async (sandbox, ref, options) => {
				try {
					await shutdownDevbox(client, ref?.id ?? sandbox.getInstance().id, options.signal);
				} catch (error) {
					if (error instanceof NotFoundError) return;
					throw error;
				}
			},
		},
		createRecovery: {
			absenceConfirmationMs: RUNLOOP_RECOVERY_CONFIRMATION_MS,
			maxAttempts: RUNLOOP_RECOVERY_MAX_ATTEMPTS,
			locator: (options) => ({
				kind: "marker",
				key: RUNLOOP_ATTEMPT_METADATA_KEY,
				value: options.name,
			}),
			isDefinitive: (error) =>
				matchesAnyCause(
					error,
					(cause) =>
						cause instanceof AuthenticationError ||
						cause instanceof BadRequestError ||
						cause instanceof RateLimitError,
				),
			isRetryableCreate: (error) =>
				matchesAnyCause(error, (cause) => cause instanceof RateLimitError),
			cleanup: async (_compute, locator, options) => {
				// No server-side metadata filter exists; drain and match the attempt marker exactly.
				const matches: string[] = [];
				for await (const devbox of liveDevboxes(client, options.signal)) {
					if (devbox.metadata?.[RUNLOOP_ATTEMPT_METADATA_KEY] === locator.value)
						matches.push(devbox.id);
				}
				if (matches.length === 0) return { status: "absent" };
				for (const id of matches) await shutdownDevbox(client, id, options.signal);
				return { status: "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: async (_sandbox, native, request) => {
			if (request.spec.diskGb === undefined) return { status: "honored" };
			const result = await execRunloopCommand(
				client,
				native.id,
				"df -Pk / | awk 'NR==2 {print $2}'",
			);
			if (result.exitCode !== 0 || !/^\d+$/.test(result.stdout.trim()))
				throw new Error("Runloop disk capacity probe failed");
			const capacityGb = Number(result.stdout.trim()) / 1024 / 1024;
			return capacityGb + RUNLOOP_DISK_CAPACITY_ALLOWANCE_GB >= request.spec.diskGb
				? { status: "honored" }
				: {
						status: "unsupported",
						detail: `requested ${request.spec.diskGb} GiB but the root filesystem exposes ${capacityGb.toFixed(2)} GiB`,
					};
		},
		hasWorkingFilesystem: true,
		probes: {
			observe: async (_compute, ref) => {
				try {
					const devbox = await client.api.devboxes.retrieve(ref.id, requestOptions(undefined));
					// A shut-down record is the vendor's tombstone for a gone allocation, which is what
					// account recovery waits for after destroy; a failed one still exists as a terminal record.
					if (devbox.status === "shutdown") return { state: "absent" };
					if (devbox.status === "failure") return { state: "terminal" };
					return { state: "running" };
				} catch (error) {
					if (error instanceof NotFoundError) return { state: "absent" };
					throw error;
				}
			},
			describe: (_compute, ref) => client.api.devboxes.retrieve(ref.id, requestOptions(undefined)),
			// One page, deliberately: this measures a list round-trip, not paginator drain time.
			list: async () =>
				(
					await client.api.devboxes.list(
						{ include_total_count: false, limit: 100 },
						requestOptions(undefined),
					)
				).getPaginatedItems(),
		},
		inventory: {
			list: async (_compute, options) => {
				const owned: string[] = [];
				let foreignCount = 0;
				for await (const devbox of liveDevboxes(client, options.signal)) {
					if (ownedByBenchmark(devbox)) owned.push(devbox.id);
					else foreignCount += 1;
				}
				return { owned, foreignCount };
			},
		},
		destroyById: async (_compute, ref, options) => {
			try {
				await shutdownDevbox(client, ref.id, options.signal);
			} catch (error) {
				if (error instanceof NotFoundError) return;
				throw error;
			}
		},
	});
}

export default defineComputeSdkDriver("runloop", {
	provenance: RUNLOOP_PROVENANCE,
	readiness: RUNLOOP_READINESS,
	execution: RUNLOOP_EXECUTION,
	createBudget: { owner: "harness", timeoutMs: RUNLOOP_CREATE_TIMEOUT_MS },
	spec: runloopSpec,
});
