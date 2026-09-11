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

test("native background commands acknowledge launch before the workload finishes", async () => {
	const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "native-launch-"));
	const done = join(root, "done");
	const compute = nativeSdkCompute(
		async () => ({ id: "sandbox-1" }),
		() => ({
			sandboxId: "sandbox-1",
			runCommand: async (command) => ({
				exitCode: await Bun.spawn(["sh", "-c", command], { stdout: "ignore", stderr: "ignore" })
					.exited,
			}),
			destroy: async () => {},
		}),
	);
	try {
		const sandbox = await compute.sandbox.create(undefined);
		await sandbox.runCommand(`sleep 0.5; touch '${done}'`, { background: true });
		expect(existsSync(done)).toBe(false);
		await Bun.sleep(700);
		expect(existsSync(done)).toBe(true);
	} finally {
		await Bun.sleep(700);
		rmSync(root, { recursive: true, force: true });
	}
});
