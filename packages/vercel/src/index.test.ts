import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CreateRequest } from "@sandbox-benchmarks/driver";
import { sandboxRef } from "@sandbox-benchmarks/driver";
import { APIError, Sandbox } from "@vercel/sandbox";
import vercelDriver, {
	isVercelDefinitiveCreateRejection,
	isVercelRetryableCreate,
	VERCEL_EXECUTION,
	VERCEL_LIVE_STATUSES,
	VERCEL_NAME_PREFIX,
	VERCEL_OWNER_TAG,
	VERCEL_OWNER_VALUE,
	VERCEL_PROVENANCE,
	VERCEL_READINESS,
	VERCEL_REQUEST_COVERAGE,
	VERCEL_SANDBOX_ID,
	VERCEL_SANDBOX_LIFETIME_MS,
	vercelCredentials,
	vercelSpec,
} from "./index.ts";

const CLAIMS = { owner_id: "team_test123", project_id: "prj_test456" };
const OIDC_TOKEN = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(CLAIMS)).toString("base64url")}.sig`;
const IMAGE =
	"vcr.vercel.com/starsling/hpc-sandbox-benchmarks/sandbox-benchmarks-toolchain-vercel:v1";
const OWNED_NAME = "sandbox-benchmarks-11111111-1111-4111-8111-111111111111";

const context = {
	env: { VERCEL_OIDC_TOKEN: OIDC_TOKEN },
	artifact: { kind: "mirror", repository: "sandbox-benchmarks-toolchain-vercel" },
	resolvedArtifact: { kind: "mirror", ref: IMAGE },
} as const;

const request: CreateRequest = {
	spec: { vcpus: 4, memoryGb: 8, diskGb: 40 },
	artifact: context.resolvedArtifact,
	deadlineMs: 300_000,
};

const credentials = { token: OIDC_TOKEN, teamId: CLAIMS.owner_id, projectId: CLAIMS.project_id };

interface FakeSandboxOptions {
	readonly name?: string;
	readonly status?: string;
	readonly diskCapacityGb?: number;
	readonly onDelete?: () => void;
	readonly onCommand?: (params: Record<string, unknown>) => void;
	readonly exitCode?: number;
}

function fakeSandbox(options: FakeSandboxOptions = {}): Sandbox {
	const { diskCapacityGb = 80, exitCode = 0 } = options;
	return {
		name: options.name ?? OWNED_NAME,
		status: options.status ?? "running",
		delete: async () => {
			options.onDelete?.();
		},
		currentSession: () => ({
			runCommand: async (params: Record<string, unknown>) => {
				options.onCommand?.(params);
				if (params.detached === true) return { cmd: params };
				const script = (params.args as string[])[1] ?? "";
				return {
					exitCode: script.startsWith("df -Pk") ? 0 : exitCode,
					durationMs: 5,
					stdout: async () =>
						script.startsWith("df -Pk") ? `${diskCapacityGb * 1024 * 1024}\n` : "out",
					stderr: async () => "err",
				};
			},
		}),
	} as unknown as Sandbox;
}

function notFound(): APIError<unknown> {
	return new APIError(new Response(null, { status: 404 }), { message: "not found" });
}

function apiError(status: number): APIError<unknown> {
	return new APIError(new Response(null, { status }), { message: `http ${status}` });
}

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.reverse()) restore();
	restores.length = 0;
});
function restore<T extends { mockRestore(): void }>(mock: T): T {
	restores.push(() => mock.mockRestore());
	return mock;
}

describe("Vercel module policy", () => {
	test("declares integration, readiness, and native durable execution", () => {
		expect(vercelDriver.id).toBe("vercel");
		expect(vercelDriver.provenance).toEqual(VERCEL_PROVENANCE);
		expect(vercelDriver.provenance.packageName).toBe("@vercel/sandbox");
		expect(vercelDriver.readiness).toEqual(VERCEL_READINESS);
		expect(vercelDriver.execution).toEqual(VERCEL_EXECUTION);
		expect(vercelDriver.createBudget).toBeUndefined();
	});

	test("projects the OIDC token into explicit credentials without leaking it on failure", () => {
		expect(vercelCredentials(OIDC_TOKEN)).toEqual(credentials);
		for (const bad of ["not-a-jwt", "a.!!!.c", `a.${Buffer.from("[]").toString("base64url")}.c`]) {
			const error = (() => {
				try {
					vercelCredentials(bad);
					return undefined;
				} catch (caught) {
					return caught as Error;
				}
			})();
			expect(error).toBeInstanceOf(Error);
			expect(error?.message).not.toContain(bad);
		}
	});

	test("maps the request onto a name-keyed, tagged, non-persistent create", () => {
		const spec = vercelSpec(context);
		expect(spec.createOptions.coverage).toEqual(VERCEL_REQUEST_COVERAGE);
		const mapped = spec.createOptions.map(request, (detail) => {
			throw new Error(detail);
		});
		expect(mapped).toMatchObject({
			image: IMAGE,
			resources: { vcpus: 4 },
			timeout: VERCEL_SANDBOX_LIFETIME_MS,
		});
		expect(VERCEL_SANDBOX_ID.allows(mapped.name as string)).toBe(true);
		expect((mapped.name as string).startsWith(VERCEL_NAME_PREFIX)).toBe(true);
		expect(spec.createRecovery?.locator(mapped)).toEqual({
			kind: "name",
			value: mapped.name as string,
		});
		expect(spec.hasWorkingFilesystem).toBe(false);
		expect(spec.probes).toBeDefined();
		expect(spec.inventory).toBeDefined();
		expect(spec.destroyById).toBeDefined();
		const unsupported = (detail: string): never => {
			throw new Error(detail);
		};
		expect(() =>
			spec.createOptions.map({ ...request, spec: { ...request.spec, memoryGb: 16 } }, unsupported),
		).toThrow(/2 GiB per vCPU/);
		expect(() =>
			spec.createOptions.map(
				{ ...request, artifact: { kind: "mirror", ref: "vcr.vercel.com/other/image:v1" } },
				unsupported,
			),
		).toThrow(/does not match/);
	});

	test("classifies create refusals only from the API's typed status", () => {
		expect(isVercelDefinitiveCreateRejection(apiError(401))).toBe(true);
		expect(isVercelDefinitiveCreateRejection(apiError(429))).toBe(true);
		expect(isVercelDefinitiveCreateRejection(apiError(500))).toBe(false);
		expect(isVercelDefinitiveCreateRejection(new Error("HTTP 401 rate limit"))).toBe(false);
		expect(isVercelRetryableCreate(apiError(429))).toBe(true);
		expect(isVercelRetryableCreate(apiError(503))).toBe(false);
		expect(isVercelRetryableCreate(new Error("429 too many requests"))).toBe(false);
	});
});

describe("Vercel driver lifecycle", () => {
	test("creates with explicit credentials and runs commands through the current session only", async () => {
		const commands: Record<string, unknown>[] = [];
		let createParams: Record<string, unknown> | undefined;
		restore(
			spyOn(Sandbox, "create").mockImplementation((async (params: Record<string, unknown>) => {
				createParams = params;
				return fakeSandbox({ onCommand: (params) => commands.push(params), exitCode: 7 });
			}) as unknown as typeof Sandbox.create),
		);
		const driver = vercelDriver.driver(context);
		const session = await driver.create(request);
		expect(createParams).toMatchObject({
			...credentials,
			image: IMAGE,
			resources: { vcpus: 4 },
			persistent: false,
			timeout: VERCEL_SANDBOX_LIFETIME_MS,
			tags: { [VERCEL_OWNER_TAG]: VERCEL_OWNER_VALUE },
		});
		expect(VERCEL_SANDBOX_ID.allows(createParams?.name as string)).toBe(true);
		expect(session.sandboxRef).toEqual(sandboxRef("vercel", OWNED_NAME));
		// The disk probe ran through the session before the create was accepted.
		expect(commands[0]?.args).toEqual(["-lc", "df -Pk / | awk 'NR==2 {print $2}'"]);
		const result = await session.exec("printf test");
		expect(result.exit).toEqual({ kind: "exited", code: 7 });
		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
		expect(commands.at(-1)).toMatchObject({ cmd: "/bin/sh", args: ["-lc", "printf test"] });
		expect(commands.at(-1)).not.toHaveProperty("detached");
		await session.launch?.("sleep 10");
		expect(commands.at(-1)).toMatchObject({ args: ["-lc", "sleep 10"], detached: true });
	});

	test("tears down an allocation whose disk is short of the request", async () => {
		let deleted = 0;
		const native = fakeSandbox({ diskCapacityGb: 24, onDelete: () => deleted++ });
		restore(spyOn(Sandbox, "create").mockResolvedValue(native as never));
		restore(spyOn(Sandbox, "get").mockResolvedValue(native as never));
		const error = await vercelDriver
			.driver(context)
			.create(request)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "invalid-create-request", provider: "vercel" });
		expect(deleted).toBe(1);
	});

	test("destroys by name without resuming, converging only on the typed 404", async () => {
		let deleted = 0;
		const getParams: Record<string, unknown>[] = [];
		const native = fakeSandbox({ onDelete: () => deleted++ });
		restore(spyOn(Sandbox, "create").mockResolvedValue(native as never));
		const get = restore(
			spyOn(Sandbox, "get").mockImplementation((async (params: Record<string, unknown>) => {
				getParams.push(params);
				return native;
			}) as unknown as typeof Sandbox.get),
		);
		const driver = vercelDriver.driver(context);
		const session = await driver.create(request);
		await session.destroy();
		expect(deleted).toBe(1);
		expect(getParams.at(-1)).toMatchObject({ ...credentials, name: OWNED_NAME, resume: false });
		get.mockRejectedValueOnce(notFound());
		await driver.destroyById?.(sandboxRef("vercel", OWNED_NAME));
		get.mockRejectedValueOnce(new Error("transport lost"));
		await expect(driver.destroyById?.(sandboxRef("vercel", OWNED_NAME))).rejects.toMatchObject({
			code: "destroy-failed",
			provider: "vercel",
		});
		await expect(driver.destroyById?.(sandboxRef("vercel", "not-our-name"))).rejects.toMatchObject({
			code: "invalid-sandbox-ref",
			provider: "vercel",
		});
	});

	test("observes running, terminal, and absent states from the record status", async () => {
		const get = restore(spyOn(Sandbox, "get"));
		const driver = vercelDriver.driver(context);
		const ref = sandboxRef("vercel", OWNED_NAME);
		get.mockResolvedValueOnce(fakeSandbox({ status: "running" }) as never);
		expect(await driver.probes?.observe(ref)).toEqual({ state: "running" });
		get.mockResolvedValueOnce(fakeSandbox({ status: "pending" }) as never);
		expect(await driver.probes?.observe(ref)).toEqual({ state: "running" });
		get.mockResolvedValueOnce(fakeSandbox({ status: "stopped" }) as never);
		expect(await driver.probes?.observe(ref)).toEqual({ state: "terminal" });
		get.mockRejectedValueOnce(notFound());
		expect(await driver.probes?.observe(ref)).toEqual({ state: "absent" });
		get.mockRejectedValueOnce(new Error("transport lost"));
		await expect(driver.probes?.observe(ref)).rejects.toMatchObject({ code: "probe-failed" });
	});

	test("reconciles an ambiguously accepted create by its name", async () => {
		let deleted = 0;
		restore(spyOn(Sandbox, "create").mockRejectedValue(new Error("response lost")));
		const get = restore(
			spyOn(Sandbox, "get").mockResolvedValue(fakeSandbox({ onDelete: () => deleted++ }) as never),
		);
		const spec = vercelSpec(context);
		const locator = spec.createRecovery?.locator(
			spec.createOptions.map(request, (detail) => {
				throw new Error(detail);
			}),
		);
		if (locator === undefined) throw new Error("no recovery locator");
		// The fake returns a sandbox whose name differs from the locator: recovery must refuse it.
		await expect(spec.createRecovery?.cleanup(spec.compute, locator, {})).rejects.toThrow(
			/other than the one requested/,
		);
		expect(deleted).toBe(0);
		get.mockResolvedValueOnce(
			fakeSandbox({ name: locator.value, onDelete: () => deleted++ }) as never,
		);
		expect(await spec.createRecovery?.cleanup(spec.compute, locator, {})).toEqual({
			status: "destroyed",
		});
		expect(deleted).toBe(1);
		get.mockRejectedValueOnce(notFound());
		expect(await spec.createRecovery?.cleanup(spec.compute, locator, {})).toEqual({
			status: "absent",
		});
	});
});

describe("Vercel account inventory", () => {
	test("drains the whole project once: owned by exact name shape, foreign only while live", async () => {
		const rows = [
			{ name: OWNED_NAME, status: "running" },
			{ name: "sandbox-benchmarks-22222222-2222-4222-8222-222222222222", status: "failed" },
			{ name: "sandbox-benchmarks-dev", status: "running" },
			{ name: "someone-elses-box", status: "stopped" },
			{ name: "dead-box", status: "aborted" },
		];
		let listParams: Record<string, unknown> | undefined;
		restore(
			spyOn(Sandbox, "list").mockImplementation((async (params: Record<string, unknown>) => {
				listParams = params;
				return { toArray: async () => rows };
			}) as unknown as typeof Sandbox.list),
		);
		expect(await vercelDriver.driver(context).inventory?.list()).toEqual({
			owned: [
				sandboxRef("vercel", OWNED_NAME),
				sandboxRef("vercel", "sandbox-benchmarks-22222222-2222-4222-8222-222222222222"),
			],
			foreignCount: 2,
		});
		expect(listParams).toMatchObject(credentials);
		expect(listParams).not.toHaveProperty("namePrefix");
		expect([...VERCEL_LIVE_STATUSES]).toEqual([
			"pending",
			"running",
			"stopping",
			"snapshotting",
			"stopped",
		]);
	});

	test("surfaces a failed listing instead of reporting an empty account", async () => {
		restore(spyOn(Sandbox, "list").mockRejectedValue(apiError(500)));
		await expect(vercelDriver.driver(context).inventory?.list()).rejects.toMatchObject({
			code: "probe-failed",
			provider: "vercel",
		});
	});
});
