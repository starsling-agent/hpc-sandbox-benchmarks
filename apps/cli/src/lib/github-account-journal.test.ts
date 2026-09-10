import { expect, test } from "bun:test";
import { type } from "arktype";
import type { GitRequest } from "./github-account-journal.ts";
import { githubAccountJournal } from "./github-account-journal.ts";

const intent = {
	version: "1",
	kind: "intent",
	account: "tama",
	attempt: "attempt-1",
	cellId: "tama-system-r0",
	planDigest: `sha256:${"a".repeat(64)}`,
} as const;
const requestTree = type({ tree: [{ path: "string", content: "string" }] });
function fixture() {
	let head = "a".repeat(40);
	let next = 1;
	const entries: Array<{ path: string; type: string; sha: string }> = [
		{ path: "journal.json", type: "blob", sha: head },
	];
	const blobs = new Map<string, string>([
		[head, JSON.stringify({ schemaVersion: "1", account: "tama", records: [] })],
	]);
	let pending: { path: string; content: string } | undefined;
	const writes: unknown[] = [];
	const request: GitRequest = async (method, path, body) => {
		if (method === "GET" && path.startsWith("/git/ref/")) return { object: { sha: head } };
		if (method === "GET" && path.startsWith("/git/commits/")) return { tree: { sha: head } };
		if (method === "GET" && path.startsWith("/git/trees/"))
			return { truncated: false, tree: entries };
		if (method === "GET" && path.startsWith("/git/blobs/"))
			return {
				encoding: "base64",
				content: Buffer.from(blobs.get(path.slice(11)) ?? "").toString("base64"),
			};
		if (method === "POST" && path === "/git/trees") {
			pending = requestTree.assert(body).tree[0];
			return { sha: "b".repeat(40) };
		}
		if (method === "POST" && path === "/git/commits")
			return { sha: (++next).toString(16).padStart(40, "0") };
		if (method === "PATCH") {
			writes.push(body);
			const update = type({ sha: "string", force: "false" }).assert(body);
			if (!pending) throw new Error("missing tree");
			head = update.sha;
			blobs.set(head, pending.content);
			entries.splice(0, entries.length, { path: pending.path, type: "blob", sha: head });
			pending = undefined;
			return { object: { sha: head } };
		}
		throw new Error("unexpected Git request");
	};
	return { request, writes };
}

test("journal survives new clients and refuses replacing an earlier immutable record", async () => {
	const f = fixture();
	await githubAccountJournal(f.request).append(intent);
	expect(await githubAccountJournal(f.request).read("tama")).toEqual([intent]);
	await expect(githubAccountJournal(f.request).append(intent)).rejects.toThrow("already exists");
	expect(f.writes).toHaveLength(1);
});
test("concurrent attempts append serially without losing records", async () => {
	const f = fixture();
	const journal = githubAccountJournal(f.request);
	await Promise.all([journal.append(intent), journal.append({ ...intent, attempt: "attempt-2" })]);
	expect(await githubAccountJournal(f.request).read("tama")).toHaveLength(2);
	expect(f.writes).toHaveLength(2);
});
test("missing journal and truncated history cannot become an empty account", async () => {
	await expect(
		githubAccountJournal(async () => {
			throw new Error("HTTP 404");
		}).read("tama"),
	).rejects.toThrow("404");
	const f = fixture();
	await expect(
		githubAccountJournal((method, path, body) =>
			path.startsWith("/git/trees/")
				? Promise.resolve({ truncated: true, tree: [] })
				: f.request(method, path, body),
		).read("tama"),
	).rejects.toThrow("incomplete");
});
test("a transient append failure does not poison later appends or reads", async () => {
	const f = fixture();
	let blip = true;
	const journal = githubAccountJournal((method, path, body) => {
		if (method === "PATCH" && blip) {
			blip = false;
			throw new Error("HTTP 502");
		}
		return f.request(method, path, body);
	});
	await expect(journal.append(intent)).rejects.toThrow("502");
	// The same client keeps working: the next cell's record lands and reads see it.
	await journal.append({ ...intent, attempt: "attempt-2" });
	expect(await journal.read("tama")).toEqual([{ ...intent, attempt: "attempt-2" }]);
	expect(f.writes).toHaveLength(1);
});
test("a competing writer rejects the append rather than forcing the journal ref", async () => {
	const f = fixture();
	const journal = githubAccountJournal((method, path, body) => {
		if (method === "PATCH") {
			expect(body).toMatchObject({ force: false });
			throw new Error("HTTP 422");
		}
		return f.request(method, path, body);
	});
	await expect(journal.append(intent)).rejects.toThrow("422");
	await expect(journal.append({ ...intent, attempt: "attempt-2" })).rejects.toThrow("422");
});
