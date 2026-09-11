import { describe, expect, it } from "bun:test";
import type { ExecOptions as NativeExecOptions, Sandbox, SandboxState } from "@run-cloud/sdk";
import { RunCloudError } from "@run-cloud/sdk";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import {
	FailedCreateCleanupError,
	isRetryableDriverCreate,
	sandboxRef,
} from "@sandbox-benchmarks/driver";
import { driverFromComputeSpec } from "@sandbox-benchmarks/driver/computesdk";
import type { RuncloudSpecOptions } from "./index.ts";
import runcloudDriver, {
	RUNCLOUD_CREATE_BUDGET,
	RUNCLOUD_CREATE_CEILING_MS,
	RUNCLOUD_EXECUTION,
	RUNCLOUD_PROVENANCE,
	RUNCLOUD_READINESS,
	RUNCLOUD_RECOVERY_NAME_PREFIX,
	RUNCLOUD_SANDBOX_LIFETIME_SECS,
	RuncloudAmbiguousCreateError,
	RuncloudBootFailureError,
	RuncloudCallTimeoutError,
	runcloudObservation,
	runcloudSpec,
} from "./index.ts";

type NativeClient = NonNullable<RuncloudSpecOptions["client"]>;

const context = {
	env: { RUN_CLOUD_API_KEY: "rc_test-key" },
	artifact: { kind: "image" },
	resolvedArtifact: { kind: "image", ref: "ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v1" },
} as const;

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: context.resolvedArtifact,
	deadlineMs: 300_000,
};

function nativeSandbox(state: SandboxState = "running", overrides: Partial<Sandbox> = {}): Sandbox {
	return {
		id: "sb-test",
		state,
		image: context.resolvedArtifact.ref,
		region: "us-west",
		sizeClass: "custom",
		milliCpu: 4_000,
		memMb: 8_192,
		warmStart: false,
		timeoutSeconds: RUNCLOUD_SANDBOX_LIFETIME_SECS,
		createdAt: "2026-08-03T00:00:00.000Z",
		...overrides,
	};
}

/** The df probe answers 80 GiB unless a test overrides exec; everything else exits 0 silently. */
function nativeClient(overrides: Partial<NativeClient> = {}): NativeClient {
	const removed = new Set<string>();
	return {
		create: async () => nativeSandbox(),
		get: async (id) => nativeSandbox(removed.has(id) ? "destroyed" : "running", { id }),
		list: async () => [],
		exec: async (_id, command) => ({
			stdout: String(command).startsWith("df -Pk") ? `${80 * 1024 * 1024}\n` : "",
			stderr: "",
			exit_code: 0,
			exitCode: 0,
		}),
		...overrides,
		destroy: async (id) => {
			await overrides.destroy?.(id);
			removed.add(id);
		},
	} as NativeClient;
}

/** Fast seams: no real sleeps, tight bounds, and no absence-confirmation wait in the bridge. */
function fast(client: NativeClient, seams: RuncloudSpecOptions = {}): RuncloudSpecOptions {
	return {
		client,
		readyPollMs: 0,
		reconcileRetryMs: 0,
		cleanupRetryMs: 0,
		recoveryAbsenceConfirmationMs: 1,
		sleep: async () => {},
		...seams,
	};
}

function driver(client: NativeClient, seams: RuncloudSpecOptions = {}) {
	return driverFromComputeSpec(
		"runcloud",
		runcloudSpec(context, fast(client, seams)),
		context.resolvedArtifact,
		[context.env.RUN_CLOUD_API_KEY],
	);
}

/** The exact create options the module maps for the benchmark request. */
function mapped(seams: RuncloudSpecOptions = {}) {
	return runcloudSpec(context, fast(nativeClient(), seams)).createOptions.map(request, (detail) => {
		throw new Error(detail);
	});
}

describe("run.cloud module policy", () => {
	it("declares provenance, readiness, execution, the create ceiling, and cost evidence", () => {
		expect(runcloudDriver.id).toBe("runcloud");
		expect(runcloudDriver.provenance).toEqual(RUNCLOUD_PROVENANCE);
		expect(runcloudDriver.readiness).toEqual(RUNCLOUD_READINESS);
		expect(runcloudDriver.execution).toEqual(RUNCLOUD_EXECUTION);
		expect(runcloudDriver.createBudget).toEqual(RUNCLOUD_CREATE_BUDGET);
		expect(RUNCLOUD_CREATE_CEILING_MS).toBeGreaterThan(20 * 60_000);
		expect(runcloudDriver.costEvidence?.sdk).toEqual(RUNCLOUD_PROVENANCE);
	});

	it("records explicit missing cost evidence without calling organization-wide APIs", async () => {
		const capture = runcloudDriver.costEvidence?.captureAfterTeardown;
		if (!capture) throw new Error("run.cloud declares no cost evidence");
		const cell = { runId: "run-1", providerId: "runcloud", suite: "cpu-node" } as const;
		const completed = await capture({
			cell,
			providerId: "runcloud",
			sandboxId: "sb-123",
			teardown: {
				completed: true,
				attemptedAt: "2026-08-08T00:00:00.000Z",
				completedAt: "2026-08-08T00:00:01.000Z",
			},
		});
		expect(completed).toMatchObject({ kind: "missing", reason: "not_sandbox_scoped" });
		if (completed.kind !== "missing") throw new Error("run.cloud hook returned observed evidence");
		expect(completed.detail).toContain("was not called or delta-attributed");
		expect(
			await capture({
				cell,
				providerId: "runcloud",
				sandboxId: "sb-123",
				teardown: { completed: false, attemptedAt: "2026-08-08T00:00:00.000Z" },
			}),
		).toMatchObject({ kind: "missing", reason: "sandbox_teardown_unconfirmed" });
	});

	it("maps the benchmark request onto the native create with the name as idempotency key", async () => {
		let createInput: Record<string, unknown> | undefined;
		const states = [nativeSandbox("building_image"), nativeSandbox("running")];
		const client = nativeClient({
			create: async (input) => {
				createInput = input as Record<string, unknown>;
				return nativeSandbox("building_image");
			},
			get: async () => states.shift() ?? nativeSandbox("running"),
		});
		const session = await driver(client).create(request);
		expect(session.sandboxRef).toEqual(sandboxRef("runcloud", "sb-test"));
		expect(createInput).toEqual({
			idempotencyKey: expect.stringMatching(
				new RegExp(`^${RUNCLOUD_RECOVERY_NAME_PREFIX}-[0-9a-f-]{36}$`),
			),
			name: expect.stringMatching(new RegExp(`^${RUNCLOUD_RECOVERY_NAME_PREFIX}-[0-9a-f-]{36}$`)),
			image: context.resolvedArtifact.ref,
			cpu: 4,
			memory: 8_192,
			disk: 40,
			idlePauseSeconds: RUNCLOUD_SANDBOX_LIFETIME_SECS,
			timeoutSeconds: RUNCLOUD_SANDBOX_LIFETIME_SECS,
		});
		expect(createInput?.idempotencyKey).toBe(createInput?.name);
		// Readiness waited through the transitional state before the session was handed out.
		expect(states).toHaveLength(0);
	});

	it("rejects artifact drift before allocation and verifies the allocation afterwards", async () => {
		let createCalls = 0;
		const destroyed: string[] = [];
		const client = nativeClient({
			create: async () => {
				createCalls++;
				return nativeSandbox("running", { milliCpu: 2_000 });
			},
			// Readiness re-reads the record, so the fresh read must report the same undersized core.
			get: async () =>
				nativeSandbox(destroyed.length ? "destroyed" : "running", { milliCpu: 2_000 }),
			destroy: async (id) => {
				destroyed.push(id);
			},
		});
		const d = driver(client);
		await expect(
			d.create({ ...request, artifact: { kind: "image", ref: "ghcr.io/other:latest" } }),
		).rejects.toMatchObject({ code: "invalid-create-request", provider: "runcloud" });
		expect(createCalls).toBe(0);
		// An allocation that reports fewer cores than requested is torn down, not measured.
		await expect(d.create(request)).rejects.toMatchObject({ code: "invalid-create-request" });
		expect(destroyed).toEqual(["sb-test"]);
	});

	it("allows the filesystem's own overhead on the disk quota but not a smaller allocation", async () => {
		const withDisk = (capacityGb: number) =>
			nativeClient({
				exec: async () => ({
					stdout: `${Math.round(capacityGb * 1024 * 1024)}\n`,
					stderr: "",
					exit_code: 0,
					exitCode: 0,
				}),
			});
		// Measured live: a 40 GiB request formats to 39.30 GiB of ext4.
		const session = await driver(withDisk(39.3)).create(request);
		expect(session.sandboxRef.id).toBe("sb-test");
		const error = await driver(withDisk(30))
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "invalid-create-request", provider: "runcloud" });
		expect((error as Error).message).toContain(
			"requested 40 GiB but the allocation exposes 30.00 GiB",
		);
	});
});

describe("run.cloud readiness and failed-create cleanup", () => {
	/** A create accepted whose readiness lands in `state`; `get` reports `destroyed` once destroy ran. */
	const bootingTo = (state: SandboxState, destroy: NativeClient["destroy"] = async () => {}) => {
		let torndown = false;
		return nativeClient({
			create: async () => nativeSandbox("building_image"),
			get: async () => nativeSandbox(torndown ? "destroyed" : state),
			destroy: async (id) => {
				await destroy(id);
				torndown = true;
			},
		});
	};

	it.each([
		"interrupted",
		"failed",
		"destroying",
	] as const)("marks a host-side boot failure (%s) retryable once the allocation is confirmed gone", async (state) => {
		const destroyed: string[] = [];
		const error = await driver(
			bootingTo(state, async (id) => {
				destroyed.push(id);
			}),
		)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "runcloud" });
		expect((error as Error).message).toContain(`entered terminal state "${state}"`);
		expect(destroyed).toEqual(["sb-test"]);
		expect(isRetryableDriverCreate(error)).toBe(true);
	});

	it("leaves a boot failure unmarked when teardown cannot be confirmed", async () => {
		// destroy resolving is a request accepted, not a microVM removed; a control plane that keeps
		// reporting `interrupted` has not established the "nothing is allocated" half of the mark.
		const client = nativeClient({
			create: async () => nativeSandbox("building_image"),
			get: async () => nativeSandbox("interrupted"),
		});
		const error = await driver(client)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed" });
		expect(isRetryableDriverCreate(error)).toBe(false);
	});

	it("leaves a clean stop unmarked — it says nothing about the host giving up", async () => {
		const error = await driver(bootingTo("stopped"))
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed" });
		expect((error as Error).message).toContain('entered terminal state "stopped"');
		expect(isRetryableDriverCreate(error)).toBe(false);
	});

	it("destroys the allocation when a readiness poll throws or the wait times out", async () => {
		const destroyed: string[] = [];
		const throwing = nativeClient({
			create: async () => nativeSandbox("building_image"),
			get: async () => {
				if (destroyed.length > 0) return nativeSandbox("destroyed");
				throw new Error("readiness failed");
			},
			destroy: async (id) => {
				destroyed.push(id);
			},
		});
		await expect(driver(throwing).create(request)).rejects.toThrow(/readiness failed/);
		let now = 0;
		const stalled = nativeClient({
			create: async () => nativeSandbox("building_image"),
			get: async () => nativeSandbox(destroyed.length > 1 ? "destroyed" : "building_image"),
			destroy: async (id) => {
				destroyed.push(id);
			},
		});
		const error = await driver(stalled, { readyTimeoutMs: 10, now: () => (now += 5) })
			.create(request)
			.catch((caught: unknown) => caught);
		expect((error as Error).message).toMatch(/not running after 10ms/);
		// A readiness timeout proved nothing about the host, so it is never marked retryable.
		expect(isRetryableDriverCreate(error)).toBe(false);
		expect(destroyed).toEqual(["sb-test", "sb-test"]);
	});

	it("bounds a hung readiness request and still awaits cleanup", async () => {
		const destroyed: string[] = [];
		const client = nativeClient({
			create: async () => nativeSandbox("building_image"),
			get: () =>
				destroyed.length
					? Promise.resolve(nativeSandbox("destroyed"))
					: new Promise<Sandbox>(() => {}),
			destroy: async (id) => {
				destroyed.push(id);
			},
		});
		const error = await driver(client, { controlPlaneTimeoutMs: 5 })
			.create(request)
			.catch((caught: unknown) => caught);
		expect((error as Error).message).toMatch(/readiness get for sandbox sb-test did not settle/);
		expect(isRetryableDriverCreate(error)).toBe(false);
		expect(destroyed).toEqual(["sb-test"]);
	});

	it("retries a transient cleanup, accepts a destroying confirmation, and surfaces exhaustion", async () => {
		let destroyCalls = 0;
		const transient = nativeClient({
			create: async () => nativeSandbox("building_image"),
			get: async () => {
				throw new Error("readiness failed");
			},
			destroy: async () => {
				destroyCalls++;
				if (destroyCalls === 1) throw new Error("transient cleanup failure");
			},
		});
		await expect(driver(transient, { cleanupAttempts: 2 }).create(request)).rejects.toThrow(
			/readiness failed/,
		);
		expect(destroyCalls).toBe(2);

		let getCalls = 0;
		destroyCalls = 0;
		const ambiguous = nativeClient({
			create: async () => nativeSandbox("building_image"),
			get: async () => {
				getCalls++;
				if (getCalls === 1) throw new Error("readiness failed");
				return nativeSandbox("destroying");
			},
			destroy: async () => {
				destroyCalls++;
				throw new Error("response lost after request");
			},
		});
		await expect(driver(ambiguous, { cleanupAttempts: 3 }).create(request)).rejects.toThrow(
			/readiness failed/,
		);
		expect(destroyCalls).toBe(1);
		expect(getCalls).toBe(2);

		destroyCalls = 0;
		let requestedName: string | undefined;
		const exhausted = nativeClient({
			create: async (input) => {
				requestedName = input?.name;
				return nativeSandbox("building_image");
			},
			get: async () => {
				throw new Error("readiness failed");
			},
			// The allocation is still there for every lookup, the module's and the kit's alike.
			list: async () => [nativeSandbox("interrupted", { name: requestedName })],
			destroy: async () => {
				destroyCalls++;
				throw new Error("cleanup failed");
			},
		});
		const error = await driver(exhausted, { cleanupAttempts: 3 })
			.create(request)
			.catch((caught: unknown) => caught);
		// The kit retains the double fault: it names the sandbox and never claims it is gone.
		expect(error).toBeInstanceOf(FailedCreateCleanupError);
		expect(isRetryableDriverCreate(error)).toBe(false);
		// Three module attempts, then one per kit recovery attempt — never a replayed create.
		expect(destroyCalls).toBeGreaterThanOrEqual(3);
	});
});

describe("run.cloud ambiguous-create reconciliation", () => {
	it("adopts the allocation when the create response is lost, without replaying the create", async () => {
		let createCalls = 0;
		let requestedName: string | undefined;
		const listedNames: Array<string | undefined> = [];
		const destroyed: string[] = [];
		const client = nativeClient({
			create: (input) => {
				createCalls++;
				requestedName = input?.name;
				return new Promise<Sandbox>(() => {});
			},
			list: async (options) => {
				listedNames.push(options?.name);
				return [nativeSandbox("running", { name: requestedName })];
			},
			destroy: async (id) => {
				destroyed.push(id);
			},
		});
		const session = await driver(client, { controlPlaneTimeoutMs: 5 }).create(request);
		expect(session.sandboxRef.id).toBe("sb-test");
		expect(createCalls).toBe(1);
		expect(listedNames).toEqual([requestedName]);
		expect(destroyed).toEqual([]);
	});

	it("adopts after an ambiguous 5xx, a hidden conflict, and the oldest of duplicate matches", async () => {
		for (const status of [503, 409]) {
			let requestedName: string | undefined;
			const client = nativeClient({
				create: async (input) => {
					requestedName = input?.name;
					throw new RunCloudError(status, "response lost after allocation");
				},
				list: async () => [
					nativeSandbox("running", {
						id: "sb-newer",
						name: requestedName,
						createdAt: "2026-08-03T00:00:05.000Z",
					}),
					nativeSandbox("running", {
						id: "sb-older",
						name: requestedName,
						createdAt: "2026-08-03T00:00:00.000Z",
					}),
				],
			});
			expect((await driver(client).create(request)).sandboxRef.id).toBe("sb-older");
		}
	});

	it("marks a stalled create retryable only once absence is established, keeping the original error", async () => {
		let listCalls = 0;
		const client = nativeClient({
			create: () => new Promise<Sandbox>(() => {}),
			list: async () => {
				listCalls++;
				return [];
			},
		});
		const error = await driver(client, { controlPlaneTimeoutMs: 5, reconcileAttempts: 3 })
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed", provider: "runcloud" });
		expect((error as Error).message).toContain("run.cloud create did not settle within 5ms");
		expect((error as Error).message).not.toMatch(/manual cleanup/);
		// A stall that allocated nothing is this control plane reporting saturation without a 429.
		expect(isRetryableDriverCreate(error)).toBe(true);
		// The module's window plus the bridge's own confirming lookups, never a replayed create.
		expect(listCalls).toBeGreaterThanOrEqual(3);
	});

	it("never marks a generic failure, a definitive rejection, or an unanswered window", async () => {
		const generic = nativeClient({
			create: async () => {
				throw new Error("client serialization failed");
			},
		});
		const genericError = await driver(generic, { reconcileAttempts: 1 })
			.create(request)
			.catch((caught: unknown) => caught);
		expect((genericError as Error).message).toContain("client serialization failed");
		expect(isRetryableDriverCreate(genericError)).toBe(false);

		let listCalls = 0;
		const definitive = nativeClient({
			create: async () => {
				throw new RunCloudError(422, "invalid image");
			},
			list: async () => {
				listCalls++;
				return [];
			},
		});
		const definitiveError = await driver(definitive)
			.create(request)
			.catch((caught: unknown) => caught);
		expect((definitiveError as Error).message).toContain("invalid image");
		expect(isRetryableDriverCreate(definitiveError)).toBe(false);
		// A definitive 4xx gets ONE confirming pass (a rejection can still sit on a real allocation)
		// and the bridge skips its own recovery because the rejection is proof enough.
		expect(listCalls).toBe(1);

		const unanswered = nativeClient({
			create: () => new Promise<Sandbox>(() => {}),
			list: async () => {
				throw new Error("control plane unavailable");
			},
		});
		const unansweredError = await driver(unanswered, {
			controlPlaneTimeoutMs: 5,
			reconcileAttempts: 2,
		})
			.create(request)
			.catch((caught: unknown) => caught);
		// Absence was never established, so the kit keeps the double fault: not retryable, and the
		// recovery name survives for an operator sweep.
		expect(unansweredError).toBeInstanceOf(FailedCreateCleanupError);
		expect(isRetryableDriverCreate(unansweredError)).toBe(false);
	});

	it("keeps a 429 retryable through the typed status alone", async () => {
		const client = nativeClient({
			create: async () => {
				throw new RunCloudError(429, "too many sandboxes");
			},
		});
		const error = await driver(client)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "create-failed" });
		expect(isRetryableDriverCreate(error)).toBe(true);
	});

	it("keeps asking through failed lookups, ignores tombstones and fuzzy matches", async () => {
		let requestedName: string | undefined;
		let listCalls = 0;
		const eventually = nativeClient({
			create: async (input) => {
				requestedName = input?.name;
				throw new RunCloudError(503, "response lost after allocation");
			},
			list: async () => {
				listCalls++;
				if (listCalls === 1) throw new Error("control plane unavailable");
				if (listCalls === 2) return [];
				return [nativeSandbox("running", { name: requestedName })];
			},
		});
		expect((await driver(eventually, { reconcileAttempts: 4 }).create(request)).sandboxRef.id).toBe(
			"sb-test",
		);
		expect(listCalls).toBe(3);

		const unrelated = nativeClient({
			create: async (input) => {
				requestedName = input?.name;
				throw new RunCloudError(503, "response lost after allocation");
			},
			list: async () => [
				nativeSandbox("destroyed", { id: "sb-tombstone", name: requestedName }),
				nativeSandbox("destroying", { id: "sb-going", name: requestedName }),
				nativeSandbox("running", { id: "sb-other", name: `${requestedName}-different` }),
			],
		});
		await expect(driver(unrelated, { reconcileAttempts: 2 }).create(request)).rejects.toThrow(
			/response lost after allocation/,
		);
	});

	it("exposes the module verdicts the bridge classifies from", () => {
		const spec = runcloudSpec(context, fast(nativeClient()));
		const recovery = spec.createRecovery;
		if (!recovery) throw new Error("run.cloud declares no create recovery");
		expect(recovery.locator(mapped())).toEqual({
			kind: "name",
			value: expect.stringMatching(new RegExp(`^${RUNCLOUD_RECOVERY_NAME_PREFIX}-`)),
		});
		expect(recovery.isDefinitive?.(new RunCloudError(422, "bad"))).toBe(true);
		expect(recovery.isDefinitive?.(new RunCloudError(409, "conflict"))).toBe(false);
		expect(recovery.isDefinitive?.(new RunCloudError(408, "slow"))).toBe(false);
		expect(recovery.isDefinitive?.(new RuncloudBootFailureError("sb", "failed", true, true))).toBe(
			true,
		);
		expect(recovery.isDefinitive?.(new RuncloudBootFailureError("sb", "failed", true, false))).toBe(
			false,
		);
		expect(recovery.isRetryableCreate?.(new RuncloudCallTimeoutError("create", 5))).toBe(true);
		expect(
			recovery.isRetryableCreate?.(new RuncloudCallTimeoutError("destroy sandbox sb", 5)),
		).toBe(false);
		expect(recovery.isRetryableCreate?.(new RunCloudError(429, "quota"))).toBe(true);
		expect(recovery.isRetryableCreate?.(new Error("HTTP 429 in prose"))).toBe(false);
		expect(recovery.isRetryableCreate?.(new RuncloudAmbiguousCreateError("n", 1, 2))).toBe(false);
	});
});

describe("run.cloud commands, lifecycle, and account inventory", () => {
	it("passes commands straight to the native exec and preserves non-zero exits", async () => {
		const execCalls: Array<{ command: string; options: NativeExecOptions }> = [];
		const client = nativeClient({
			exec: async (_id, command, options = {}) => {
				execCalls.push({ command: String(command), options });
				if (String(command).startsWith("df -Pk"))
					return { stdout: `${80 * 1024 * 1024}\n`, stderr: "", exit_code: 0, exitCode: 0 };
				return { stdout: "out", stderr: "err", exit_code: 7, exitCode: 7 };
			},
		});
		const session = await driver(client).create(request);
		const result = await session.exec("printf test");
		expect(result).toMatchObject({
			exit: { kind: "exited", code: 7 },
			stdout: "out",
			stderr: "err",
		});
		// The first exec was the disk probe issued during create verification.
		expect(execCalls.at(-1)?.command).toBe("printf test");
	});

	it("waits for an accepted DELETE to stop running and refuses unconfirmed removal", async () => {
		let observations = 0;
		const delayed = nativeClient({
			get: async () => nativeSandbox(++observations < 3 ? "running" : "destroying"),
		});
		await driver(delayed).destroyById?.(sandboxRef("runcloud", "sb-delayed"));
		expect(observations).toBe(3);
		const stuck = nativeClient({ get: async () => nativeSandbox("running") });
		await expect(
			driver(stuck, { cleanupAttempts: 2 }).destroyById?.(sandboxRef("runcloud", "sb-stuck")),
		).rejects.toMatchObject({ code: "destroy-failed" });
	});

	it("destroys by canonical id, converges on 404, and reads tombstones as absence", async () => {
		const destroyed: string[] = [];
		const client = nativeClient({
			destroy: async (id) => {
				destroyed.push(id);
				if (id === "sb-gone") throw new RunCloudError(404, "gone");
				if (id === "sb-broken") throw new RunCloudError(503, "control plane unavailable");
			},
			get: async (id) => {
				if (id === "sb-gone") throw new RunCloudError(404, "gone");
				return nativeSandbox(id === "sb-tombstone" ? "destroyed" : "destroying", { id });
			},
		});
		const d = driver(client);
		await d.destroyById?.(sandboxRef("runcloud", "sb-leftover"));
		await d.destroyById?.(sandboxRef("runcloud", "sb-gone"));
		await expect(d.destroyById?.(sandboxRef("runcloud", "sb-broken"))).rejects.toMatchObject({
			code: "destroy-failed",
			provider: "runcloud",
		});
		expect(destroyed).toEqual(["sb-leftover", "sb-gone", "sb-broken"]);
		expect(await d.probes?.observe(sandboxRef("runcloud", "sb-gone"))).toEqual({ state: "absent" });
		expect(await d.probes?.observe(sandboxRef("runcloud", "sb-tombstone"))).toEqual({
			state: "absent",
		});
		expect(await d.probes?.observe(sandboxRef("runcloud", "sb-going"))).toEqual({
			state: "terminal",
		});
		expect(runcloudObservation("running")).toEqual({ state: "running" });
		expect(runcloudObservation("building_image")).toEqual({ state: "running" });
		expect(runcloudObservation("stopped")).toEqual({ state: "terminal" });
	});

	it("owns sandboxes by the benchmark name prefix and skips tombstones in the account sweep", async () => {
		const client = nativeClient({
			list: async () => [
				nativeSandbox("running", { id: "ours-1", name: `${RUNCLOUD_RECOVERY_NAME_PREFIX}-a` }),
				nativeSandbox("paused", { id: "ours-2", name: `${RUNCLOUD_RECOVERY_NAME_PREFIX}-b` }),
				nativeSandbox("destroyed", { id: "gone", name: `${RUNCLOUD_RECOVERY_NAME_PREFIX}-c` }),
				nativeSandbox("running", { id: "theirs", name: "dev-box" }),
				nativeSandbox("stopped", { id: "unnamed", name: null }),
			],
		});
		expect(await driver(client).inventory?.list()).toEqual({
			owned: [sandboxRef("runcloud", "ours-1"), sandboxRef("runcloud", "ours-2")],
			foreignCount: 2,
		});
		const broken = nativeClient({ list: async () => ({ sandboxes: [] }) as never });
		await expect(driver(broken).inventory?.list()).rejects.toMatchObject({
			code: "probe-failed",
			provider: "runcloud",
		});
	});
});
