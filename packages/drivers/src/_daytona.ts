import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { DaytonaConfig, Sandbox } from "@daytona/sdk";
import { Daytona, DaytonaError, DaytonaNotFoundError, DaytonaRateLimitError } from "@daytona/sdk";
import type { DriverContext, ExecOptions } from "@sandbox-benchmarks/driver";
import { shellQuote } from "@sandbox-benchmarks/driver";
import { type } from "arktype";
import { computeSdkSpec, defineComputeSdkDriver } from "./_computesdk.ts";
import { matchesAnyCause } from "./_errors.ts";
import { nativeSdkCompute } from "./_native.ts";
import { DAYTONA_PROVENANCE } from "./_provenance.ts";

type DaytonaId = "daytona-vm" | "daytona-container";
export const DAYTONA_SANDBOX_ID = type("string.uuid");
const createInput = type({ name: "string >= 1", snapshot: "string >= 1" });
const CONTROL_TIMEOUT_MS = 10000;
type CommandSandbox = {
	readonly process: Pick<Sandbox["process"], "createSession" | "executeSessionCommand">;
};

/** A reusable control shell and independent asynchronous shells preserve stream and exit identity. */
export function daytonaCommands() {
	const controls = new WeakMap<CommandSandbox, Promise<string>>();
	const controlSession = (sandbox: CommandSandbox) => {
		let session = controls.get(sandbox);
		if (!session) {
			const id = `benchmark-control-${randomUUID()}`;
			session = sandbox.process.createSession(id).then(() => id);
			controls.set(sandbox, session);
			void session.catch(() => controls.delete(sandbox));
		}
		return session;
	};
	return {
		invalidate: (sandbox: CommandSandbox) => controls.delete(sandbox),
		exec: async (sandbox: CommandSandbox, command: string, options?: ExecOptions) => {
			options?.signal?.throwIfAborted();
			const id = await controlSession(sandbox);
			options?.signal?.throwIfAborted();
			const result = await sandbox.process.executeSessionCommand(
				id,
				{
					command: `bash -lc ${shellQuote(command)}`,
					runAsync: false,
				},
				60,
			);
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		},
		launch: async (sandbox: CommandSandbox, command: string, options?: ExecOptions) => {
			options?.signal?.throwIfAborted();
			// A durable command must not occupy the control shell used to poll its done file.
			const id = `benchmark-job-${randomUUID()}`;
			await sandbox.process.createSession(id);
			options?.signal?.throwIfAborted();
			const result = await sandbox.process.executeSessionCommand(
				id,
				{
					command: `bash -lc ${shellQuote(command)}`,
					runAsync: true,
				},
				CONTROL_TIMEOUT_MS / 1000,
			);
			if (typeof result.cmdId !== "string" || !result.cmdId)
				throw new Error("Daytona returned no asynchronous command id");
		},
	};
}

export function daytonaSpec<P extends DaytonaId>(
	context: DriverContext<P>,
	createClient: (config: DaytonaConfig) => Daytona = (config) => new Daytona(config),
) {
	const { env, resolvedArtifact } = context;
	const target =
		"DAYTONA_CONTAINER_TARGET" in env ? env.DAYTONA_CONTAINER_TARGET : env.DAYTONA_TARGET;
	const client = createClient({
		apiKey: env.DAYTONA_API_KEY,
		apiUrl: "https://app.daytona.io/api",
		target,
		requestTimeoutMs: CONTROL_TIMEOUT_MS,
	});
	const commands = daytonaCommands();
	const inactiveRefusals = new WeakSet<object>();
	const compute = nativeSdkCompute(
		(options) => createInput.assert(options),
		async (options) => {
			try {
				return await client.create(
					{ snapshot: options.snapshot, name: options.name, autoStopInterval: 0 },
					{ timeout: 300 },
				);
			} catch (error) {
				// An HTTP validation refusal allocated nothing. Confirm snapshot state with the SDK
				// instead of classifying retryability from prose, and leave retries to the harness.
				if (error instanceof DaytonaError && error.statusCode === 400) {
					try {
						const snapshot = await client.snapshot.get(options.snapshot);
						if (snapshot.state === "inactive") {
							inactiveRefusals.add(error);
							await client.snapshot.activate(snapshot);
						}
					} catch {
						/* Preserve the original allocation refusal if activation fails. */
					}
				}
				throw error;
			}
		},
		(native) => ({
			sandboxId: native.id,
			runCommand: (command: string) => commands.exec(native, command),
			destroy: () => client.delete(native, 30, true),
			filesystem: {
				readFile: async (path: string) => (await native.fs.downloadFile(path)).toString("utf8"),
				exists: async (path: string) => {
					try {
						await native.fs.getFileDetails(path);
						return true;
					} catch (error) {
						if (error instanceof DaytonaNotFoundError) return false;
						throw error;
					}
				},
				writeFile: (path: string, content: string) =>
					native.fs.uploadFile(Buffer.from(content), path),
			},
		}),
	);
	return computeSdkSpec(compute, {
		sandboxId: DAYTONA_SANDBOX_ID,
		createOptions: {
			coverage: {
				spec: { vcpus: { artifact: 4 }, memoryGb: { artifact: 8 }, diskGb: "runtime-verified" },
				artifact: "context",
				deadlineMs: "harness",
				gpu: { model: "unsupported", count: "unsupported" },
				env: "unsupported",
			},
			map: (request, unsupported) => {
				if (request.artifact.kind !== "baked" || request.artifact.ref !== resolvedArtifact.ref)
					unsupported("request artifact differs from the resolved Daytona snapshot");
				return { name: `benchmark-${randomUUID()}`, snapshot: resolvedArtifact.ref };
			},
		},
		commands: {
			exec: (sandbox, command, options) => commands.exec(sandbox.getInstance(), command, options),
			launch: (sandbox, command, options) =>
				commands.launch(sandbox.getInstance(), command, options),
		},
		lifecycle: {
			destroy: async (sandbox) => {
				await client.delete(sandbox.getInstance(), 30, true);
			},
		},
		createRecovery: {
			absenceConfirmationMs: 2000,
			maxAttempts: 4,
			locator: (options) => ({ kind: "name", value: createInput.assert(options).name }),
			isDefinitive: (error) =>
				matchesAnyCause(
					error,
					(cause) =>
						cause instanceof DaytonaError &&
						[400, 401, 403, 422, 429].includes(cause.statusCode ?? 0),
				),
			isRetryableCreate: (error) =>
				matchesAnyCause(
					error,
					(cause) =>
						cause instanceof DaytonaRateLimitError ||
						(cause instanceof Error && inactiveRefusals.has(cause)),
				),
			cleanup: async (_compute, locator, options) => {
				options.signal?.throwIfAborted();
				let sandbox: Sandbox;
				try {
					sandbox = await client.get(locator.value);
				} catch (error) {
					if (error instanceof DaytonaNotFoundError) return { status: "absent" };
					throw error;
				}
				if (sandbox.name !== locator.value)
					throw new Error("Daytona recovery returned an unrelated sandbox");
				await client.delete(sandbox, 30, true);
				return { status: "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: async (_sandbox, native, request) => {
			if (request.spec.diskGb === undefined) return { status: "honored" };
			return native.disk >= request.spec.diskGb
				? { status: "honored" }
				: {
						status: "unsupported",
						detail: `requested ${request.spec.diskGb} GiB but snapshot allocates ${native.disk} GiB`,
					};
		},
		hasWorkingFilesystem: true,
		probes: {
			observe: async (_compute, ref) => {
				try {
					const sandbox = await client.get(ref.id);
					if (sandbox.state === "destroyed") return { state: "terminal" };
					if (sandbox.state === undefined) throw new Error("Daytona returned no sandbox state");
					return { state: "running" };
				} catch (error) {
					if (error instanceof DaytonaNotFoundError) return { state: "absent" };
					throw error;
				}
			},
			describe: (_compute, ref) => client.get(ref.id),
			list: async () => {
				const rows = [];
				for await (const sandbox of client.list()) rows.push(sandbox);
				return rows;
			},
		},
		snapshots: {
			create: async (_compute, session) => {
				const name = `benchmark-snapshot-${randomUUID()}`;
				const vm = session.native.sandboxClass === "linux-vm";
				try {
					if (vm) {
						await session.native.stop(30);
						commands.invalidate(session.native);
					}
					let failure: { error: unknown } | undefined;
					try {
						await session.native.createSnapshot(name, 300);
					} catch (error) {
						failure = { error };
					}
					if (vm) {
						try {
							await session.native.start(60);
						} catch (error) {
							if (!failure) failure = { error };
						}
					}
					if (failure) throw failure.error;
					return { snapshotId: name };
				} catch (error) {
					// If restart fails after snapshot creation, the harness never receives an id to delete.
					try {
						await client.snapshot.delete(name);
					} catch (cleanup) {
						if (!(cleanup instanceof DaytonaNotFoundError))
							console.warn("Daytona failed-snapshot cleanup also failed");
					}
					throw error;
				}
			},
			delete: (_compute, name) => client.snapshot.delete(name),
		},
	});
}

export function defineDaytonaDriver<P extends DaytonaId>(id: P) {
	return defineComputeSdkDriver(id, {
		provenance: DAYTONA_PROVENANCE,
		readiness: { startup: "create-returns-ready" },
		execution: { syncCapMs: 60000, durable: "native-launch" },
		spec: (context) => daytonaSpec(context),
	});
}
