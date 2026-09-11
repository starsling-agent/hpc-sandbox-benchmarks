import { describe, expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import novita, { NOVITA_DOMAIN, novitaSpec } from "./novita.ts";

const { Sandbox, AuthenticationError, RateLimitError } = createRequire(import.meta.url)(
	"novita-sandbox",
) as typeof import("novita-sandbox");
const context = {
	env: { NOVITA_API_KEY: "nvta_test" },
	artifact: { kind: "baked" },
	resolvedArtifact: { kind: "baked", ref: "toolchain-test" },
} as const;
const request = {
	spec: { vcpus: 4, memoryGb: 8 },
	artifact: context.resolvedArtifact,
	deadlineMs: 300000,
};

describe("Novita native integration", () => {
	test("keeps the account credential in the regional control plane channel", async () => {
		const failure = new AuthenticationError("invalid test key");
		const create = spyOn(Sandbox, "create").mockRejectedValueOnce(failure);
		try {
			const driver = novita.driver(context);
			await expect(driver.create(request)).rejects.toThrow();
			expect(create).toHaveBeenCalledTimes(1);
			const options = create.mock.calls[0]?.[1];
			expect(options).toMatchObject({ apiKey: "nvta_test", domain: NOVITA_DOMAIN });
			expect(options).not.toHaveProperty("headers");
			expect(options).not.toHaveProperty("envs");
		} finally {
			create.mockRestore();
		}
	});
	test("rejects requests the baked artifact cannot honor before allocation", async () => {
		const create = spyOn(Sandbox, "create").mockClear();
		try {
			const driver = novita.driver(context);
			for (const input of [
				{ ...request, spec: { vcpus: 8, memoryGb: 8 } },
				{ ...request, artifact: { kind: "baked" as const, ref: "other" } },
				{ ...request, env: { OVERRIDE: "yes" } },
			])
				await expect(driver.create(input)).rejects.toThrow();
			expect(create).not.toHaveBeenCalled();
		} finally {
			create.mockRestore();
		}
	});
	test("classifies typed refusals independently from ambiguous transport failures", () => {
		const recovery = novitaSpec(context).createRecovery;
		if (!recovery) throw new Error("missing create recovery");
		expect(recovery.isDefinitive?.(new AuthenticationError("bad key"))).toBe(true);
		expect(recovery.isRetryableCreate?.(new RateLimitError("capacity"))).toBe(true);
		expect(recovery.isDefinitive?.(new Error("HTTP 429 response lost"))).toBe(false);
		expect(recovery.isRetryableCreate?.(new Error("capacity"))).toBe(false);
	});
	test("never tears down a recovery row belonging to another create attempt", async () => {
		const spec = novitaSpec(context);
		if (!spec.createRecovery) throw new Error("missing create recovery");
		const paginator = Sandbox.list({ apiKey: "nvta_test", domain: NOVITA_DOMAIN });
		const next = spyOn(paginator, "nextItems").mockResolvedValueOnce([
			{
				sandboxId: "iother",
				metadata: { "sandbox-benchmarks-attempt": "other" },
				templateId: "toolchain-test",
				startedAt: new Date(),
				endAt: new Date(),
				state: "running",
				cpuCount: 4,
				memoryMB: 8192,
				envdVersion: "0.0.0",
			},
		]);
		const list = spyOn(Sandbox, "list").mockReturnValueOnce(paginator);
		const kill = spyOn(Sandbox, "kill");
		try {
			await expect(
				spec.createRecovery.cleanup(
					spec.compute,
					{ kind: "marker", key: "sandbox-benchmarks-attempt", value: "wanted" },
					{},
				),
			).rejects.toThrow("unrelated sandbox");
			expect(kill).not.toHaveBeenCalled();
		} finally {
			next.mockRestore();
			list.mockRestore();
			kill.mockRestore();
		}
	});
});

describe("Novita account inventory and recovery", () => {
	function fakePaginator(pages: readonly unknown[]) {
		let index = 0;
		return {
			get hasNext() {
				return index < pages.length;
			},
			get nextToken() {
				return index < pages.length ? `page-${index + 1}` : undefined;
			},
			nextItems: async () => {
				const page = pages[index];
				index += 1;
				return page;
			},
		} as unknown as ReturnType<typeof Sandbox.list>;
	}

	test("drains every live page, owns by the attempt marker, and counts the rest as foreign", async () => {
		const list = spyOn(Sandbox, "list").mockReturnValueOnce(
			fakePaginator([
				[
					{ sandboxId: "owned-1", metadata: { "sandbox-benchmarks-attempt": "benchmark-a" } },
					{ sandboxId: "foreign-1", metadata: {} },
					{ sandboxId: "foreign-2" },
				],
				[{ sandboxId: "owned-2", metadata: { "sandbox-benchmarks-attempt": "benchmark-b" } }],
			]),
		);
		try {
			expect(await novita.driver(context).inventory?.list()).toEqual({
				owned: [
					{ provider: "novita", id: "owned-1" },
					{ provider: "novita", id: "owned-2" },
				],
				foreignCount: 2,
			});
			expect(list.mock.calls[0]?.[0]).toMatchObject({
				apiKey: "nvta_test",
				domain: NOVITA_DOMAIN,
				query: { state: ["running", "paused"] },
			});
		} finally {
			list.mockRestore();
		}
	});

	test("destroys by canonical id and converges only on Novita's own absence", async () => {
		const { SandboxNotFoundError } = createRequire(import.meta.url)(
			"novita-sandbox",
		) as typeof import("novita-sandbox");
		const kill = spyOn(Sandbox, "kill").mockResolvedValueOnce(true);
		try {
			const driver = novita.driver(context);
			await driver.destroyById?.({ provider: "novita", id: "leftover" });
			expect(kill).toHaveBeenCalledWith(
				"leftover",
				expect.objectContaining({ apiKey: "nvta_test" }),
			);
			kill.mockRejectedValueOnce(new SandboxNotFoundError("gone"));
			await driver.destroyById?.({ provider: "novita", id: "leftover" });
			kill.mockRejectedValueOnce(new Error("control plane unavailable"));
			await expect(
				driver.destroyById?.({ provider: "novita", id: "leftover" }),
			).rejects.toMatchObject({ code: "destroy-failed", provider: "novita" });
		} finally {
			kill.mockRestore();
		}
	});
});
