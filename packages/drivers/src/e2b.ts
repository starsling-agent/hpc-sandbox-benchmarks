// E2B is a native SDK module: one registry-joined file owns credentials, artifact mapping,
// sandbox identity, lifecycle truth, and the few vendor-specific projections the universal wrapper
// cannot express safely. The shared bridge still owns request validation, error normalization,
// redaction, ambiguous-create ownership, output caps, and session assembly.

import { randomUUID } from "node:crypto";
import type {
	CreateRequest,
	DriverContext,
	DriverOperationOptions,
	ExecOptions,
	SandboxRef,
} from "@sandbox-benchmarks/driver";
import { type } from "arktype";
import {
	AuthenticationError,
	InvalidArgumentError,
	RateLimitError,
	Sandbox,
	SandboxNotFoundError,
} from "e2b";
import type {
	ComputeSdkCreatedRequestVerification,
	ComputeSdkCreateRecovery,
	ComputeSdkCreateRequestCoverage,
	ComputeSdkDriverSpec,
	ComputeSdkLifecycle,
	ComputeSdkNativeOf,
	ComputeSdkSandboxOf,
} from "./_computesdk.ts";
import { computeSdkSpec, defineComputeSdkDriver } from "./_computesdk.ts";
import { matchesAnyCause } from "./_errors.ts";
import { nativeSdkCompute } from "./_native.ts";
import { E2B_PROVENANCE } from "./_provenance.ts";

export { E2B_PROVENANCE };

type E2bCompute = ReturnType<typeof nativeE2bCompute>;
type E2bSandboxHandle = ComputeSdkSandboxOf<E2bCompute>;
type E2bNativeSandbox = ComputeSdkNativeOf<E2bSandboxHandle>;

export const E2B_SANDBOX_ID = type(/^i[a-z0-9]+$/);
export const E2B_SANDBOX_LIFETIME_MS = 3 * 60 * 60_000;
export const E2B_CONTROL_PLANE_TIMEOUT_MS = 5_000;
export const E2B_RECOVERY_CONFIRMATION_MS = 2_000;
export const E2B_RECOVERY_MAX_ATTEMPTS = 4;
export const E2B_ATTEMPT_METADATA_KEY = "sandbox-benchmarks-attempt";
export const E2B_READINESS = Object.freeze({ startup: "create-returns-ready" as const });
export const E2B_EXECUTION = Object.freeze({
	syncCapMs: 60_000,
	durable: "native-launch" as const,
});
const E2B_RECOVERY_MAX_PAGES = 100;
const E2B_CREATE_OPTIONS = type({
	snapshotId: "string >= 1",
	timeout: "number.integer > 0",
	metadata: { "[string]": "string" },
});

/** Allocate with the pinned SDK so typed refusals survive until reconciliation/classification. */
export function nativeE2bCompute(apiKey: string) {
	return nativeSdkCompute(
		(options) => E2B_CREATE_OPTIONS.assert(options),
		(options, operation) =>
			Sandbox.create(options.snapshotId, {
				apiKey,
				timeoutMs: options.timeout,
				metadata: options.metadata,
				...(operation.signal === undefined ? {} : { signal: operation.signal }),
			}),
		(native) => ({
			sandboxId: native.sandboxId,
			runCommand: (command, options) =>
				native.commands.run(command, {
					user: "root",
					background: false,
					...(options?.signal === undefined ? {} : { signal: options.signal }),
				}),
			destroy: () => native.kill(),
			filesystem: {
				readFile: (path) => native.files.read(path, { user: "root" }),
				exists: (path) => native.files.exists(path, { user: "root" }),
				writeFile: async (path, content) => {
					await native.files.write(path, content, { user: "root" });
				},
			},
		}),
	);
}

export const E2B_REQUEST_COVERAGE = {
	spec: {
		vcpus: { artifact: 4 },
		memoryGb: { artifact: 8 },
		diskGb: "runtime-verified",
	},
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies ComputeSdkCreateRequestCoverage;

function foreignCommandExit(
	caught: unknown,
): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } | undefined {
	if ((typeof caught !== "object" && typeof caught !== "function") || caught === null) {
		return undefined;
	}
	try {
		const name = Reflect.get(caught, "name");
		const exitCode = Reflect.get(caught, "exitCode");
		const stdout = Reflect.get(caught, "stdout");
		const stderr = Reflect.get(caught, "stderr");
		if (
			name !== "CommandExitError" ||
			!Number.isSafeInteger(exitCode) ||
			exitCode === 0 ||
			typeof stdout !== "string" ||
			typeof stderr !== "string"
		) {
			return undefined;
		}
		return { exitCode, stdout, stderr };
	} catch {
		return undefined;
	}
}

/** Foreground root execution preserves E2B's public nonzero exit envelope for kit normalization. */
export async function execE2bCommandAsRoot(
	sandbox: E2bSandboxHandle,
	command: string,
	options?: ExecOptions,
): Promise<unknown> {
	const native = sandbox.getInstance();
	try {
		return await native.commands.run(command, {
			user: "root",
			background: false,
			...(options?.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch (caught) {
		const failure = foreignCommandExit(caught);
		if (failure !== undefined) return failure;
		throw caught;
	}
}

/** Background execution succeeds only after E2B returns a genuine positive process handle. */
export async function launchE2bCommandAsRoot(
	sandbox: E2bSandboxHandle,
	command: string,
	options?: ExecOptions,
): Promise<void> {
	const handle = await sandbox.getInstance().commands.run(command, {
		user: "root",
		background: true,
		...(options?.signal === undefined ? {} : { signal: options.signal }),
	});
	if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) {
		throw new Error("E2B background command returned no positive process id");
	}
}

function attemptMarker(createOptions: Readonly<Record<string, unknown>>): string {
	const metadata = createOptions.metadata;
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw new Error("E2B create options are missing attempt metadata");
	}
	const marker = (metadata as Readonly<Record<string, unknown>>)[E2B_ATTEMPT_METADATA_KEY];
	if (typeof marker !== "string" || marker.length === 0) {
		throw new Error("E2B create options contain no stable attempt marker");
	}
	return marker;
}

function recoverySandboxIds(value: unknown, marker: string): readonly string[] {
	let length: unknown;
	try {
		if (!Array.isArray(value)) throw new Error("non-array result");
		length = Reflect.get(value, "length");
	} catch {
		throw new Error("E2B recovery list returned a non-array result");
	}
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
		throw new Error("E2B recovery list returned an invalid array length");
	}
	const sandboxIds: string[] = [];
	for (let index = 0; index < length; index += 1) {
		let row: unknown;
		try {
			row = Reflect.get(value, index);
		} catch {
			throw new Error(`E2B recovery list row ${index} is unreadable`);
		}
		if ((typeof row !== "object" && typeof row !== "function") || row === null) {
			throw new Error(`E2B recovery list row ${index} is not an object`);
		}
		let sandboxId: unknown;
		let metadata: unknown;
		try {
			sandboxId = Reflect.get(row, "sandboxId");
			metadata = Reflect.get(row, "metadata");
		} catch {
			throw new Error(`E2B recovery list row ${index} is unreadable`);
		}
		if ((typeof metadata !== "object" && typeof metadata !== "function") || metadata === null) {
			throw new Error(`E2B recovery list row ${index} has no metadata object`);
		}
		let rowMarker: unknown;
		try {
			rowMarker = Reflect.get(metadata, E2B_ATTEMPT_METADATA_KEY);
		} catch {
			throw new Error(`E2B recovery list row ${index} metadata is unreadable`);
		}
		if (rowMarker !== marker) {
			throw new Error(`E2B recovery list row ${index} does not match the create attempt marker`);
		}
		sandboxIds.push(E2B_SANDBOX_ID.assert(sandboxId));
	}
	return sandboxIds;
}

export function e2bLifecycle(apiKey: string): ComputeSdkLifecycle<E2bCompute> {
	return {
		destroy: async (sandbox, ref, options) => {
			const controlOptions = {
				requestTimeoutMs: E2B_CONTROL_PLANE_TIMEOUT_MS,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			};
			if (ref === undefined) {
				await sandbox.getInstance().kill(controlOptions);
				return;
			}
			await Sandbox.kill(ref.id, { apiKey, ...controlOptions });
		},
	};
}

/** Typed rejections made before allocation need no recovery lookup. */
export function isE2bDefinitiveCreateRejection(error: unknown): boolean {
	return matchesAnyCause(
		error,
		(link) =>
			link instanceof AuthenticationError ||
			link instanceof InvalidArgumentError ||
			link instanceof RateLimitError,
	);
}

/** Only the installed SDK's rate-limit class establishes a transient refusal. */
export function isE2bRetryableCreate(error: unknown): boolean {
	return matchesAnyCause(error, (link) => link instanceof RateLimitError);
}

/**
 * What the bridge needs to reconcile — and classify — a create whose outcome E2B left ambiguous.
 *
 * The locator is an attempt marker written into create metadata, so a sandbox the wrapper never
 * returned a handle for is still findable by listing. Both classifiers answer independently: whether
 * the refusal happened before allocation, and whether it is worth retrying.
 */
export function e2bCreateRecovery(apiKey: string): ComputeSdkCreateRecovery<E2bCompute> {
	return {
		absenceConfirmationMs: E2B_RECOVERY_CONFIRMATION_MS,
		maxAttempts: E2B_RECOVERY_MAX_ATTEMPTS,
		isDefinitive: isE2bDefinitiveCreateRejection,
		isRetryableCreate: isE2bRetryableCreate,
		locator: (createOptions) => ({
			kind: "marker",
			key: E2B_ATTEMPT_METADATA_KEY,
			value: attemptMarker(createOptions),
		}),
		cleanup: async (_compute, locator, options) => {
			const marker = locator.value;
			const controlOptions = {
				apiKey,
				requestTimeoutMs: E2B_CONTROL_PLANE_TIMEOUT_MS,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			};
			const paginator: unknown = Sandbox.list({
				...controlOptions,
				query: { metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } },
			});
			if (
				(typeof paginator !== "object" && typeof paginator !== "function") ||
				paginator === null
			) {
				throw new Error("E2B recovery list returned no paginator");
			}
			let nextItems: unknown;
			try {
				nextItems = Reflect.get(paginator, "nextItems");
			} catch {
				throw new Error("E2B recovery paginator method is unreadable");
			}
			if (typeof nextItems !== "function") {
				throw new Error("E2B recovery paginator method is not callable");
			}
			const sandboxIds = new Set<string>();
			const seenTokens = new Set<string>();
			let paginationComplete = false;
			for (let page = 0; page < E2B_RECOVERY_MAX_PAGES; page += 1) {
				// BasePaginator starts with a mandatory first page. Fetching it unconditionally makes a
				// malformed initial hasNext=false fail closed instead of manufacturing absence.
				const response: unknown = await Reflect.apply(nextItems, paginator, [controlOptions]);
				for (const sandboxId of recoverySandboxIds(response, marker)) {
					sandboxIds.add(sandboxId);
				}
				let hasNext: unknown;
				try {
					hasNext = Reflect.get(paginator, "hasNext");
				} catch {
					throw new Error("E2B recovery paginator state is unreadable");
				}
				if (typeof hasNext !== "boolean") {
					throw new Error("E2B recovery paginator state is not boolean");
				}
				let nextToken: unknown;
				try {
					nextToken = Reflect.get(paginator, "nextToken");
				} catch {
					throw new Error("E2B recovery paginator token is unreadable");
				}
				if (!hasNext) {
					if (nextToken !== undefined) {
						throw new Error("E2B recovery paginator retained a terminal continuation token");
					}
					paginationComplete = true;
					break;
				}
				if (typeof nextToken !== "string" || nextToken.length === 0) {
					throw new Error("E2B recovery paginator has no continuation token");
				}
				if (seenTokens.has(nextToken)) {
					throw new Error("E2B recovery paginator repeated a continuation token");
				}
				seenTokens.add(nextToken);
			}
			if (!paginationComplete) throw new Error("E2B recovery paginator exceeded its page limit");
			if (sandboxIds.size === 0) return { status: "absent" };
			let destroyed = false;
			for (const sandboxId of sandboxIds) {
				destroyed = (await Sandbox.kill(sandboxId, controlOptions)) || destroyed;
			}
			return destroyed
				? { status: "destroyed" }
				: { status: "absent", contradictedPriorAbsence: true };
		},
	};
}

export function e2bProbes(apiKey: string): NonNullable<ComputeSdkDriverSpec<E2bCompute>["probes"]> {
	return {
		observe: async (_compute, ref: SandboxRef) => {
			try {
				const info = await Sandbox.getInfo(ref.id, {
					apiKey,
					requestTimeoutMs: E2B_CONTROL_PLANE_TIMEOUT_MS,
				});
				if (info.state === "running" || info.state === "paused") {
					return { state: "running" as const };
				}
				throw new Error("E2B returned an unknown sandbox state");
			} catch (caught) {
				let notFound = false;
				try {
					notFound = caught instanceof SandboxNotFoundError;
				} catch {
					// A hostile rejection cannot be treated as convergence; the bridge omission boundary
					// converts it to a typed probe contract failure without retaining the thrown value.
				}
				if (notFound) return { state: "absent" as const };
				throw caught;
			}
		},
	};
}

export async function verifyE2bDiskCapacity(
	native: E2bNativeSandbox,
	request: CreateRequest,
	options: DriverOperationOptions,
): Promise<ComputeSdkCreatedRequestVerification> {
	const requestedDiskGb = request.spec.diskGb;
	if (requestedDiskGb === undefined) return { status: "honored" };
	const result = await native.commands.run("df -Pk / | awk 'NR==2 {print $2}'", {
		user: "root",
		background: false,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (result.exitCode !== 0) {
		throw new Error(`E2B disk capacity probe exited ${result.exitCode}`);
	}
	const stdout = result.stdout.trim();
	if (!/^\d+$/.test(stdout)) {
		throw new Error("E2B disk capacity probe returned malformed output");
	}
	const capacityGb = Number(stdout) / 1024 / 1024;
	if (!Number.isFinite(capacityGb) || capacityGb <= 0) {
		throw new Error("E2B disk capacity probe returned an invalid capacity");
	}
	return capacityGb >= requestedDiskGb
		? { status: "honored" }
		: {
				status: "unsupported",
				detail: `requested ${requestedDiskGb} GiB but the allocation exposes ${capacityGb.toFixed(2)} GiB`,
			};
}

/** Extracted through the joined context type so tests can pin the actual one-file authoring shape. */
export function e2bSpec({ env, resolvedArtifact }: DriverContext<"e2b">) {
	const apiKey = env.E2B_API_KEY;
	return computeSdkSpec(nativeE2bCompute(apiKey), {
		sandboxId: E2B_SANDBOX_ID,
		createOptions: {
			coverage: E2B_REQUEST_COVERAGE,
			map: (request, unsupported) => {
				if (request.artifact.kind !== "baked" || request.artifact.ref !== resolvedArtifact.ref) {
					unsupported("the request artifact does not match the resolved E2B template");
				}
				return {
					snapshotId: resolvedArtifact.ref,
					timeout: E2B_SANDBOX_LIFETIME_MS,
					metadata: { [E2B_ATTEMPT_METADATA_KEY]: `benchmark-${randomUUID()}` },
				} satisfies typeof E2B_CREATE_OPTIONS.infer;
			},
		},
		commands: {
			exec: execE2bCommandAsRoot,
			launch: launchE2bCommandAsRoot,
		},
		lifecycle: e2bLifecycle(apiKey),
		createRecovery: e2bCreateRecovery(apiKey),
		prepareAndVerifyCreatedRequest: (_sandbox, native, request, options) =>
			verifyE2bDiskCapacity(native, request, options),
		hasWorkingFilesystem: true,
		probes: e2bProbes(apiKey),
	});
}

export default defineComputeSdkDriver("e2b", {
	provenance: E2B_PROVENANCE,
	readiness: E2B_READINESS,
	execution: E2B_EXECUTION,
	spec: e2bSpec,
});
