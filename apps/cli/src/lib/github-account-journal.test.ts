import { expect, spyOn, test } from "bun:test";
import { type } from "arktype";
import type { GitRequest } from "./github-account-journal.ts";
import { githubAccountJournal, githubGitRequest } from "./github-account-journal.ts";

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
			throw new Error("HTTP 502");
		}
		return f.request(method, path, body);
	});
	await expect(journal.append(intent)).rejects.toThrow("502");
	blip = false;
	// The same client keeps working: the next cell's record lands and reads see it.
	await journal.append({ ...intent, attempt: "attempt-2" });
	expect(await journal.read("tama")).toEqual([{ ...intent, attempt: "attempt-2" }]);
	expect(f.writes).toHaveLength(1);
});
test("a competing writer rejects the append rather than forcing the journal ref", async () => {
	const f = fixture();
	let competing = false;
	const journal = githubAccountJournal((method, path, body) => {
		if (method === "GET" && path.startsWith("/git/ref/") && competing)
			return Promise.resolve({ object: { sha: "f".repeat(40) } });
		if (method === "PATCH" && competing) {
			expect(body).toMatchObject({ force: false });
			throw new Error("HTTP 422");
		}
		return f.request(method, path, body);
	});
	await journal.append(intent);
	competing = true;
	await expect(journal.append({ ...intent, attempt: "attempt-2" })).rejects.toThrow("422");
	await expect(journal.append({ ...intent, attempt: "attempt-3" })).rejects.toThrow("422");
});

test("a rejected ref update retries the same commit only while its parent is unchanged", async () => {
	const f = fixture();
	let commits = 0;
	let patches = 0;
	const journal = githubAccountJournal((method, path, body) => {
		if (method === "POST" && path === "/git/commits") commits++;
		if (method === "PATCH" && ++patches === 1) throw new Error("HTTP 422");
		return f.request(method, path, body);
	});
	await journal.append(intent);
	expect(await journal.read("tama")).toEqual([intent]);
	expect(commits).toBe(1);
	expect(patches).toBe(2);
});

test("a lost acknowledgement is recovered from the exact committed ref without replay", async () => {
	const f = fixture();
	let patches = 0;
	const journal = githubAccountJournal(async (method, path, body) => {
		const result = await f.request(method, path, body);
		if (method === "PATCH") {
			patches++;
			throw new Error("response lost");
		}
		return result;
	});
	await journal.append(intent);
	expect(await journal.read("tama")).toEqual([intent]);
	expect(patches).toBe(1);
});

test("GitHub rejection diagnostics preserve the reason and request ID", async () => {
	const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ message: "Update is not a fast forward" }), {
			status: 422,
			headers: { "x-github-request-id": "request-123" },
		}),
	);
	try {
		const request = githubGitRequest({ GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "test-token" });
		await expect(request("PATCH", "/git/refs/heads/journal", {})).rejects.toThrow(
			"HTTP 422: Update is not a fast forward [request request-123]",
		);
	} finally {
		fetch.mockRestore();
	}
});

test("an acknowledged append remains the parent when a subsequent ref read is stale", async () => {
	const f = fixture();
	const reads = new Map<string, unknown>();
	let stale = false;
	let head = "a".repeat(40);
	let parent = "";
	const journal = githubAccountJournal(async (method, path, body) => {
		if (method === "GET" && stale && reads.has(path)) return structuredClone(reads.get(path));
		if (method === "POST" && path === "/git/commits")
			parent = type({ parents: ["string"] }).assert(body).parents[0];
		if (method === "PATCH" && parent !== head) throw new Error("HTTP 422: not a fast forward");
		const result = await f.request(method, path, body);
		if (method === "GET") reads.set(path, structuredClone(result));
		if (method === "PATCH") head = type({ object: { sha: "string" } }).assert(result).object.sha;
		return result;
	});
	await journal.append(intent);
	stale = true;
	await journal.append({ ...intent, attempt: "attempt-2" });
	stale = false;
	expect(await journal.read("tama")).toHaveLength(2);
});
