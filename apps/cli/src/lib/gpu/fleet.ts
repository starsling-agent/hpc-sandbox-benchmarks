import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { succeeded } from "@sandbox-benchmarks/driver";
import { collectResults } from "@sandbox-benchmarks/harness";
import type { App, Image, ModalClient, Volume } from "modal";
import { installLineTagging, withLineTag } from "../log-prefix.ts";
import { runPooled } from "../replicates.ts";
import type { GpuArgs } from "./args.ts";
import { GPU_BENCHMARK } from "./config.ts";
import { cudaGraphEvidenceFromLog, cudaGraphEvidencePassed } from "./cuda-graphs.ts";
import {
	gpuSandboxResources,
	observeGpuSandbox,
	stageCollectedEvidence,
	stageGpuProducer,
	vllmEnvironment,
	withGpuSandbox,
} from "./modal.ts";
import { validateModelAssets } from "./prepare-models.ts";
import type { GpuFleetFailure, GpuFleetReplicate } from "./report.ts";
import { createGpuBenchmarkMetadata, renderGpuFleetReport } from "./report.ts";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const errorDetail = (error: unknown): string =>
	error instanceof Error ? (error.stack ?? error.message) : String(error);

function writeReport(
	outputDirectory: string,
	report: ReturnType<typeof renderGpuFleetReport>,
): void {
	const assetsDirectory = join(outputDirectory, "assets");
	mkdirSync(assetsDirectory, { recursive: true });
	for (const [file, svg] of report.assets) writeFileSync(join(assetsDirectory, file), svg);
	writeFileSync(join(outputDirectory, "report.md"), report.markdown);
	writeJson(join(outputDirectory, "fleet-summary.json"), report.summary);
}

async function runGpuReplicate(options: {
	client: ModalClient;
	app: App;
	baseImage: Image;
	kernelImage: Image;
	modelVolume: Volume;
	args: GpuArgs;
	index: number;
	outputRoot: string;
}): Promise<GpuFleetReplicate> {
	const { args, index } = options;
	const outputDirectory = join(options.outputRoot, "replicates", `r${index}`);
	mkdirSync(outputDirectory, { recursive: true });
	const startedAt = new Date();
	return withGpuSandbox(
		{
			client: options.client,
			app: options.app,
			image: options.kernelImage,
			options: {
				...gpuSandboxResources(args),
				env: vllmEnvironment(args),
				volumes: {
					[GPU_BENCHMARK.paths.modelMount]: options.modelVolume.withMountOptions({
						readOnly: true,
					}),
				},
			},
		},
		async (sandbox) => {
			await sandbox.session.native.setTags({
				"gpu-benchmark-role": "benchmark-replicate",
				"gpu-benchmark-replicate": String(index),
				profile: GPU_BENCHMARK.profile.name,
				gpu: args.gpu,
				"model-volume": args.modelVolume,
				"kernel-snapshot-image": options.kernelImage.imageId,
			});
			console.error(`Modal GPU sandbox r${index}: ${sandbox.session.sandboxRef.id}`);
			await validateModelAssets(sandbox);
			await stageGpuProducer(sandbox);
			sandbox.runner.phase = "benchmark";
			const benchmark = await sandbox.runner.step(
				`run ${GPU_BENCHMARK.profile.id}`,
				`cd ${GPU_BENCHMARK.paths.remoteRoot} && bash ${GPU_BENCHMARK.task}`,
				Math.max(
					60_000,
					(args.timeoutMinutes - GPU_BENCHMARK.deadlines.artifactReserveMinutes) * 60_000,
				),
				{ allowFailure: true },
			);
			writeFileSync(join(outputDirectory, "benchmark.stdout.log"), benchmark.stdout ?? "");
			writeFileSync(join(outputDirectory, "benchmark.stderr.log"), benchmark.stderr ?? "");
			const artifactErrors: unknown[] = [];
			try {
				await stageCollectedEvidence(sandbox);
			} catch (error) {
				artifactErrors.push(error);
			}
			try {
				await collectResults(sandbox.runner, outputDirectory);
			} catch (error) {
				artifactErrors.push(error);
			}
			if (!succeeded(benchmark.exit)) {
				if (artifactErrors.length > 0) {
					console.error(
						`Artifact collection also failed after the PTS workload exited ${JSON.stringify(benchmark.exit)}: ${artifactErrors.map(errorDetail).join("; ")}`,
					);
				}
				throw new Error(
					`PTS vLLM workload exited ${JSON.stringify(benchmark.exit)}; partial artifacts were retained`,
				);
			}
			if (artifactErrors.length > 0) {
				throw new AggregateError(artifactErrors, "GPU benchmark artifact collection failed");
			}

			const xmlPath = join(outputDirectory, `${GPU_BENCHMARK.profile.resultPrefix}.xml`);
			const serverLogPath = join(outputDirectory, "vllm-native", "server.log");
			const cudaGraphs = cudaGraphEvidenceFromLog(readFileSync(serverLogPath, "utf8"));
			const observed = await observeGpuSandbox(sandbox);
			const finishedAt = new Date();
			const metadata = createGpuBenchmarkMetadata({
				args,
				replicateIndex: index,
				baseImageId: options.baseImage.imageId,
				kernelSnapshotImageId: options.kernelImage.imageId,
				sandboxId: sandbox.session.sandboxRef.id,
				startedAt,
				finishedAt,
				cudaGraphs,
				observed,
			});
			writeJson(join(outputDirectory, "metadata.json"), metadata);
			if (!cudaGraphEvidencePassed(cudaGraphs)) {
				throw new Error("vLLM completed without complete CUDA-graph evidence");
			}
			return { index, xml: readFileSync(xmlPath, "utf8"), metadata };
		},
		{ path: join(outputDirectory, "lifecycle.json"), replicateIndex: index },
	);
}

type FleetOutcome =
	| { replicate: GpuFleetReplicate; failure?: never }
	| { replicate?: never; failure: GpuFleetFailure };

export async function runGpuFleet(options: {
	client: ModalClient;
	app: App;
	baseImage: Image;
	kernelImage: Image;
	modelVolume: Volume;
	args: GpuArgs;
}): Promise<void> {
	const indices = options.args.replicateIndices;
	if (!indices) throw new Error("benchmark execution requires a replicate plan");
	const outputRoot = resolve(options.args.outputDirectory);
	for (const entry of [
		"replicates",
		"assets",
		"report.md",
		"fleet-summary.json",
		"replicate-outcomes.json",
	]) {
		rmSync(join(outputRoot, entry), { recursive: true, force: true });
	}
	mkdirSync(outputRoot, { recursive: true });
	if (indices.length > 1) installLineTagging();
	const outcomes = await runPooled<number, FleetOutcome>(
		indices,
		options.args.maxConcurrency,
		(index) =>
			withLineTag(`[r${index}] `, async () => ({
				replicate: await runGpuReplicate({ ...options, index, outputRoot }),
			})),
		(error, index) => {
			const outputDirectory = join(outputRoot, "replicates", `r${index}`);
			mkdirSync(outputDirectory, { recursive: true });
			const failure = {
				index,
				outputDirectory,
				detail: errorDetail(error),
			};
			writeJson(join(outputDirectory, "failure.json"), failure);
			return { failure };
		},
	);
	const completed = outcomes.flatMap(({ replicate }) => (replicate ? [replicate] : []));
	const failures = outcomes.flatMap(({ failure }) => (failure ? [failure] : []));
	writeJson(join(outputRoot, "replicate-outcomes.json"), {
		requested: indices,
		completed: completed.map(({ index, metadata }) => ({
			index,
			sandboxId: metadata.sandboxId,
			durationSeconds: metadata.durationSeconds,
		})),
		failures,
	});
	if (completed.length === 0) throw new Error(`all ${indices.length} GPU replicates failed`);
	const report = renderGpuFleetReport({
		replicates: completed,
		failures,
		requestedReplicates: indices.length,
		precisionTarget: options.args.precisionTarget,
		durationTargetSeconds: options.args.durationTargetSeconds,
	});
	writeReport(outputRoot, report);
	if (failures.length > 0) {
		throw new Error(`${failures.length}/${indices.length} GPU replicates failed`);
	}
	if (options.args.requirePrecision && !report.summary.primaryPrecisionPassed) {
		throw new Error(
			`95% output-token-throughput interval exceeded the ${(options.args.precisionTarget * 100).toFixed(2)}% relative half-width target`,
		);
	}
	if (options.args.requireDuration && !report.summary.durationPassed) {
		throw new Error(
			`one or more GPU replicates exceeded the ${options.args.durationTargetSeconds}-second target`,
		);
	}
}
