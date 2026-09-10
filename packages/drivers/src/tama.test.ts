import { describe, expect, test } from "bun:test";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { DriverError, driverFromTable } from "@sandbox-benchmarks/driver";
import type { CliRunner } from "@sandbox-benchmarks/driver/cli";
import { cliMethodTable } from "@sandbox-benchmarks/driver/cli";
import tamaDriver, {
	TAMA_CREATE_CEILING_MS,
	TAMA_EXECUTION,
	TAMA_MACHINE_NOT_FOUND,
	TAMA_MACHINES,
	TAMA_PROVENANCE,
	TAMA_REQUEST_COVERAGE,
	TAMA_SANDBOX_ID,
	tamaSpec,
} from "./tama.ts";

const context = {
	env: { TAMA_TOKEN: "tama_test-token", TAMA_CLI: "/opt/tama" },
	artifact: { kind: "image" },
	resolvedArtifact: { kind: "image", ref: "ghcr.io/starslingdev/toolchain:v1" },
} as const;

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: context.resolvedArtifact,
	deadlineMs: TAMA_CREATE_CEILING_MS,
};

const readyMachine = {
	id: "machine-obusdw8bsyw2",
	name: "bench-123",
	status: "ready",
	status_detail: "booted",
};

describe("Tama proof driver", () => {
	test("is one joined CLI module with truthful operation-specific budgets", () => {
		expect(tamaDriver.id).toBe("tama");
		expect(tamaDriver.createBudget).toEqual({
			owner: "driver",
			attemptCeilingMs: TAMA_CREATE_CEILING_MS,
		});
		expect(tamaDriver.provenance).toEqual(TAMA_PROVENANCE);
		expect(tamaDriver.readiness).toEqual({ startup: "create-returns-ready" });
		expect(tamaDriver.execution).toEqual(TAMA_EXECUTION);

		const spec = tamaSpec(context);
		expect(spec.binary).toBe("/opt/tama");
		expect(spec.commandTimeoutMs).toBe(60_000);
		expect(spec.createCommandTimeoutMs).toBe(20 * 60_000);
		expect(spec.requestCoverage).toEqual(TAMA_REQUEST_COVERAGE);
		expect(spec.prepare).toEqual({
			authenticateFirst: true,
			probe: ["list", "--all", "--json"],
			fallback: ["login", "--token", "tama_test-token"],
		});
	});

	test("translates the canonical request into the real Tama CLI contract", () => {
		const spec = tamaSpec(context);
		expect(spec.create(request, "bench-123")).toEqual([
			"new",
			"bench-123",
			"--ttl",
			"0",
			"--json",
			"--image",
			"ghcr.io/starslingdev/toolchain:v1",
			"--cpu",
			"4",
			"--memory",
			"8192",
		]);
		expect(spec.exec(readyMachine.id, "uname -a")).toEqual([
			"exec",
			readyMachine.id,
			"--",
			"bash",
			"-lc",
			"uname -a",
		]);
		expect(spec.destroy(readyMachine.id)).toEqual(["rm", "-y", readyMachine.id]);
		expect(() =>
			spec.create(
				{ ...request, artifact: { kind: "image", ref: "ghcr.io/other/image:v2" } },
				"bench-123",
			),
		).toThrow(/does not match the resolved Tama image/);
	});

	test("parses list output, validates real IDs, and reconciles by generated name", () => {
		const rows = TAMA_MACHINES.assert(
			JSON.stringify([{ ...readyMachine, cpu_millicores: 4_000, ignored_vendor_field: true }]),
		);
		const spec = tamaSpec(context);
		expect(rows).toHaveLength(1);
		const selected = spec.ready.select(rows, "bench-123");
		expect(selected).toMatchObject(readyMachine);
		expect(spec.cleanupCreated.kind).toBe("lookup");
		if (spec.cleanupCreated.kind === "lookup") {
			expect(spec.cleanupCreated.select(rows, "bench-123")).toBe(selected);
		}
		expect(TAMA_SANDBOX_ID.assert(readyMachine.id)).toBe(readyMachine.id);
		expect(() => TAMA_SANDBOX_ID.assert("m-test")).toThrow();
	});

	test("classifies ready, pending, and terminal rows without prose parsing in the kit", () => {
		const classify = tamaSpec(context).ready.classify;
		expect(classify(readyMachine)).toBe("ready");
		expect(classify({ ...readyMachine, status: "READY" })).toBe("ready");
		expect(classify({ ...readyMachine, status: "creating" })).toBe("pending");
		expect(classify({ ...readyMachine, status: "stopped" })).toEqual({
			terminal: "status=stopped (booted)",
			retryable: false,
		});
		expect(
			classify({ ...readyMachine, status: "failed", status_detail: "image pull failed" }),
		).toEqual({ terminal: "status=failed (image pull failed)", retryable: false });
	});

	test("uses the stock binary when no developer override is present", () => {
		expect(
			tamaSpec({
				...context,
				env: { TAMA_TOKEN: "tama_test-token" },
			}).binary,
		).toBe("tama");
	});

	test("rejects unsupported request axes before invoking the CLI", async () => {
		const calls: string[][] = [];
		const run: CliRunner = async (_binary, args) => {
			if (args[0] === "login") return { stdout: "", stderr: "", code: 0 };
			calls.push([...args]);
			return { stdout: "", stderr: "", code: 0 };
		};
		const driver = driverFromTable(
			cliMethodTable("tama", tamaSpec(context), {
				run,
				createAttemptCeilingMs: TAMA_CREATE_CEILING_MS,
			}),
			() => Promise.resolve({}),
		);
		const invalidRequests: CreateRequest[] = [
			{ ...request, spec: { ...request.spec, diskGb: 41 } },
			{ ...request, gpu: { model: "H100", count: 8 } },
			{ ...request, env: { SHOULD_EXIST: "yes" } },
		];
		for (const invalid of invalidRequests) {
			const error = await driver.create(invalid).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(DriverError);
			expect(error).toMatchObject({ code: "invalid-create-request", provider: "tama" });
		}
		expect(calls).toEqual([]);
	});

	test("the compiled CLI table owns create, observation, and idempotent destroy", async () => {
		let name = "";
		let destroyed = false;
		const run: CliRunner = async (_binary, args) => {
			if (args[0] === "login") return { stdout: "", stderr: "", code: 0 };
			if (args[0] === "new") {
				name = args[1] ?? "";
				return { stdout: "{}", stderr: "", code: 0 };
			}
			if (args[0] === "rm") {
				destroyed = true;
				return { stdout: "", stderr: "", code: 0 };
			}
			if (args[0] === "list") {
				return {
					stdout: JSON.stringify(destroyed || name === "" ? [] : [{ ...readyMachine, name }]),
					stderr: "",
					code: 0,
				};
			}
			throw new Error(`unexpected command ${args.join(" ")}`);
		};
		const driver = driverFromTable(
			cliMethodTable("tama", tamaSpec(context), {
				run,
				createAttemptCeilingMs: TAMA_CREATE_CEILING_MS,
			}),
			() => Promise.resolve({}),
		);
		const session = await driver.create(request);
		expect(await driver.probes?.observe(session.sandboxRef)).toEqual({ state: "running" });
		await session.destroy();
		expect(await driver.probes?.observe(session.sandboxRef)).toEqual({ state: "absent" });
	});

	test("serializes profile authentication across contexts and preserves a failed list without relogin", async () => {
		let active = 0;
		let peak = 0;
		const calls: string[] = [];
		const run: CliRunner = async (_binary, args) => {
			calls.push(args[0] ?? "");
			if (args[0] === "login") {
				peak = Math.max(peak, ++active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return { stdout: "", stderr: "", code: 0 };
			}
			return { stdout: "", stderr: "control plane unavailable", code: 1 };
		};
		const create = () =>
			driverFromTable(
				cliMethodTable("tama", tamaSpec(context), {
					run,
					createAttemptCeilingMs: TAMA_CREATE_CEILING_MS,
				}),
				async () => ({}),
			).create(request);
		const results = await Promise.allSettled([create(), create()]);
		expect(peak).toBe(1);
		expect(calls).toEqual(["login", "list", "login", "list"]);
		for (const result of results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected")
				expect(result.reason.vendorMessage).toContain("control plane unavailable");
		}
	});

	test("inventory distinguishes exact benchmark names from foreign machines", async () => {
		const rows = [
			{ ...readyMachine, name: "bench-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
			{ ...readyMachine, id: "machine-aaaaaaaaaaaa", name: "developer-machine" },
		];
		const run: CliRunner = async (_binary, args) => ({
			stdout: args[0] === "login" ? "" : JSON.stringify(rows),
			stderr: "",
			code: 0,
		});
		const driver = driverFromTable(
			cliMethodTable("tama", tamaSpec(context), { run }),
			async () => ({}),
		);
		expect(await driver.inventory?.list()).toEqual({
			owned: [{ provider: "tama", id: readyMachine.id }],
			foreignCount: 1,
		});
	});

	test("retains teardown ownership when an unrelated local dependency is not found", async () => {
		let name = "";
		let destroyAttempts = 0;
		const unrelatedFailures = [
			"credential helper not found",
			"machine credential helper not found",
			"machine image manifest not found",
			"machine profile not found",
			`machine ${readyMachine.id} not found\ntransport failed`,
			`error: machine ${readyMachine.id} not found\nerror: connection reset`,
		];
		const run: CliRunner = async (_binary, args) => {
			if (args[0] === "login") return { stdout: "", stderr: "", code: 0 };
			if (args[0] === "new") {
				name = args[1] ?? "";
				return { stdout: "{}", stderr: "", code: 0 };
			}
			if (args[0] === "list") {
				return {
					stdout: JSON.stringify(name === "" ? [] : [{ ...readyMachine, name }]),
					stderr: "",
					code: 0,
				};
			}
			if (args[0] === "rm") {
				destroyAttempts += 1;
				const unrelated = unrelatedFailures[destroyAttempts - 1];
				if (unrelated !== undefined) {
					return { stdout: "", stderr: unrelated, code: 1 };
				}
				name = "";
				return { stdout: "", stderr: "", code: 0 };
			}
			throw new Error(`unexpected command ${args.join(" ")}`);
		};
		const driver = driverFromTable(
			cliMethodTable("tama", tamaSpec(context), {
				run,
				createAttemptCeilingMs: TAMA_CREATE_CEILING_MS,
			}),
			() => Promise.resolve({}),
		);
		const session = await driver.create(request);
		for (const diagnostic of unrelatedFailures) {
			const destroyError = await session.destroy().catch((caught: unknown) => caught);
			expect(destroyError).toMatchObject({ code: "destroy-failed", provider: "tama" });
			expect(TAMA_MACHINE_NOT_FOUND.test(diagnostic)).toBe(false);
		}
		await session.destroy();
		expect(TAMA_MACHINE_NOT_FOUND.test(`machine ${readyMachine.id} not found`)).toBe(true);
		expect(destroyAttempts).toBe(unrelatedFailures.length + 1);
	});
});
