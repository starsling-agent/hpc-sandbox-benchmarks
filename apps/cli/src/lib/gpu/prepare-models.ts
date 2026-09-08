import { writeTextFile } from "@sandbox-benchmarks/driver";
import type { App, Image, ModalClient, Volume } from "modal";
import { GPU_BENCHMARK, MODEL_CACHE_ENV, readSource } from "./config.ts";
import type { GpuSandbox } from "./modal.ts";
import { withGpuSandbox } from "./modal.ts";

const REMOTE_SCRIPT = "/tmp/prepare-gpu-models.py";
const REMOTE_CONFIG = "/tmp/gpu-benchmark-assets.json";

export function modelAssetConfig() {
	return {
		model: GPU_BENCHMARK.workload.model,
		speedBench: GPU_BENCHMARK.assets.speedBench,
		paths: {
			modelMount: GPU_BENCHMARK.paths.modelMount,
			modelCache: `${GPU_BENCHMARK.paths.modelCache}/hub`,
			speedBench: GPU_BENCHMARK.paths.speedBench,
		},
	};
}

async function stageModelPreparation(sandbox: GpuSandbox): Promise<void> {
	await Promise.all([
		writeTextFile(
			sandbox.session,
			REMOTE_SCRIPT,
			readSource("apps/cli/src/lib/gpu/prepare-models.py"),
		),
		writeTextFile(
			sandbox.session,
			REMOTE_CONFIG,
			`${JSON.stringify(modelAssetConfig(), null, 2)}\n`,
		),
	]);
}

async function runModelPreparation(
	sandbox: GpuSandbox,
	mode: "download" | "check",
	timeoutMs: number,
): Promise<void> {
	await stageModelPreparation(sandbox);
	await sandbox.runner.step(
		`${mode === "download" ? "prepare" : "validate"} model assets`,
		`${GPU_BENCHMARK.paths.vllmEnvironment}/bin/python ${REMOTE_SCRIPT} ${mode} ${REMOTE_CONFIG}`,
		timeoutMs,
	);
}

export async function validateModelAssets(sandbox: GpuSandbox): Promise<void> {
	await runModelPreparation(sandbox, "check", 5 * 60_000);
}

export async function prepareModelAssets(options: {
	client: ModalClient;
	app: App;
	image: Image;
	volume: Volume;
	volumeName: string;
	cpu: number;
	cpuLimit: number;
	timeoutMinutes: number;
}): Promise<void> {
	await withGpuSandbox(
		{
			client: options.client,
			app: options.app,
			image: options.image,
			options: {
				cpu: options.cpu,
				cpuLimit: options.cpuLimit,
				memoryMiB: GPU_BENCHMARK.modelPreparation.memoryMiB,
				memoryLimitMiB: GPU_BENCHMARK.modelPreparation.memoryLimitMiB,
				timeoutMs: options.timeoutMinutes * 60_000,
				env: { ...MODEL_CACHE_ENV },
				volumes: { [GPU_BENCHMARK.paths.modelMount]: options.volume },
			},
		},
		async (sandbox) => {
			await sandbox.session.native.setTags({
				"gpu-benchmark-role": "model-cache",
				"model-volume": options.volumeName,
			});
			console.error(`Modal model-cache sandbox: ${sandbox.session.sandboxRef.id}`);
			await runModelPreparation(
				sandbox,
				"download",
				Math.max(60_000, options.timeoutMinutes * 60_000 - 60_000),
			);
		},
	);
	// Modal Volume v1 commits its final state during the scoped sandbox termination above.
}
