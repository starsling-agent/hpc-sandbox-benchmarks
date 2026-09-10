import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	rawTreeDigest,
	readExperimentAttempts,
	writeImmutableJson,
} from "./experiment-artifacts.ts";

const directories: string[] = [];
function temporary() {
	const directory = mkdtempSync(join(tmpdir(), "experiment-evidence-"));
	directories.push(directory);
	return directory;
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

test("published evidence is immutable and failed overwrite preserves the original", () => {
	const path = join(temporary(), "attempt.json");
	writeImmutableJson(path, { outcome: "failed" });
	expect(() => writeImmutableJson(path, { outcome: "completed" })).toThrow();
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ outcome: "failed" });
});

test("raw digest binds both paths and bytes, independently of creation order", () => {
	const a = temporary();
	const b = temporary();
	writeFileSync(join(a, "one.xml"), "one");
	writeFileSync(join(a, "two.xml"), "two");
	writeFileSync(join(b, "two.xml"), "two");
	writeFileSync(join(b, "one.xml"), "one");
	expect(rawTreeDigest(a)).toBe(rawTreeDigest(b));
	writeFileSync(join(b, "one.xml"), "changed");
	expect(rawTreeDigest(a)).not.toBe(rawTreeDigest(b));
	rmSync(join(b, "one.xml"));
	writeFileSync(join(b, "renamed.xml"), "one");
	expect(rawTreeDigest(a)).not.toBe(rawTreeDigest(b));
});

test("empty raw trees and symlinked evidence fail closed", () => {
	const root = temporary();
	expect(() => rawTreeDigest(root)).toThrow("empty");
	symlinkSync(temporary(), join(root, "outside"));
	expect(() => rawTreeDigest(root)).toThrow("symbolic");
	expect(() => readExperimentAttempts(join(root, "outside"))).toThrow("symbolic");
});

test("interrupted launch intent is not a terminal attempt", () => {
	const root = temporary();
	mkdirSync(join(root, "attempt-one"));
	writeImmutableJson(join(root, "attempt-one", "intent.json"), { started: true });
	expect(() => readExperimentAttempts(root)).toThrow("unterminated allocation intent");
});
