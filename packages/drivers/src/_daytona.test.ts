import { describe, expect, mock, test } from "bun:test";
import { daytonaCommands } from "./_daytona.ts";

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
	const { daytonaSpec } = await import("./_daytona.ts");
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
