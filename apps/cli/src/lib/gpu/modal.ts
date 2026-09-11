import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxSession } from "@sandbox-benchmarks/driver";
import { readTextFile, writeTextFile } from "@sandbox-benchmarks/driver";
import type { SandboxWork } from "@sandbox-benchmarks/harness";
import { withSandboxWork } from "@sandbox-benchmarks/harness";
import type { ModalAllocationConfiguration } from "@sandbox-benchmarks/modal/allocation";
import { createModalAllocation } from "@sandbox-benchmarks/modal/allocation";
import type { Sandbox, SandboxCreateParams } from "modal";
import type { GpuArgs } from "./args.ts";
import {
	GPU_BENCHMARK,
	KERNEL_CACHE_ENV,
	MODAL_GPU_ENV,
	MODEL_OFFLINE_ENV,
	PYTHON_ENVIRONMENT_COMMAND,
	readSource,
} from "./config.ts";

export type GpuSandbox = SandboxWork<Sandbox>;

/** Native allocation and shared harness lifetime, with optional GPU-specific teardown evidence. */
export async function withGpuSandbox<T>(
	configuration: ModalAllocationConfiguration,
	work: (sandbox: GpuSandbox) => Promise<T>,
	evidence?: { readonly path: string; readonly replicateIndex: number },
): Promise<T> {
	type Outcome = { kind: "value"; value: T } | { kind: "error"; error: unknown };
	let outcome: Outcome | undefined;
	let sandboxId: string | undefined;
	try {
		await withSandboxWork(
			createModalAllocation(configuration),
			async (sandbox) => {
				sandboxId = sandbox.session.sandboxRef.id;
				try {
					outcome = { kind: "value", value: await work(sandbox) };
				} catch (error) {
					outcome = { kind: "error", error };
				}
			},
			{ ptsPassPolicy: { mode: "fixed", times: 1 } },
		);
		if (evidence)
			writeFileSync(
				evidence.path,
				`${JSON.stringify({ schemaVersion: "1.0", replicateIndex: evidence.replicateIndex, sandboxId, terminatedAndUnlisted: true, verifiedAt: new Date().toISOString() }, null, 2)}\n`,
			);
	} catch (error) {
		if (outcome?.kind === "error") {
			console.error("Modal GPU scope cleanup or evidence also failed:", error);
			throw outcome.error;
		}
		throw error;
	}
	if (outcome === undefined)
		throw new Error("Modal GPU scope returned without running its workload");
	if (outcome.kind === "error") throw outcome.error;
	return outcome.value;
}

/** Resource and lifetime policy shared by the kernel seed and measured benchmark allocations. */
export function gpuSandboxResources(args: GpuArgs) {
	return {
		gpu: args.gpu,
		cpu: args.cpuRequested,
		cpuLimit: args.cpuLimit,
		memoryMiB: args.memoryRequestedMiB,
		memoryLimitMiB: args.memoryLimitMiB,
		timeoutMs: args.timeoutMinutes * 60_000,
		blockNetwork: true,
	} satisfies SandboxCreateParams;
}

/** vLLM runtime policy shared by cache seeding and measured runs. */
export function vllmEnvironment(args: GpuArgs) {
	if (args.operation === "models") {
		throw new Error("model preparation does not use the vLLM runtime environment");
	}
	const kernelSeed = args.operation === "kernels";
	return {
		...MODEL_OFFLINE_ENV,
		...KERNEL_CACHE_ENV,
		...MODAL_GPU_ENV,
		...(kernelSeed ? { BENCH_VLLM_PREPARE_KERNELS_ONLY: "1" } : { BENCH_VLLM_MODE: args.mode }),
		BENCH_VLLM_FLASHINFER_AUTOTUNE: args.flashinferAutotune,
		BENCH_VLLM_MAX_JOBS: String(kernelSeed ? args.cudaBuildJobs : 1),
		BENCH_VLLM_NVCC_THREADS: String(kernelSeed ? args.nvccThreads : 1),
		BENCH_VLLM_READY_TIMEOUT_SECONDS: String(
			GPU_BENCHMARK.deadlines[kernelSeed ? "kernelServerReadyMinutes" : "serverReadyMinutes"] * 60,
		),
		BENCH_VLLM_CLIENT_TIMEOUT_SECONDS: String(kernelSeed ? 60 : args.clientTimeoutMinutes * 60),
		BENCH_VLLM_BIN: `${GPU_BENCHMARK.paths.vllmEnvironment}/bin/vllm`,
		BENCH_VLLM_NATIVE_RESULTS_DIR: `${GPU_BENCHMARK.paths.remoteRoot}/benchmark-results/vllm-native`,
	};
}

export async function stageGpuProducer(sandbox: GpuSandbox): Promise<void> {
	const files = [
		"lib/bench.sh",
		GPU_BENCHMARK.task,
		...[
			".catalog-ignore",
			"install.sh",
			"results-definition.xml",
			"runner.sh",
			"test-definition.xml",
		].map((file) => `${GPU_BENCHMARK.profile.directory}/${file}`),
	];
	await Promise.all(
		files.map((relative) =>
			writeTextFile(
				sandbox.session,
				join(GPU_BENCHMARK.paths.remoteRoot, relative),
				readSource(relative),
			),
		),
	);
	await sandbox.runner.run(
		"initialize staged benchmark",
		`git init -q ${GPU_BENCHMARK.paths.remoteRoot}`,
		30_000,
	);
}

export async function stageCollectedEvidence(sandbox: GpuSandbox): Promise<void> {
	const results = join(GPU_BENCHMARK.paths.remoteRoot, "benchmark-results");
	await sandbox.runner.run(
		"stage reproducibility evidence",
		[
			`mkdir -p ${results}`,
			`cp ${GPU_BENCHMARK.paths.modelMount}/benchmark-assets.json ${results}/benchmark-assets.json`,
			`${PYTHON_ENVIRONMENT_COMMAND} > ${results}/python-environment.txt`,
		].join("\n"),
		60_000,
	);
}

function numberFrom(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export async function observeGpuSandbox(sandbox: GpuSandbox) {
	const gpu = await sandbox.runner.run(
		"capture GPU metadata",
		"nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader,nounits",
		30_000,
	);
	const gpuOutput = (gpu.stdout ?? "").trim();
	const gpuRows = gpuOutput
		? gpuOutput.split("\n").map((line) => line.split(",").map((value) => value.trim()))
		: [];
	const system = await sandbox.runner.run(
		"capture software metadata",
		[
			"printf 'visible_cpus=%s\\n' \"$(nproc)\"",
			"printf 'memory_bytes='; if [ -r /sys/fs/cgroup/memory.max ] && [ \"$(cat /sys/fs/cgroup/memory.max)\" != max ]; then cat /sys/fs/cgroup/memory.max; else awk '/MemTotal:/ { print $2 * 1024 }' /proc/meminfo; fi",
			"printf 'pts_version=%s\\n' \"$(phoronix-test-suite version | sed -n 's/^Phoronix Test Suite v//p')\"",
			`${GPU_BENCHMARK.paths.vllmEnvironment}/bin/python - <<'PY'`,
			"import importlib.metadata, json, platform, subprocess, torch, transformers, vllm",
			"def version(name):",
			"    try: return importlib.metadata.version(name)",
			"    except importlib.metadata.PackageNotFoundError: return None",
			"available = torch.cuda.is_available()",
			"if not available: raise RuntimeError('torch.cuda.is_available() is false')",
			"smoke = float((torch.ones(256, device='cuda') * 2).sum().item())",
			"nvcc = subprocess.run(['nvcc', '--version'], check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1]",
			"print(json.dumps({'python': platform.python_version(), 'torch': torch.__version__, 'torchaudio': version('torchaudio'), 'transformers': transformers.__version__, 'triton': version('triton'), 'flashinfer': version('flashinfer-python'), 'cutlass_dsl': version('nvidia-cutlass-dsl'), 'cuda': torch.version.cuda, 'nvcc': nvcc, 'cuda_available': available, 'cuda_smoke': smoke, 'vllm': vllm.__version__}))",
			"PY",
		].join("\n"),
		60_000,
	);
	const lines = (system.stdout ?? "").trim().split("\n");
	const versions = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
	const tagged = (name: string) =>
		lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
	const strings = (index: number) => [
		...new Set(gpuRows.map((row) => row[index]).filter((value): value is string => Boolean(value))),
	];
	const value = (name: string) => (typeof versions[name] === "string" ? versions[name] : undefined);
	const memoryBytes = numberFrom(tagged("memory_bytes") ?? "");
	return {
		gpuName: strings(0).length > 1 ? strings(0).join(", ") : strings(0)[0],
		gpuCount: gpuRows.length || undefined,
		driverVersion: strings(1).join(", "),
		gpuMemoryMiB: gpuRows.reduce((total, row) => total + (numberFrom(row[2] ?? "") ?? 0), 0),
		computeCapability: strings(3).join(", "),
		visibleCpus: numberFrom(tagged("visible_cpus") ?? ""),
		memoryLimitMiB: memoryBytes === undefined ? undefined : Math.round(memoryBytes / 1024 / 1024),
		ptsVersion: tagged("pts_version") || undefined,
		pythonVersion: value("python"),
		torchVersion: value("torch"),
		torchaudioVersion: value("torchaudio"),
		transformersVersion: value("transformers"),
		tritonVersion: value("triton"),
		flashinferVersion: value("flashinfer"),
		cutlassDslVersion: value("cutlass_dsl"),
		cudaVersion: value("cuda"),
		nvccVersion: value("nvcc"),
		cudaAvailable: versions.cuda_available === true,
		cudaSmoke: typeof versions.cuda_smoke === "number" ? String(versions.cuda_smoke) : undefined,
		vllmVersion: value("vllm"),
	};
}

/** GPU artifacts are required inputs; an unreadable file is never silently treated as empty. */
export async function readGpuFile(session: SandboxSession, path: string): Promise<string> {
	const text = await readTextFile(session, path);
	if (text === null) throw new Error(`GPU artifact is unreadable: ${path}`);
	return text;
}
