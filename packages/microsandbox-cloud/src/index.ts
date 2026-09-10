// Microsandbox Cloud is a native SDK module: one registry-joined file owns credentials, the OCI
// image boot, sandbox identity (the caller-chosen name), lifecycle truth (stop-before-remove), and
// the account inventory. The shared bridge still owns request validation, error normalization,
// redaction, ambiguous-create ownership, output caps, and session assembly.
//
// The control-plane credential lives only in the SDK backend selected around each call; it never
// enters create options, labels, or the guest environment.

import { randomUUID } from "node:crypto";
import { posix as posixPath } from "node:path";
import type {
	CreateRequest,
	DriverContext,
	DriverOperationOptions,
	ExecOptions,
} from "@sandbox-benchmarks/driver";
import { shellQuote } from "@sandbox-benchmarks/driver";
import type {
	ComputeSdkCreatedRequestVerification,
	ComputeSdkDriverSpec,
} from "@sandbox-benchmarks/driver/computesdk";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { matchesAnyCause } from "@sandbox-benchmarks/driver/errors";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import type { DefaultBackend, SandboxHandle as MsbSandboxHandle } from "microsandbox";
import {
	CloudHttpError,
	HttpError,
	InvalidConfigError,
	IoError,
	Sandbox as MsbSandbox,
	ProtocolError,
	SandboxNotFoundError,
	withDefaultBackend,
} from "microsandbox";
import { MICROSANDBOX_PROVENANCE } from "./provenance.ts";

export { MICROSANDBOX_PROVENANCE };

type MicrosandboxCompute = ReturnType<typeof microsandboxCompute>;

/** Every benchmark sandbox is named this way; the name IS the vendor id and the ownership marker. */
export const MICROSANDBOX_NAME_PREFIX = "bench-cloud-";
export const MICROSANDBOX_SANDBOX_ID = type(
	/^bench-cloud-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
/** Vendor-console label written on every create; inventory ownership keys on the name shape. */
export const MICROSANDBOX_LABEL_MARKER = "sandbox-benchmarks.provider";
/** The longest suite budgets 155 minutes; leave setup and teardown margin, keep leaks self-expiring. */
export const MICROSANDBOX_SANDBOX_LIFETIME_MS = 3 * 60 * 60_000;
/**
 * `create` does not return until the sandbox is RUNNING, so the toolchain image pull (~1.5 GiB
 * compressed, cold on every CI runner) happens inside it. The harness's default five-minute attempt
 * budget loses to that pull and a create timeout is not a capacity refusal, so it would not retry.
 */
export const MICROSANDBOX_CREATE_TIMEOUT_MS = 20 * 60_000;
export const MICROSANDBOX_RECOVERY_CONFIRMATION_MS = 2_000;
export const MICROSANDBOX_RECOVERY_MAX_ATTEMPTS = 4;
export const MICROSANDBOX_INVENTORY_MAX_PAGES = 100;
export const MICROSANDBOX_READINESS = Object.freeze({ startup: "create-returns-ready" as const });
export const MICROSANDBOX_EXECUTION = Object.freeze({
	syncCapMs: 60_000,
	durable: "shell-detach" as const,
});
export const MICROSANDBOX_CREATE_BUDGET = Object.freeze({
	owner: "harness" as const,
	timeoutMs: MICROSANDBOX_CREATE_TIMEOUT_MS,
});

export const MICROSANDBOX_REQUEST_COVERAGE = {
	spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "mapped" },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "mapped",
} as const;

// The SDK exposes a builder, not typed create parameters; carry the canonical request to that edge.
type MicrosandboxCreateOptions = Pick<CreateRequest, "env"> & {
	name: string;
	image: string;
	spec: Required<CreateRequest["spec"]>;
};

/**
 * Did the agent CONNECTION fail, rather than the guest rejecting the operation? Only a transport
 * fault makes a reconnect meaningful: a missing path or a vanished record reproduces identically
 * after one, so retrying it only spends a get+connect round trip — and under the detached poll
 * loop, whose calls are individually bounded, that latency can turn a benign miss into a counted
 * poll failure.
 */
function isConnectionError(error: unknown): boolean {
	return (
		error instanceof IoError ||
		error instanceof HttpError ||
		error instanceof CloudHttpError ||
		error instanceof ProtocolError
	);
}

/** Owned iff the name is one this driver (or its legacy adapter) generated; labels are informational. */
export function isMicrosandboxOwned(name: string): boolean {
	return !(MICROSANDBOX_SANDBOX_ID(name) instanceof type.errors);
}

async function execShell(
	sandbox: MsbSandbox,
	command: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	const output = await sandbox.execWith("/bin/sh", (builder) => builder.args(["-c", command]));
	return { exitCode: output.code, stdout: output.stdout(), stderr: output.stderr() };
}

/**
 * Stop and remove one record if it exists. Microsandbox Cloud can persist a status=error record
 * before create rejects, remove() is documented for STOPPED sandboxes only, and transitional or
 * undocumented statuses (a record still booting, `crashed`) do occur — so anything not already
 * stopped is stopped first, or the remove rejects and the microVM leaks until its maxDuration.
 * A record the control plane no longer knows is convergence, never a failure.
 */
async function removeMicrosandbox(backend: DefaultBackend, name: string): Promise<void> {
	await withDefaultBackend(backend, async () => {
		// The whole sequence converges on the SDK's typed absence, not just the lookup: an ephemeral
		// sandbox's record disappears the moment its stop completes (observed live), so the stop wait
		// or the remove can be the call that first sees not-found.
		try {
			const handle = await MsbSandbox.get(name);
			if (handle.name !== name) throw new Error("Microsandbox returned an unrelated sandbox");
			if (handle.status !== "stopped") {
				await handle.requestStop();
				await handle.waitUntilStopped();
			}
			await MsbSandbox.remove(name);
		} catch (error) {
			if (error instanceof SandboxNotFoundError) return;
			throw error;
		}
	});
}

/** Drain every page; a repeated or empty continuation cursor fails closed. */
async function listMicrosandboxes(
	backend: DefaultBackend,
	options: DriverOperationOptions,
): Promise<MsbSandboxHandle[]> {
	return withDefaultBackend(backend, async () => {
		const rows: MsbSandboxHandle[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; ; page++) {
			options.signal?.throwIfAborted();
			if (page >= MICROSANDBOX_INVENTORY_MAX_PAGES)
				throw new Error("Microsandbox inventory exceeded its page limit");
			const next = cursor;
			const result = await MsbSandbox.listWith((list) =>
				next === undefined ? list.limit(100) : list.limit(100).cursor(next),
			);
			rows.push(...result.sandboxes);
			if (!result.nextCursor) return rows;
			if (cursors.has(result.nextCursor))
				throw new Error("Microsandbox inventory repeated a continuation cursor");
			cursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
	});
}

/** Allocate with the pinned SDK so typed refusals survive until reconciliation/classification. */
export function microsandboxCompute(backend: DefaultBackend) {
	return nativeSdkCompute(
		(options: MicrosandboxCreateOptions, operation) => {
			operation.signal?.throwIfAborted();
			return withDefaultBackend(backend, () => {
				let builder = MsbSandbox.builder(options.name)
					.image(options.image)
					.rootDisk(options.spec.diskGb * 1024)
					.cpus(options.spec.vcpus)
					.memory(options.spec.memoryGb * 1024)
					.maxDuration(Math.ceil(MICROSANDBOX_SANDBOX_LIFETIME_MS / 1000))
					.detached(true)
					// Ephemeral: state is deleted when the sandbox stops, so a stopped leftover holds nothing.
					.ephemeral(true)
					.label(MICROSANDBOX_LABEL_MARKER, "microsandbox-cloud");
				if (options.env !== undefined && Object.keys(options.env).length > 0)
					builder = builder.envs(options.env);
				return builder.create();
			});
		},
		(native) => {
			// The create returns a connected agent session. A connection that dies mid-run must not
			// silently boot a replacement guest: a sandbox that died must surface as lost, not answer
			// every done-file poll with "not yet" from an empty VM.
			let connected: MsbSandbox = native;
			let staleAfterCommand = false;
			const reconnect = () =>
				withDefaultBackend(backend, async () => {
					const current = await MsbSandbox.get(native.name);
					if (current.status !== "running")
						throw new Error(
							`Microsandbox sandbox "${native.name}" is ${current.status}, not running; refusing to reboot it`,
						);
					return current.connect();
				});
			// Idempotent filesystem operations may retry once after a CONNECTION failure.
			const withFilesystemReconnect = async <T>(
				operation: (sandbox: MsbSandbox) => Promise<T>,
			): Promise<T> => {
				try {
					return await operation(connected);
				} catch (error) {
					if (!isConnectionError(error)) throw error;
					connected = await reconnect();
					return operation(connected);
				}
			};
			return {
				sandboxId: native.name,
				runCommand: async (command, options) => {
					options?.signal?.throwIfAborted();
					// The agent may have accepted a command before its connection failed. Reconnect for the
					// NEXT command, but never replay this one: setup mutations and detached launches are not
					// idempotent. Throwing (not a synthesized exit) keeps a never-started launch from being
					// polled for until the step's whole budget expires.
					if (staleAfterCommand) {
						connected = await reconnect();
						staleAfterCommand = false;
					}
					try {
						return await execShell(connected, command);
					} catch (error) {
						if (isConnectionError(error)) staleAfterCommand = true;
						throw error;
					}
				},
				destroy: () => removeMicrosandbox(backend, native.name),
				filesystem: {
					readFile: (path: string) =>
						withFilesystemReconnect((sandbox) => sandbox.fs().readToString(path)),
					exists: (path: string) => withFilesystemReconnect((sandbox) => sandbox.fs().exists(path)),
					writeFile: async (path: string, content: string) => {
						const parent = posixPath.dirname(path);
						if (parent && parent !== "/" && parent !== ".") {
							const result = await execShell(connected, `mkdir -p ${shellQuote(parent)}`);
							if (result.exitCode !== 0)
								throw new Error(`Microsandbox mkdir failed for ${parent}: ${result.stderr}`);
						}
						await withFilesystemReconnect((sandbox) => sandbox.fs().write(path, content));
					},
				},
			};
		},
	);
}

/**
 * The SDK reports one allocation in two shapes (observed live on 0.6.8): a listed record's config
 * carries `resources.{vcpus,memoryMib,diskSizeMib}`, a live sandbox's config carries
 * `resources.{cpus,memoryMib}` with the managed root disk under `image.Oci.rootDisk.sizeMib`.
 */
const allocatedResources = type({
	resources: {
		"cpus?": "number > 0",
		"vcpus?": "number > 0",
		memoryMib: "number > 0",
		"diskSizeMib?": "number > 0",
	},
	"image?": { "Oci?": { "rootDisk?": { kind: "string", "sizeMib?": "number > 0" } } },
});

/**
 * Prove the control plane allocated what the request mapped, from the sandbox's own config (the
 * same source daytona reads) rather than an in-guest `df`: a managed root disk of N MiB formats to
 * slightly less than N MiB of filesystem, so a capacity probe would refuse every correctly-sized
 * allocation.
 */
export async function verifyMicrosandboxResources(
	native: MsbSandbox,
	request: CreateRequest,
	options: DriverOperationOptions,
): Promise<ComputeSdkCreatedRequestVerification> {
	options.signal?.throwIfAborted();
	const config = allocatedResources.assert(await native.config());
	const vcpus = config.resources.cpus ?? config.resources.vcpus;
	const memoryMib = config.resources.memoryMib;
	if (vcpus !== request.spec.vcpus || memoryMib !== request.spec.memoryGb * 1024)
		return {
			status: "unsupported",
			detail: `requested ${request.spec.vcpus} vCPU / ${request.spec.memoryGb} GiB but the allocation reports ${vcpus ?? "unknown"} vCPU / ${memoryMib} MiB`,
		};
	const requestedDiskGb = request.spec.diskGb;
	if (requestedDiskGb === undefined) return { status: "honored" };
	const rootDisk = config.image?.Oci?.rootDisk;
	const diskSizeMib =
		config.resources.diskSizeMib ?? (rootDisk?.kind === "managed" ? rootDisk.sizeMib : undefined);
	if (diskSizeMib === undefined)
		throw new Error("Microsandbox reported no managed root disk for the allocation");
	return diskSizeMib >= requestedDiskGb * 1024
		? { status: "honored" }
		: {
				status: "unsupported",
				detail: `requested ${requestedDiskGb} GiB but the allocation reports a ${diskSizeMib} MiB root disk`,
			};
}

export function microsandboxProbes(
	backend: DefaultBackend,
): NonNullable<ComputeSdkDriverSpec<MicrosandboxCompute>["probes"]> {
	return {
		observe: (_compute, ref) =>
			withDefaultBackend(backend, async () => {
				try {
					const handle = await MsbSandbox.get(ref.id);
					// A record that still exists but is no longer running is terminal, not absent: only a
					// removed record proves convergence.
					return handle.status === "running" || handle.status === "draining"
						? { state: "running" as const }
						: { state: "terminal" as const };
				} catch (error) {
					if (error instanceof SandboxNotFoundError) return { state: "absent" as const };
					throw error;
				}
			}),
		describe: (_compute, ref) => withDefaultBackend(backend, () => MsbSandbox.get(ref.id)),
		// One list page: a round-trip measurement, not an enumeration (that is `inventory`).
		list: () => withDefaultBackend(backend, () => MsbSandbox.list()),
	};
}

/** Whole-account inventory: every record, owned iff its name is one the benchmark generates. */
export function microsandboxInventory(
	backend: DefaultBackend,
): NonNullable<ComputeSdkDriverSpec<MicrosandboxCompute>["inventory"]> {
	return {
		list: async (_compute, options) => {
			const owned: string[] = [];
			let foreignCount = 0;
			for (const handle of await listMicrosandboxes(backend, options)) {
				// A stopped record is still an account resource (ours to remove, theirs to block on):
				// remove() is the only transition that makes a record disappear from this listing.
				if (isMicrosandboxOwned(handle.name)) owned.push(handle.name);
				else foreignCount += 1;
			}
			return { owned, foreignCount };
		},
	};
}

/** Extracted through the joined context type so tests can pin the actual one-file authoring shape. */
export function microsandboxCloudSpec({
	env,
	resolvedArtifact,
}: DriverContext<"microsandbox-cloud">) {
	// Omitting the URL delegates to the SDK's production default; the property stays absent rather
	// than undefined so the backend selection shape is explicit.
	const backend: DefaultBackend =
		env.MSB_API_URL === undefined
			? { kind: "cloud", apiKey: env.MSB_API_KEY }
			: { kind: "cloud", url: env.MSB_API_URL, apiKey: env.MSB_API_KEY };
	return computeSdkSpec(microsandboxCompute(backend), {
		sandboxId: MICROSANDBOX_SANDBOX_ID,
		createOptions: {
			coverage: MICROSANDBOX_REQUEST_COVERAGE,
			map: (request, unsupported) => {
				if (request.artifact.kind !== "image" || request.artifact.ref !== resolvedArtifact.ref)
					unsupported("the request artifact does not match the resolved Microsandbox image");
				if (request.gpu !== undefined) unsupported("Microsandbox Cloud allocates no accelerators");
				const diskGb = request.spec.diskGb;
				if (diskGb === undefined)
					return unsupported("Microsandbox Cloud requires an explicit managed root disk size");
				return {
					name: `${MICROSANDBOX_NAME_PREFIX}${randomUUID()}`,
					image: resolvedArtifact.ref,
					spec: { ...request.spec, diskGb },
					...(request.env === undefined ? {} : { env: request.env }),
				};
			},
		},
		lifecycle: {
			destroy: async (sandbox, ref, options) => {
				options.signal?.throwIfAborted();
				await removeMicrosandbox(backend, ref?.id ?? sandbox.getInstance().name);
			},
		},
		createRecovery: {
			absenceConfirmationMs: MICROSANDBOX_RECOVERY_CONFIRMATION_MS,
			maxAttempts: MICROSANDBOX_RECOVERY_MAX_ATTEMPTS,
			locator: (options) => ({ kind: "name", value: options.name }),
			// Only a configuration the SDK refused before contacting the control plane proves nothing
			// was allocated. The SDK types no capacity refusal, so no create is ever marked retryable:
			// vendor prose must never manufacture a retry decision.
			isDefinitive: (error) =>
				matchesAnyCause(error, (cause) => cause instanceof InvalidConfigError),
			cleanup: async (_compute, locator, options) => {
				options.signal?.throwIfAborted();
				const present = await withDefaultBackend(backend, async () => {
					try {
						const handle = await MsbSandbox.get(locator.value);
						if (handle.name !== locator.value)
							throw new Error("Microsandbox recovery returned an unrelated sandbox");
						return true;
					} catch (error) {
						if (error instanceof SandboxNotFoundError) return false;
						throw error;
					}
				});
				if (!present) return { status: "absent" };
				await removeMicrosandbox(backend, locator.value);
				return { status: "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: (_sandbox, native, request, options) =>
			verifyMicrosandboxResources(native, request, options),
		hasWorkingFilesystem: true,
		probes: microsandboxProbes(backend),
		inventory: microsandboxInventory(backend),
		destroyById: async (_compute, ref, options) => {
			options.signal?.throwIfAborted();
			await removeMicrosandbox(backend, ref.id);
		},
	});
}

export default defineComputeSdkDriver("microsandbox-cloud", {
	provenance: MICROSANDBOX_PROVENANCE,
	readiness: MICROSANDBOX_READINESS,
	execution: MICROSANDBOX_EXECUTION,
	createBudget: MICROSANDBOX_CREATE_BUDGET,
	spec: microsandboxCloudSpec,
});

/** Exposed for tests: the exec projection the driver's session runs every command through. */
export const execMicrosandboxShell = execShell;
export type { ExecOptions };
