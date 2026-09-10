// The typed join (ADR-0007 §3): a driver binds to the registry through one autocompleted id
// parameter, and everything it may touch derives from that id. This root module imports the
// registry TYPE only so the driver kit remains runtime dependency-free; ../env.ts is the explicit
// arktype boundary that evaluates the same descriptor tuple.

import type { ProviderId, ProviderInput, REGISTRY } from "@sandbox-benchmarks/schema/providers";
import { DriverError, FailedCreateCleanupError } from "./errors.ts";
import type { DriverPolicy } from "./policy.ts";
import { normalizeDriverPolicy } from "./policy.ts";
import type {
	CreateRequest,
	DriverOperationOptions,
	ResolvedArtifact,
	SandboxDriver,
	SandboxRef,
	SandboxSession,
} from "./port.ts";

type Prettify<T> = { [K in keyof T]: T[K] } & {};

type InputName<I extends ProviderInput> = I extends string
	? I
	: I extends { readonly name: infer N extends string }
		? N
		: never;

type IsResolvedOptional<I extends ProviderInput> = I extends string
	? false
	: I extends { readonly default: string }
		? false
		: I extends { readonly required: false }
			? true
			: false;

type IsInputOptional<I extends ProviderInput> = I extends string
	? false
	: I extends { readonly default: string }
		? true
		: I extends { readonly required: false }
			? true
			: false;

/** The raw input slice: defaulted and genuinely optional fields may both be absent. */
export type EnvInputFromInputs<I extends readonly ProviderInput[]> = Prettify<
	{
		readonly [C in I[number] as IsInputOptional<C> extends true ? never : InputName<C>]: string;
	} & {
		readonly [C in I[number] as IsInputOptional<C> extends true ? InputName<C> : never]?: string;
	}
>;

/**
 * The resolved env slice for a literal provider-input tuple.
 *
 * Required inputs and inputs with defaults are always strings in driver code. Only inputs that
 * explicitly declare `required: false` without a default remain optional after parsing.
 */
export type EnvFromInputs<I extends readonly ProviderInput[]> = Prettify<
	{
		readonly [C in I[number] as IsResolvedOptional<C> extends true ? never : InputName<C>]: string;
	} & {
		readonly [C in I[number] as IsResolvedOptional<C> extends true ? InputName<C> : never]?: string;
	}
>;

/**
 * The env slice a driver may read: exactly the variables its provider declares. Reading an
 * undeclared credential is a compile error — "never read process.env here" is unrepresentable
 * rather than a comment.
 */
export type EnvOf<P extends ProviderId> = P extends ProviderId
	? EnvFromInputs<(typeof REGISTRY)[P]["inputs"]>
	: never;

/** The provider input accepted before defaults are applied. */
export type EnvInputOf<P extends ProviderId> = P extends ProviderId
	? EnvInputFromInputs<(typeof REGISTRY)[P]["inputs"]>
	: never;

/** The exact, literal artifact descriptor authored for one provider in the registry. */
export type ArtifactOf<P extends ProviderId> = P extends ProviderId
	? (typeof REGISTRY)[P]["artifact"]
	: never;

type ResolvedArtifactFor<Artifact> = Artifact extends { readonly kind: "none" }
	? Extract<ResolvedArtifact, { readonly kind: "none" }>
	: Artifact extends { readonly kind: "image" }
		? Extract<ResolvedArtifact, { readonly kind: "image" }>
		: Artifact extends { readonly kind: "baked" }
			? Extract<ResolvedArtifact, { readonly kind: "baked" }>
			: Artifact extends { readonly kind: "mirror" }
				? Extract<ResolvedArtifact, { readonly kind: "mirror" }>
				: Artifact extends { readonly kind: "built" }
					? Extract<ResolvedArtifact, { readonly kind: "built" }>
					: never;

/** The lane-resolved artifact shape for one provider; `ref` is impossible for `kind: "none"`. */
export type ResolvedArtifactOf<P extends ProviderId> = P extends ProviderId
	? ResolvedArtifactFor<(typeof REGISTRY)[P]["artifact"]>
	: never;

export interface DriverContext<P extends ProviderId> {
	readonly env: EnvOf<P>;
	readonly artifact: ArtifactOf<P>;
	readonly resolvedArtifact: ResolvedArtifactOf<P>;
}

export interface DriverSpec<P extends ProviderId, Handle = unknown>
	extends DriverPolicy<P, Handle> {
	readonly driver: (context: DriverContext<P>) => SandboxDriver<Handle>;
}

export interface DriverModule<P extends ProviderId, Handle = unknown>
	extends DriverSpec<P, Handle> {
	readonly id: P;
}

function driverMember(
	provider: ProviderId,
	driver: object,
	member: "create" | "destroyById" | "probes" | "snapshots" | "inventory",
): unknown {
	try {
		return Reflect.get(driver, member);
	} catch {
		throw new DriverError(
			"vendor-contract-violation",
			`sandbox driver ${member} could not be read safely`,
			{ provider },
		);
	}
}

function retainedSessionId(session: SandboxSession): string | undefined {
	try {
		const ref: unknown = Reflect.get(session, "sandboxRef");
		if ((typeof ref !== "object" && typeof ref !== "function") || ref === null) return undefined;
		const id: unknown = Reflect.get(ref, "id");
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

async function rejectMissingNativeLaunch(
	provider: ProviderId,
	session: SandboxSession,
): Promise<never> {
	const primary = new DriverError(
		"vendor-contract-violation",
		"native-launch execution returned a session without a launch capability",
		{ provider },
	);
	const cleanup = async (options?: DriverOperationOptions): Promise<void> => {
		const destroy: unknown = Reflect.get(session, "destroy");
		if (typeof destroy !== "function") {
			throw new Error("returned session has no callable destroy capability");
		}
		await Reflect.apply(destroy, session, [options]);
	};
	try {
		await cleanup();
	} catch (cleanupError) {
		const id = retainedSessionId(session);
		throw new FailedCreateCleanupError(cleanupError, primary, {
			provider,
			locator: id === undefined ? { kind: "cleanup-callback" } : { kind: "id", value: id },
			cleanup,
		});
	}
	throw primary;
}

/** Apply policy claims at the last common boundary before provider behavior reaches callers. */
function policyGuardedDriver<P extends ProviderId, Handle>(
	provider: P,
	policy: DriverPolicy<P, Handle>,
	value: unknown,
): SandboxDriver<Handle> {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		throw new DriverError("vendor-contract-violation", "driver factory must return an object", {
			provider,
		});
	}
	const raw = value;
	const create = driverMember(provider, raw, "create");
	if (typeof create !== "function") {
		throw new DriverError("vendor-contract-violation", "sandbox driver create must be callable", {
			provider,
		});
	}
	const destroyById = driverMember(provider, raw, "destroyById");
	if (destroyById !== undefined && typeof destroyById !== "function") {
		throw new DriverError(
			"vendor-contract-violation",
			"sandbox driver destroyById must be callable when present",
			{ provider },
		);
	}
	const probes = driverMember(provider, raw, "probes") as SandboxDriver<Handle>["probes"];
	const snapshots = driverMember(provider, raw, "snapshots") as SandboxDriver<Handle>["snapshots"];
	const inventory = driverMember(provider, raw, "inventory") as SandboxDriver<Handle>["inventory"];
	return Object.freeze({
		async create(request: CreateRequest, options?: DriverOperationOptions) {
			if (request.gpu !== undefined && policy.accelerator === undefined) {
				throw new DriverError(
					"invalid-create-request",
					"GPU requests require an accelerator strategy on the selected driver module",
					{ provider },
				);
			}
			const session = (await Reflect.apply(create, raw, [
				request,
				options,
			])) as SandboxSession<Handle>;
			if (policy.execution.durable === "native-launch") {
				let launch: unknown;
				try {
					launch = Reflect.get(session, "launch");
				} catch {
					launch = undefined;
				}
				if (typeof launch !== "function") await rejectMissingNativeLaunch(provider, session);
			}
			return session;
		},
		...(destroyById === undefined
			? {}
			: {
					destroyById: (ref: SandboxRef, options?: DriverOperationOptions) =>
						Reflect.apply(destroyById, raw, [ref, options]),
				}),
		...(probes === undefined ? {} : { probes }),
		...(snapshots === undefined ? {} : { snapshots }),
		...(inventory === undefined ? {} : { inventory }),
	});
}

/**
 * Define a provider's driver. The id is the whole join: it is autocompleted against
 * {@link ProviderId}, an unregistered id fails compile, and the spec can never bend `P`
 * (`NoInfer`) — only the id names the binding. One generic signature, deliberately not
 * overloads: overloads prefix every mistake with a signature dump, while a single signature
 * lands the error on the field the author got wrong.
 *
 * The spec literal stays inline in this call (or flows through a `DriverSpec<…>`-typed
 * factory); an untyped extracted const severs contextual typing (ADR-0007 §9). Anything you
 * want to extract and unit-test belongs in a `satisfies MethodTable<…>` table instead.
 */
export function defineDriver<P extends ProviderId, Handle = unknown>(
	id: P,
	spec: DriverSpec<NoInfer<P>, Handle>,
): DriverModule<P, Handle> {
	let driver: unknown;
	try {
		driver = Reflect.get(spec, "driver");
	} catch {
		throw new DriverError("vendor-contract-violation", "driver factory could not be read safely", {
			provider: id,
		});
	}
	if (typeof driver !== "function") {
		throw new DriverError("vendor-contract-violation", "driver factory must be callable", {
			provider: id,
		});
	}
	const policy = normalizeDriverPolicy(id, spec);
	const factory = driver as DriverSpec<P, Handle>["driver"];
	return Object.freeze({
		...policy,
		id,
		driver: (context: DriverContext<P>) => policyGuardedDriver(id, policy, factory(context)),
	});
}
