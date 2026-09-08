import { expect, test } from "bun:test";
import { type } from "arktype";
import { nativeSdkCompute } from "./_native.ts";

test("native projection preserves typed handles, create errors, and cancellation", async () => {
	const schema = type({ image: "string" });
	const native = { id: "sandbox-1", sdkOnly: () => 42 };
	const refusal = new Error("native refusal");
	let creates = 0;
	let shouldFail = false;
	const controller = new AbortController();
	const compute = nativeSdkCompute(
		(value) => schema.assert(value),
		async (options, operation) => {
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
	await expect(compute.sandbox.create({ image: 1 }, operation)).rejects.toThrow();
	expect(creates).toBe(2);
	controller.abort(new Error("cancelled"));
	await expect(compute.sandbox.create(options, operation)).rejects.toThrow("cancelled");
	expect(creates).toBe(2);
});
