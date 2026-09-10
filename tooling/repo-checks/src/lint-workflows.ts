import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ACTIONLINT_QUEUE_COMPATIBILITY,
	checkConcurrencyQueues,
} from "./lib/workflow-concurrency.ts";

if (import.meta.main) {
	for (const file of readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
		try {
			checkConcurrencyQueues(readFileSync(join(".github/workflows", file), "utf8"));
		} catch (error) {
			throw new Error(`Invalid concurrency queue in ${file}`, { cause: error });
		}
	}
	const result = Bun.spawnSync(
		["mise", "exec", "--", "actionlint", "-no-color", "-ignore", ACTIONLINT_QUEUE_COMPATIBILITY],
		{ stdout: "inherit", stderr: "inherit" },
	);
	process.exitCode = result.exitCode;
}
