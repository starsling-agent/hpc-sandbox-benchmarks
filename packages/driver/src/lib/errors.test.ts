import { describe, expect, test } from "bun:test";
import type { FailedCreateRecovery } from "./errors.ts";
import {
	DriverError,
	FailedCreateCleanupError,
	isRetryableDriverCreate,
	markRetryableDriverCreate,
} from "./errors.ts";

function retainedError(locator: FailedCreateRecovery["locator"], cleanup = async () => {}) {
	return new FailedCreateCleanupError(new Error("cleanup failed"), new Error("create failed"), {
		provider: "tama",
		locator,
		cleanup,
	});
}

describe("FailedCreateCleanupError", () => {
	test("owns inherited and non-enumerable marker fields instead of spreading their container", () => {
		const inherited = Object.create({ kind: "marker" }) as object;
		Object.defineProperties(inherited, {
			key: { value: "attempt", enumerable: false },
			value: { value: "abc", enumerable: false },
		});
		const error = retainedError(inherited as FailedCreateRecovery["locator"]);
		expect(error.locator).toEqual({ kind: "marker", key: "attempt", value: "abc" });
		expect(Object.isFrozen(error.locator)).toBe(true);
		expect(error.message).toContain("marker attempt=abc");
	});

	test("single-reads stateful locator accessors into one stable snapshot", () => {
		const reads = { kind: 0, key: 0, value: 0 };
		const locator = {
			get kind() {
				if (++reads.kind > 1) throw new Error("kind reread");
				return "marker" as const;
			},
			get key() {
				if (++reads.key > 1) throw new Error("key reread");
				return "externalId";
			},
			get value() {
				if (++reads.value > 1) throw new Error("value reread");
				return "stable";
			},
		};
		const error = retainedError(locator);
		expect(error.locator).toEqual({ kind: "marker", key: "externalId", value: "stable" });
		expect(reads).toEqual({ kind: 1, key: 1, value: 1 });
	});

	test("retains callback-only cleanup when a marker accessor throws", async () => {
		let cleanupCalls = 0;
		const locator = {
			kind: "marker" as const,
			get key(): string {
				throw new Error("raw locator secret");
			},
			value: "stable",
		};
		const error = retainedError(locator, async () => {
			cleanupCalls += 1;
		});
		expect(error.locator).toEqual({ kind: "cleanup-callback" });
		expect(error.message).toContain("retained cleanup callback");
		expect(error.message).not.toContain("raw locator secret");
		await error.cleanup();
		expect(cleanupCalls).toBe(1);
	});
});

describe("isRetryableDriverCreate", () => {
	test("a constructor mark on create-failed is retryable", () => {
		const error = new DriverError("create-failed", "no slot right now", {
			provider: "e2b",
			retryable: true,
			vendorMessage: "quota exceeded",
		});
		expect(error.retryable).toBe(true);
		expect(isRetryableDriverCreate(error)).toBe(true);
		expect(markRetryableDriverCreate(error)).toBe(error);
	});

	test("markRetryableDriverCreate sets the typed bit without wrapping", () => {
		const error = new DriverError(
			"create-failed",
			"run.cloud create did not settle within 30000ms",
			{
				provider: "tama",
			},
		);
		expect(error.retryable).toBe(false);
		expect(isRetryableDriverCreate(error)).toBe(false);
		expect(markRetryableDriverCreate(error)).toBe(error);
		expect(error.retryable).toBe(true);
		expect(isRetryableDriverCreate(error)).toBe(true);
	});

	test("unclassified prose, including a 429 sentence, is not retryable", () => {
		const prose = new DriverError("create-failed", "429 Too Many Requests", {
			provider: "e2b",
			vendorMessage: "quota|rate limit|capacity|429",
		});
		expect(isRetryableDriverCreate(prose)).toBe(false);
		expect(isRetryableDriverCreate(new Error("429 Too Many Requests"))).toBe(false);
		expect(isRetryableDriverCreate("quota exceeded")).toBe(false);
		const unmarked = new Error("no slot");
		expect(markRetryableDriverCreate(unmarked)).toBe(unmarked);
		expect(isRetryableDriverCreate(unmarked)).toBe(false);
	});

	test("a structured vendor exit of 429 is retryable without a mark", () => {
		// Shaped like a driver that built its failure straight from an HTTP response — the only
		// producer that can put a status here. A CLI driver's vendorExitCode is a process exit status.
		const error = new DriverError("create-failed", "POST /sandboxes: 429 Too Many Requests", {
			provider: "tama",
			vendorExitCode: 429,
			vendorMessage: "capacity",
		});
		expect(error.retryable).toBe(false);
		expect(isRetryableDriverCreate(error)).toBe(true);
	});

	test("non-create codes stay terminal even when a caller asks to mark them", () => {
		const invalid = new DriverError("invalid-create-request", "bad image", {
			provider: "e2b",
			retryable: true,
		});
		expect(invalid.retryable).toBe(false);
		expect(isRetryableDriverCreate(markRetryableDriverCreate(invalid))).toBe(false);
		expect(
			isRetryableDriverCreate(
				new DriverError("readiness-timeout", "never ready", {
					provider: "e2b",
					retryable: true,
					vendorExitCode: 429,
				}),
			),
		).toBe(false);
	});

	test("a failed-create cleanup double fault is not a retryable create", () => {
		const create = markRetryableDriverCreate(
			new DriverError("create-failed", "no slot", { provider: "tama" }),
		);
		const error = new FailedCreateCleanupError(new Error("cleanup failed"), create, {
			provider: "tama",
			locator: { kind: "name", value: "bench-1" },
			cleanup: async () => {},
		});
		expect(isRetryableDriverCreate(error)).toBe(false);
		expect(isRetryableDriverCreate(error.suppressed)).toBe(true);
	});
});
