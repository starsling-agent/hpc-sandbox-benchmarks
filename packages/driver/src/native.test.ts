import { expect, test } from "bun:test";
import { nativeSdkCompute } from "./native.ts";

test("native projection preserves typed handles, create errors, and cancellation", async () => {
	const native = { id: "sandbox-1", sdkOnly: () => 42 };
	const refusal = new Error("native refusal");
	let creates = 0;
	let shouldFail = false;
	const controller = new AbortController();
	const compute = nativeSdkCompute(
		async (options: { image: string }, operation) => {
			creates++;
			expect(options.image).toBe("image-1");
			expect(operation.signal).toBe(controller.signal);
			if (shouldFail) throw refusal;
			return native;
		},
		(handle) => ({
			sandboxId: handle.id,
			runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			destroy: async () => {},
		}),
	);
	const options = { image: "image-1" };
	const operation = { signal: controller.signal };
	const sandbox = await compute.sandbox.create(options, operation);
	expect(sandbox.getInstance()).toBe(native);
	expect(sandbox.getInstance().sdkOnly()).toBe(42);
	shouldFail = true;
	const caught = await compute.sandbox.create(options, operation).catch((error: unknown) => error);
	expect(caught).toBe(refusal);
	// @ts-expect-error The native SDK options survive through the adapter.
	const invalid: Parameters<typeof compute.sandbox.create>[0] = { image: 1 };
	void invalid;
	expect(creates).toBe(2);
	controller.abort(new Error("cancelled"));
	await expect(compute.sandbox.create(options, operation)).rejects.toThrow("cancelled");
	expect(creates).toBe(2);
});
