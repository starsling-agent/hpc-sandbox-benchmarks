// The arktype-free sandbox driver port (ADR-0007 §2). This module contains only trusted in-process
// data and behavioral contracts. Parsing untrusted argv/config/persisted input lives in `./schemas`;
// provider-specific sandbox-id validation belongs to the selected DriverModule.

import type {
	DriverCreateRequest,
	DriverExecResult,
	DriverExit,
	DriverGpuSpec,
	DriverResolvedArtifact,
	DriverSandboxObservation,
	DriverSandboxRefEnvelope,
} from "@sandbox-benchmarks/schema/driver-schemas";
import type { ProviderId } from "@sandbox-benchmarks/schema/provider-ids";
import type { TargetSpec } from "@sandbox-benchmarks/schema/target-spec";

export type { TargetSpec } from "@sandbox-benchmarks/schema/target-spec";

/* ------------------------------ Sandbox identification ------------------------------ */

/** Provider-qualified sandbox identity. The selected driver owns validation of its `id`. */
export interface SandboxRef<P extends ProviderId = ProviderId> {
	readonly provider: P;
	readonly id: string;
}

/** Construct a ref from an id already validated by the selected driver module. */
export function sandboxRef<P extends ProviderId>(provider: P, id: string): SandboxRef<P> {
	return { provider, id };
}

/* --------------------------------- Command results --------------------------------- */

/** A missing vendor exit code is evidence, never a fabricated non-zero code. */
export type Exit =
	| { readonly kind: "exited"; readonly code: number }
	| { readonly kind: "signalled"; readonly signal: string }
	| { readonly kind: "unknown"; readonly detail: string };

export const succeeded = (exit: Exit): boolean => exit.kind === "exited" && exit.code === 0;

export interface ExecResult {
	readonly exit: Exit;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly truncated: boolean;
}

export interface ExecOptions {
	/** Opt-in cap. A kit-wide default would truncate multi-MB result collection. */
	readonly maxOutputBytes?: number;
	/** Cooperative cancellation. Implementations reject only after accepted work has settled. */
	readonly signal?: AbortSignal;
}

/** Cooperative cancellation for process-owned lifecycle operations. */
export interface DriverOperationOptions {
	readonly signal?: AbortSignal;
}

/* --------------------------------- Create requests --------------------------------- */

export interface GpuSpec {
	readonly model: string;
	readonly count: number;
}

export type ResolvedArtifact =
	| { readonly kind: "none" }
	| { readonly kind: "image"; readonly ref: string }
	| { readonly kind: "baked"; readonly ref: string }
	| { readonly kind: "mirror"; readonly ref: string }
	| { readonly kind: "built"; readonly ref: string };

export interface CreateRequest {
	readonly spec: TargetSpec;
	readonly artifact: ResolvedArtifact;
	readonly deadlineMs: number;
	readonly gpu?: GpuSpec;
	readonly env?: Readonly<Record<string, string>>;
}

/* ------------------------- Behavioral contracts (plain TS) ------------------------- */

export interface SandboxFiles {
	readFile(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	writeText(path: string, text: string): Promise<void>;
}

export interface SandboxSession<Handle = unknown> {
	readonly sandboxRef: SandboxRef;
	readonly artifact: ResolvedArtifact;
	readonly native: Handle;
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	destroy(options?: DriverOperationOptions): Promise<void>;
	readonly files?: SandboxFiles;
	launch?(command: string, options?: ExecOptions): Promise<void>;
}

export type SandboxObservation =
	| { readonly state: "running" }
	| { readonly state: "terminal" }
	| { readonly state: "absent" };

export interface ControlPlaneProbes {
	observe(ref: SandboxRef): Promise<SandboxObservation>;
	describe?(ref: SandboxRef): Promise<unknown>;
	list?(): Promise<unknown>;
}

export interface SnapshotCapability<Handle = unknown> {
	create(session: SandboxSession<Handle>): Promise<{ readonly snapshotId: string }>;
	delete(snapshotId: string): Promise<void>;
}

/** Full account observation, not the opaque and possibly paginated diagnostic list probe. */
export interface InventorySnapshot {
	readonly owned: readonly SandboxRef[];
	readonly foreignCount: number;
}

export interface InventoryCapability {
	/** Drain all pages. An unavailable or partial inventory must reject, never return an empty list. */
	list(options?: DriverOperationOptions): Promise<InventorySnapshot>;
}

export interface SandboxDriver<Handle = unknown> {
	create(request: CreateRequest, options?: DriverOperationOptions): Promise<SandboxSession<Handle>>;
	destroyById?(ref: SandboxRef, options?: DriverOperationOptions): Promise<void>;
	readonly probes?: ControlPlaneProbes;
	readonly snapshots?: SnapshotCapability<Handle>;
	readonly inventory?: InventoryCapability;
}

export type CreateBudget =
	| { readonly owner: "harness"; readonly timeoutMs?: number }
	| { readonly owner: "driver"; readonly attemptCeilingMs: number };

/* -------------------------- Schema/port exactness guardrail -------------------------- */

type DeepReadonly<T> = T extends readonly (infer Item)[]
	? readonly DeepReadonly<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T;
type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
			? true
			: false
		: false;
type Assert<T extends true> = T;

// Pins the helper itself: mutual assignability would incorrectly call these equal.
type _exactnessRejectsOptionalDrift = Assert<
	Equal<
		{ readonly required: string },
		{ readonly required: string; readonly optional?: number }
	> extends false
		? true
		: false
>;

type _sandboxRefMatches = Assert<Equal<SandboxRef, DeepReadonly<DriverSandboxRefEnvelope>>>;
type _exitMatches = Assert<Equal<Exit, DeepReadonly<DriverExit>>>;
type _execMatches = Assert<Equal<ExecResult, DeepReadonly<DriverExecResult>>>;
type _gpuMatches = Assert<Equal<GpuSpec, DeepReadonly<DriverGpuSpec>>>;
type _artifactMatches = Assert<Equal<ResolvedArtifact, DeepReadonly<DriverResolvedArtifact>>>;
type _createMatches = Assert<Equal<CreateRequest, DeepReadonly<DriverCreateRequest>>>;
type _observationMatches = Assert<
	Equal<SandboxObservation, DeepReadonly<DriverSandboxObservation>>
>;
