import { describe, expect, test } from "bun:test";
import { DriverError } from "@sandbox-benchmarks/driver";
import {
	concurrentSandboxAdmissionDetail,
	isConcurrentSandboxAdmissionError,
} from "./admission-capacity.ts";

describe("concurrent sandbox admission errors", () => {
	test("recognizes a structured 429 concurrent limit", () => {
		const error = new DriverError("create-failed", "computesdk create failed", {
			provider: "runcloud",
			vendorHttpStatus: 429,
			vendorMessage: "API 429: concurrent sandbox resource limit reached",
		});
		expect(isConcurrentSandboxAdmissionError(error)).toBe(true);
		expect(
			concurrentSandboxAdmissionDetail(error, {
				quotaDomain: "runcloud",
				declaredSandboxes: 30,
				batchConcurrency: 30,
			}),
		).toContain("declared 30 sandboxes");
	});

	test("ignores unclassified 429 prose and non-429 create failures", () => {
		expect(
			isConcurrentSandboxAdmissionError(
				new DriverError("create-failed", "API 429: concurrent sandbox resource limit reached", {
					provider: "runcloud",
				}),
			),
		).toBe(false);
		expect(
			isConcurrentSandboxAdmissionError(
				new DriverError("create-failed", "rate limited", {
					provider: "runcloud",
					vendorHttpStatus: 429,
					vendorMessage: "too many requests",
				}),
			),
		).toBe(false);
	});
});
