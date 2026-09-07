import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { E2BSandbox } from "@computesdk/e2b";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { DriverError, FailedCreateCleanupError, sandboxRef } from "@sandbox-benchmarks/driver";
import {
	AuthenticationError,
	CommandExitError,
	InvalidArgumentError,
	RateLimitError,
	Sandbox,
	TimeoutError,
} from "e2b";
import type { ComputeSdkSandboxOf } from "./_computesdk.ts";
import e2bDriver, {
	E2B_ATTEMPT_METADATA_KEY,
	E2B_CONTROL_PLANE_TIMEOUT_MS,
	E2B_EXECUTION,
	E2B_PROVENANCE,
	E2B_READINESS,
	E2B_RECOVERY_MAX_ATTEMPTS,
	E2B_REQUEST_COVERAGE,
	E2B_SANDBOX_ID,
	E2B_SANDBOX_LIFETIME_MS,
	E2B_WRAPPER_CAPACITY_CREATE_MESSAGE,
	E2B_WRAPPER_DEFINITIVE_CREATE_MESSAGES,
	e2bSpec,
	execE2bCommandAsRoot,
	isE2bDefinitiveCreateRejection,
	isE2bRetryableCreate,
	launchE2bCommandAsRoot,
} from "./e2b.ts";

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
		? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
			? true
			: false
		: false;
type Expect<T extends true> = T;

const context = {
	env: { E2B_API_KEY: "e2b_test-key" },
	artifact: { kind: "baked" },
	resolvedArtifact: { kind: "baked", ref: "sandbox-benchmarks-e2b-v1" },
} as const;

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: context.resolvedArtifact,
	deadlineMs: 300_000,
};

describe("E2B module policy", () => {
	test("declares integration, readiness, and native durable execution", () => {
		expect(e2bDriver.provenance).toEqual(E2B_PROVENANCE);
		expect(e2bDriver.readiness).toEqual(E2B_READINESS);
		expect(e2bDriver.execution).toEqual(E2B_EXECUTION);
	});
});

function fakeNativeSandbox(id = "i2f3k4abc", diskCapacityGb = 80): Sandbox {
	return {
		sandboxId: id,
		commands: {
			run: async (command: string) => ({
				pid: 42,
				exitCode: 0,
				stdout: command.startsWith("df -Pk") ? `${diskCapacityGb * 1024 * 1024}\n` : "",
				stderr: "",
			}),
		},
		kill: async () => {},
		files: {
			read: async () => "",
			exists: async () => true,
			write: async () => {},
		},
	} as unknown as Sandbox;
}

function fakeSandboxPaginator(
	pages: readonly unknown[],
	onNext?: (pageIndex: number, options: unknown) => void,
): ReturnType<typeof Sandbox.list> {
	let pageIndex = 0;
	return {
		get hasNext() {
			return pageIndex < pages.length;
		},
		get nextToken() {
			return pageIndex < pages.length ? `page-${pageIndex + 1}` : undefined;
		},
		nextItems: async (options?: unknown) => {
			onNext?.(pageIndex, options);
			const page = pages[pageIndex];
			pageIndex += 1;
			return page;
		},
	} as unknown as ReturnType<typeof Sandbox.list>;
}

describe("E2B proof driver", () => {
	test("is one registry-joined module with explicit capacity, lifetime, and recovery policy", () => {
		expect(e2bDriver.id).toBe("e2b");
		expect(e2bDriver.createBudget).toBeUndefined();

		const spec = e2bSpec(context);
		expect(spec.compute.name).toBe("e2b");
		expect(spec.createOptions.coverage).toEqual(E2B_REQUEST_COVERAGE);
		const mapped = spec.createOptions.map(request, (detail) => {
			throw new Error(detail);
		});
		expect(mapped).toMatchObject({
			snapshotId: context.resolvedArtifact.ref,
			timeout: E2B_SANDBOX_LIFETIME_MS,
		});
		const mappedMarker = (mapped.metadata as Record<string, string>)[E2B_ATTEMPT_METADATA_KEY];
		if (mappedMarker === undefined) throw new Error("mapped request has no attempt marker");
		expect(mappedMarker).toMatch(/^benchmark-[0-9a-f-]+$/);
		expect(spec.hasWorkingFilesystem).toBe(true);
		expect(spec.commands?.exec).toBe(execE2bCommandAsRoot);
		expect(spec.commands?.launch).toBe(launchE2bCommandAsRoot);
		expect(spec.lifecycle).toBeDefined();
		expect(spec.createRecovery).toBeDefined();
		expect(spec.createRecovery?.maxAttempts).toBe(E2B_RECOVERY_MAX_ATTEMPTS);
		expect(spec.createRecovery?.locator(mapped)).toEqual({
			kind: "marker",
			key: E2B_ATTEMPT_METADATA_KEY,
			value: mappedMarker,
		});
		expect(spec.prepareAndVerifyCreatedRequest).toBeDefined();
		expect(spec.probes).toBeDefined();
		expect(E2B_SANDBOX_ID.assert("i2f3k4abc")).toBe("i2f3k4abc");
		expect(() => E2B_SANDBOX_ID.assert("sandbox-123")).toThrow();

		type Driver = ReturnType<(typeof e2bDriver)["driver"]>;
		type Session = Awaited<ReturnType<Driver["create"]>>;
		type _nativeIsInstalledWrapperType = Expect<Equal<Session["native"], E2BSandbox>>;
		expect(true).toBe(true);
	});

	test("verifies disk capacity after allocation and tears down an undersized sandbox", async () => {
		const create = spyOn(Sandbox, "create").mockResolvedValue(fakeNativeSandbox("iundersized", 24));
		const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({
				code: "invalid-create-request",
				provider: "e2b",
				ref: { provider: "e2b", id: "iundersized" },
			});
			expect(kill).toHaveBeenCalledWith("iundersized", expect.any(Object));
		} finally {
			create.mockRestore();
			kill.mockRestore();
		}
	});

	test("rejects artifact, hardware, accelerator, and environment drift before allocation", async () => {
		const create = spyOn(Sandbox, "create").mockResolvedValue(fakeNativeSandbox());
		try {
			const driver = e2bDriver.driver(context);
			const invalidRequests: CreateRequest[] = [
				{ ...request, artifact: { kind: "baked", ref: "some-other-template" } },
				{ ...request, spec: { ...request.spec, vcpus: 8 } },
				{ ...request, spec: { ...request.spec, memoryGb: 16 } },
				{ ...request, gpu: { model: "H100", count: 2 } },
				{ ...request, env: { SHOULD_EXIST: "yes" } },
			];
			for (const invalid of invalidRequests) {
				const error = await driver.create(invalid).catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(DriverError);
				expect(error).toMatchObject({ code: "invalid-create-request", provider: "e2b" });
			}
			expect(create).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
		}
	});

	test("passes a suite-length lifetime and uses direct typed teardown", async () => {
		const create = spyOn(Sandbox, "create").mockResolvedValue(fakeNativeSandbox());
		const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
		try {
			const session = await e2bDriver.driver(context).create(request);
			expect(create).toHaveBeenCalledTimes(1);
			expect(create.mock.calls[0]?.[1]).toMatchObject({
				timeoutMs: E2B_SANDBOX_LIFETIME_MS,
				metadata: { [E2B_ATTEMPT_METADATA_KEY]: expect.stringMatching(/^benchmark-/) },
			});
			await session.destroy();
			expect(kill).toHaveBeenCalledWith("i2f3k4abc", {
				apiKey: "e2b_test-key",
				requestTimeoutMs: E2B_CONTROL_PLANE_TIMEOUT_MS,
				signal: expect.any(AbortSignal),
			});
		} finally {
			create.mockRestore();
			kill.mockRestore();
		}
	});

	test("surfaces direct teardown transport failures through the typed redacted boundary", async () => {
		const create = spyOn(Sandbox, "create").mockResolvedValue(fakeNativeSandbox());
		const kill = spyOn(Sandbox, "kill").mockRejectedValue(
			new Error("network failed for e2b_test-key"),
		);
		try {
			const session = await e2bDriver.driver(context).create(request);
			const error = await session.destroy().catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "destroy-failed", provider: "e2b" });
			expect((error as Error).message).not.toContain("e2b_test-key");
		} finally {
			create.mockRestore();
			kill.mockRestore();
		}
	});

	test("reconciles an ambiguously accepted create by its unique metadata marker", async () => {
		const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
		const list = spyOn(Sandbox, "list").mockImplementation((options) => {
			const marker = options?.query?.metadata?.[E2B_ATTEMPT_METADATA_KEY];
			return fakeSandboxPaginator([
				[{ sandboxId: "iaccepted", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }],
			]);
		});
		const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
			const query = list.mock.calls[0]?.[0]?.query?.metadata;
			expect(query?.[E2B_ATTEMPT_METADATA_KEY]).toMatch(/^benchmark-/);
			expect(kill).toHaveBeenCalledWith("iaccepted", expect.any(Object));
		} finally {
			create.mockRestore();
			list.mockRestore();
			kill.mockRestore();
		}
	});

	test("recognizes the installed wrapper's authentication envelope before recovery", async () => {
		// @computesdk/e2b catches the typed SDK error and emits this stable plain-Error envelope.
		const create = spyOn(Sandbox, "create").mockRejectedValue(
			new AuthenticationError("API key rejected"),
		);
		const list = spyOn(Sandbox, "list").mockImplementation(() => {
			throw new Error("definitive authentication rejection must not enter recovery");
		});
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).not.toBeInstanceOf(FailedCreateCleanupError);
			expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
			expect((error as Error).message).toContain("E2B authentication failed");
			expect(create).toHaveBeenCalledTimes(1);
			expect(list).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
			list.mockRestore();
		}
	});

	test("validates and destroys every exact-marker allocation across every paginator page", async () => {
		const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
		let fetchedPages = 0;
		const list = spyOn(Sandbox, "list").mockImplementation((options) => {
			const marker = options?.query?.metadata?.[E2B_ATTEMPT_METADATA_KEY];
			return fakeSandboxPaginator(
				[
					[],
					[{ sandboxId: "ifirst", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }],
					[{ sandboxId: "isecond", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }],
				],
				() => {
					fetchedPages += 1;
				},
			);
		});
		const killed: string[] = [];
		const kill = spyOn(Sandbox, "kill").mockImplementation(async (sandboxId) => {
			expect(fetchedPages).toBe(3);
			killed.push(sandboxId);
			return true;
		});
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
			expect(killed).toEqual(["ifirst", "isecond"]);
		} finally {
			create.mockRestore();
			list.mockRestore();
			kill.mockRestore();
		}
	});

	test("fetches the mandatory first recovery page even when initial paginator state lies", async () => {
		const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
		let fetchedPages = 0;
		const list = spyOn(Sandbox, "list").mockImplementation((options) => {
			const marker = options?.query?.metadata?.[E2B_ATTEMPT_METADATA_KEY];
			return {
				hasNext: false,
				nextItems: async () => {
					fetchedPages += 1;
					return [{ sandboxId: "iinitial", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }];
				},
			} as unknown as ReturnType<typeof Sandbox.list>;
		});
		const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
			expect(fetchedPages).toBe(1);
			expect(kill).toHaveBeenCalledWith("iinitial", expect.any(Object));
		} finally {
			create.mockRestore();
			list.mockRestore();
			kill.mockRestore();
		}
	});

	test("retains ownership on malformed or cyclic recovery continuation state", async () => {
		for (const paginatorFactory of [
			() => ({
				hasNext: "false",
				nextItems: async () => [],
			}),
			() => ({
				hasNext: false,
				nextToken: "hidden-page",
				nextItems: async () => [],
			}),
			() => ({
				hasNext: false,
				get nextToken(): never {
					throw new Error("terminal-token-secret");
				},
				nextItems: async () => [],
			}),
			() => ({
				hasNext: true,
				nextToken: "repeated-token",
				nextItems: async () => [],
			}),
		]) {
			const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
			const list = spyOn(Sandbox, "list").mockImplementation(
				() => paginatorFactory() as unknown as ReturnType<typeof Sandbox.list>,
			);
			const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
			try {
				const error = await e2bDriver
					.driver(context)
					.create(request)
					.catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(FailedCreateCleanupError);
				expect(kill).not.toHaveBeenCalled();
			} finally {
				create.mockRestore();
				list.mockRestore();
				kill.mockRestore();
			}
		}
	});

	test("retains all ownership when a later recovery page is malformed", async () => {
		const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
		const list = spyOn(Sandbox, "list").mockImplementation((options) => {
			const marker = options?.query?.metadata?.[E2B_ATTEMPT_METADATA_KEY];
			return fakeSandboxPaginator([
				[{ sandboxId: "ifirst", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }],
				[{ sandboxId: "invalid-later-id", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }],
			]);
		});
		const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(FailedCreateCleanupError);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
			list.mockRestore();
			kill.mockRestore();
		}
	});

	test("never delegates recovery traversal to an untrusted array method", async () => {
		const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
		const list = spyOn(Sandbox, "list").mockImplementation((options) => {
			const marker = options?.query?.metadata?.[E2B_ATTEMPT_METADATA_KEY];
			const rows = [{ sandboxId: "iaccepted", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }];
			Object.defineProperty(rows, "map", {
				value: () => ["ivictim"],
			});
			return fakeSandboxPaginator([rows]);
		});
		const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({ code: "create-failed", provider: "e2b" });
			expect(kill).toHaveBeenCalledWith("iaccepted", expect.any(Object));
			expect(kill.mock.calls.some(([id]) => id === "ivictim")).toBe(false);
		} finally {
			create.mockRestore();
			list.mockRestore();
			kill.mockRestore();
		}
	});

	test("rejects malformed recovery ids without destroying an unvalidated allocation", async () => {
		const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
		const list = spyOn(Sandbox, "list").mockImplementation((options) => {
			const marker = options?.query?.metadata?.[E2B_ATTEMPT_METADATA_KEY];
			return fakeSandboxPaginator([
				[{ sandboxId: "wrong-provider-id", metadata: { [E2B_ATTEMPT_METADATA_KEY]: marker } }],
			]);
		});
		const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(FailedCreateCleanupError);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
			list.mockRestore();
			kill.mockRestore();
		}
	});

	test("retains ownership on malformed recovery envelopes and validates every row before kill", async () => {
		const malformedResponses: unknown[] = [
			{ length: 0 },
			[
				{
					sandboxId: "iaccepted",
					metadata: { [E2B_ATTEMPT_METADATA_KEY]: "benchmark-current" },
				},
				{
					sandboxId: "iunrelated",
					metadata: { [E2B_ATTEMPT_METADATA_KEY]: "benchmark-someone-else" },
				},
			],
		];
		for (const response of malformedResponses) {
			const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
			const list = spyOn(Sandbox, "list").mockImplementation((options) => {
				const currentMarker = options?.query?.metadata?.[E2B_ATTEMPT_METADATA_KEY];
				const resolvedResponse = Array.isArray(response)
					? response.map((row, index) =>
							index === 0
								? {
										sandboxId: "iaccepted",
										metadata: { [E2B_ATTEMPT_METADATA_KEY]: currentMarker },
									}
								: row,
						)
					: response;
				return fakeSandboxPaginator([resolvedResponse]);
			});
			const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
			try {
				const error = await e2bDriver
					.driver(context)
					.create(request)
					.catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(FailedCreateCleanupError);
				expect(kill).not.toHaveBeenCalled();
			} finally {
				create.mockRestore();
				list.mockRestore();
				kill.mockRestore();
			}
		}
	});

	test("forwards create cancellation into the E2B recovery paginator", async () => {
		const cancellation = new AbortController();
		const create = spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost"));
		const paginatorSignals: Array<AbortSignal | undefined> = [];
		let pageIndex = 0;
		const list = spyOn(Sandbox, "list").mockImplementation(
			() =>
				({
					get hasNext() {
						return pageIndex < 2;
					},
					get nextToken() {
						return pageIndex < 2 ? `page-${pageIndex + 1}` : undefined;
					},
					nextItems: async (options?: { readonly signal?: AbortSignal }) => {
						paginatorSignals.push(options?.signal);
						pageIndex += 1;
						if (pageIndex === 1) return [];
						return await new Promise<never>((_resolve, reject) => {
							const signal = options?.signal;
							if (signal === undefined) return reject(new Error("missing recovery signal"));
							const rejectAborted = () => reject(signal.reason);
							if (signal.aborted) return rejectAborted();
							signal.addEventListener("abort", rejectAborted, { once: true });
							queueMicrotask(() => cancellation.abort(new Error("caller stopped")));
						});
					},
				}) as unknown as ReturnType<typeof Sandbox.list>,
		);
		try {
			const error = await e2bDriver
				.driver(context)
				.create(request, { signal: cancellation.signal })
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(FailedCreateCleanupError);
			expect(paginatorSignals).toEqual([cancellation.signal, cancellation.signal]);
		} finally {
			create.mockRestore();
			list.mockRestore();
		}
	});

	test("keeps paused sandboxes live and rejects unknown lifecycle states", async () => {
		const getInfo = spyOn(Sandbox, "getInfo").mockResolvedValue({ state: "paused" } as Awaited<
			ReturnType<typeof Sandbox.getInfo>
		>);
		try {
			const probes = e2bSpec(context).probes;
			if (probes === undefined) throw new Error("E2B probes missing");
			const ref = sandboxRef("e2b", "i2f3k4abc");
			expect(await probes.observe(e2bSpec(context).compute, ref)).toEqual({ state: "running" });
			getInfo.mockResolvedValue({ state: "unknown-vendor-state" } as never);
			await expect(probes.observe(e2bSpec(context).compute, ref)).rejects.toThrow(
				"unknown sandbox state",
			);
		} finally {
			getInfo.mockRestore();
		}
	});

	test("splits foreground results from genuine background acceptance", async () => {
		const calls: Array<[string, { readonly user?: string; readonly background?: boolean }]> = [];
		const wrapper = {
			getInstance: () => ({
				commands: {
					run: async (
						command: string,
						options: { readonly user?: string; readonly background?: boolean },
					) => {
						calls.push([command, options]);
						return options.background ? { pid: 42 } : { exitCode: 0, stdout: "0\n", stderr: "" };
					},
				},
			}),
		} as unknown as ComputeSdkSandboxOf<ReturnType<typeof e2bSpec>["compute"]>;

		expect(await execE2bCommandAsRoot(wrapper, "id -u")).toEqual({
			exitCode: 0,
			stdout: "0\n",
			stderr: "",
		});
		expect(await launchE2bCommandAsRoot(wrapper, "daemon")).toBeUndefined();
		expect(calls).toEqual([
			["id -u", { user: "root", background: false }],
			["daemon", { user: "root", background: true }],
		]);
	});

	test("uses public E2B error fields only for genuine nonzero foreground exits", async () => {
		const failure = new CommandExitError({ exitCode: 23, stdout: "", stderr: "command failed" });
		const wrapper = {
			getInstance: () => ({ commands: { run: async () => Promise.reject(failure) } }),
		} as unknown as Parameters<typeof execE2bCommandAsRoot>[0];
		expect(await execE2bCommandAsRoot(wrapper, "false")).toEqual({
			exitCode: 23,
			stdout: "",
			stderr: "command failed",
		});

		const foreignFailure = {
			name: "CommandExitError",
			exitCode: 29,
			stdout: "foreign stdout",
			stderr: "foreign stderr",
		};
		const foreignWrapper = {
			getInstance: () => ({ commands: { run: async () => Promise.reject(foreignFailure) } }),
		} as unknown as Parameters<typeof execE2bCommandAsRoot>[0];
		expect(await execE2bCommandAsRoot(foreignWrapper, "false")).toEqual({
			exitCode: 29,
			stdout: "foreign stdout",
			stderr: "foreign stderr",
		});
	});

	test("only a provably refused E2B request is definitive; everything unproven stays ambiguous", () => {
		expect(isE2bDefinitiveCreateRejection(new AuthenticationError("invalid api key"))).toBe(true);
		expect(isE2bDefinitiveCreateRejection(new InvalidArgumentError("bad template"))).toBe(true);
		expect(
			isE2bDefinitiveCreateRejection(
				new Error("E2B authentication failed. Please check your E2B_API_KEY environment variable."),
			),
		).toBe(true);
		// The wrapper may wrap the SDK error, so a bounded cause walk still recognizes the rejection.
		expect(
			isE2bDefinitiveCreateRejection(
				new Error("computesdk create failed", {
					cause: new AuthenticationError("invalid api key"),
				}),
			),
		).toBe(true);
		// A lost response after remote acceptance is exactly the case reconciliation exists for.
		expect(isE2bDefinitiveCreateRejection(new TimeoutError("request timed out"))).toBe(false);
		expect(
			isE2bDefinitiveCreateRejection(new Error("Failed to create E2B sandbox: request timed out")),
		).toBe(false);
		expect(isE2bDefinitiveCreateRejection(new Error("socket hang up"))).toBe(false);
		expect(isE2bDefinitiveCreateRejection(undefined)).toBe(false);
		// A self-referential cause must terminate rather than spin.
		const looping = new Error("looping");
		Object.defineProperty(looping, "cause", { value: looping });
		expect(isE2bDefinitiveCreateRejection(looping)).toBe(false);
	});

	test("only typed rate-limit signals are retryable creates; prose is not", () => {
		expect(isE2bRetryableCreate(new RateLimitError("too many sandboxes"))).toBe(true);
		expect(
			isE2bRetryableCreate(
				new Error("computesdk create failed", { cause: new RateLimitError("too many sandboxes") }),
			),
		).toBe(true);
		expect(
			isE2bRetryableCreate(Object.assign(new Error("wrapper copy"), { name: "RateLimitError" })),
		).toBe(true);
		expect(isE2bRetryableCreate(Object.assign(new Error("throttled"), { status: 429 }))).toBe(true);
		// The pinned wrapper erases the SDK class and the cause, so its own complete envelope is the
		// only signal a real rate limit leaves behind on the path this driver creates through.
		expect(isE2bRetryableCreate(new Error(E2B_WRAPPER_CAPACITY_CREATE_MESSAGE))).toBe(true);
		expect(isE2bRetryableCreate(new Error("429 Too Many Requests"))).toBe(false);
		expect(isE2bRetryableCreate(new Error("quota|rate limit|capacity"))).toBe(false);
		expect(isE2bRetryableCreate(new Error("E2B quota exceeded elsewhere"))).toBe(false);
		expect(isE2bRetryableCreate(new TimeoutError("request timed out"))).toBe(false);
		expect(isE2bRetryableCreate(new AuthenticationError("invalid api key"))).toBe(false);
		expect(isE2bRetryableCreate(undefined)).toBe(false);
		const looping = new Error("looping");
		Object.defineProperty(looping, "cause", { value: looping });
		expect(isE2bRetryableCreate(looping)).toBe(false);
	});

	test("the pinned wrapper still throws the envelopes both classifiers match", () => {
		// Classification of a create failure rests on these exact strings, because the wrapper's create
		// catch discards the SDK error class and its cause. Read the installed build rather than trust
		// the constant: a catalog bump that reworded an envelope would otherwise turn every auth
		// rejection into a recovery lookup and every rate limit into a terminal failure, silently.
		const wrapper = readFileSync(fileURLToPath(import.meta.resolve("@computesdk/e2b")), "utf8");
		for (const envelope of [
			...E2B_WRAPPER_DEFINITIVE_CREATE_MESSAGES,
			E2B_WRAPPER_CAPACITY_CREATE_MESSAGE,
		]) {
			expect(wrapper).toContain(envelope);
		}
	});
});
