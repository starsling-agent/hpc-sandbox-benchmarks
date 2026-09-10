import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { parseArgs, stampPath } from "./warm-pts.ts";

describe("parseArgs", () => {
	it("accepts repeated --suite, -s, --suite=, and positional tokens", () => {
		expect(parseArgs(["--suite", "disk", "-s", "memory", "--suite=network", "cpu-node"])).toEqual({
			suites: ["disk", "memory", "network", "cpu-node"],
			dryPlan: false,
			listSuites: false,
		});
	});

	it("defaults to no selection (the planner's `synthetic`) and reads the mode flags", () => {
		expect(parseArgs(["--dry-plan", "--list-suites"])).toEqual({
			suites: [],
			dryPlan: true,
			listSuites: true,
		});
	});

	it("rejects a flag-shaped value rather than swallowing the next flag as a suite", () => {
		expect(() => parseArgs(["--suite", "--dry-plan"])).toThrow(/needs a value/);
		expect(() => parseArgs(["--suite="])).toThrow(/needs a value/);
		expect(() => parseArgs(["--warm-everything"])).toThrow(/unexpected argument/);
	});
});

describe("stampPath", () => {
	it("keys one stamp per resolved suite set, order-independent within a run", () => {
		expect(stampPath(["disk", "memory"])).toBe(
			`${homedir()}/.cache/sandbox-benchmarks/pts-warm-disk+memory.stamp`,
		);
		// A suite name can only be [a-z0-9-], but the stamp is a path: keep the sanitizer honest.
		expect(stampPath(["../../etc/passwd"])).toBe(
			`${homedir()}/.cache/sandbox-benchmarks/pts-warm-.._.._etc_passwd.stamp`,
		);
	});
});
