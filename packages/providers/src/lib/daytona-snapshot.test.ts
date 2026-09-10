// Offline (no creds, no network) verification of the inactive-snapshot recovery. The activation runs
// through the REAL SDK with the axios transport stubbed — the same seam daytona-target.test.ts uses —
// so the test proves the snapshot API is actually reached, and proves it stays best-effort when that
// call fails, which is the state the stub leaves it in.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SandboxMethods } from "@computesdk/provider";
import { Daytona } from "@daytonaio/sdk";
import type { DaytonaConfig } from "../config.ts";
import { daytonaActivateSnapshot } from "./daytona-snapshot.ts";
import { isRetryableCreateError } from "./retryable-create.ts";
import type { DirectProvider } from "./types.ts";

const CFG: DaytonaConfig = {
	apiKey: "fake-key-offline-test",
	target: "us-west-2",
	snapshot: "sandbox-benchmarks-toolchain-v8",
};

/** The message the control plane produced for every daytona-vm replicate of run 33712242440, as it
 *  reaches this wrapper through @computesdk/daytona's create-failure prefix. */
const INACTIVE = `Failed to create Daytona sandbox: Snapshot ${CFG.snapshot} is inactive`;

const captured: string[] = [];

/**
 * Stand in for the SDK's transport factory: record each request's URL, then fail it.
 *
 * Failing is deliberate — it leaves the activation in the state these tests care about (attempted,
 * unsuccessful), which is what proves the recovery stays best-effort and never replaces the control
 * plane's own create error with its own. The recorded URLs are how a test asserts the snapshot API
 * was reached at all.
 */
function stubAxios() {
	return {
		interceptors: { request: { use: () => 0 }, response: { use: () => 0 } },
		defaults: { headers: {} },
		request: async (requestConfig: { url?: string }) => {
			captured.push(requestConfig.url ?? "");
			throw new Error("transport stubbed: request captured");
		},
	};
}

const sdkClass = Daytona as unknown as { createAxiosInstance: () => unknown };
const stockAxiosFactory = sdkClass.createAxiosInstance;

type DaytonaCreate = SandboxMethods<unknown, unknown>["create"];

/**
 * A minimal stand-in for the wrapper's sandbox manager. It mirrors the one structural fact the patch
 * depends on: the public `create` dispatches through `methods.create` on every call, which is why
 * replacing the table takes effect at all. Only `create` is patched, so only `create` has to exist.
 */
function fakeProvider(create: DaytonaCreate): DirectProvider {
	const manager = {
		methods: { create },
		create: (...args: Parameters<DaytonaCreate>) => manager.methods.create(...args),
	};
	return { sandbox: manager } as unknown as DirectProvider;
}

describe("daytonaActivateSnapshot", () => {
	beforeAll(() => {
		sdkClass.createAxiosInstance = stubAxios;
	});
	afterAll(() => {
		sdkClass.createAxiosInstance = stockAxiosFactory;
	});
	beforeEach(() => {
		captured.length = 0;
	});

	/** A provider whose create fails the way the control plane failed every daytona-vm replicate. */
	const inactiveProvider = () =>
		daytonaActivateSnapshot(
			fakeProvider(async () => {
				throw new Error(INACTIVE);
			}),
			CFG,
		);

	it("marks an inactive-snapshot create retryable so the harness re-issues it", async () => {
		const error = await inactiveProvider()
			.sandbox.create()
			.catch((e: unknown) => e);
		expect((error as Error).message).toBe(INACTIVE);
		// Without the mark this is a permanent cell failure: the harness's classifier matches only
		// quota/rate-limit/capacity wording, and "is inactive" is none of those.
		expect(isRetryableCreateError(error)).toBe(true);
	});

	it("reaches the snapshot API for the configured snapshot", async () => {
		await inactiveProvider()
			.sandbox.create()
			.catch(() => undefined);
		expect(captured.some((url) => url.includes(CFG.snapshot))).toBe(true);
	});

	it("passes any other create failure through untouched", async () => {
		const other = new Error("Failed to create Daytona sandbox: quota exceeded");
		const provider = daytonaActivateSnapshot(
			fakeProvider(async () => {
				throw other;
			}),
			CFG,
		);

		const error = await provider.sandbox.create().catch((e: unknown) => e);
		expect(error).toBe(other);
		// Not this wrapper's business: the harness's own message classifier already covers quota, and
		// marking it here would claim "nothing was allocated" for a failure that never established it.
		expect(isRetryableCreateError(error)).toBe(false);
		expect(captured).toEqual([]);
	});

	it("leaves a successful create alone", async () => {
		const created = { sandbox: {}, sandboxId: "sb-ok" };
		const provider = daytonaActivateSnapshot(
			fakeProvider(async () => created as never),
			CFG,
		);

		expect(await provider.sandbox.create()).toBe(created as never);
		expect(captured).toEqual([]);
	});

	it("refuses to patch a wrapper whose manager no longer exposes create", () => {
		expect(() => daytonaActivateSnapshot({ sandbox: { methods: {} } } as never, CFG)).toThrow(
			/no patchable create method/,
		);
	});
});
