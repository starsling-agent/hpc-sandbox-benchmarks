import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { CommandService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/command_pb";
import {
	ComputeService,
	InstanceMetadataSchema,
	InstanceMetadata_Status as Status,
} from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { sandboxRef } from "@sandbox-benchmarks/driver";
import { driverFromComputeSpec } from "@sandbox-benchmarks/driver/computesdk";
import namespaceDriver, {
	classifyNamespaceStatus,
	destroyNamespaceInstance,
	execNamespaceCommand,
	isNamespaceAbsent,
	isNamespaceDefinitiveCreateRejection,
	isNamespaceRetryableCreate,
	listNamespaceInstances,
	NAMESPACE_CONTAINER,
	NAMESPACE_EXIT_SENTINEL,
	NAMESPACE_PURPOSE_PREFIX,
	namespaceClient,
	namespaceSpec,
	observeNamespaceInstance,
	splitSentinelOutput,
	waitForNamespaceRunning,
} from "./index.ts";

const context = {
	env: { NSC_TOKEN_FILE: "/not-read-in-unit-tests" },
	artifact: { kind: "image" },
	resolvedArtifact: { kind: "image", ref: "ghcr.io/example/toolchain:v1" },
} as const;
const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: context.resolvedArtifact,
	deadlineMs: 30_000,
};
const bytes = (text: string) => new TextEncoder().encode(text);
const metadata = (instanceId: string, documentedPurpose = "", status = Status.RUNNING) =>
	create(InstanceMetadataSchema, { instanceId, documentedPurpose, status });

/** Real generated clients and protobuf serialization, with only service behavior replaced. */
function fake(
	compute: Partial<ServiceImpl<typeof ComputeService>> = {},
	command: Partial<ServiceImpl<typeof CommandService>> = {},
) {
	let current = metadata("inst-test", `${NAMESPACE_PURPOSE_PREFIX}attempt`);
	const commands: string[] = [];
	const transport = createRouterTransport(({ service }) => {
		service(ComputeService, {
			createInstance: (input) => {
				current = metadata("inst-test", input.documentedPurpose);
				return {
					metadata: current,
					extendedMetadata: { commandServiceEndpoint: "https://commands.example" },
				};
			},
			describeInstance: () => ({ metadata: current }),
			destroyInstance: () => {
				current = { ...current, status: Status.DESTROYED };
				return {};
			},
			listInstances: () => ({ instances: [current] }),
			...compute,
		});
		service(CommandService, {
			runCommandSync: (input) => {
				expect(input.targetContainerName).toBe(NAMESPACE_CONTAINER);
				const shell = input.command?.command[2] ?? "";
				commands.push(shell);
				const output = shell.includes("df -Pk") ? `${80 * 1024 * 1024}\n` : "";
				return { stdout: bytes(`${output}\n${NAMESPACE_EXIT_SENTINEL}0\n`) };
			},
			...command,
		});
	});
	const client = {
		compute: createClient(ComputeService, transport),
		command: (_endpoint: string) => createClient(CommandService, transport),
	};
	const spec = namespaceSpec(context, client);
	return {
		client,
		spec,
		commands,
		driver: driverFromComputeSpec("namespace", spec, context.resolvedArtifact, []),
	};
}

describe("Namespace SDK driver", () => {
	test("maps the canonical request into protobuf and retains exact ownership in recovery", () => {
		const { spec } = fake();
		const mapped = spec.createOptions.map({ ...request, env: { HELLO: "world" } }, (message) => {
			throw new Error(message);
		});
		expect(mapped.$typeName).toBe("namespace.cloud.compute.v1beta.CreateInstanceRequest");
		expect(mapped.shape).toMatchObject({
			virtualCpu: 4,
			memoryMegabytes: 8192,
			machineArch: "amd64",
			os: "linux",
		});
		expect(mapped.containers[0]).toMatchObject({
			imageRef: context.resolvedArtifact.ref,
			environment: { HELLO: "world" },
		});
		expect(mapped.documentedPurpose.startsWith(NAMESPACE_PURPOSE_PREFIX)).toBe(true);
		expect(spec.createRecovery?.locator(mapped)).toEqual({
			kind: "marker",
			key: "documented_purpose",
			value: mapped.documentedPurpose,
		});
		expect(namespaceDriver.provenance.packageName).toBe("@namespacelabs/sdk");
	});

	test("creates, verifies disk, executes, launches detached work, and destroys twice", async () => {
		const { driver, commands } = fake();
		const session = await driver.create(request);
		expect(session.native.metadata.instanceId).toBe("inst-test");
		expect((await session.exec("true")).exit).toEqual({ kind: "exited", code: 0 });
		await session.launch?.("sleep 65");
		expect(commands.at(-1)).toContain("nohup");
		expect(commands.at(-1)).toContain("sleep 65");
		await session.destroy();
		await session.destroy();
		expect(await driver.probes?.observe(session.sandboxRef)).toEqual({ state: "absent" });
	});

	test("rejects artifact drift before allocating and cleans an undersized guest", async () => {
		let creates = 0;
		const drift = fake({
			createInstance: () => {
				creates++;
				throw new Error("must not allocate");
			},
		});
		await expect(
			drift.driver.create({ ...request, artifact: { kind: "image", ref: "wrong" } }),
		).rejects.toMatchObject({ code: "invalid-create-request" });
		expect(creates).toBe(0);
		const undersized = fake(
			{},
			{ runCommandSync: () => ({ stdout: bytes(`1024\n\n${NAMESPACE_EXIT_SENTINEL}0\n`) }) },
		);
		await expect(undersized.driver.create(request)).rejects.toMatchObject({
			code: "invalid-create-request",
		});
		expect(await observeNamespaceInstance(undersized.client, "inst-test")).toEqual({
			state: "absent",
		});
	});

	test("preserves UTF-8, split streams, and actual nonzero exits; a missing trailer stays unknown", async () => {
		const { client } = fake(
			{},
			{
				runCommandSync: () => ({
					stdout: bytes(`héllo\n${NAMESPACE_EXIT_SENTINEL}7\n`),
					stderr: bytes("bad €"),
					exitCode: 1,
				}),
			},
		);
		expect(await execNamespaceCommand(client.command(""), "inst-test", "exit 7")).toEqual({
			stdout: "héllo",
			stderr: "bad €",
			exitCode: 7,
		});
		expect(splitSentinelOutput("no trailer")).toEqual({
			stdout: "no trailer",
			exitCode: undefined,
		});
		expect(splitSentinelOutput(`x\n${NAMESPACE_EXIT_SENTINEL}999\n`).exitCode).toBeUndefined();
		const missing = fake({}, { runCommandSync: () => ({ stdout: bytes("partial"), exitCode: 0 }) });
		expect(
			await execNamespaceCommand(missing.client.command(""), "inst-test", "true"),
		).not.toHaveProperty("exitCode");
	});

	test("uses generated lifecycle enums, including CREATING and retained suspended instances", () => {
		for (const status of [
			Status.PENDING,
			Status.CREATING,
			Status.RUNNING,
			Status.SUSPENDING,
			Status.SUSPENDED,
		])
			expect(classifyNamespaceStatus(status)).toBe("running");
		expect(classifyNamespaceStatus(Status.DESTROYING)).toBe("terminal");
		expect(classifyNamespaceStatus(Status.ERROR)).toBe("terminal");
		expect(classifyNamespaceStatus(Status.DESTROYED)).toBe("absent");
		expect(() => classifyNamespaceStatus(Status.STATUS_UNKNOWN)).toThrow("unknown instance status");
	});

	test("waits through CREATING, rejects lost/mismatched instances, and honors cancellation", async () => {
		let calls = 0;
		const { client } = fake({
			describeInstance: () => ({
				metadata: metadata("inst-test", "", ++calls === 1 ? Status.CREATING : Status.RUNNING),
			}),
		});
		await waitForNamespaceRunning(client, "inst-test", {}, 1000, 0);
		expect(calls).toBe(2);
		const mismatch = fake({ describeInstance: () => ({ metadata: metadata("someone-else") }) });
		await expect(observeNamespaceInstance(mismatch.client, "inst-test")).rejects.toThrow(
			"matching instance",
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			waitForNamespaceRunning(client, "inst-test", { signal: controller.signal }, 1000, 0),
		).rejects.toThrow();
	});

	test("waits for DESTROYED and surfaces teardown/auth errors", async () => {
		let calls = 0;
		const delayed = fake({
			describeInstance: () => ({
				metadata: metadata("inst-test", "", ++calls < 3 ? Status.DESTROYING : Status.DESTROYED),
			}),
		});
		await destroyNamespaceInstance(delayed.client, "inst-test", {}, 1000, 0);
		expect(calls).toBe(3);
		const denied = fake({
			destroyInstance: () => {
				throw new ConnectError("denied", Code.PermissionDenied);
			},
		});
		await expect(
			denied.driver.destroyById?.(sandboxRef("namespace", "inst-test")),
		).rejects.toMatchObject({ code: "destroy-failed" });
		const gone = fake({
			destroyInstance: () => {
				throw new ConnectError("gone", Code.NotFound);
			},
		});
		await destroyNamespaceInstance(gone.client, "inst-test");
	});

	test("drains byte cursors and counts unmarked, suspended, and error records as account resources", async () => {
		const cursors: number[] = [];
		const { driver } = fake({
			listInstances: (input) => {
				expect(input.includeCompleteRuns).toBe(true);
				cursors.push(input.paginationCursor[0] ?? 0);
				return input.paginationCursor.length === 0
					? {
							instances: [
								metadata("owned", `${NAMESPACE_PURPOSE_PREFIX}x`),
								metadata("foreign", "", Status.SUSPENDED),
							],
							paginationCursor: new Uint8Array([1]),
						}
					: {
							instances: [
								metadata("dead", "", Status.DESTROYED),
								metadata("error", "", Status.ERROR),
							],
						};
			},
		});
		expect(await driver.inventory?.list()).toEqual({
			owned: [{ provider: "namespace", id: "owned" }],
			foreignCount: 2,
		});
		expect(cursors).toEqual([0, 1]);
	});

	test("rejects repeated cursors and a failed later page without returning partial inventory", async () => {
		const repeated = fake({ listInstances: () => ({ paginationCursor: new Uint8Array([1]) }) });
		await expect(listNamespaceInstances(repeated.client)).rejects.toThrow(
			"repeated a pagination cursor",
		);
		let calls = 0;
		const partial = fake({
			listInstances: () => {
				if (++calls > 1) throw new ConnectError("unavailable", Code.Unavailable);
				return {
					instances: [metadata("owned", `${NAMESPACE_PURPOSE_PREFIX}x`)],
					paginationCursor: new Uint8Array([1]),
				};
			},
		});
		await expect(partial.driver.inventory?.list()).rejects.toMatchObject({ code: "probe-failed" });
	});

	test("recovery deletes only the exact attempt marker", async () => {
		const destroyed: string[] = [];
		const { spec } = fake({
			listInstances: () => ({
				instances: [
					metadata("ours", `${NAMESPACE_PURPOSE_PREFIX}attempt`),
					metadata("other", `${NAMESPACE_PURPOSE_PREFIX}another`),
				],
			}),
			destroyInstance: (input) => {
				destroyed.push(input.instanceId);
				return {};
			},
			describeInstance: (input) => ({ metadata: metadata(input.instanceId, "", Status.DESTROYED) }),
		});
		expect(
			await spec.createRecovery?.cleanup(
				spec.compute,
				{ kind: "marker", key: "documented_purpose", value: `${NAMESPACE_PURPOSE_PREFIX}attempt` },
				{},
			),
		).toEqual({ status: "destroyed" });
		expect(destroyed).toEqual(["ours"]);
	});

	test("classifies only Connect's typed codes", () => {
		expect(isNamespaceAbsent(new ConnectError("gone", Code.NotFound))).toBe(true);
		for (const code of [Code.InvalidArgument, Code.Unauthenticated, Code.PermissionDenied])
			expect(isNamespaceDefinitiveCreateRejection(new ConnectError("refused", code))).toBe(true);
		expect(isNamespaceRetryableCreate(new ConnectError("capacity", Code.ResourceExhausted))).toBe(
			true,
		);
		expect(isNamespaceAbsent(new Error("HTTP 404 not_found"))).toBe(false);
		expect(isNamespaceDefinitiveCreateRejection(new ConnectError("lost", Code.Unavailable))).toBe(
			false,
		);
	});

	test("the SDK transport uses the explicit token file and retries a failed lazy read", async () => {
		const directory = await mkdtemp(join(tmpdir(), "namespace-sdk-"));
		const tokenFile = join(directory, "token.json");
		const authorization: (string | null)[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => {
				authorization.push(request.headers.get("authorization"));
				return Response.json({ instances: [] });
			},
		});
		try {
			const client = namespaceClient(tokenFile, server.url.toString());
			await expect(client.compute.listInstances({})).rejects.toThrow();
			await Bun.write(tokenFile, JSON.stringify({ bearer_token: "test-bearer" }));
			expect((await client.compute.listInstances({})).instances).toEqual([]);
			expect(authorization).toEqual(["Bearer test-bearer"]);
		} finally {
			await server.stop(true);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
