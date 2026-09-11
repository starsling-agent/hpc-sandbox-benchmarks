// Vercel Sandbox is a native SDK module: one registry-joined file owns the OIDC credential
// projection, artifact mapping, the name-keyed sandbox identity, lifecycle truth, and the account
// inventory. The shared bridge still owns request validation, error normalization, redaction,
// ambiguous-create ownership, output caps, and session assembly.
//
// Vercel v2 is name-keyed, so the sandbox's native name IS the canonical sandbox id. Every lookup
// passes `resume: false`: the SDK defaults to resuming a stopped session on `get`, and a benchmark
// that silently booted a replacement VM after loss would hide the loss it exists to measure.
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type {
	CreateRequest,
	DriverContext,
	DriverOperationOptions,
	ExecOptions,
	SandboxRef,
} from "@sandbox-benchmarks/driver";
import type {
	ComputeSdkCreatedRequestVerification,
	ComputeSdkCreateRecovery,
	ComputeSdkCreateRequestCoverage,
	ComputeSdkDriverSpec,
	ComputeSdkLifecycle,
	ComputeSdkSandboxOf,
} from "@sandbox-benchmarks/driver/computesdk";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { matchesAnyCause } from "@sandbox-benchmarks/driver/errors";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { APIError, Sandbox } from "@vercel/sandbox";
import { type } from "arktype";
import { VERCEL_PROVENANCE } from "./provenance.ts";

export { VERCEL_PROVENANCE };

type VercelCompute = ReturnType<typeof nativeVercelCompute>;
type VercelSandboxHandle = ComputeSdkSandboxOf<VercelCompute>;

/** Every benchmark create is named with this prefix plus a UUID; the account sweep keys on it. */
export const VERCEL_NAME_PREFIX = "sandbox-benchmarks-";
/** Second ownership marker, recorded as a tag on the sandbox record (list rows do not carry tags). */
export const VERCEL_OWNER_TAG = "sandbox-benchmarks";
export const VERCEL_OWNER_VALUE = "vercel";
export const VERCEL_SANDBOX_ID = type(
	/^sandbox-benchmarks-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
/** The longest suite budgets 155 minutes; leave setup/collection margin while a leak self-expires. */
export const VERCEL_SANDBOX_LIFETIME_MS = 3 * 60 * 60_000;
/** Per-call ceiling on control-plane requests (get/list/delete), independent of the operation signal. */
export const VERCEL_CONTROL_TIMEOUT_MS = 20_000;
export const VERCEL_RECOVERY_CONFIRMATION_MS = 2_000;
export const VERCEL_RECOVERY_MAX_ATTEMPTS = 4;
/** Vercel derives memory at a fixed 2048 MB per vCPU; the target's 4 vCPU × 8 GiB is that ratio. */
export const VERCEL_MEMORY_GB_PER_VCPU = 2;
/** `Sandbox.create` resolves with a running session; the conformance gate proves it on every run. */
export const VERCEL_READINESS = Object.freeze({ startup: "create-returns-ready" as const });
/**
 * A detached native command is the durable route: the current session accepts it and returns a
 * handle while the guest keeps running it, and the kit observes completion through the done file.
 */
export const VERCEL_EXECUTION = Object.freeze({
	syncCapMs: 60_000,
	durable: "native-launch" as const,
});
/**
 * Statuses under which an UNMARKED record is a foreign resource: it holds (or is about to hold) a
 * VM, or is a stopped record that can still be resumed. A record already `failed` or `aborted` is
 * a dead entry nobody can use, so it neither blocks allocation nor counts as live. The benchmark's
 * own records count as owned in EVERY status: a dead record of ours is still ours to delete.
 */
export const VERCEL_LIVE_STATUSES = Object.freeze(
	new Set(["pending", "running", "stopping", "snapshotting", "stopped"] as const),
);

type VercelCreateOptions = NonNullable<Parameters<typeof Sandbox.create>[0]> & { name: string };
export type VercelCredentials = Required<
	Pick<NonNullable<Parameters<typeof Sandbox.list>[0]>, "token" | "teamId" | "projectId">
>;

const OIDC_CLAIMS = type({ owner_id: "string >= 1", project_id: "string >= 1" });

/**
 * Project the registry's one credential into what every SDK call needs. The OIDC token is a JWT
 * whose payload names the team (`owner_id`) and project (`project_id`), which is exactly how the
 * SDK itself resolves them from `VERCEL_OIDC_TOKEN`; decoding here lets the driver pass all three
 * explicitly instead of letting the SDK read ambient process env (or fall into its interactive
 * device-login flow when it finds none). The token never appears in a diagnostic.
 */
export function vercelCredentials(oidcToken: string): VercelCredentials {
	const [, payload] = oidcToken.split(".");
	if (payload === undefined || payload.length === 0) {
		throw new Error(
			"VERCEL_OIDC_TOKEN is not a JWT: expected a dot-separated header.payload.signature",
		);
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		throw new Error("VERCEL_OIDC_TOKEN payload is not base64url-encoded JSON");
	}
	const claims = OIDC_CLAIMS(decoded);
	if (claims instanceof type.errors) {
		throw new Error(
			"VERCEL_OIDC_TOKEN payload names no owner_id/project_id; it is not a Vercel OIDC token",
		);
	}
	return { token: oidcToken, teamId: claims.owner_id, projectId: claims.project_id };
}

export const VERCEL_REQUEST_COVERAGE = {
	// Memory is not an independent axis on Vercel: `map` proves the request sits on the 2 GiB/vCPU
	// line before treating both as mapped. Disk has no create-time knob at all, so it is verified
	// from inside the allocation and the sandbox is torn down if it falls short.
	spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "runtime-verified" },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies ComputeSdkCreateRequestCoverage;

/** Only the SDK's typed 404 proves absence; message text never does. */
function isNotFound(error: unknown): boolean {
	return matchesAnyCause(error, (link) => {
		try {
			return link instanceof APIError && link.response.status === 404;
		} catch {
			return false;
		}
	});
}

function apiStatus(error: unknown): number | undefined {
	let status: number | undefined;
	matchesAnyCause(error, (link) => {
		try {
			if (link instanceof APIError) {
				status = link.response.status;
				return true;
			}
		} catch {
			// A hostile error object proves nothing; keep walking the cause chain.
		}
		return false;
	});
	return status;
}

/** Bound one control-plane call by both the operation's signal and the driver's own ceiling. */
function controlSignal(options: DriverOperationOptions | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(VERCEL_CONTROL_TIMEOUT_MS);
	return options?.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

/** Reconnect by name without resuming: a stopped sandbox must stay stopped to the benchmark. */
function getByName(
	credentials: VercelCredentials,
	name: string,
	options?: DriverOperationOptions,
): Promise<Sandbox> {
	return Sandbox.get({ ...credentials, name, resume: false, signal: controlSignal(options) });
}

/**
 * Permanent teardown by name. `stop()` only ends the current VM session and leaves the named record
 * resumable; `delete()` removes the record with all its sessions and snapshots, whatever its status.
 * A 404 on either step is convergence; every other failure surfaces.
 */
async function deleteByName(
	credentials: VercelCredentials,
	name: string,
	options?: DriverOperationOptions,
): Promise<"destroyed" | "absent"> {
	options?.signal?.throwIfAborted();
	let sandbox: Sandbox;
	try {
		sandbox = await getByName(credentials, name, options);
	} catch (error) {
		if (isNotFound(error)) return "absent";
		throw error;
	}
	if (sandbox.name !== name)
		throw new Error("Vercel returned a sandbox other than the one requested");
	try {
		await sandbox.delete({ signal: controlSignal(options) });
	} catch (error) {
		if (isNotFound(error)) return "absent";
		throw error;
	}
	return "destroyed";
}

function ensureRunning(sandbox: Sandbox): Sandbox {
	if (sandbox.status !== "running") {
		throw new Error(
			`Vercel sandbox is ${sandbox.status}, not running; refusing to resume or replace it`,
		);
	}
	return sandbox;
}

/**
 * Foreground execution through the CURRENT session only. `Sandbox.runCommand` wraps its call in
 * the SDK's auto-resume, which could boot a replacement VM after loss and invalidate the benchmark
 * filesystem underneath a running suite; the session call has no such fallback.
 */
export async function execVercelCommand(
	native: Sandbox,
	command: string,
	options?: ExecOptions,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	options?.signal?.throwIfAborted();
	const finished = await ensureRunning(native)
		.currentSession()
		.runCommand({ cmd: "/bin/sh", args: ["-lc", command] });
	const [stdout, stderr] = await Promise.all([
		finished.stdout({ signal: options?.signal }),
		finished.stderr({ signal: options?.signal }),
	]);
	return { exitCode: finished.exitCode, stdout, stderr };
}

/** Background execution succeeds only once the session has accepted the detached command. */
export async function launchVercelCommand(
	native: Sandbox,
	command: string,
	options?: ExecOptions,
): Promise<void> {
	options?.signal?.throwIfAborted();
	const handle: unknown = await ensureRunning(native)
		.currentSession()
		.runCommand({ cmd: "/bin/sh", args: ["-lc", command], detached: true });
	if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
		throw new Error("Vercel returned no handle for the detached command");
	}
}

/** Allocate with the pinned SDK, passing the projected credentials on every call. */
export function nativeVercelCompute(credentials: VercelCredentials) {
	return nativeSdkCompute(
		(options: VercelCreateOptions, operation) =>
			Sandbox.create({
				...credentials,
				...options,
				...(operation.signal === undefined ? {} : { signal: operation.signal }),
			}),
		(native) => ({
			sandboxId: native.name,
			runCommand: (command, options) => execVercelCommand(native, command, options),
			destroy: () => native.delete(),
		}),
	);
}

export function vercelLifecycle(
	credentials: VercelCredentials,
): ComputeSdkLifecycle<VercelCompute> {
	return {
		destroy: async (sandbox, ref, options) => {
			await deleteByName(credentials, ref?.id ?? sandbox.getInstance().name, options);
		},
	};
}

/** Typed rejections made before allocation need no recovery lookup. */
export function isVercelDefinitiveCreateRejection(error: unknown): boolean {
	const status = apiStatus(error);
	return status !== undefined && [400, 401, 403, 404, 422, 429].includes(status);
}

/** Only the API's own rate-limit status establishes a transient refusal worth waiting out. */
export function isVercelRetryableCreate(error: unknown): boolean {
	return apiStatus(error) === 429;
}

/** The create name is the recovery key: an accepted create whose response was lost is findable. */
export function vercelCreateRecovery(
	credentials: VercelCredentials,
): ComputeSdkCreateRecovery<VercelCompute> {
	return {
		absenceConfirmationMs: VERCEL_RECOVERY_CONFIRMATION_MS,
		maxAttempts: VERCEL_RECOVERY_MAX_ATTEMPTS,
		isDefinitive: isVercelDefinitiveCreateRejection,
		isRetryableCreate: isVercelRetryableCreate,
		locator: (createOptions) => ({
			kind: "name",
			value: createOptions.name,
		}),
		cleanup: async (_compute, locator, options) => ({
			status: await deleteByName(credentials, locator.value, options),
		}),
	};
}

export async function verifyVercelDiskCapacity(
	native: Sandbox,
	request: CreateRequest,
	options: DriverOperationOptions,
): Promise<ComputeSdkCreatedRequestVerification> {
	const requestedDiskGb = request.spec.diskGb;
	if (requestedDiskGb === undefined) return { status: "honored" };
	const result = await execVercelCommand(native, "df -Pk / | awk 'NR==2 {print $2}'", options);
	if (result.exitCode !== 0) {
		throw new Error(`Vercel disk capacity probe exited ${result.exitCode}`);
	}
	const stdout = result.stdout.trim();
	if (!/^\d+$/.test(stdout))
		throw new Error("Vercel disk capacity probe returned malformed output");
	const capacityGb = Number(stdout) / 1024 / 1024;
	if (!Number.isFinite(capacityGb) || capacityGb <= 0) {
		throw new Error("Vercel disk capacity probe returned an invalid capacity");
	}
	return capacityGb >= requestedDiskGb
		? { status: "honored" }
		: {
				status: "unsupported",
				detail: `requested ${requestedDiskGb} GiB but the allocation exposes ${capacityGb.toFixed(2)} GiB`,
			};
}

export function vercelProbes(
	credentials: VercelCredentials,
): NonNullable<ComputeSdkDriverSpec<VercelCompute>["probes"]> {
	return {
		observe: async (_compute, ref: SandboxRef) => {
			let sandbox: Sandbox;
			try {
				sandbox = await getByName(credentials, ref.id);
			} catch (error) {
				if (isNotFound(error)) return { state: "absent" as const };
				throw error;
			}
			return sandbox.status === "stopped" ||
				sandbox.status === "failed" ||
				sandbox.status === "aborted"
				? { state: "terminal" as const }
				: { state: "running" as const };
		},
		describe: (_compute, ref) => getByName(credentials, ref.id),
		// One drain of the benchmark's own names: a diagnostic round-trip, not the account inventory.
		list: async () =>
			(await Sandbox.list({ ...credentials, namePrefix: VERCEL_NAME_PREFIX })).toArray(),
	};
}

/**
 * Whole-project inventory in one drain. The project is the account boundary the credential names,
 * so every record it lists is either the benchmark's (its exact name shape) or foreign. Ownership
 * comes from the name because list rows carry no tags; the tag is a second marker on the record.
 */
export function vercelInventory(
	credentials: VercelCredentials,
): NonNullable<ComputeSdkDriverSpec<VercelCompute>["inventory"]> {
	return {
		list: async (_compute, options) => {
			const rows = await (
				await Sandbox.list({ ...credentials, signal: controlSignal(options) })
			).toArray();
			const owned: string[] = [];
			let foreignCount = 0;
			for (const row of rows) {
				if (VERCEL_SANDBOX_ID.allows(row.name)) owned.push(row.name);
				else if ((VERCEL_LIVE_STATUSES as ReadonlySet<string>).has(row.status)) foreignCount += 1;
			}
			return { owned, foreignCount };
		},
	};
}

export function vercelDestroyById(
	credentials: VercelCredentials,
): NonNullable<ComputeSdkDriverSpec<VercelCompute>["destroyById"]> {
	return async (_compute, ref, options) => {
		await deleteByName(credentials, ref.id, options);
	};
}

/** Extracted through the joined context type so tests can pin the actual one-file authoring shape. */
export function vercelSpec({ env, resolvedArtifact }: DriverContext<"vercel">) {
	const credentials = vercelCredentials(env.VERCEL_OIDC_TOKEN);
	return computeSdkSpec(nativeVercelCompute(credentials), {
		sandboxId: VERCEL_SANDBOX_ID,
		createOptions: {
			coverage: VERCEL_REQUEST_COVERAGE,
			map: (request, unsupported) => {
				if (request.artifact.kind !== "mirror" || request.artifact.ref !== resolvedArtifact.ref) {
					unsupported("the request artifact does not match the resolved Vercel VCR image");
				}
				if (request.spec.memoryGb !== request.spec.vcpus * VERCEL_MEMORY_GB_PER_VCPU) {
					unsupported(
						`Vercel derives memory at ${VERCEL_MEMORY_GB_PER_VCPU} GiB per vCPU; ${request.spec.vcpus} vCPU cannot carry ${request.spec.memoryGb} GiB`,
					);
				}
				return {
					name: `${VERCEL_NAME_PREFIX}${randomUUID()}`,
					image: resolvedArtifact.ref,
					resources: { vcpus: request.spec.vcpus },
					persistent: false,
					tags: { [VERCEL_OWNER_TAG]: VERCEL_OWNER_VALUE },
					timeout: VERCEL_SANDBOX_LIFETIME_MS,
				};
			},
		},
		commands: {
			exec: (sandbox: VercelSandboxHandle, command, options) =>
				execVercelCommand(sandbox.getInstance(), command, options),
			launch: (sandbox: VercelSandboxHandle, command, options) =>
				launchVercelCommand(sandbox.getInstance(), command, options),
		},
		lifecycle: vercelLifecycle(credentials),
		createRecovery: vercelCreateRecovery(credentials),
		prepareAndVerifyCreatedRequest: (_sandbox, native, request, options) =>
			verifyVercelDiskCapacity(native, request, options),
		// The session file API writes as the `vercel-sandbox` user, not as the root the toolchain runs
		// as; the validated legacy path polled done-files over exec, and the kit's exec fallback keeps
		// that behaviour rather than claiming a filesystem that may not see root-owned paths.
		hasWorkingFilesystem: false,
		probes: vercelProbes(credentials),
		inventory: vercelInventory(credentials),
		destroyById: vercelDestroyById(credentials),
	});
}

export default defineComputeSdkDriver("vercel", {
	provenance: VERCEL_PROVENANCE,
	readiness: VERCEL_READINESS,
	execution: VERCEL_EXECUTION,
	spec: vercelSpec,
});
