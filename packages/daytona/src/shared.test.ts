import { describe, expect, mock, test } from "bun:test";
import type { Daytona } from "@daytona/sdk";
import { DaytonaNotFoundError } from "@daytona/sdk";
import { daytonaCommands, daytonaSpec } from "./shared.ts";

describe("Daytona session commands", () => {
	test("reuses one control session and retains separate streams and nonzero exits", async () => {
		const process = {
			createSession: mock(async (_id: string) => {}),
			executeSessionCommand: mock(async () => ({
				cmdId: "cmd-1",
				exitCode: 7,
				stdout: "out",
				stderr: "err",
			})),
		};
		const sandbox = { process };
		const commands = daytonaCommands();
		const results = await Promise.all([
			commands.exec(sandbox, "echo one"),
			commands.exec(sandbox, "echo two"),
		]);
		expect(process.createSession).toHaveBeenCalledTimes(1);
		expect(results).toEqual([
			{ exitCode: 7, stdout: "out", stderr: "err" },
			{ exitCode: 7, stdout: "out", stderr: "err" },
		]);
	});
	test("launches once in an independent job session so polling can use the control shell", async () => {
		const calls: { id: string; command: string; runAsync?: boolean }[] = [];
		const process = {
			createSession: mock(async (_id: string) => {}),
			executeSessionCommand: async (
				id: string,
				request: { command: string; runAsync?: boolean },
			) => {
				calls.push({ id, ...request });
				return { cmdId: "accepted", exitCode: 0, stdout: "", stderr: "" };
			},
		};
		const sandbox = { process };
		const commands = daytonaCommands();
		await commands.launch(sandbox, "sleep 60");
		await commands.exec(sandbox, "test -f /tmp/done");
		expect(calls).toHaveLength(2);
		expect(calls[0]?.runAsync).toBe(true);
		expect(calls[1]?.runAsync).toBe(false);
		expect(calls[0]?.id).not.toBe(calls[1]?.id);
		expect(calls[0]?.command).not.toContain("nohup");
	});
	test("rejects missing async acceptance and does not cache failed session creation", async () => {
		const process = {
			createSession: mock(async (_id: string) => {}).mockRejectedValueOnce(
				new Error("create transport failed"),
			),
			executeSessionCommand: mock(async () => ({ cmdId: "", exitCode: 0, stdout: "", stderr: "" })),
		};
		const sandbox = { process };
		const commands = daytonaCommands();
		await expect(commands.exec(sandbox, "true")).rejects.toThrow("create transport failed");
		await commands.exec(sandbox, "true");
		expect(process.createSession).toHaveBeenCalledTimes(2);
		await expect(commands.launch(sandbox, "true")).rejects.toThrow("no asynchronous command id");
	});
	test("a cancelled operation never starts a session", async () => {
		const process = {
			createSession: mock(async (_id: string) => {}),
			executeSessionCommand: mock(async () => ({ cmdId: "unused" })),
		};
		await expect(
			daytonaCommands().exec({ process }, "true", { signal: AbortSignal.abort() }),
		).rejects.toThrow();
		expect(process.createSession).not.toHaveBeenCalled();
	});
});

test("native allocation sends the resolved target and snapshot without mutating ambient region", async () => {
	const { Daytona, DaytonaAuthenticationError } = await import("@daytona/sdk");
	const { spyOn } = await import("bun:test");
	const { daytonaSpec } = await import("./shared.ts");
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("offline fixture", { status: 503 }),
	});
	let client: InstanceType<typeof Daytona> | undefined;
	const stock = Daytona.createAxiosInstance;
	const bodies: unknown[] = [];
	const previous = process.env.DAYTONA_TARGET;
	process.env.DAYTONA_TARGET = "decoy-region";
	const transport = spyOn(Daytona, "createAxiosInstance").mockImplementation((timeout) => {
		const axios = stock(timeout);
		axios.defaults.adapter = async (config) => {
			bodies.push(typeof config.data === "string" ? JSON.parse(config.data) : config.data);
			throw new DaytonaAuthenticationError("offline test refusal", 401);
		};
		return axios;
	});
	try {
		const spec = daytonaSpec(
			{
				env: { DAYTONA_API_KEY: "test-key", DAYTONA_TARGET: "us-west-2" },
				artifact: { kind: "baked" },
				resolvedArtifact: { kind: "baked", ref: "test-snapshot" },
			},
			(options) => {
				client = new Daytona({ ...options, apiUrl: server.url.toString() });
				return client;
			},
		);
		await expect(
			spec.compute.sandbox.create({ name: "test-attempt", snapshot: "test-snapshot" }),
		).rejects.toThrow();
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			name: "test-attempt",
			snapshot: "test-snapshot",
			target: "us-west-2",
			autoStopInterval: 0,
		});
		expect(process.env.DAYTONA_TARGET).toBe("decoy-region");
	} finally {
		transport.mockRestore();
		await client?.[Symbol.asyncDispose]();
		server.stop(true);
		if (previous === undefined) delete process.env.DAYTONA_TARGET;
		else process.env.DAYTONA_TARGET = previous;
	}
});

describe("Daytona account inventory and recovery", () => {
	const owned1 = "11111111-1111-4111-8111-111111111111";
	const owned2 = "22222222-2222-4222-8222-222222222222";
	const foreign = "33333333-3333-4333-8333-333333333333";
	const gone = "44444444-4444-4444-8444-444444444444";
	const rows = [
		{ id: owned1, name: "benchmark-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "started" },
		{ id: foreign, name: "dev-box", state: "started" },
		{ id: gone, name: "benchmark-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "destroyed" },
		{ id: owned2, name: "benchmark-cccccccc-cccc-4ccc-8ccc-cccccccccccc", state: "stopped" },
	];
	const deleted: string[] = [];
	const client = {
		list: async function* () {
			yield* rows;
		},
		get: async (id: string) => {
			const row = rows.find((entry) => entry.id === id);
			if (!row || row.state === "destroyed") throw new DaytonaNotFoundError("no such sandbox", 404);
			return row;
		},
		delete: async (sandbox: { id: string }) => {
			deleted.push(sandbox.id);
		},
	} as unknown as Daytona;
	const spec = daytonaSpec(
		{
			env: { DAYTONA_API_KEY: "test-key", DAYTONA_TARGET: "us-west-2" },
			artifact: { kind: "baked" },
			resolvedArtifact: { kind: "baked", ref: "test-snapshot" },
		},
		() => client,
	);

	test("claims every benchmark-named sandbox, skips the dying, and counts the rest as foreign", async () => {
		expect(await spec.inventory?.list(spec.compute, {})).toEqual({
			owned: [owned1, owned2],
			foreignCount: 1,
		});
	});

	test("destroys by id through a fresh lookup and converges on Daytona's own absence", async () => {
		await spec.destroyById?.(spec.compute, { provider: "daytona-vm", id: owned1 }, {});
		await spec.destroyById?.(spec.compute, { provider: "daytona-vm", id: gone }, {});
		expect(deleted).toEqual([owned1]);
	});
});
