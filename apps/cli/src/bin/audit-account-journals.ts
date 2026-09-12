#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { unresolvedJournalAttempts } from "../lib/account-journal.ts";
import { githubAccountJournal, githubGitRequest } from "../lib/github-account-journal.ts";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		account: { type: "string", multiple: true },
		"from-plan": { type: "string" },
		probe: { type: "boolean", default: false },
	},
});

if (values.probe) {
	throw new Error(
		"probe mode requires an explicit operator session with live credentials; this command only reads journals and never fabricates releases",
	);
}

const accounts = new Set<string>(values.account ?? []);
if (values["from-plan"]) {
	const plan = JSON.parse(readFileSync(values["from-plan"], "utf8")) as {
		accounts?: Array<{ quotaDomain: string }>;
	};
	for (const account of plan.accounts ?? []) {
		if (!account.quotaDomain) throw new Error("plan account lacks quotaDomain");
		accounts.add(account.quotaDomain);
	}
}
if (accounts.size === 0) {
	throw new Error("usage: audit-account-journals --account <domain>... | --from-plan <plan.json>");
}

const journal = githubAccountJournal(githubGitRequest());
const unresolved = [];
for (const account of [...accounts].sort()) {
	const records = await journal.read(account);
	unresolved.push(...unresolvedJournalAttempts(records));
}

if (unresolved.length === 0) {
	console.log(`account journals clean for ${[...accounts].sort().join(", ")}`);
	process.exit(0);
}

console.error("unresolved journal ownership (no releases were written):");
for (const entry of unresolved) {
	console.error(
		JSON.stringify({
			account: entry.account,
			attempt: entry.attempt,
			cellId: entry.cellId,
			allocated: entry.allocated,
			ref: entry.ref ?? null,
		}),
	);
}
console.error(
	`${unresolved.length} unresolved attempt(s); recover with recover-allocated-intent / recover-completed-create before another full matrix`,
);
process.exit(1);
