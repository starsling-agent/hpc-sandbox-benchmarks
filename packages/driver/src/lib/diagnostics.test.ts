import { expect, test } from "bun:test";
import { describeDriverFailure, redactDiagnosticText } from "./diagnostics.ts";
import { DriverError, FailedCreateCleanupError } from "./errors.ts";

test("retains driver-projected vendor diagnostics and ignores arbitrary SDK fields", () => {
	const failure = new DriverError("create-failed", "tama new: exit 1", {
		vendorMessage: "capacity exhausted; token <REDACTED>",
		vendorExitCode: 1,
		vendorHttpStatus: 429,
	});
	Object.assign(failure, { headers: { authorization: "sentinel-secret" } });
	const message = describeDriverFailure(failure);
	expect(message).toContain("capacity exhausted");
	expect(message).toContain("HTTP 429");
	expect(message).not.toContain("sentinel-secret");
});

test("preserves primary and cleanup failures without traversing untrusted causes", () => {
	const primary = new DriverError("create-failed", "create refused", {
		vendorMessage: "no capacity",
	});
	const failure = new FailedCreateCleanupError(new Error("delete unavailable"), primary, {
		provider: "tama",
		locator: { kind: "name", value: "benchmark-test" },
		cleanup: async () => {},
	});
	expect(describeDriverFailure(failure)).toBe(
		"create refused; no capacity; cleanup failed: delete unavailable",
	);
	expect(describeDriverFailure(new Error("safe", { cause: { token: "secret" } }))).toBe("safe");
});

test("caps vendor diagnostics", () => {
	expect(
		describeDriverFailure(
			new DriverError("create-failed", "failed", { vendorMessage: "x".repeat(20000) }),
		).length,
	).toBeLessThanOrEqual(8192);
});

test("redacts registered secrets before truncation in primary and cleanup projections", () => {
	const secret = "sentinel/token+secret-value";
	const primary = new DriverError("create-failed", `request ${secret}`, {
		vendorMessage: `x${" ".repeat(8170)}${secret}`,
	});
	const failure = new FailedCreateCleanupError(
		new Error(`cleanup ${encodeURIComponent(secret)}`),
		primary,
		{
			provider: "tama",
			locator: { kind: "name", value: "benchmark-test" },
			cleanup: async () => {},
		},
	);
	const message = describeDriverFailure(failure, [secret]);
	expect(message).not.toContain("sentinel");
	expect(message).not.toContain("secret-value");
	expect(message).toContain("<REDACTED>");
	expect(redactDiagnosticText(`Bearer unknown-token ${secret}`, [secret])).toBe(
		"Bearer <REDACTED> <REDACTED>",
	);
	expect(describeDriverFailure({ toString: () => secret }, [secret])).toBe("Unknown failure");
});
