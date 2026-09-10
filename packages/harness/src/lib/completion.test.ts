import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { completionCode, detachedCommand } from "./completion.ts";

test("receipt rejects foreign identity, partial status, and fabricated exits", () => {
	expect(completionCode("v1 bench-abc 7", "bench-abc")).toBe(7);
	for (const raw of ["0", "", "v1 bench-def 0", "v1 bench-abc 7garbage", "v1 bench-abc 256"]) {
		expect(completionCode(raw, "bench-abc")).toBeNull();
	}
});

test.each([
	["echo passed", 0],
	["set -e; false; echo should-not-run", 1],
	["echo 'All tasks passed'; exit 7", 7],
	["sleep 0.1 & echo parent-completed", 0],
])("real shell publishes actual exit for %s", async (command, expected) => {
	const identity = `bench-${randomUUID()}`;
	try {
		const process = Bun.spawn(["bash", "-c", detachedCommand(identity, String(command))], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await process.exited).toBe(0);
		const receipt = await readFile(`/tmp/${identity}/completion.done`, "utf8");
		expect(completionCode(receipt, identity)).toBe(expected);
		const output = await readFile(`/tmp/${identity}/output.log`, "utf8");
		expect(output).not.toContain("should-not-run");
	} finally {
		await rm(`/tmp/${identity}`, { recursive: true, force: true });
	}
});
