import { type } from "arktype";

const scope = type({ "concurrency?": "unknown" });
const workflow = type({ "concurrency?": "unknown", jobs: { "[string]": scope } });
const queue = type({ group: "string >= 1", "cancel-in-progress": "false", queue: "'max'" });

/** Compatibility validation until actionlint understands GitHub's queue property. */
export function checkConcurrencyQueues(source: string): void {
	const parsed = workflow.assert(Bun.YAML.parse(source));
	for (const item of [parsed, ...Object.values(parsed.jobs)]) {
		const concurrency = item.concurrency;
		if (concurrency !== null && typeof concurrency === "object" && "queue" in concurrency)
			queue.assert(concurrency);
	}
}

// Match only the parser's unsupported-field diagnostic; every other actionlint check remains active.
export const ACTIONLINT_QUEUE_COMPATIBILITY =
	'^unexpected key "queue" for "concurrency" section\\. expected one of "cancel-in-progress", "group"$';
