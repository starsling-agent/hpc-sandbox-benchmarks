// ComputeSDK adapter for Microsandbox Cloud.
import { randomUUID } from "node:crypto";
import { posix as posixPath } from "node:path";
import type {
	CommandResult,
	CreateSandboxOptions,
	FileEntry,
	RunCommandOptions,
	SandboxInfo,
	SandboxMethods,
} from "@computesdk/provider";
import { defineProvider } from "@computesdk/provider";
import type {
	DefaultBackend,
	FsEntry as MsbFsEntry,
	SandboxHandle as MsbSandboxHandle,
} from "microsandbox";
import {
	CloudHttpError,
	HttpError,
	IoError,
	Sandbox as MsbSandbox,
	ProtocolError,
	SandboxNotFoundError,
	withDefaultBackend,
} from "microsandbox";

type MsbSandboxBuilder = ReturnType<typeof MsbSandbox.builder>;

/** Identifies sandboxes created by this benchmark provider. */
const LABEL_MARKER = "sandbox-benchmarks.provider";
/** Label prefix under which ComputeSDK metadata is persisted. */
const LABEL_META_PREFIX = "sandbox-benchmarks.meta.";

export interface MicrosandboxCloudConfig {
	backend: Extract<DefaultBackend, { kind: "cloud" }>;
	/** Whether the provider should delete sandbox state when the sandbox stops. */
	ephemeral: boolean;
	/** OCI image to boot when create() receives no templateId. */
	image: string;
	/** Guest vCPUs. */
	cpus: number;
	/** Guest memory in MiB. */
	memoryMib: number;
	/** Writable managed root disk in MiB. */
	rootDiskMib: number;
	/** Prefix for generated sandbox names. */
	namePrefix: string;
	/** Informational timeout surfaced through ComputeSDK getInfo(). */
	timeoutMs: number;
}

export type MicrosandboxConfig = MicrosandboxCloudConfig;

/** The native sandbox plus enough immutable context to reconnect it safely. */
export interface MicrosandboxHandle {
	name: string;
	sandbox: InstanceType<typeof MsbSandbox> | null;
	backend: MicrosandboxCloudConfig["backend"];
	createdAt: Date;
	timeoutMs: number;
	metadata: Record<string, unknown>;
}

/**
 * Thrown when the command never reached the guest — the agent connection failed, or the SDK gave up
 * waiting for a response.
 *
 * This is deliberately NOT folded into a `CommandResult`: `StepRunner.runDetached` launches the
 * benchmark with `runCommand(..., { background: true })` and discards the result, so a synthesized
 * "exit 127" would leave the harness polling for the done-file of a job that was never started until
 * the step's whole budget expired. A guest command that genuinely exits 127 still returns a result.
 */
export class MicrosandboxTransportError extends Error {
	constructor(sandboxName: string, cause: unknown) {
		super(`Microsandbox command did not reach sandbox "${sandboxName}": ${errorMessage(cause)}`, {
			cause,
		});
		this.name = "MicrosandboxTransportError";
	}
}

/** POSIX single-quote shell escaping for commands sent to the guest shell. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return error instanceof SandboxNotFoundError;
}

/**
 * Does this error mean the agent connection itself failed, rather than the guest rejecting the
 * operation?
 *
 * Only a transport fault makes a retry meaningful. Application faults — `SandboxFsOpsError` for a
 * missing path or a read-only target, `SandboxNotFoundError` for a vanished record — reproduce
 * identically after a reconnect, so retrying them only spends a `get` + `connect` round trip and, on
 * the detached poll path, risks pushing a bounded poll past its cap.
 */
function isConnectionError(error: unknown): boolean {
	return (
		error instanceof IoError ||
		error instanceof HttpError ||
		error instanceof CloudHttpError ||
		error instanceof ProtocolError
	);
}

function mapStatus(status: string): SandboxInfo["status"] {
	switch (status) {
		case "running":
		case "draining":
			return "running";
		case "stopped":
			return "stopped";
		default:
			return "error";
	}
}

function recoverFromConfig(configJson: string): {
	labels: Record<string, string>;
	metadata: Record<string, unknown>;
} {
	const labels: Record<string, string> = {};
	const metadata: Record<string, unknown> = {};
	try {
		const config = JSON.parse(configJson) as Record<string, unknown>;
		const rawLabels = config.labels;
		if (rawLabels && typeof rawLabels === "object") {
			for (const [key, value] of Object.entries(rawLabels as Record<string, unknown>)) {
				labels[key] = String(value);
				if (key.startsWith(LABEL_META_PREFIX)) {
					metadata[key.slice(LABEL_META_PREFIX.length)] = String(value);
				}
			}
		}
	} catch {
		// A malformed legacy config must not make list/get unusable; the name prefix remains a fallback.
	}
	return { labels, metadata };
}

function handleFromMsb(
	config: MicrosandboxConfig,
	msbHandle: MsbSandboxHandle,
): MicrosandboxHandle {
	const { metadata } = recoverFromConfig(msbHandle.configJson);
	return {
		name: msbHandle.name,
		sandbox: null,
		backend: config.backend,
		createdAt: msbHandle.createdAt ?? new Date(),
		timeoutMs: config.timeoutMs,
		metadata,
	};
}

function isOurs(config: MicrosandboxConfig, handle: MsbSandboxHandle): boolean {
	const { labels } = recoverFromConfig(handle.configJson);
	if (labels[LABEL_MARKER] === "microsandbox-cloud") return true;
	return handle.name.startsWith(config.namePrefix);
}

async function withBackend<T>(config: MicrosandboxConfig, operation: () => Promise<T>): Promise<T> {
	return withDefaultBackend(config.backend, operation);
}

/**
 * Stop and remove one sandbox record if it exists.
 *
 * Microsandbox Cloud can persist a status=error record before create() rejects. Callers that never
 * receive a ComputeSDK sandbox handle cannot use the normal destroy path, so failed autogenerated
 * creates use this primitive too. Missing records are already clean and therefore a no-op.
 */
async function removeSandboxIfPresent(
	config: MicrosandboxConfig,
	sandboxId: string,
): Promise<void> {
	await withBackend(config, async () => {
		try {
			const handle = await MsbSandbox.get(sandboxId);
			// Stop anything not already stopped, not just the two statuses that map to "running". The SDK
			// documents remove() as removing a STOPPED sandbox, and `mapStatus`'s `default` arm exists
			// precisely because transitional/unknown statuses (a cloud record still booting, `crashed`) do
			// occur — skipping the stop for those made remove() reject and leaked the microVM until its
			// maxDuration expired.
			if (handle.status !== "stopped") {
				// Request and await cloud stop without escalating to unsupported kill().
				await handle.requestStop();
				await handle.waitUntilStopped();
			}
			await MsbSandbox.remove(sandboxId);
		} catch (error) {
			if (isNotFound(error)) return;
			throw error;
		}
	});
}

/** Map the SDK's structured listing without parsing or normalizing valid POSIX filename bytes. */
export function microsandboxFileEntries(entries: readonly MsbFsEntry[]): FileEntry[] {
	return entries.map((entry) => ({
		name: posixPath.basename(entry.path),
		type: entry.kind === "directory" ? ("directory" as const) : ("file" as const),
		size: entry.size,
		...(entry.modified ? { modified: entry.modified } : {}),
	}));
}

/**
 * Connect lazily; handles created by the SDK already retain their backend after this lookup.
 *
 * A sandbox that is no longer running is an ERROR, never something to boot back up. The harness's
 * detached poll loop treats a run of failing filesystem calls as `GapError{kind:"sandbox-lost"}`
 * specifically so a microVM killed by its maxDuration, an OOM, or a host fault is recorded as a gap.
 * Silently returning a freshly booted guest defeats that: the done-file it is asked about can never
 * appear, so the step burns its whole budget and reports a plain timeout — and on the synchronous
 * path the results tar is collected from an empty VM, yielding a Run with no results AND no gap.
 */
async function ensureConnected(
	handle: MicrosandboxHandle,
): Promise<InstanceType<typeof MsbSandbox>> {
	if (handle.sandbox) return handle.sandbox;
	const sandbox = await withDefaultBackend(handle.backend, async () => {
		const current = await MsbSandbox.get(handle.name);
		if (current.status !== "running") {
			throw new Error(
				`Microsandbox sandbox "${handle.name}" is ${current.status}, not running — refusing to ` +
					`reboot it. A sandbox that died mid-run must surface as a lost sandbox, not be replaced ` +
					`by an empty guest that answers every probe with "not done yet".`,
			);
		}
		return current.connect();
	});
	handle.sandbox = sandbox;
	return sandbox;
}

/**
 * Retry one agent filesystem operation once when the CONNECTION failed.
 *
 * Two things are deliberately narrow here. Only connection-class errors retry ({@link
 * isConnectionError}): a missing path or a read-only target reproduces identically after a reconnect,
 * so retrying it just spends a get+connect round trip and can push a bounded detached poll past its
 * cap. And the retry is gated on the error, not on whether a cached connection existed — a handle from
 * `getById`/`list` starts with none, and a connection that goes stale inside that very call deserves
 * the same second chance as one that was already cached.
 *
 * Command execution is excluded from all of this because a lost response cannot tell us whether the
 * guest already accepted that command; filesystem reads and full-content writes are idempotent.
 */
async function withFilesystemReconnect<T>(
	handle: MicrosandboxHandle,
	operation: (sandbox: InstanceType<typeof MsbSandbox>) => Promise<T>,
): Promise<T> {
	const sandbox = await ensureConnected(handle);
	try {
		return await operation(sandbox);
	} catch (error) {
		if (!isConnectionError(error)) throw error;
		handle.sandbox = null;
		return operation(await ensureConnected(handle));
	}
}

async function execOnce(
	sandbox: InstanceType<typeof MsbSandbox>,
	command: string,
	options?: RunCommandOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const script = options?.background
		? `nohup sh -c ${shellQuote(command)} >/dev/null 2>&1 &`
		: command;
	const output = await sandbox.execWith("/bin/sh", (builder) => {
		let configured = builder.args(["-c", script]);
		if (options?.cwd) configured = configured.cwd(options.cwd);
		if (options?.env && Object.keys(options.env).length > 0) {
			configured = configured.envs(options.env);
		}
		if (options?.timeout) configured = configured.timeout(options.timeout);
		return configured;
	});
	return { stdout: output.stdout(), stderr: output.stderr(), exitCode: output.code };
}

async function runShell(
	handle: MicrosandboxHandle,
	command: string,
	options?: RunCommandOptions,
): Promise<CommandResult> {
	const started = Date.now();
	try {
		const sandbox = await ensureConnected(handle);
		return { ...(await execOnce(sandbox, command, options)), durationMs: Date.now() - started };
	} catch (error) {
		// The agent may have accepted the command before its connection failed. Drop the stale cache so
		// the NEXT operation reconnects, but never replay this operation: setup mutations and detached
		// benchmark launches are not generally idempotent.
		handle.sandbox = null;
		// THROW rather than synthesizing a result. `StepRunner.runDetached` discards the result of its
		// background launch, so a returned "exit 127" left the harness polling for a job that was never
		// started until the step's whole budget expired — and it was indistinguishable from a guest
		// command that genuinely exits 127.
		throw new MicrosandboxTransportError(handle.name, error);
	}
}

/** Drain every page for this provider marker; ComputeSDK's list contract is not paginated. */
async function listAll(config: MicrosandboxConfig): Promise<MsbSandboxHandle[]> {
	return withBackend(config, async () => {
		// Ownership is decided once, in isOurs(): labels cover current sandboxes and the name prefix
		// recovers legacy/partial records whose labels were lost. A server-side label filter would make
		// that fallback unreachable.
		let page = await MsbSandbox.listWith((list) => list.limit(100));
		const all = [...page.sandboxes];
		while (page.nextCursor) {
			const cursor = page.nextCursor;
			page = await MsbSandbox.listWith((list) => list.limit(100).cursor(cursor));
			all.push(...page.sandboxes);
		}
		return all;
	});
}

const sandboxMethods: SandboxMethods<MicrosandboxHandle, MicrosandboxConfig> = {
	create: async (config, options?: CreateSandboxOptions) => {
		const generatedName = options?.name === undefined;
		const name = options?.name ?? `${config.namePrefix}${randomUUID()}`;
		const timeoutMs = options?.timeout ?? config.timeoutMs;
		const metadata: Record<string, unknown> = options?.metadata ?? {};
		if (options?.ports?.length) {
			throw new Error("Microsandbox sandboxes do not expose published host ports");
		}
		if (options?.snapshotId) {
			throw new Error("Microsandbox cloud snapshots are not supported");
		}
		const maxDurationSecs = Math.max(1, Math.ceil(timeoutMs / 1000));

		try {
			const sandbox = await withBackend(config, async () => {
				let builder: MsbSandboxBuilder = MsbSandbox.builder(name)
					.image(options?.templateId ?? config.image)
					.rootDisk(config.rootDiskMib);
				builder = builder
					.cpus(config.cpus)
					.memory(config.memoryMib)
					.maxDuration(maxDurationSecs)
					.detached(true)
					.ephemeral(config.ephemeral)
					.label(LABEL_MARKER, "microsandbox-cloud");
				for (const [key, value] of Object.entries(metadata)) {
					builder = builder.label(`${LABEL_META_PREFIX}${key}`, String(value));
				}
				if (options?.envs && Object.keys(options.envs).length > 0)
					builder = builder.envs(options.envs);
				return builder.create();
			});

			return {
				sandbox: {
					name,
					sandbox,
					backend: config.backend,
					createdAt: new Date(),
					timeoutMs,
					metadata,
				},
				sandboxId: name,
			};
		} catch (error) {
			let cleanupFailure: unknown;
			// Generated UUID names cannot refer to a caller-owned pre-existing sandbox. Explicit names can:
			// an AlreadyExists or transport error must never turn into deleting that existing resource.
			if (generatedName) {
				try {
					await removeSandboxIfPresent(config, name);
				} catch (cleanupError) {
					cleanupFailure = cleanupError;
				}
			}
			const cleanupSuffix = cleanupFailure
				? `; cleanup of the partial sandbox also failed: ${errorMessage(cleanupFailure)}`
				: "";
			throw new Error(
				`Failed to create microsandbox-cloud sandbox "${name}" through the cloud control plane: ${errorMessage(error)}${cleanupSuffix}`,
				{ cause: error },
			);
		}
	},

	getById: async (config, sandboxId) => {
		try {
			const handle = await withBackend(config, () => MsbSandbox.get(sandboxId));
			return { sandbox: handleFromMsb(config, handle), sandboxId };
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	},

	list: async (config) =>
		(await listAll(config))
			.filter((handle) => isOurs(config, handle))
			.map((handle) => ({ sandbox: handleFromMsb(config, handle), sandboxId: handle.name })),

	destroy: removeSandboxIfPresent,

	runCommand: runShell,

	getInfo: async (handle): Promise<SandboxInfo> => {
		let status: SandboxInfo["status"] = "running";
		let createdAt = handle.createdAt;
		try {
			const current = await withDefaultBackend(handle.backend, () => MsbSandbox.get(handle.name));
			status = mapStatus(current.status);
			createdAt = current.createdAt ?? createdAt;
		} catch (error) {
			if (!isNotFound(error)) throw error;
			status = "stopped";
		}
		return {
			id: handle.name,
			provider: "microsandbox-cloud",
			status,
			createdAt,
			timeout: handle.timeoutMs,
			metadata: {
				...handle.metadata,
				isolation: "microVM (libkrun)",
				backend: "cloud",
			},
		};
	},
	// Required by SandboxMethods, though this provider does not publish ports.
	getUrl: async (handle): Promise<string> => {
		throw new Error(
			`Microsandbox sandbox "${handle.name}" does not expose published ports; drive it through runCommand`,
		);
	},

	filesystem: {
		readFile: async (handle, path): Promise<string> =>
			withFilesystemReconnect(handle, (sandbox) => sandbox.fs().readToString(path)),
		writeFile: async (handle, path, content, runCommand): Promise<void> => {
			const parent = posixPath.dirname(path);
			if (parent && parent !== "/" && parent !== ".") {
				const result = await runCommand(handle, `mkdir -p ${shellQuote(parent)}`);
				if (result.exitCode !== 0) {
					throw new Error(`mkdir failed for ${parent}: ${result.stderr}`);
				}
			}
			await withFilesystemReconnect(handle, (sandbox) => sandbox.fs().write(path, content));
		},
		mkdir: async (handle, path, runCommand): Promise<void> => {
			const result = await runCommand(handle, `mkdir -p ${shellQuote(path)}`);
			if (result.exitCode !== 0) throw new Error(`mkdir failed for ${path}: ${result.stderr}`);
		},
		readdir: async (handle, path): Promise<FileEntry[]> =>
			microsandboxFileEntries(
				await withFilesystemReconnect(handle, (sandbox) => sandbox.fs().list(path)),
			),
		exists: async (handle, path): Promise<boolean> =>
			withFilesystemReconnect(handle, (sandbox) => sandbox.fs().exists(path)),
		remove: async (handle, path, runCommand): Promise<void> => {
			const result = await runCommand(handle, `rm -rf ${shellQuote(path)}`);
			if (result.exitCode !== 0) throw new Error(`remove failed for ${path}: ${result.stderr}`);
		},
	},
};

/** Cloud provider. Snapshot methods are intentionally absent so the lifecycle harness records a gap. */
export const microsandboxCloudCompute = defineProvider<MicrosandboxHandle, MicrosandboxCloudConfig>(
	{
		name: "microsandbox-cloud",
		methods: {
			sandbox: sandboxMethods,
		},
	},
);
