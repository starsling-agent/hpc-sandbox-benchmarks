// Blaxel is a native SDK module over @blaxel/core. The published @computesdk/blaxel wrapper cannot
// carry this provider through account admission: its `list()` maps over a PaginatedList (a TypeError
// against @blaxel/core 0.3.5) and its `destroy` swallows every failure, so a leaked, billable
// sandbox would read as removed. One registry-joined file therefore owns credentials, the
// memory-coupled shape, the ephemeral volume and keepalive a benchmark needs on Blaxel's RAM-overlay
// root, sandbox identity, lifecycle truth, inventory and recovery. The shared bridge still owns
// request validation, error normalization, redaction, ambiguous-create ownership, output caps, and
// session assembly.

import { randomUUID } from "node:crypto";
import { initialize, SandboxInstance } from "@blaxel/core";
import type {
	CreateRequest,
	DriverContext,
	DriverOperationOptions,
	ExecOptions,
	SandboxObservation,
} from "@sandbox-benchmarks/driver";
import { shellQuote } from "@sandbox-benchmarks/driver";
import type {
	ComputeSdkCreatedRequestVerification,
	ComputeSdkCreateRequestCoverage,
	ComputeSdkDriverSpec,
} from "@sandbox-benchmarks/driver/computesdk";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import { BLAXEL_PROVENANCE } from "./provenance.ts";

export { BLAXEL_PROVENANCE };

type BlaxelCompute = ReturnType<typeof nativeBlaxelCompute>;
type BlaxelProcess = Awaited<ReturnType<SandboxInstance["process"]["exec"]>>;

/** Blaxel resource names: lowercase alphanumeric plus hyphens, at most 49 characters. */
export const BLAXEL_SANDBOX_ID = type(/^[a-z0-9][a-z0-9-]{0,48}$/);
/** The Debian image: Blaxel's stock Alpine base has no apt, so PTS cannot be installed there. */
export const BLAXEL_IMAGE = "blaxel/ts-app:latest";
export const BLAXEL_REGION = "us-was-1";
/** Blaxel couples CPU to RAM (measured: cores = memory MB / 2048) and exposes no independent knob. */
export const BLAXEL_MEMORY_MB_PER_VCPU = 2048;
export const BLAXEL_SANDBOX_LIFETIME_MS = 3 * 60 * 60_000;
/** Where the heavy suites write (PTS_USER_PATH_OVERRIDE); the ephemeral volume mounts here. */
export const BLAXEL_PTS_DATA_DIR = "/var/lib/phoronix-test-suite";
/**
 * Filesystem metadata eats into an ephemeral volume: a 40960 MB volume mounted with 39.94 GiB
 * visible (live, 2026-09-10). The request is usable capacity, so the volume is sized with this
 * headroom and the mount is still verified against the request afterwards.
 */
export const BLAXEL_VOLUME_HEADROOM_MB = 256;
/** Ownership label every benchmark create writes; inventory keys on it (name shape as fallback). */
export const BLAXEL_OWNER_LABEL = "sandbox-benchmarks";
export const BLAXEL_ATTEMPT_LABEL = "sandbox-benchmarks-attempt";
export const BLAXEL_KEEPALIVE_PROCESS = "benchmark-keepalive";
export const BLAXEL_RECOVERY_CONFIRMATION_MS = 2_000;
export const BLAXEL_RECOVERY_MAX_ATTEMPTS = 4;
export const BLAXEL_READINESS = Object.freeze({ startup: "create-returns-ready" as const });
/** Sync execs cross the sandbox gateway unvalidated past a minute; long steps use the native process API. */
export const BLAXEL_EXECUTION = Object.freeze({
	syncCapMs: 60_000,
	durable: "native-launch" as const,
});
const BLAXEL_BENCHMARK_NAME =
	/^benchmark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Statuses under which the sandbox is no longer an allocation anyone owns. */
const BLAXEL_TERMINAL_STATUSES = new Set([
	"DELETING",
	"TERMINATED",
	"FAILED",
	"DEACTIVATED",
	"DEACTIVATING",
]);
type BlaxelCreateOptions = Extract<
	Parameters<typeof SandboxInstance.create>[0],
	{ name?: string }
> & { name: string };

export const BLAXEL_REQUEST_COVERAGE = {
	// vCPU is mapped through memory: the mapper refuses any request off Blaxel's coupling curve.
	spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies ComputeSdkCreateRequestCoverage;

/**
 * The control plane's structured error code. With `throwOnError` the generated client throws the
 * parsed error body, whose `code` is the HTTP status — the SDK's own idiom (`createIfNotExists`
 * matches `e.code === 409`). Prose is never consulted.
 */
function controlPlaneCode(caught: unknown): number | undefined {
	if ((typeof caught !== "object" && typeof caught !== "function") || caught === null) {
		return undefined;
	}
	try {
		const code = Reflect.get(caught, "code");
		return typeof code === "number" ? code : undefined;
	} catch {
		return undefined;
	}
}

/** Only the control plane's own 404 proves a sandbox is gone. */
export function isBlaxelNotFound(caught: unknown): boolean {
	return controlPlaneCode(caught) === 404;
}

/** The data plane attaches the HTTP response to its thrown error; the class itself is not exported. */
function isDataPlaneNotFound(caught: unknown): boolean {
	if ((typeof caught !== "object" && typeof caught !== "function") || caught === null) {
		return false;
	}
	try {
		const response = Reflect.get(caught, "response");
		if ((typeof response !== "object" && typeof response !== "function") || response === null) {
			return false;
		}
		return Reflect.get(response, "status") === 404;
	} catch {
		return false;
	}
}

/**
 * A process the sandbox killed or stopped never reported its own exit. Withholding the code lets
 * the kit record an unknown exit as evidence instead of the fabricated zero the response carries.
 */
function commandOutcome(result: BlaxelProcess): {
	readonly exitCode?: number;
	readonly stdout: string;
	readonly stderr: string;
} {
	const reported = result.status === "completed" || result.status === "failed";
	return {
		...(reported && Number.isSafeInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

/** Foreground execution through the native process API, waiting for the command to settle. */
export async function execBlaxelCommand(
	native: SandboxInstance,
	command: string,
	options?: ExecOptions,
): Promise<{ readonly exitCode?: number; readonly stdout: string; readonly stderr: string }> {
	options?.signal?.throwIfAborted();
	// timeout 0: the harness owns every step deadline; the vendor must not kill a command mid-wait.
	return commandOutcome(
		await native.process.exec({ command, waitForCompletion: true, timeout: 0 }),
	);
}

/** Background execution succeeds only after Blaxel has returned a genuine process handle. */
export async function launchBlaxelCommand(
	native: SandboxInstance,
	command: string,
	options?: ExecOptions,
): Promise<void> {
	options?.signal?.throwIfAborted();
	const handle = await native.process.exec({
		name: `benchmark-job-${randomUUID()}`,
		command,
		waitForCompletion: false,
		keepAlive: true,
		timeout: 0,
	});
	if (typeof handle.pid !== "string" || handle.pid.length === 0) {
		throw new Error("Blaxel background process returned no process id");
	}
	if (handle.status === "failed" || handle.status === "killed" || handle.status === "stopped") {
		throw new Error(`Blaxel background process ended immediately with status ${handle.status}`);
	}
}

function blaxelFilesystem(native: SandboxInstance) {
	return {
		readFile: (path: string) => native.fs.read(path),
		writeFile: async (path: string, content: string) => {
			await native.fs.write(path, content);
		},
		// One read answers existence whether or not the parent directory exists yet; the harness only
		// asks this of its tiny done-file, never of a log.
		exists: async (path: string) => {
			try {
				await native.fs.read(path);
				return true;
			} catch (caught) {
				if (isDataPlaneNotFound(caught)) return false;
				throw caught;
			}
		},
	};
}

/** Allocate with the pinned SDK so the control plane's structured refusals survive to recovery. */
export function nativeBlaxelCompute() {
	return nativeSdkCompute(
		(options: BlaxelCreateOptions, operation) => {
			operation.signal?.throwIfAborted();
			return SandboxInstance.create(options);
		},
		(native) => ({
			sandboxId: native.metadata.name,
			runCommand: (command, options) => execBlaxelCommand(native, command, options),
			destroy: () => native.delete(),
			filesystem: blaxelFilesystem(native),
		}),
	);
}

function blaxelObservation(status: string | undefined): SandboxObservation {
	if (status === undefined) throw new Error("Blaxel returned no sandbox status");
	return BLAXEL_TERMINAL_STATUSES.has(status) ? { state: "terminal" } : { state: "running" };
}

function isBlaxelOwned(instance: SandboxInstance): boolean {
	const labels: unknown = instance.metadata.labels;
	const owner =
		(typeof labels === "object" || typeof labels === "function") && labels !== null
			? Reflect.get(labels, BLAXEL_OWNER_LABEL)
			: undefined;
	return owner === "blaxel" || BLAXEL_BENCHMARK_NAME.test(instance.metadata.name);
}

/**
 * Start the lifetime keepalive and prove the allocation matches the request. Blaxel suspends a
 * sandbox after ~15 s without an inbound request, and a running benchmark is not one; one
 * keepAlive process keeps it resident through synchronous steps, detached steps and the gaps
 * between harness calls alike. Throwing or returning unsupported makes the bridge tear the
 * accepted sandbox down, so a keepalive that never started cannot leak a suspended allocation.
 */
export async function prepareBlaxelSandbox(
	native: SandboxInstance,
	request: CreateRequest,
	options: DriverOperationOptions,
): Promise<ComputeSdkCreatedRequestVerification> {
	options.signal?.throwIfAborted();
	const keepalive = await native.process.exec({
		name: BLAXEL_KEEPALIVE_PROCESS,
		command: "sleep infinity",
		keepAlive: true,
		timeout: 0,
		waitForCompletion: false,
	});
	if (keepalive.status !== "running") {
		throw new Error(`Blaxel keepalive process is ${keepalive.status}, not running`);
	}
	const memoryMb = native.spec.runtime?.memory;
	if (memoryMb !== request.spec.memoryGb * 1024) {
		return {
			status: "unsupported",
			detail: `requested ${request.spec.memoryGb} GiB but the sandbox reports ${memoryMb ?? "unknown"} MB`,
		};
	}
	if (request.spec.diskGb === undefined) return { status: "honored" };
	const probe = await execBlaxelCommand(
		native,
		`df -Pk ${shellQuote(BLAXEL_PTS_DATA_DIR)} | awk 'NR==2 {print $2}'`,
		options,
	);
	const output = probe.stdout.trim();
	if (probe.exitCode !== 0 || !/^\d+$/.test(output)) {
		throw new Error("Blaxel volume capacity probe failed");
	}
	const capacityGb = Number(output) / 1024 / 1024;
	return capacityGb >= request.spec.diskGb
		? { status: "honored" }
		: {
				status: "unsupported",
				detail: `requested ${request.spec.diskGb} GiB but the volume exposes ${capacityGb.toFixed(2)} GiB`,
			};
}

/** Whole-account inventory: every live sandbox, owned iff it carries the benchmark label. */
export function blaxelInventory(): NonNullable<ComputeSdkDriverSpec<BlaxelCompute>["inventory"]> {
	return {
		list: async (_compute, options) => {
			options.signal?.throwIfAborted();
			const owned: string[] = [];
			let foreignCount = 0;
			// showTerminated keeps deleted history out of the listing; a sandbox mid-delete is
			// nobody's resource either. The page iterator drains every cursor.
			const page = await SandboxInstance.list({ limit: 100, showTerminated: false });
			for await (const instance of page) {
				options.signal?.throwIfAborted();
				const status = instance.status;
				if (status === "DELETING" || status === "TERMINATED") continue;
				const name = instance.metadata.name;
				if (typeof name !== "string" || name.length === 0) {
					throw new Error("Blaxel listed a sandbox without a name");
				}
				if (isBlaxelOwned(instance)) owned.push(name);
				else foreignCount += 1;
			}
			return { owned, foreignCount };
		},
	};
}

/** Canonical-name teardown for account recovery: the control plane's own 404 is convergence. */
export async function destroyBlaxelSandbox(
	name: string,
	options: DriverOperationOptions,
): Promise<void> {
	options.signal?.throwIfAborted();
	try {
		await SandboxInstance.delete(name);
	} catch (caught) {
		if (!isBlaxelNotFound(caught)) throw caught;
	}
}

/** Extracted through the joined context type so tests can pin the actual one-file authoring shape. */
export function blaxelSpec({ env, resolvedArtifact }: DriverContext<"blaxel">) {
	// The core SDK is configured process-wide. One benchmark cell drives one provider, so the
	// registry's parsed input slice is the only configuration this process ever applies.
	initialize({ apikey: env.BL_API_KEY, workspace: env.BL_WORKSPACE });
	return computeSdkSpec(nativeBlaxelCompute(), {
		sandboxId: BLAXEL_SANDBOX_ID,
		createOptions: {
			coverage: BLAXEL_REQUEST_COVERAGE,
			map: (request, unsupported) => {
				if (request.artifact.kind !== "none" || resolvedArtifact.kind !== "none") {
					unsupported("Blaxel boots its stock image; the request names an artifact");
				}
				const memoryMb = request.spec.memoryGb * 1024;
				if (memoryMb !== request.spec.vcpus * BLAXEL_MEMORY_MB_PER_VCPU) {
					unsupported(
						`Blaxel couples vCPU to RAM at ${BLAXEL_MEMORY_MB_PER_VCPU} MB per vCPU; ${request.spec.vcpus} vCPU and ${request.spec.memoryGb} GiB are off that curve`,
					);
				}
				const name = `benchmark-${randomUUID()}`;
				return {
					name,
					image: BLAXEL_IMAGE,
					memory: memoryMb,
					region: BLAXEL_REGION,
					ttl: `${Math.ceil(BLAXEL_SANDBOX_LIFETIME_MS / 1000)}s`,
					labels: { [BLAXEL_OWNER_LABEL]: "blaxel", [BLAXEL_ATTEMPT_LABEL]: name },
					...(request.spec.diskGb === undefined
						? {}
						: {
								volumes: [
									{
										name: `sbx-bench-${name.slice(-8)}`,
										mountPath: BLAXEL_PTS_DATA_DIR,
										type: "ephemeral" as const,
										sizeMb: request.spec.diskGb * 1024 + BLAXEL_VOLUME_HEADROOM_MB,
									},
								],
							}),
				};
			},
		},
		commands: {
			exec: (sandbox, command, options) =>
				execBlaxelCommand(sandbox.getInstance(), command, options),
			launch: (sandbox, command, options) =>
				launchBlaxelCommand(sandbox.getInstance(), command, options),
		},
		lifecycle: {
			destroy: (sandbox, ref, options) =>
				destroyBlaxelSandbox(ref?.id ?? sandbox.getInstance().metadata.name, options),
		},
		createRecovery: {
			absenceConfirmationMs: BLAXEL_RECOVERY_CONFIRMATION_MS,
			maxAttempts: BLAXEL_RECOVERY_MAX_ATTEMPTS,
			locator: (options) => ({ kind: "name", value: options.name }),
			// A structured refusal before allocation proves nothing was created; 429 is also the one
			// transient refusal worth retrying. Anything without a control-plane code stays ambiguous.
			isDefinitive: (error) => [400, 401, 403, 422, 429].includes(controlPlaneCode(error) ?? -1),
			isRetryableCreate: (error) => controlPlaneCode(error) === 429,
			cleanup: async (_compute, locator, options) => {
				options.signal?.throwIfAborted();
				let existing: SandboxInstance;
				try {
					existing = await SandboxInstance.get(locator.value);
				} catch (caught) {
					if (isBlaxelNotFound(caught)) return { status: "absent" };
					throw caught;
				}
				if (existing.metadata.name !== locator.value) {
					throw new Error("Blaxel recovery returned an unrelated sandbox");
				}
				await SandboxInstance.delete(locator.value);
				return { status: "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: (_sandbox, native, request, options) =>
			prepareBlaxelSandbox(native, request, options),
		hasWorkingFilesystem: true,
		probes: {
			observe: async (_compute, ref) => {
				let instance: SandboxInstance;
				try {
					instance = await SandboxInstance.get(ref.id);
				} catch (caught) {
					if (isBlaxelNotFound(caught)) return { state: "absent" };
					throw caught;
				}
				return blaxelObservation(instance.status);
			},
			describe: async (_compute, ref) => {
				const instance = await SandboxInstance.get(ref.id);
				return {
					name: instance.metadata.name,
					status: instance.status,
					labels: instance.metadata.labels,
					region: instance.spec.region,
				};
			},
			// Preserve the existing measurement: one list page, rather than timing full enumeration.
			list: async () =>
				(await SandboxInstance.list({ limit: 100 })).data.map((instance) => ({
					name: instance.metadata.name,
					status: instance.status,
				})),
		},
		inventory: blaxelInventory(),
		destroyById: (_compute, ref, options) => destroyBlaxelSandbox(ref.id, options),
	});
}

export default defineComputeSdkDriver("blaxel", {
	provenance: BLAXEL_PROVENANCE,
	readiness: BLAXEL_READINESS,
	execution: BLAXEL_EXECUTION,
	spec: blaxelSpec,
});
