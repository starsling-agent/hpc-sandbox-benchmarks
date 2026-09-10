// Drift gate for scripts/assert-paths-allowlisted.sh — the path fence update-leaderboard.yml uses
// before merging. A silent widen (or a broken argv parser) would let a release PR touch
// `.github/` and still merge.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findRepoRoot } from "./lib/workspace.ts";

const ROOT = findRepoRoot();
const SCRIPT = join(ROOT, "scripts/assert-paths-allowlisted.sh");

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "assert-paths-"));
	temps.push(dir);
	const git = (args: string[]) =>
		Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	expect(git(["init", "-q"]).exitCode).toBe(0);
	expect(git(["config", "user.email", "test@example.com"]).exitCode).toBe(0);
	expect(git(["config", "user.name", "test"]).exitCode).toBe(0);
	// Fixture commits must not invoke a developer's interactive signing agent.
	expect(git(["config", "commit.gpgsign", "false"]).exitCode).toBe(0);
	return dir;
}

function runAssert(
	cwd: string,
	args: string[],
	env?: Record<string, string>,
): { exitCode: number; stderr: string } {
	const result = Bun.spawnSync(["bash", SCRIPT, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	return {
		exitCode: result.exitCode,
		stderr: new TextDecoder().decode(result.stderr),
	};
}

/** Put a stub `gh` on PATH that answers `gh pr view … --json url` with PR 123's canonical URL and
 * `gh api repos/acme/widgets/pulls/123/files` with the given newline-separated path list
 * (mimicking the script's `--jq '.[] | .filename, (.previous_filename // empty)'` output). Any
 * other invocation — including an `api` call that doesn't target the URL-derived owner/repo —
 * fails loudly, so the test breaks if the production script's gh calls drift (e.g. back to
 * `{owner}/{repo}` placeholders that name the current checkout instead of the resolved PR's
 * repository). With `failMidStream` the api branch emits its paths and then exits non-zero,
 * simulating a --paginate request dying after earlier pages printed. */
function stubGh(paths: string[], opts?: { failMidStream?: boolean }): string {
	const dir = mkdtempSync(join(tmpdir(), "stub-gh-"));
	temps.push(dir);
	const body = [
		"#!/usr/bin/env bash",
		'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
		'  echo "https://github.com/acme/widgets/pull/123"',
		'elif [ "$1" = "api" ] && [ "$2" = "repos/acme/widgets/pulls/123/files" ]; then',
		...paths.map((p) => `  echo "${p}"`),
		...(opts?.failMidStream ? ["  exit 1"] : []),
		"else",
		'  echo "unexpected gh invocation: $*" >&2',
		"  exit 1",
		"fi",
	].join("\n");
	writeFileSync(join(dir, "gh"), `${body}\n`);
	chmodSync(join(dir, "gh"), 0o755);
	return dir;
}

describe("scripts/assert-paths-allowlisted.sh", () => {
	test("accepts a staged change set that is exactly the allowlist", () => {
		const dir = tempGitRepo();
		writeFileSync(join(dir, "LEADERBOARD.md"), "# ok\n");
		Bun.spawnSync(["git", "add", "LEADERBOARD.md"], { cwd: dir });
		const { exitCode, stderr } = runAssert(dir, ["staged", "--", "LEADERBOARD.md"]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("rejects a staged path outside the allowlist", () => {
		const dir = tempGitRepo();
		writeFileSync(join(dir, "LEADERBOARD.md"), "# ok\n");
		writeFileSync(join(dir, "evil.yml"), "name: pwn\n");
		Bun.spawnSync(["git", "add", "LEADERBOARD.md", "evil.yml"], { cwd: dir });
		const { exitCode, stderr } = runAssert(dir, ["staged", "--", "LEADERBOARD.md"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("path not allowlisted: evil.yml");
	});

	test("rejects an empty staged change set", () => {
		const dir = tempGitRepo();
		const { exitCode, stderr } = runAssert(dir, ["staged", "--", "LEADERBOARD.md"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("change set is empty");
	});

	test("rejects a staged rename of a sensitive file into the allowlisted path", () => {
		const dir = tempGitRepo();
		const git = (args: string[]) =>
			Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		writeFileSync(join(dir, "secret.yml"), "credentials: yes\n");
		expect(git(["add", "secret.yml"]).exitCode).toBe(0);
		expect(git(["commit", "-q", "-m", "seed"]).exitCode).toBe(0);
		// A rename's staged diff must expose the SOURCE path (delete), not just the destination —
		// otherwise renaming a sensitive file into LEADERBOARD.md would slip through the fence.
		expect(git(["mv", "secret.yml", "LEADERBOARD.md"]).exitCode).toBe(0);
		const { exitCode, stderr } = runAssert(dir, ["staged", "--", "LEADERBOARD.md"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("path not allowlisted: secret.yml");
	});

	test("accepts a single-level glob entry and the files it covers", () => {
		// The leaderboard commits one WebP chart per realworld suite, and how many there are is a
		// property of the dataset — so the fence takes `docs/figures/*.webp` rather than three literals
		// that a fourth suite would silently invalidate.
		const dir = tempGitRepo();
		mkdirSync(join(dir, "docs/figures"), { recursive: true });
		writeFileSync(join(dir, "LEADERBOARD.md"), "# ok\n");
		// Placeholder bytes: the fence matches on PATH, and never opens what it is fencing.
		writeFileSync(join(dir, "docs/figures/realworld-mastra.webp"), "webp\n");
		writeFileSync(join(dir, "docs/figures/realworld-openclaw.webp"), "webp\n");
		Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
		const { exitCode, stderr } = runAssert(dir, [
			"staged",
			"--",
			"LEADERBOARD.md",
			"docs/figures/*.webp",
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("a glob entry does not widen past its own directory or extension", () => {
		// The three ways the pattern could leak if it were implemented as a substring or a `**`: a
		// deeper path under the same directory, a different extension beside the allowed one, and the
		// same extension somewhere else entirely.
		for (const outside of [
			"docs/figures/nested/deep.webp",
			"docs/figures/evil.yml",
			".github/workflows/evil.webp",
		]) {
			const dir = tempGitRepo();
			mkdirSync(join(dir, dirname(outside)), { recursive: true });
			writeFileSync(join(dir, outside), "x\n");
			Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
			const { exitCode, stderr } = runAssert(dir, ["staged", "--", "docs/figures/*.webp"]);
			expect(exitCode, outside).toBe(1);
			expect(stderr, outside).toContain(`path not allowlisted: ${outside}`);
		}
	});

	test("refuses an allowlist pattern that is not DIR/*.EXT", () => {
		// Fail closed on anything broader than the one shape the fence understands, rather than
		// interpreting it and hoping. `docs/*` and `**` are the two that would actually be dangerous.
		for (const pattern of ["docs/figures/*", "docs/**/*.webp", "*", "docs/figures/*.we*"]) {
			const dir = tempGitRepo();
			writeFileSync(join(dir, "LEADERBOARD.md"), "# ok\n");
			Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
			const { exitCode, stderr } = runAssert(dir, ["staged", "--", pattern]);
			expect(exitCode, pattern).toBe(2);
			expect(stderr, pattern).toContain("refusing allowlist glob");
		}
	});

	test("pr mode accepts a PR file list that is exactly the allowlist", () => {
		const dir = tempGitRepo();
		const stub = stubGh(["LEADERBOARD.md"]);
		const { exitCode, stderr } = runAssert(dir, ["pr", "123", "--", "LEADERBOARD.md"], {
			PATH: `${stub}:${process.env.PATH}`,
		});
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
	});

	test("pr mode rejects a rename source path surfaced via previous_filename", () => {
		const dir = tempGitRepo();
		// The API-side view of a rename attack: filename is allowlisted, previous_filename is not.
		const stub = stubGh(["LEADERBOARD.md", ".github/workflows/ci.yml"]);
		const { exitCode, stderr } = runAssert(dir, ["pr", "123", "--", "LEADERBOARD.md"], {
			PATH: `${stub}:${process.env.PATH}`,
		});
		expect(exitCode).toBe(1);
		expect(stderr).toContain("path not allowlisted: .github/workflows/ci.yml");
	});

	test("pr mode fails closed when the file listing dies mid-stream", () => {
		const dir = tempGitRepo();
		// A --paginate request erroring after earlier pages printed must NOT validate the partial
		// (allowlisted-so-far) list — the collection failure itself has to fail the fence.
		const stub = stubGh(["LEADERBOARD.md"], { failMidStream: true });
		const { exitCode } = runAssert(dir, ["pr", "123", "--", "LEADERBOARD.md"], {
			PATH: `${stub}:${process.env.PATH}`,
		});
		expect(exitCode).not.toBe(0);
	});
});
