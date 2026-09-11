import { describe, expect, test } from "bun:test";
import type { E2BSandbox } from "@computesdk/e2b";
import { e2b } from "@computesdk/e2b";
import type {
	ComputeSdkCreateRequestCoverage,
	ComputeSdkCreateRequestMapper,
} from "@sandbox-benchmarks/driver/computesdk";
import { computeSdkSpec, defineComputeSdkDriver } from "@sandbox-benchmarks/driver/computesdk";
import { type } from "arktype";

const e2bSandboxId = type(/^i[a-z0-9]+$/);
type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
			? true
			: false
		: false;
type Expect<T extends true> = T;

const artifactCoverage = {
	spec: { vcpus: { artifact: 4 }, memoryGb: { artifact: 8 }, diskGb: { artifact: 40 } },
	artifact: "context",
	deadlineMs: "harness",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies ComputeSdkCreateRequestCoverage;

const bridgePolicy = {
	provenance: { packageName: "@computesdk/fake", version: "1.0.0" },
	readiness: { startup: "create-returns-ready" },
	execution: { syncCapMs: 60_000, durable: "shell-detach" },
	// The generic bridge fixture maps GPU request axes, so it must also declare how the shared gate
	// would observe them. Production providers that reject GPU requests omit this strategy.
	accelerator: {
		family: "test",
		command: "test-gpu-observation",
		parse: () => ({ model: "test-gpu", count: 1 }),
		matches: () => true,
	},
} as const;

const createRequestMapper = (
	map: ComputeSdkCreateRequestMapper["map"] = () => ({}),
	coverage: ComputeSdkCreateRequestCoverage = artifactCoverage,
): ComputeSdkCreateRequestMapper => ({ coverage, map });

describe("ComputeSDK wrapper compatibility", () => {
	test("infers session.native as the installed wrapper's vendored SDK instance", () => {
		const module_ = defineComputeSdkDriver("e2b", {
			...bridgePolicy,
			spec: ({ env }) => ({
				compute: e2b({ apiKey: env.E2B_API_KEY }),
				sandboxId: e2bSandboxId,
				createOptions: createRequestMapper(undefined, artifactCoverage),
				hasWorkingFilesystem: true,
			}),
		});
		type Driver = ReturnType<(typeof module_)["driver"]>;
		type Session = Awaited<ReturnType<Driver["create"]>>;
		type _native = Expect<Equal<Session["native"], E2BSandbox>>;
		expect(module_.id).toBe("e2b");
	});

	test("preserves the installed wrapper type inside capability callbacks", () => {
		const module_ = defineComputeSdkDriver("e2b", {
			...bridgePolicy,
			spec: ({ env }) =>
				computeSdkSpec(e2b({ apiKey: env.E2B_API_KEY }), {
					sandboxId: e2bSandboxId,
					createOptions: createRequestMapper(undefined, artifactCoverage),
					hasWorkingFilesystem: true,
					probes: {
						observe: async (compute, ref) => {
							const found = await compute.sandbox.getById(ref.id);
							return found === undefined ? { state: "absent" } : { state: "running" };
						},
					},
				}),
		});
		expect(module_.id).toBe("e2b");
	});
});
