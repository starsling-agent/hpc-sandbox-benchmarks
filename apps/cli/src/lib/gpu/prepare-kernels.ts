import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { succeeded, writeTextFile } from "@sandbox-benchmarks/driver";
import type { App, Image, ModalClient, Volume } from "modal";
import type { GpuArgs } from "./args.ts";
import { GPU_BENCHMARK, readSource } from "./config.ts";
import { cudaGraphEvidenceFromLog, cudaGraphEvidencePassed } from "./cuda-graphs.ts";
import type { GpuSandbox } from "./modal.ts";
import {
	gpuSandboxResources,
	readGpuFile,
	stageGpuProducer,
	vllmEnvironment,
	withGpuSandbox,
} from "./modal.ts";
import { validateModelAssets } from "./prepare-models.ts";

const registryPointerPath = `${GPU_BENCHMARK.paths.kernelRegistryMount}/current.json`;
const seedManifestPath = `${GPU_BENCHMARK.paths.kernelCache}/seed-manifest.json`;

export function kernelSeedManifest(
	baseImageId: string,
	args: Pick<GpuArgs, "gpu" | "flashinferAutotune">,
) {
	const profileSha256 = createHash("sha256");
	for (const file of ["install.sh", "results-definition.xml", "runner.sh", "test-definition.xml"]) {
		profileSha256
			.update(file)
			.update("\0")
			.update(readSource(`${GPU_BENCHMARK.profile.directory}/${file}`))
			.update("\0");
	}
	return {
		schemaVersion: "3.0" as const,
		modalImageId: baseImageId,
		cudaImage: GPU_BENCHMARK.software.cudaImage,
		pythonVersion: GPU_BENCHMARK.software.python,
		vllmVersion: GPU_BENCHMARK.software.vllm,
		gpu: args.gpu,
		modelSnapshots: [GPU_BENCHMARK.workload.model],
		profileSha256: profileSha256.digest("hex"),
		parallelism: { tensor: 1, pipeline: 1 } as const,
		cudaGraphs: "FULL_AND_PIECEWISE" as const,
		flashinferAutotune: args.flashinferAutotune,
	};
}

export type KernelSeedManifest = ReturnType<typeof kernelSeedManifest>;

function createKernelSnapshotPointer(snapshotImageId: string, seed: KernelSeedManifest) {
	return {
		schemaVersion: "1.0" as const,
		snapshotImageId,
		createdAt: new Date().toISOString(),
		seed,
	};
}

export type KernelSnapshotPointer = ReturnType<typeof createKernelSnapshotPointer>;

const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function kernelSnapshotPointerFromText(
	raw: string,
	expectedSeed: KernelSeedManifest,
): KernelSnapshotPointer | undefined {
	try {
		const pointer = JSON.parse(raw) as Partial<KernelSnapshotPointer>;
		if (
			pointer.schemaVersion !== "1.0" ||
			typeof pointer.snapshotImageId !== "string" ||
			!pointer.snapshotImageId.startsWith("im-") ||
			typeof pointer.createdAt !== "string" ||
			pointer.seed === undefined ||
			encode(pointer.seed) !== encode(expectedSeed)
		) {
			return undefined;
		}
		return pointer as KernelSnapshotPointer;
	} catch {
		return undefined;
	}
}

export async function resolveKernelSnapshot(options: {
	client: ModalClient;
	app: App;
	baseImage: Image;
	registryVolume: Volume;
	registryVolumeName: string;
	args: GpuArgs;
}): Promise<Image | undefined> {
	const expectedSeed = kernelSeedManifest(options.baseImage.imageId, options.args);
	const pointer = await withGpuSandbox(
		{
			client: options.client,
			app: options.app,
			image: options.baseImage,
			options: {
				cpu: 0.25,
				cpuLimit: 1,
				memoryMiB: 128,
				memoryLimitMiB: 512,
				timeoutMs: 5 * 60_000,
				blockNetwork: true,
				volumes: {
					[GPU_BENCHMARK.paths.kernelRegistryMount]: options.registryVolume.withMountOptions({
						readOnly: true,
					}),
				},
			},
		},
		async (registry) => {
			try {
				await registry.session.native.setTags({
					"gpu-benchmark-role": "kernel-snapshot-registry-check",
					"kernel-snapshot-registry-volume": options.registryVolumeName,
				});
				return kernelSnapshotPointerFromText(
					await readGpuFile(registry.session, registryPointerPath),
					expectedSeed,
				);
			} catch {
				// Missing registry state is an ordinary cache miss.
				return undefined;
			}
		},
	);
	if (!pointer) return undefined;

	let candidate: Image;
	try {
		candidate = await options.client.images.fromId(pointer.snapshotImageId);
	} catch {
		return undefined;
	}
	return await withGpuSandbox(
		{
			client: options.client,
			app: options.app,
			image: candidate,
			options: {
				cpu: 0.25,
				cpuLimit: 1,
				memoryMiB: 128,
				memoryLimitMiB: 512,
				timeoutMs: 2 * 60_000,
				blockNetwork: true,
			},
		},
		async (probe) => {
			try {
				await probe.session.native.setTags({
					"gpu-benchmark-role": "kernel-snapshot-check",
					"kernel-snapshot-image": pointer.snapshotImageId,
				});
				const embeddedSeed = await readGpuFile(probe.session, seedManifestPath);
				return embeddedSeed === encode(expectedSeed) ? candidate : undefined;
			} catch {
				return undefined;
			}
		},
	);
}

async function installProfile(sandbox: GpuSandbox): Promise<void> {
	await sandbox.runner.step(
		"install PTS profile",
		[
			`cd ${GPU_BENCHMARK.paths.remoteRoot}`,
			"REPO_ROOT=$PWD",
			"source lib/bench.sh",
			"ensure_pts",
			`install_local_pts_profile ${GPU_BENCHMARK.profile.name}`,
			`phoronix-test-suite batch-install ${GPU_BENCHMARK.profile.id}`,
		].join("\n"),
		20 * 60_000,
	);
}

export async function prepareKernelSnapshot(options: {
	client: ModalClient;
	app: App;
	baseImage: Image;
	modelVolume: Volume;
	modelVolumeName: string;
	registryVolume: Volume;
	registryVolumeName: string;
	args: GpuArgs;
}): Promise<KernelSnapshotPointer> {
	const { args } = options;
	const expectedSeed = kernelSeedManifest(options.baseImage.imageId, args);
	const outputDirectory = resolve(args.outputDirectory);
	mkdirSync(outputDirectory, { recursive: true });
	return withGpuSandbox(
		{
			client: options.client,
			app: options.app,
			image: options.baseImage,
			options: {
				...gpuSandboxResources(args),
				env: vllmEnvironment(args),
				volumes: {
					[GPU_BENCHMARK.paths.modelMount]: options.modelVolume.withMountOptions({
						readOnly: true,
					}),
					[GPU_BENCHMARK.paths.kernelRegistryMount]: options.registryVolume,
				},
			},
		},
		async (sandbox) => {
			await sandbox.session.native.setTags({
				"gpu-benchmark-role": "kernel-cache-seed",
				profile: GPU_BENCHMARK.profile.name,
				gpu: args.gpu,
				"model-volume": options.modelVolumeName,
				"kernel-snapshot-registry-volume": options.registryVolumeName,
			});
			console.error(`Modal GPU kernel-seed sandbox: ${sandbox.session.sandboxRef.id}`);
			await validateModelAssets(sandbox);
			await stageGpuProducer(sandbox);
			await installProfile(sandbox);
			const model = GPU_BENCHMARK.workload.model;
			const seed = await sandbox.runner.step(
				"seed vLLM kernel cache",
				`cd ${GPU_BENCHMARK.paths.remoteRoot} && LOG_FILE=/tmp/vllm-kernel-seed.log bash ${GPU_BENCHMARK.profile.directory}/runner.sh speed-bench --model ${model.repoId} --revision ${model.revision}`,
				Math.max(
					60_000,
					(args.timeoutMinutes - GPU_BENCHMARK.deadlines.artifactReserveMinutes) * 60_000,
				),
				{ allowFailure: true },
			);
			writeFileSync(join(outputDirectory, "kernel-seed.stdout.log"), seed.stdout ?? "");
			writeFileSync(join(outputDirectory, "kernel-seed.stderr.log"), seed.stderr ?? "");
			if (!succeeded(seed.exit))
				throw new Error(`kernel-cache seed exited ${JSON.stringify(seed.exit)}`);
			const serverLog = await readGpuFile(
				sandbox.session,
				`${GPU_BENCHMARK.paths.remoteRoot}/benchmark-results/vllm-native/server.log`,
			);
			writeFileSync(join(outputDirectory, "vllm-server.log"), serverLog);
			const cudaGraphs = cudaGraphEvidenceFromLog(serverLog);
			if (!cudaGraphEvidencePassed(cudaGraphs)) {
				throw new Error("kernel-cache seed reached no verified CUDA-graph capture");
			}
			await writeTextFile(sandbox.session, seedManifestPath, encode(expectedSeed));
			const snapshot = await sandbox.session.native.snapshotFilesystem({
				timeoutMs: 5 * 60_000,
				ttlMs: GPU_BENCHMARK.kernelSnapshotTtlDays * 24 * 60 * 60_000,
			});
			const pointer = createKernelSnapshotPointer(snapshot.imageId, expectedSeed);
			await writeTextFile(sandbox.session, registryPointerPath, encode(pointer));
			return pointer;
		},
	);
}
