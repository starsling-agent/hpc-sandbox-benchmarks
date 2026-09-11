import { describe, expect, test } from "bun:test";
import { isDriverError } from "@sandbox-benchmarks/driver";
import { App, Image, ModalClient } from "modal";
import { createModalAllocation } from "./allocation.ts";

function configuration(gpu?: string) {
	const client = new ModalClient({ tokenId: "test-token", tokenSecret: "test-secret" });
	return {
		client,
		app: new App("ap-prepared", "allocation-test"),
		image: new Image(client, "im-prepared", ""),
		options: {
			cpu: 0.25,
			cpuLimit: 2,
			memoryMiB: 128,
			memoryLimitMiB: 512,
			timeoutMs: 300000,
			gpu,
			env: { WORKLOAD: "test" },
		},
	};
}

describe("prepared Modal allocation", () => {
	test("preserves fractional reservations, separate limits, GPU count and prepared image identity", () => {
		const configured = createModalAllocation(configuration("T4:2"));
		expect(configured.request).toEqual({
			spec: { vcpus: 0.25, memoryGb: 0.125 },
			artifact: { kind: "built", ref: "im-prepared" },
			gpu: { model: "T4", count: 2 },
			env: { WORKLOAD: "test" },
		});
		expect(configured.module.id).toBe("modal-gvisor");
		expect(configured.module.execution.syncCapMs).toBeNull();
	});
	test("rejects conflicting canonical requests before making a vendor call", async () => {
		const configured = createModalAllocation(configuration("T4"));
		for (const input of [
			{ ...configured.request, spec: { vcpus: 1, memoryGb: 0.125 } },
			{ ...configured.request, gpu: { model: "T4", count: 2 } },
			{ ...configured.request, env: { WORKLOAD: "other" } },
		]) {
			try {
				await configured.driver.create({ ...input, deadlineMs: 1000 });
				throw new Error("accepted conflicting input");
			} catch (error) {
				expect(isDriverError(error) && error.code).toBe("invalid-create-request");
			}
		}
	});
	test("requires a recovery name and a resolved image before allocation", () => {
		const options = configuration();
		expect(() => createModalAllocation({ ...options, app: new App("ap-unnamed") })).toThrow(
			"named app",
		);
		expect(() =>
			createModalAllocation({
				...options,
				image: options.client.images.fromRegistry("ubuntu:24.04"),
			}),
		).toThrow();
	});
});
