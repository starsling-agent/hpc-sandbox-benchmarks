import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot } from "./lib/workspace.ts";

test("fio parser staging replaces stale definitions without deleting the installed executable", () => {
	const root = findRepoRoot();
	const temporary = mkdtempSync(join(tmpdir(), "fio-parser-"));
	try {
		const profile = join(temporary, "test-profiles/pts/fio-2.1.0");
		const installed = join(temporary, "installed-tests/pts/fio-2.1.0");
		mkdirSync(profile, { recursive: true });
		mkdirSync(installed, { recursive: true });
		writeFileSync(join(profile, "results-definition.xml"), "stale");
		writeFileSync(join(installed, "fio-run"), "compiled executable");
		const result = Bun.spawnSync(
			[
				"bash",
				"-euc",
				'source "$REPO_ROOT/lib/bench.sh"; pts_user_dir() { echo "$TEST_PTS_ROOT"; }; _stage_fio_pts_parser',
			],
			{ env: { ...process.env, REPO_ROOT: root, TEST_PTS_ROOT: temporary } },
		);
		expect(result.exitCode).toBe(0);
		for (const file of ["test-definition.xml", "results-definition.xml"]) {
			expect(readFileSync(join(profile, file), "utf8")).toBe(
				readFileSync(join(root, "packages/schema/src/pts-profiles/fio-2.1.0", file), "utf8"),
			);
		}
		expect(readFileSync(join(installed, "fio-run"), "utf8")).toBe("compiled executable");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
