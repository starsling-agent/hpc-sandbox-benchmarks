// Novita's E2B-compatible SDK owns its regional control plane and credential channel. No account
// key is injected into custom headers, which the SDK would also forward to the guest daemon.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DriverContext, ExecOptions } from "@sandbox-benchmarks/driver";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { matchesAnyCause } from "@sandbox-benchmarks/driver/errors";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import type { Sandbox as NativeSandbox } from "novita-sandbox";
import { NOVITA_PROVENANCE } from "./provenance.ts";

// Match the CJS format used by the still-unmigrated legacy adapter to avoid Bun's mixed chalk
// module-load race. This remains the native SDK; no wrapper internals are patched.
const { Sandbox, SandboxNotFoundError, AuthenticationError, InvalidArgumentError, RateLimitError } =
	createRequire(import.meta.url)("novita-sandbox") as typeof import("novita-sandbox");
export const NOVITA_DOMAIN = "us-phx-1.sandbox.novita.ai";
export const NOVITA_SANDBOX_ID = type(/^[A-Za-z0-9_-]+$/);
const CONTROL_TIMEOUT_MS = 5000;
const ATTEMPT_KEY = "sandbox-benchmarks-attempt";
const optionsSchema = type({
	template: "string >= 1",
	marker: "string >= 1",
});
const recoveryRows = type({
	sandboxId: NOVITA_SANDBOX_ID,
	metadata: { "[string]": "string" },
}).array();
/** Every benchmark create writes `${ATTEMPT_KEY}: benchmark-<uuid>`; the account sweep keys on it. */
const MARKER_PREFIX = "benchmark-";
/** A paused sandbox is still an allocation the account owns, so the sweep lists both live states. */
const INVENTORY_STATES = ["running", "paused"] as const;
const inventoryRows = type({
	sandboxId: "string >= 1",
	"metadata?": { "[string]": "string" },
}).array();

/** Drain one Novita paginator; a repeated or missing continuation token fails closed. */
async function drainNovitaList(
	lane: "recovery" | "inventory",
	listOptions: Parameters<typeof Sandbox.list>[0],
	options: { readonly signal?: AbortSignal },
	consume: (rows: unknown) => void,
): Promise<void> {
	const paginator = Sandbox.list(listOptions);
	const tokens = new Set<string>();
	for (let page = 0; ; page++) {
		options.signal?.throwIfAborted();
		if (page >= 100) throw new Error(`Novita ${lane} exceeded its page limit`);
		consume(await paginator.nextItems());
		if (!paginator.hasNext) return;
		const token = paginator.nextToken;
		if (!token || tokens.has(token))
			throw new Error(`Novita ${lane} repeated or omitted a continuation token`);
		tokens.add(token);
	}
}
const commandFailure = type({
	name: "'CommandExitError'",
	exitCode: "number.integer",
	stdout: "string",
	stderr: "string",
});

async function exec(native: NativeSandbox, command: string, options?: ExecOptions) {
	options?.signal?.throwIfAborted();
	try {
		return await native.commands.run(command, {
			user: "root",
			background: false,
			timeoutMs: 60000,
			requestTimeoutMs: CONTROL_TIMEOUT_MS,
		});
	} catch (error) {
		const result = commandFailure(error);
		if (!(result instanceof type.errors) && result.exitCode !== 0) return result;
		throw error;
	}
}

export function novitaSpec({ env, resolvedArtifact }: DriverContext<"novita">) {
	const connection = {
		apiKey: env.NOVITA_API_KEY,
		domain: NOVITA_DOMAIN,
		requestTimeoutMs: CONTROL_TIMEOUT_MS,
	};
	const compute = nativeSdkCompute(
		(options: typeof optionsSchema.infer) =>
			Sandbox.create(options.template, {
				...connection,
				requestTimeoutMs: 300000,
				timeoutMs: 3 * 60 * 60000,
				metadata: { [ATTEMPT_KEY]: options.marker },
			}),
		(native) => ({
			sandboxId: native.sandboxId,
			runCommand: (command: string) => exec(native, command),
			destroy: () => native.kill(connection),
			filesystem: {
				readFile: (path: string) =>
					native.files.read(path, { user: "root", requestTimeoutMs: CONTROL_TIMEOUT_MS }),
				exists: (path: string) =>
					native.files.exists(path, { user: "root", requestTimeoutMs: CONTROL_TIMEOUT_MS }),
				writeFile: async (path: string, content: string) => {
					await native.files.write(path, content, {
						user: "root",
						requestTimeoutMs: CONTROL_TIMEOUT_MS,
					});
				},
			},
		}),
	);
	return computeSdkSpec(compute, {
		sandboxId: NOVITA_SANDBOX_ID,
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
					unsupported("request artifact differs from the resolved Novita template");
				return { template: resolvedArtifact.ref, marker: `benchmark-${randomUUID()}` };
			},
		},
		commands: {
			exec: (sandbox, command, options) => exec(sandbox.getInstance(), command, options),
			launch: async (sandbox, command, options) => {
				options?.signal?.throwIfAborted();
				const handle = await sandbox.getInstance().commands.run(command, {
					user: "root",
					background: true,
					timeoutMs: 0,
					requestTimeoutMs: CONTROL_TIMEOUT_MS,
				});
				if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0)
					throw new Error("Novita returned no positive process id");
			},
		},
		lifecycle: {
			destroy: async (sandbox, ref) => {
				if (ref) await Sandbox.kill(ref.id, connection);
				else await sandbox.getInstance().kill(connection);
			},
		},
		createRecovery: {
			absenceConfirmationMs: 2000,
			maxAttempts: 4,
			locator: (options) => ({
				kind: "marker",
				key: ATTEMPT_KEY,
				value: options.marker,
			}),
			isDefinitive: (error) =>
				matchesAnyCause(
					error,
					(cause) =>
						cause instanceof AuthenticationError ||
						cause instanceof InvalidArgumentError ||
						cause instanceof RateLimitError,
				),
			isRetryableCreate: (error) =>
				matchesAnyCause(error, (cause) => cause instanceof RateLimitError),
			cleanup: async (_compute, locator, options) => {
				const ids = new Set<string>();
				await drainNovitaList(
					"recovery",
					{ ...connection, query: { metadata: { [ATTEMPT_KEY]: locator.value } } },
					options,
					(rows) => {
						for (const row of recoveryRows.assert(rows)) {
							if (row.metadata[ATTEMPT_KEY] !== locator.value)
								throw new Error("Novita recovery returned an unrelated sandbox");
							ids.add(row.sandboxId);
						}
					},
				);
				let destroyed = false;
				for (const id of ids) {
					options.signal?.throwIfAborted();
					destroyed = (await Sandbox.kill(id, connection)) || destroyed;
				}
				return destroyed
					? { status: "destroyed" }
					: { status: "absent", contradictedPriorAbsence: ids.size > 0 };
			},
		},
		prepareAndVerifyCreatedRequest: async (_sandbox, native, request) => {
			if (request.spec.diskGb === undefined) return { status: "honored" };
			const result = await exec(native, "df -Pk / | awk 'NR==2 {print $2}'");
			if (result.exitCode !== 0 || !/^\d+$/.test(result.stdout.trim()))
				throw new Error("Novita disk capacity probe failed");
			const capacity = Number(result.stdout.trim()) / 1024 / 1024;
			return capacity >= request.spec.diskGb
				? { status: "honored" }
				: {
						status: "unsupported",
						detail: `requested ${request.spec.diskGb} GiB but allocation exposes ${capacity.toFixed(2)} GiB`,
					};
		},
		hasWorkingFilesystem: true,
		probes: {
			observe: async (_compute, ref) => {
				try {
					const info = await Sandbox.getInfo(ref.id, connection);
					if (info.state !== "running" && info.state !== "paused")
						throw new Error("Novita returned an unknown state");
					return { state: "running" };
				} catch (error) {
					if (error instanceof SandboxNotFoundError) return { state: "absent" };
					throw error;
				}
			},
			describe: (_compute, ref) => Sandbox.getInfo(ref.id, connection),
			// Preserve the existing measurement: one list page, rather than timing full enumeration.
			list: () => Sandbox.list(connection).nextItems(),
		},
		inventory: {
			list: async (_compute, options) => {
				const owned: string[] = [];
				let foreignCount = 0;
				await drainNovitaList(
					"inventory",
					{ ...connection, query: { state: [...INVENTORY_STATES] } },
					options,
					(rows) => {
						for (const row of inventoryRows.assert(rows)) {
							if (row.metadata?.[ATTEMPT_KEY]?.startsWith(MARKER_PREFIX)) owned.push(row.sandboxId);
							else foreignCount += 1;
						}
					},
				);
				return { owned, foreignCount };
			},
		},
		destroyById: async (_compute, ref, options) => {
			options.signal?.throwIfAborted();
			try {
				await Sandbox.kill(ref.id, connection);
			} catch (error) {
				if (error instanceof SandboxNotFoundError) return;
				throw error;
			}
		},
	});
}

export default defineComputeSdkDriver("novita", {
	provenance: NOVITA_PROVENANCE,
	readiness: { startup: "create-returns-ready" },
	execution: { syncCapMs: 60000, durable: "native-launch" },
	spec: novitaSpec,
});
