import { type } from "arktype";
import type { AccountJournal } from "./account-journal.ts";
import { accountRecordSchema } from "./account-journal.ts";

const reference = type({ object: { sha: /^[a-f0-9]{40}$/ } });
const object = type({ sha: /^[a-f0-9]{40}$/ });
const commit = type({ tree: { sha: /^[a-f0-9]{40}$/ } });
const tree = type({
	truncated: "boolean",
	tree: type({ path: "string", type: "string", sha: /^[a-f0-9]{40}$/ }).array(),
});
const blob = type({ encoding: "'base64'", content: "string <= 16000000" });
const responseError = type({ message: "string <= 2000" });
const journalSchema = type({
	schemaVersion: "'1'",
	account: "string",
	records: accountRecordSchema.array(),
}).onUndeclaredKey("reject");
export type GitRequest = (
	method: "GET" | "POST" | "PATCH",
	path: string,
	body?: unknown,
) => Promise<unknown>;

/** Durable evidence, not a distributed lock. Provision and protect the branch before account admission. */
export function githubAccountJournal(
	request: GitRequest,
	branch = "benchmark-account-journal",
): AccountJournal {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(branch))
		throw new Error("invalid account journal branch");
	let tail: Promise<unknown> = Promise.resolve();
	const snapshot = async (account: string) => {
		const head = reference.assert(await request("GET", `/git/ref/heads/${branch}-${account}`))
			.object.sha;
		const baseTree = commit.assert(await request("GET", `/git/commits/${head}`)).tree.sha;
		const inventory = tree.assert(await request("GET", `/git/trees/${baseTree}?recursive=1`));
		if (inventory.truncated) throw new Error("account journal tree is incomplete");
		const entry = inventory.tree.find((entry) => entry.path === "journal.json");
		if (entry?.type !== "blob") throw new Error("account journal has not been provisioned");
		const data = blob.assert(await request("GET", `/git/blobs/${entry.sha}`));
		const journal = journalSchema.assert(
			JSON.parse(Buffer.from(data.content, "base64").toString("utf8")),
		);
		if (journal.account !== account || journal.records.some((record) => record.account !== account))
			throw new Error("journal account provenance mismatch");
		return { head, baseTree, journal };
	};
	const acknowledged = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
	return {
		async read(account) {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(account))
				throw new Error("invalid account identity");
			await tail;
			return (await snapshot(account)).journal.records;
		},
		append(raw) {
			const record = accountRecordSchema.assert(raw);
			const pending = tail.then(async () => {
				// Chain our own acknowledged writes without depending on ref read-after-write consistency.
				// A competing writer still fails the non-forced ref update below.
				const state = acknowledged.get(record.account) ?? (await snapshot(record.account));
				const nextJournal = { ...state.journal, records: [...state.journal.records, record] };
				const path = "journal.json";
				if (
					state.journal.records.some(
						(entry) => entry.attempt === record.attempt && entry.kind === record.kind,
					)
				)
					throw new Error("immutable journal record already exists");
				const nextTree = object.assert(
					await request("POST", "/git/trees", {
						base_tree: state.baseTree,
						tree: [
							{
								path,
								mode: "100644",
								type: "blob",
								content: `${JSON.stringify(nextJournal)}\n`,
							},
						],
					}),
				);
				const nextCommit = object.assert(
					await request("POST", "/git/commits", {
						message: `Record ${record.account} ${record.attempt} ${record.kind}`,
						tree: nextTree.sha,
						parents: [state.head],
					}),
				);
				let response: unknown;
				for (let attempt = 0; ; attempt++) {
					try {
						response = await request("PATCH", `/git/refs/heads/${branch}-${record.account}`, {
							sha: nextCommit.sha,
							force: false,
						});
						break;
					} catch (error) {
						if (attempt >= 2) throw error;
						let observed: string;
						try {
							observed = reference.assert(
								await request("GET", `/git/ref/heads/${branch}-${record.account}`),
							).object.sha;
						} catch {
							throw error;
						}
						// A lost response is settled by the exact commit, never by guessing or forcing.
						if (observed === nextCommit.sha) {
							response = { object: { sha: observed } };
							break;
						}
						// Retry only the same conditional ref update. A competing writer fails closed.
						if (observed !== state.head) throw error;
						await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
					}
				}
				const updated = reference.assert(response);
				if (updated.object.sha !== nextCommit.sha)
					throw new Error("journal append was not acknowledged");
				acknowledged.set(record.account, {
					head: nextCommit.sha,
					baseTree: nextTree.sha,
					journal: nextJournal,
				});
			});
			// The chain only orders appends; it must not carry their outcomes. A rejected tail would skip
			// every later append's callback and fail every read with the first (possibly transient)
			// error for the rest of the process, silently dropping the batch's remaining records.
			tail = pending.catch(() => undefined);
			return pending;
		},
	};
}

export function githubGitRequest(env: NodeJS.ProcessEnv = process.env): GitRequest {
	const repository = env.GITHUB_REPOSITORY;
	const token = env.GH_TOKEN || env.GITHUB_TOKEN;
	if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
		throw new Error("account journal requires GitHub repository and token");
	return async (method, path, body) => {
		const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			const payload = responseError(await response.json().catch(() => null));
			const detail = payload instanceof type.errors ? "" : `: ${payload.message}`;
			const requestId = response.headers.get("x-github-request-id");
			throw new Error(
				`account journal ${method} HTTP ${response.status}${detail}${requestId ? ` [request ${requestId}]` : ""}; allocation blocked`,
			);
		}
		return response.json();
	};
}
