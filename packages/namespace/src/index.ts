// Namespace's generated clients own RPC encoding, protobuf types, and typed errors. The driver
// owns benchmark policy: purpose-based ownership, lifecycle convergence, and truthful shell exits.

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createComputeClient, createRegionTransport } from "@namespacelabs/sdk/api";
import type { TokenSource } from "@namespacelabs/sdk/auth";
import { fromBearerToken } from "@namespacelabs/sdk/auth";
import { CommandService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/command_pb";
import type {
	CreateInstanceRequest,
	InstanceMetadata,
} from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import {
	CreateInstanceRequestSchema,
	InstanceMetadata_Status as Status,
} from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import type {
	DriverContext,
	DriverOperationOptions,
	ExecOptions,
	SandboxObservation,
} from "@sandbox-benchmarks/driver";
import { detachedShellCommand, pollUntilReady } from "@sandbox-benchmarks/driver";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { matchesAnyCause } from "@sandbox-benchmarks/driver/errors";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import { NAMESPACE_PROVENANCE } from "./provenance.ts";

export { NAMESPACE_PROVENANCE };
export const NAMESPACE_INSTANCE_ID = type(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const NAMESPACE_PURPOSE_PREFIX = "sandbox-benchmarks:namespace:";
export const NAMESPACE_CONTAINER = "main-container";
export const NAMESPACE_EXIT_SENTINEL = "__sandbox_benchmarks_exit__:";
export const NAMESPACE_CONTROL_TIMEOUT_MS = 20_000;
export const NAMESPACE_INSTANCE_LIFETIME_MS = 195 * 60_000;
export const NAMESPACE_READY_WAIT_MS = 15 * 60_000;
export const NAMESPACE_DESTROY_WAIT_MS = 3 * 60_000;
export const NAMESPACE_STATUS_POLL_MS = 2_000;
// RunCommandSync hangs against a pending container, so readiness completes inside create.
export const NAMESPACE_READINESS = { startup: "create-returns-ready" } as const;
export const NAMESPACE_CREATE_BUDGET = {
	owner: "harness",
	timeoutMs: NAMESPACE_READY_WAIT_MS + 5 * 60_000,
} as const;
export const NAMESPACE_EXECUTION = { syncCapMs: 120_000, durable: "shell-detach" } as const;

const diskCapacitySchema = type("string.integer.parse").to("number > 0");

const tokenFileSchema = type("string.json.parse")
	.to({ bearer_token: "string >= 1" })
	.pipe(({ bearer_token }) => fromBearerToken(bearer_token));

/** Only the explicit CI token file is used. A transient read failure can be retried. */
export function namespaceClient(tokenFile: string, baseUrl?: string) {
	let loaded: Promise<TokenSource> | undefined;
	const tokenSource: TokenSource = {
		issueToken: async (minDuration, force) => {
			loaded ??= Bun.file(tokenFile)
				.text()
				.then((text) => tokenFileSchema.assert(text))
				.catch((error) => {
					loaded = undefined;
					throw error;
				});
			return (await loaded).issueToken(minDuration, force);
		},
	};
	const transport = createRegionTransport("us", {
		tokenSource,
		...(baseUrl === undefined ? {} : { baseUrl }),
	});
	return {
		compute: createComputeClient({ tokenSource, transport }).compute,
		command: (endpoint: string) =>
			createClient(CommandService, createRegionTransport("us", { tokenSource, baseUrl: endpoint })),
	};
}
export type NamespaceClient = ReturnType<typeof namespaceClient>;

function controlOptions(options: DriverOperationOptions = {}) {
	return { timeoutMs: NAMESPACE_CONTROL_TIMEOUT_MS, signal: options.signal };
}

export function isNamespaceAbsent(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(cause) => cause instanceof ConnectError && cause.code === Code.NotFound,
	);
}
export function isNamespaceDefinitiveCreateRejection(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(cause) =>
			cause instanceof ConnectError &&
			[
				Code.InvalidArgument,
				Code.Unauthenticated,
				Code.PermissionDenied,
				Code.ResourceExhausted,
			].includes(cause.code),
	);
}
export function isNamespaceRetryableCreate(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(cause) => cause instanceof ConnectError && cause.code === Code.ResourceExhausted,
	);
}

// RunCommandSync collapses nonzero exits to 1. Capture the guest status before the RPC wrapper
// sees it; a missing or truncated trailer is an unknown exit, never an invented success.
export function sentinelWrappedCommand(command: string): string {
	return `( ${command}\n); printf '\\n${NAMESPACE_EXIT_SENTINEL}%d\\n' "$?"`;
}
export function splitSentinelOutput(stdout: string) {
	const marker = stdout.lastIndexOf(`\n${NAMESPACE_EXIT_SENTINEL}`);
	if (marker === -1) return { stdout, exitCode: undefined };
	const match = /^(\d{1,3})\n?$/.exec(stdout.slice(marker + 1 + NAMESPACE_EXIT_SENTINEL.length));
	if (match === null || Number(match[1]) > 255) return { stdout, exitCode: undefined };
	return { stdout: stdout.slice(0, marker), exitCode: Number(match[1]) };
}
export async function execNamespaceCommand(
	commandClient: ReturnType<NamespaceClient["command"]>,
	instanceId: string,
	command: string,
	options?: ExecOptions,
) {
	const result = await commandClient.runCommandSync(
		{
			instanceId,
			targetContainerName: NAMESPACE_CONTAINER,
			command: { command: ["sh", "-c", sentinelWrappedCommand(command)] },
		},
		{ signal: options?.signal },
	);
	const { stdout, exitCode } = splitSentinelOutput(new TextDecoder().decode(result.stdout));
	return {
		stdout,
		stderr: new TextDecoder().decode(result.stderr),
		...(exitCode === undefined ? {} : { exitCode }),
	};
}

/** Suspended instances remain account resources; only DESTROYED proves absence. */
export function classifyNamespaceStatus(status: Status): SandboxObservation["state"] {
	switch (status) {
		case Status.PENDING:
		case Status.CREATING:
		case Status.RUNNING:
		case Status.SUSPENDING:
		case Status.SUSPENDED:
			return "running";
		case Status.DESTROYING:
		case Status.ERROR:
			return "terminal";
		case Status.DESTROYED:
			return "absent";
		default:
			throw new Error(`Namespace returned an unknown instance status ${status}`);
	}
}
async function describeNamespaceInstance(
	client: NamespaceClient,
	instanceId: string,
	options: DriverOperationOptions,
) {
	try {
		const { metadata } = await client.compute.describeInstance(
			{ instanceId },
			controlOptions(options),
		);
		if (metadata?.instanceId !== instanceId)
			throw new Error("Namespace describe returned no matching instance metadata");
		return metadata;
	} catch (error) {
		if (isNamespaceAbsent(error)) return undefined;
		throw error;
	}
}
export async function observeNamespaceInstance(
	client: NamespaceClient,
	instanceId: string,
	options: DriverOperationOptions = {},
): Promise<SandboxObservation> {
	const metadata = await describeNamespaceInstance(client, instanceId, options);
	return { state: metadata === undefined ? "absent" : classifyNamespaceStatus(metadata.status) };
}
export async function waitForNamespaceRunning(
	client: NamespaceClient,
	instanceId: string,
	options: DriverOperationOptions,
	deadlineMs = NAMESPACE_READY_WAIT_MS,
	intervalMs = NAMESPACE_STATUS_POLL_MS,
) {
	await pollUntilReady({
		provider: "namespace",
		deadlineMs,
		intervalMs,
		signal: options.signal,
		poll: async () => {
			const metadata = await describeNamespaceInstance(client, instanceId, options);
			if (metadata?.status === Status.RUNNING) return true;
			if (metadata?.status === Status.PENDING || metadata?.status === Status.CREATING) return null;
			throw new Error(
				`Namespace instance ${instanceId} cannot reach running from ${metadata?.status ?? "absent"}`,
			);
		},
	});
}
export async function destroyNamespaceInstance(
	client: NamespaceClient,
	instanceId: string,
	options: DriverOperationOptions = {},
	deadlineMs = NAMESPACE_DESTROY_WAIT_MS,
	intervalMs = NAMESPACE_STATUS_POLL_MS,
) {
	try {
		await client.compute.destroyInstance(
			{ instanceId, reason: "sandbox-benchmarks teardown" },
			controlOptions(options),
		);
	} catch (error) {
		if (isNamespaceAbsent(error)) return;
		throw error;
	}
	await pollUntilReady({
		provider: "namespace",
		deadlineMs,
		intervalMs,
		signal: options.signal,
		poll: async () =>
			(await observeNamespaceInstance(client, instanceId, options)).state === "absent"
				? true
				: null,
	});
}

/** Drain the SDK's byte cursors, including completed runs so no retained allocation is hidden. */
export async function listNamespaceInstances(
	client: NamespaceClient,
	options: DriverOperationOptions = {},
): Promise<InstanceMetadata[]> {
	const instances: InstanceMetadata[] = [];
	let paginationCursor: Uint8Array = new Uint8Array();
	const cursors = new Set<string>();
	for (;;) {
		options.signal?.throwIfAborted();
		const page = await client.compute.listInstances(
			{ paginationCursor, maxEntries: 100n, includeCompleteRuns: true },
			controlOptions(options),
		);
		for (const instance of page.instances) {
			if (classifyNamespaceStatus(instance.status) !== "absent") instances.push(instance);
		}
		paginationCursor = page.paginationCursor;
		if (paginationCursor.length === 0) return instances;
		const key = paginationCursor.toBase64();
		if (cursors.has(key)) throw new Error("Namespace inventory repeated a pagination cursor");
		cursors.add(key);
	}
}

export function namespaceSpec(
	{ env, resolvedArtifact }: DriverContext<"namespace">,
	client: NamespaceClient = namespaceClient(env.NSC_TOKEN_FILE),
) {
	const compute = nativeSdkCompute(
		async (options: CreateInstanceRequest, operation) => {
			const response = await client.compute.createInstance(options, controlOptions(operation));
			const { metadata, extendedMetadata } = response;
			if (!metadata?.instanceId || !extendedMetadata?.commandServiceEndpoint)
				throw new Error("Namespace create omitted instance identity or command endpoint");
			return { ...response, metadata, extendedMetadata };
		},
		(native) => {
			const commands = client.command(native.extendedMetadata.commandServiceEndpoint);
			return {
				sandboxId: native.metadata.instanceId,
				runCommand: (command, options) =>
					execNamespaceCommand(commands, native.metadata.instanceId, command, options),
				destroy: () => destroyNamespaceInstance(client, native.metadata.instanceId),
			};
		},
	);
	return computeSdkSpec(compute, {
		sandboxId: NAMESPACE_INSTANCE_ID,
		createOptions: {
			coverage: {
				spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "runtime-verified" },
				artifact: "context",
				deadlineMs: "harness",
				gpu: { model: "unsupported", count: "unsupported" },
				env: "mapped",
			},
			map: (request, unsupported) => {
				if (request.artifact.kind !== "image" || request.artifact.ref !== resolvedArtifact.ref)
					unsupported("request artifact differs from the resolved Namespace image");
				return create(CreateInstanceRequestSchema, {
					shape: {
						virtualCpu: request.spec.vcpus,
						memoryMegabytes: request.spec.memoryGb * 1024,
						machineArch: "amd64",
						os: "linux",
					},
					containers: [
						{
							name: NAMESPACE_CONTAINER,
							imageRef: resolvedArtifact.ref,
							args: ["sleep", "infinity"],
							environment: request.env ?? {},
						},
					],
					documentedPurpose: `${NAMESPACE_PURPOSE_PREFIX}${randomUUID()}`,
					deadline: timestampFromDate(new Date(Date.now() + NAMESPACE_INSTANCE_LIFETIME_MS)),
				});
			},
		},
		commands: {
			exec: (sandbox, command, options) => sandbox.runCommand(command, options),
			launch: async (sandbox, command, options) => {
				const result = await sandbox.runCommand(detachedShellCommand(command), options);
				if (result.exitCode !== 0)
					throw new Error(`Namespace background launch exited ${result.exitCode ?? "unknown"}`);
			},
		},
		lifecycle: {
			destroy: (sandbox, ref, options) =>
				destroyNamespaceInstance(
					client,
					ref?.id ?? sandbox.getInstance().metadata.instanceId,
					options,
				),
		},
		createRecovery: {
			absenceConfirmationMs: 2_000,
			maxAttempts: 4,
			locator: (options) => ({
				kind: "marker",
				key: "documented_purpose",
				value: options.documentedPurpose,
			}),
			isDefinitive: isNamespaceDefinitiveCreateRejection,
			isRetryableCreate: isNamespaceRetryableCreate,
			cleanup: async (_compute, locator, options) => {
				const matches = (await listNamespaceInstances(client, options)).filter(
					(instance) => instance.documentedPurpose === locator.value,
				);
				for (const instance of matches)
					await destroyNamespaceInstance(client, instance.instanceId, options);
				return { status: matches.length === 0 ? "absent" : "destroyed" };
			},
		},
		prepareAndVerifyCreatedRequest: async (sandbox, native, request, options) => {
			await waitForNamespaceRunning(client, native.metadata.instanceId, options);
			if (request.spec.diskGb === undefined) return { status: "honored" };
			const result = await sandbox.runCommand("df -Pk / | awk 'NR==2 {print $2}'", options);
			const capacity = diskCapacitySchema.assert(result.stdout?.trim()) / 1024 / 1024;
			if (result.exitCode !== 0) throw new Error("Namespace disk capacity probe failed");
			return capacity >= request.spec.diskGb
				? { status: "honored" }
				: {
						status: "unsupported",
						detail: `requested ${request.spec.diskGb} GiB but the instance exposes ${capacity.toFixed(2)} GiB`,
					};
		},
		hasWorkingFilesystem: false,
		probes: {
			observe: (_compute, ref) => observeNamespaceInstance(client, ref.id),
			describe: (_compute, ref) =>
				client.compute.describeInstance({ instanceId: ref.id }, controlOptions()),
			list: () => client.compute.listInstances({ maxEntries: 100n }, controlOptions()),
		},
		inventory: {
			list: async (_compute, options) => {
				const owned: string[] = [];
				let foreignCount = 0;
				for (const instance of await listNamespaceInstances(client, options)) {
					if (instance.documentedPurpose.startsWith(NAMESPACE_PURPOSE_PREFIX))
						owned.push(instance.instanceId);
					else foreignCount++;
				}
				return { owned, foreignCount };
			},
		},
		destroyById: (_compute, ref, options) => destroyNamespaceInstance(client, ref.id, options),
	});
}

export default defineComputeSdkDriver("namespace", {
	provenance: NAMESPACE_PROVENANCE,
	readiness: NAMESPACE_READINESS,
	execution: NAMESPACE_EXECUTION,
	createBudget: NAMESPACE_CREATE_BUDGET,
	spec: namespaceSpec,
});
