import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { checkConcurrencyQueues } from "./lib/workflow-concurrency.ts";
import { findRepoRoot } from "./lib/workspace.ts";

test("queue compatibility rejects invalid values and pending-work cancellation", () => {
	for (const value of ["one", "true", "100", `'\${{ inputs.queue }}'`]) {
		expect(() =>
			checkConcurrencyQueues(
				`jobs: {}\nconcurrency:\n  group: account\n  cancel-in-progress: false\n  queue: ${value}`,
			),
		).toThrow();
	}
	expect(() =>
		checkConcurrencyQueues(
			"jobs: {}\nconcurrency:\n  group: account\n  queue: max\n  cancel-in-progress: true",
		),
	).toThrow();
	expect(() =>
		checkConcurrencyQueues(
			"jobs: {}\nconcurrency:\n  group: account\n  queue: max\n  cancel-in-progress: false",
		),
	).not.toThrow();
});

test("all current allocating workflows share account queues across variants and lanes", () => {
	const matrixGroup = `benchmark-account-\${{ (matrix.provider == 'daytona-vm' || matrix.provider == 'daytona-container') && 'daytona' || (matrix.provider == 'modal-gvisor' || matrix.provider == 'modal-vm') && 'modal' || matrix.provider }}`;
	const schema = type({ jobs: { "[string]": { "concurrency?": "unknown" } } });
	for (const [file, jobIds, group] of [
		["bench-suite.yml", ["bench"], matrixGroup],
		["toolchain-image.yml", ["bake"], matrixGroup],
		[
			"bench-gpu.yml",
			["prepare-assets", "prepare-kernels", "benchmark"],
			"benchmark-account-modal",
		],
	] as const) {
		const source = readFileSync(join(findRepoRoot(), ".github/workflows", file), "utf8");
		checkConcurrencyQueues(source);
		const parsed = schema.assert(Bun.YAML.parse(source));
		for (const job of jobIds)
			expect(parsed.jobs[job]?.concurrency).toEqual({
				group,
				queue: "max",
				"cancel-in-progress": false,
			});
	}
});
