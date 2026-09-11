// Prepared Modal resources for GPU work use the stable V1 gVisor backend. Neither the VM
// runtime nor the V2 service supports GPUs. Resource handles stay typed by the pinned SDK.
import { randomUUID } from "node:crypto";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { nvidiaAccelerator } from "@sandbox-benchmarks/driver";
import { computeSdkSpec, driverFromComputeSpec } from "@sandbox-benchmarks/driver/computesdk";
import { nativeSdkCompute } from "@sandbox-benchmarks/driver/native";
import { type } from "arktype";
import type { App, Image, SandboxCreateParams } from "modal";
import { ModalClient, Sandbox } from "modal";
import type { ClientMiddleware } from "nice-grpc";
import { MODAL_NATIVE_PROVENANCE } from "./provenance.ts";
import {
	createModalControlRunner,
	execModalCommand,
	launchModalCommand,
	MODAL_V1_SANDBOX_ID,
	modalControlPlane,
	modalCreateRecovery,
	modalLifecycle,
	modalProbes,
	modalProcessResult,
} from "./shared.ts";

export type ModalAllocationOptions = Required<
	Pick<SandboxCreateParams, "cpu" | "cpuLimit" | "memoryMiB" | "memoryLimitMiB" | "timeoutMs">
> &
	Pick<SandboxCreateParams, "gpu" | "env" | "volumes" | "blockNetwork">;

export interface ModalAllocationConfiguration {
	readonly client: ModalClient;
	readonly app: App;
	/** A built or restored SDK image; its imageId is the truthful artifact identity. */
	readonly image: Image;
	readonly options: ModalAllocationOptions;
}

const namedCreate = type({ name: "string >= 1" });

/** Resolve native configuration to one canonical request and a driver with ordinary sessions. */
export function createModalAllocation(configuration: ModalAllocationConfiguration) {
	const { app, image, client } = configuration;
	if (!app.name)
		throw new Error("Modal allocation requires a named app for failed-create recovery");
	const appName = app.name;
	const imageId = image.imageId;
	if (!imageId) throw new Error("Modal allocation requires a built image");
	const params = { ...configuration.options };
	if (params.env) params.env = { ...params.env };
	if (params.volumes) params.volumes = { ...params.volumes };
	const gpu = params.gpu?.match(/^([^:]+)(?::([1-9][0-9]*))?$/);
	if (params.gpu !== undefined && !gpu) throw new Error("Invalid Modal GPU reservation");
	const request = {
		spec: { vcpus: params.cpu, memoryGb: params.memoryMiB / 1024 },
		artifact: { kind: "built", ref: imageId },
		...(params.env === undefined ? {} : { env: params.env }),
		...(gpu === undefined || gpu === null
			? {}
			: { gpu: { model: gpu[1] ?? "", count: Number(gpu[2] ?? 1) } }),
	} satisfies Omit<CreateRequest, "deadlineMs">;
	const createClient = (middleware: ClientMiddleware) =>
		new ModalClient({
			tokenId: client.profile.tokenId,
			tokenSecret: client.profile.tokenSecret,
			endpoint: client.profile.serverUrl,
			environment: client.profile.environment,
			grpcMiddleware: [middleware],
		});
	const control = createModalControlRunner((middleware) =>
		modalControlPlane(createClient(middleware)),
	);
	const allocation = createModalControlRunner(createClient, 300_000);
	const compute = nativeSdkCompute(
		(options: typeof namedCreate.infer, operation) =>
			allocation.run(operation, async (sdk) => {
				// Reattach the already-built image through this transaction's client so its RPCs share
				// cancellation. App and volume handles are resolved inputs, not guest-owned resources.
				const prepared = await sdk.images.fromId(imageId);
				const created = await sdk.sandboxes.create(app, prepared, {
					...params,
					name: options.name,
				});
				// Allocation middleware belongs only to the create transaction. Native SDK work
				// uses the caller-owned client; driver operations attach their own deadlines.
				return new Sandbox(client, created.sandboxId, { isV2: false });
			}),
		(native) => ({
			sandboxId: native.sandboxId,
			runCommand: async (command: string) =>
				modalProcessResult(
					await native.exec(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" }),
					() => native.detach(),
				),
			destroy: () => native.terminate({ wait: true }),
		}),
	);
	const lifecycle = modalLifecycle<typeof compute>("v1", control, appName);
	const listRunner = createModalControlRunner(createClient, 15_000);
	const spec = computeSdkSpec(compute, {
		sandboxId: { fromVendor: MODAL_V1_SANDBOX_ID, canonical: MODAL_V1_SANDBOX_ID },
		createOptions: {
			coverage: {
				spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: "unsupported" },
				artifact: "context",
				deadlineMs: "harness",
				gpu: { model: "mapped", count: "mapped" },
				env: "mapped",
			},
			map: (input, unsupported) => {
				if (
					input.spec.vcpus !== request.spec.vcpus ||
					input.spec.memoryGb !== request.spec.memoryGb ||
					input.gpu?.model !== request.gpu?.model ||
					input.gpu?.count !== request.gpu?.count
				)
					unsupported("request differs from the configured Modal allocation");
				const env = input.env ?? {};
				const configuredEnv = request.env ?? {};
				if (
					Object.keys(env).length !== Object.keys(configuredEnv).length ||
					Object.entries(env).some(([key, value]) => value !== configuredEnv[key])
				)
					unsupported("request environment differs from the configured Modal allocation");
				return { name: `benchmark-${randomUUID()}` };
			},
		},
		commands: {
			launch: (sandbox, command, options, ref) =>
				launchModalCommand(control, sandbox, command, ref, options),
			exec: (sandbox, command, options, ref) =>
				execModalCommand(control, sandbox, command, ref, options),
		},
		lifecycle: {
			destroy: async (sandbox, ref, options, locator) => {
				await lifecycle.destroy(sandbox, ref, options, locator);
				if (ref === undefined) return;
				for (let attempt = 0; attempt < 5; attempt++) {
					const listed = await listRunner.run(options, async (sdk) => {
						for await (const candidate of sdk.sandboxes.list()) {
							if (candidate.sandboxId === ref.id) return true;
						}
						return false;
					});
					if (!listed) return;
					await Bun.sleep(1000);
				}
				throw new Error(`Modal sandbox ${ref.id} is still listed after termination`);
			},
		},
		createRecovery: modalCreateRecovery<typeof compute>("v1", control, appName),
		hasWorkingFilesystem: false,
		probes: modalProbes<typeof compute>(control),
	});
	const driver = driverFromComputeSpec(
		"modal-gvisor",
		spec,
		request.artifact,
		[client.profile.tokenId, client.profile.tokenSecret].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		),
	);
	return {
		module: {
			id: "modal-gvisor" as const,
			provenance: MODAL_NATIVE_PROVENANCE,
			createBudget: { owner: "harness" as const, timeoutMs: 300_000 },
			readiness: { startup: "create-returns-ready" as const },
			execution: { syncCapMs: null, durable: "none" as const },
			...(request.gpu === undefined ? {} : { accelerator: nvidiaAccelerator }),
			driver: () => driver,
		},
		driver,
		request,
	};
}
