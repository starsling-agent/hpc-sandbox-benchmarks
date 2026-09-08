import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseGpuArgs } from "./args.ts";
import {
	GPU_BENCHMARK,
	GPU_RUNTIME_IMAGE_COMMANDS,
	KERNEL_CACHE_ENV,
	MODAL_GPU_ENV,
	MODEL_CACHE_ENV,
	MODEL_OFFLINE_ENV,
	PYTHON_ENVIRONMENT_COMMAND,
	readSource,
	VLLM_IMAGE_COMMANDS,
} from "./config.ts";
import { cudaGraphEvidenceFromLog } from "./cuda-graphs.ts";
import { gpuSandboxResources, vllmEnvironment } from "./modal.ts";
import { kernelSeedManifest, kernelSnapshotPointerFromText } from "./prepare-kernels.ts";
import { modelAssetConfig } from "./prepare-models.ts";

describe("vLLM image", () => {
	test("lets vLLM own its dependency stack on the CUDA development base", () => {
		const commands = [...VLLM_IMAGE_COMMANDS, ...GPU_RUNTIME_IMAGE_COMMANDS].join("\n");
		expect(commands).toContain("'vllm[bench]==0.26.0'");
		expect(commands).toContain("uv==0.12.3");
		expect(commands).toContain("hf-xet==1.5.2");
		expect(commands).toContain("<NoInternetCommunication>TRUE</NoInternetCommunication>");
		expect(commands).toContain("<NoNetworkCommunication>TRUE</NoNetworkCommunication>");
		expect(GPU_BENCHMARK.software.cudaImage).toContain(
			"nvidia/cuda:13.3.1-devel-ubuntu24.04@sha256:",
		);
		expect(commands).toContain("CUDACXX=/usr/local/cuda/bin/nvcc");
		expect(commands).toContain("uv python install 3.13.14");
		expect(commands).toContain("phoronix-test-suite_10.8.4_all.deb");
		expect(commands).not.toContain("cuda:12.9");
		expect(commands).not.toMatch(/(?:^|\s)(?:torch|transformers|torchaudio|datasets|pyarrow)==/);
		expect(commands).not.toContain("--torch-backend");
		expect(VLLM_IMAGE_COMMANDS.join("\n")).not.toContain("hf-xet==");
		expect(GPU_RUNTIME_IMAGE_COMMANDS.join("\n")).toContain("hf-xet==1.5.2");
	});
});

describe("parseGpuArgs", () => {
	test("defaults to one qualification replicate", () => {
		expect(parseGpuArgs([])).toMatchObject({
			operation: "benchmark",
			gpu: GPU_BENCHMARK.defaults.gpu,
			modelVolume: GPU_BENCHMARK.volumes.models,
			kernelSnapshotRegistryVolume: GPU_BENCHMARK.volumes.kernelRegistry,
			cpuRequested: 4,
			cpuLimit: 4,
			memoryRequestedMiB: 512,
			memoryLimitMiB: 8192,
			mode: "qualification",
			timeoutMinutes: 45,
			clientTimeoutMinutes: 10,
			flashinferAutotune: "disabled",
			replicateIndices: [0],
			maxConcurrency: Number.POSITIVE_INFINITY,
			requirePrecision: false,
			precisionTarget: GPU_BENCHMARK.defaults.relativeCiHalfWidth,
		});
	});

	test("reuses the shared replicate plan and enforces confirmatory gates", () => {
		const indices = Array.from(
			{ length: GPU_BENCHMARK.defaults.minimumReplicates },
			(_, index) => index,
		);
		expect(parseGpuArgs(["--require-precision", "--require-duration"])).toMatchObject({
			replicateIndices: indices,
			maxConcurrency: Number.POSITIVE_INFINITY,
			requirePrecision: true,
			requireDuration: true,
		});
		expect(() => parseGpuArgs(["--replicates", "[0,1,2]", "--require-precision"])).toThrow(
			`at least ${GPU_BENCHMARK.defaults.minimumReplicates}`,
		);
	});

	test("uses one explicit preparation operation", () => {
		expect(parseGpuArgs(["--prepare", "models"])).toMatchObject({
			operation: "models",
			timeoutMinutes: 240,
			replicateIndices: undefined,
		});
		expect(parseGpuArgs(["--prepare", "kernels"])).toMatchObject({
			operation: "kernels",
			timeoutMinutes: 90,
			cudaBuildJobs: 8,
			nvccThreads: 4,
		});
		expect(() => parseGpuArgs(["--prepare", "models", "--replicates", "[0]"])).toThrow(
			"--replicates is supported only for benchmark execution",
		);
		expect(() => parseGpuArgs(["--prepare", "other"])).toThrow(
			"--prepare must be models or kernels",
		);
		expect(() => parseGpuArgs(["--prepare="])).toThrow("--prepare must be models or kernels");
	});

	test("validates modes and resource limits", () => {
		expect(parseGpuArgs(["--mode", "full"])).toMatchObject({
			mode: "full",
			timeoutMinutes: 240,
			clientTimeoutMinutes: 180,
		});
		expect(() => parseGpuArgs(["--mode", "unknown"])).toThrow(
			"--mode must be qualification or full",
		);
		expect(() =>
			parseGpuArgs(["--mode", "full", "--timeout-minutes", "19", "--client-timeout-minutes", "10"]),
		).toThrow("--timeout-minutes must be at least 20");
		expect(() => parseGpuArgs(["--cpu", "5", "--cpu-limit", "4"])).toThrow(
			"--cpu cannot exceed --cpu-limit",
		);
		expect(() => parseGpuArgs(["--memory-limit-mib", "8192.5"])).toThrow(
			"--memory-limit-mib must be a positive integer",
		);
		expect(() => parseGpuArgs(["--required-precision"])).toThrow(
			"unknown argument: --required-precision",
		);
		expect(() => parseGpuArgs(["positional"])).toThrow("unknown argument: positional");
	});
});

describe("fixed workload", () => {
	const script = readSource("apps/cli/src/lib/gpu/prepare-models.py");
	const assets = modelAssetConfig();

	test("pins the profile and asset preparation from one config", () => {
		const profileDirectory = new URL(
			"../../../../../packages/schema/src/pts-profiles/local/vllm-speed-bench-1.0.0/",
			import.meta.url,
		);
		const profile = readFileSync(new URL("test-definition.xml", profileDirectory), "utf8");
		const model = GPU_BENCHMARK.workload.model;
		expect(profile).toContain(`--model ${model.repoId} --revision ${model.revision}`);
		expect(profile).toContain(GPU_BENCHMARK.workload.label);
		expect(profile).toContain("--dataset-name speed_bench");
		expect(profile).toContain("--speed-bench-category coding");
		expect(profile).toContain("Qualification (1 prompt x 16 output tokens)");
		expect(profile).toContain("Full (80 prompts x 1024 output tokens)");

		expect(assets.model).toEqual(model);
		expect(assets.speedBench.prepare.url).toContain(assets.speedBench.prepare.revision);
		expect(script).toContain("insertion anchor changed");
		expect(script).toContain('"prepareTransforms": [');
		expect(script).toContain('"contentSha256": dataset_sha256');
	});

	test("pins every Hugging Face download to an immutable commit", () => {
		// A branch or tag resolves at download time, so anything but a full commit SHA lets the model
		// weights or the benchmark prompts change between runs (bandit B615 / CWE-494).
		const commit = /^[0-9a-f]{40}$/;
		expect(assets.model.revision).toMatch(commit);
		expect(assets.speedBench.prepare.revision).toMatch(commit);
		expect(assets.speedBench.dataset.repoId).toBe("nvidia/SPEED-Bench");
		expect(assets.speedBench.dataset.revision).toMatch(commit);

		// Both pins are enforced sandbox-side too: the script is staged into the model-cache sandbox
		// and run against this config, so it must reject a config that pins anything mutable rather
		// than trust its caller.
		expect(script.match(/_revision = pinned_revision\(/g)).toHaveLength(2);
		// Upstream's own load is unpinned; the staged copy is rewritten to the pinned commit.
		expect(script).toContain('revision="{dataset_revision}")');
		const downloads = script.match(/snapshot_download\([^)]*\)/g) ?? [];
		expect(downloads).toHaveLength(3);
		for (const call of downloads) expect(call).toContain("revision=model_revision");
		expect(script).toContain("root.name != model_revision");
	});

	test("keeps GPU consumers offline and the process runner fail-safe", () => {
		expect(MODEL_CACHE_ENV.HF_XET_HIGH_PERFORMANCE).toBe("1");
		expect(MODEL_OFFLINE_ENV.HF_HUB_OFFLINE).toBe("1");
		expect(KERNEL_CACHE_ENV.BENCH_VLLM_KERNEL_CACHE_DIR).toBe(GPU_BENCHMARK.paths.kernelCache);
		expect(PYTHON_ENVIRONMENT_COMMAND).toBe(
			"/opt/uv/bin/uv pip freeze --python /opt/vllm/bin/python",
		);
		expect(MODAL_GPU_ENV.NCCL_P2P_DISABLE).toBe("1");

		const runner = readFileSync(
			new URL(
				"../../../../../packages/schema/src/pts-profiles/local/vllm-speed-bench-1.0.0/runner.sh",
				import.meta.url,
			),
			"utf8",
		);
		expect(runner).toContain("trap stop_server EXIT");
		expect(runner).toContain('setsid "$' + '{server_env[@]}" "$' + '{server_args[@]}"');
		expect(runner).toContain('kill -TERM -- "-$server_pid"');
		expect(runner).toContain("hard readiness watchdog stopping vLLM");
		expect(runner).toContain(`--compilation-config '{"cudagraph_mode":"FULL_AND_PIECEWISE"}'`);
		expect(runner).toContain("timeout --foreground --signal=TERM --kill-after=30s");
		expect(runner).not.toMatch(/pip install|uv pip install/);
	});
});

describe("kernel snapshot registry", () => {
	test("accepts only a pointer for the exact inferred seed", () => {
		const seed = kernelSeedManifest("im-base", {
			gpu: GPU_BENCHMARK.defaults.gpu,
			flashinferAutotune: "disabled",
		});
		const raw = JSON.stringify({
			schemaVersion: "1.0",
			snapshotImageId: "im-kernel-snapshot",
			createdAt: "2026-08-10T00:00:00.000Z",
			seed,
		});
		expect(kernelSnapshotPointerFromText(raw, seed)?.snapshotImageId).toBe("im-kernel-snapshot");
		expect(
			kernelSnapshotPointerFromText(raw, { ...seed, profileSha256: "changed" }),
		).toBeUndefined();
		expect(kernelSnapshotPointerFromText("not-json", seed)).toBeUndefined();
	});
});

describe("CUDA graph evidence", () => {
	test("requires the resolved mode, eager-disabled engine, and completed capture", () => {
		expect(
			cudaGraphEvidenceFromLog(
				"CUDAGraphMode.FULL_AND_PIECEWISE enforce_eager=False Graph capturing finished in 19 secs",
			),
		).toEqual({
			requestedMode: "FULL_AND_PIECEWISE",
			runtimeModeObserved: true,
			eagerDisabled: true,
			captureCompleted: true,
		});
	});
});

describe("Modal allocation configuration", () => {
	test("shares resource and vLLM environment policy across seed and benchmark sandboxes", () => {
		const args = parseGpuArgs([]);
		expect(gpuSandboxResources(args)).toEqual({
			gpu: args.gpu,
			cpu: args.cpuRequested,
			cpuLimit: args.cpuLimit,
			memoryMiB: args.memoryRequestedMiB,
			memoryLimitMiB: args.memoryLimitMiB,
			timeoutMs: args.timeoutMinutes * 60_000,
			blockNetwork: true,
		});
		expect(vllmEnvironment(args)).toMatchObject({
			BENCH_VLLM_MODE: "qualification",
			BENCH_VLLM_MAX_JOBS: "1",
			BENCH_VLLM_NVCC_THREADS: "1",
			BENCH_VLLM_CLIENT_TIMEOUT_SECONDS: "600",
		});
		expect(vllmEnvironment(parseGpuArgs(["--prepare", "kernels"]))).toMatchObject({
			BENCH_VLLM_PREPARE_KERNELS_ONLY: "1",
			BENCH_VLLM_MAX_JOBS: "8",
			BENCH_VLLM_NVCC_THREADS: "4",
			BENCH_VLLM_CLIENT_TIMEOUT_SECONDS: "60",
		});
	});
});
