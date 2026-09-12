#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { providerIdSchema, suiteNameSchema } from "@sandbox-benchmarks/schema";
import { type } from "arktype";
import { recoverCompletedCreate } from "../lib/completed-create-recovery.ts";
import { openDriver } from "../lib/driver-run.ts";
import { githubAccountJournal, githubGitRequest } from "../lib/github-account-journal.ts";

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: { "exclusive-account": { type: "boolean", default: false } },
});
if (!values["exclusive-account"] || positionals.length !== 3)
	throw new Error(
		"usage: recover-completed-create --exclusive-account <provider> <suite> <original-attempt-directory>; stop all local account writers first",
	);
const provider = providerIdSchema.assert(positionals[0]);
const suite = suiteNameSchema.assert(positionals[1]);
const directory = type("string >= 1").assert(positionals[2]);
const operator = type(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).assert(process.env.GITHUB_ACTOR);
const request = githubGitRequest();
const workflow = type({ status: "'completed'", head_sha: /^[a-f0-9]{40}$/ });
const activeRuns = type({ total_count: "number.integer >= 0" });
const { driver } = await openDriver(provider);
await recoverCompletedCreate({
	directory,
	provider,
	suite,
	operator,
	drivers: [{ id: provider, driver }],
	journal: githubAccountJournal(request),
	signal: AbortSignal.timeout(240_000),
	assertQuiescent: async (id, sha) => {
		const run = workflow.assert(await request("GET", `/actions/runs/${id}`));
		if (run.head_sha !== sha) throw new Error("original workflow source mismatch");
		for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
			const runs = activeRuns.assert(
				await request("GET", `/actions/runs?status=${status}&per_page=1`),
			);
			if (runs.total_count !== 0)
				throw new Error(`repository has ${status} workflows; stop writers before recovery`);
		}
	},
});
console.log(
	`Recorded completed-create reconciliation for ${provider}/${suite}; original attempt remains failed.`,
);
