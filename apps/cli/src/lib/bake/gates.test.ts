import { describe, expect, test } from "bun:test";
import {
	blockingFailures,
	blockingReports,
	isBlockingFailure,
	isBlockingId,
	isBlockingReport,
	nonBlockingFailures,
	unknownProviderIds,
} from "./gates.ts";

const REQUIRED = ["e2b", "daytona-vm", "modal-gvisor"];

describe("isBlockingFailure", () => {
	test("a required provider's failure blocks", () => {
		expect(isBlockingFailure({ provider: "daytona-vm", status: "failed" }, REQUIRED)).toBe(true);
	});

	test("a non-required provider's failure does NOT block (the promote-red-on-published bug)", () => {
		// daytona-container failing must not fail a release whose required set (e2b/daytona-vm/modal-gvisor) passed.
		expect(isBlockingFailure({ provider: "daytona-container", status: "failed" }, REQUIRED)).toBe(
			false,
		);
		expect(isBlockingFailure({ provider: "modal-vm", status: "failed" }, REQUIRED)).toBe(false);
		expect(isBlockingFailure({ provider: "novita", status: "failed" }, REQUIRED)).toBe(false);
	});

	test("the `image` commit-point sentinel ALWAYS blocks, even though it is not a required provider", () => {
		// This is why the exit gate can't be `required.includes(provider)` alone: the base-retag / abort
		// reports under `image`, and those must still fail the job.
		expect(isBlockingFailure({ provider: "image", status: "failed" }, REQUIRED)).toBe(true);
	});

	test("any unknown/synthetic sentinel id blocks", () => {
		expect(isBlockingFailure({ provider: "revalidate", status: "failed" }, REQUIRED)).toBe(true);
	});

	test("a non-failed status never blocks", () => {
		expect(isBlockingFailure({ provider: "daytona-vm", status: "ok" }, REQUIRED)).toBe(false);
		expect(isBlockingFailure({ provider: "image", status: "ok" }, REQUIRED)).toBe(false);
		expect(isBlockingFailure({ provider: "daytona-container", status: "skipped" }, REQUIRED)).toBe(
			false,
		);
	});

	test("locally (nothing required) every provider failure blocks — the hand-run safety net", () => {
		expect(isBlockingFailure({ provider: "daytona-container", status: "failed" }, [])).toBe(true);
		expect(isBlockingFailure({ provider: "e2b", status: "failed" }, [])).toBe(true);
	});
});

describe("isBlockingReport", () => {
	test("a required provider skip blocks, while a best-effort skip does not", () => {
		expect(isBlockingReport({ provider: "daytona-vm", status: "skipped" }, REQUIRED)).toBe(true);
		expect(isBlockingReport({ provider: "daytona-container", status: "skipped" }, REQUIRED)).toBe(
			false,
		);
	});

	test("a local skip remains non-blocking when no provider was explicitly required", () => {
		expect(isBlockingReport({ provider: "e2b", status: "skipped" }, [])).toBe(false);
	});
});

describe("blockingFailures / nonBlockingFailures partition the failures", () => {
	const reports = [
		{ provider: "e2b", status: "ok" },
		{ provider: "daytona-vm", status: "ok" },
		{ provider: "daytona-container", status: "failed" },
		{ provider: "modal-gvisor", status: "ok" },
		{ provider: "novita", status: "skipped" },
		{ provider: "image", status: "ok" },
	];

	test("only the non-required daytona-container failure is surfaced, and it is non-blocking", () => {
		expect(blockingFailures(reports, REQUIRED)).toEqual([]);
		expect(nonBlockingFailures(reports, REQUIRED).map((r) => r.provider)).toEqual([
			"daytona-container",
		]);
	});

	test("a required failure lands in blocking, a best-effort failure in non-blocking", () => {
		const mixed = [
			{ provider: "daytona-vm", status: "failed" },
			{ provider: "daytona-container", status: "failed" },
			{ provider: "image", status: "failed" },
		];
		expect(blockingFailures(mixed, REQUIRED).map((r) => r.provider)).toEqual([
			"daytona-vm",
			"image",
		]);
		expect(nonBlockingFailures(mixed, REQUIRED).map((r) => r.provider)).toEqual([
			"daytona-container",
		]);
	});

	test("blockingReports also includes required skips", () => {
		const outcomes = [
			{ provider: "e2b", status: "skipped" },
			{ provider: "daytona-container", status: "skipped" },
			{ provider: "image", status: "failed" },
		];
		expect(blockingReports(outcomes, REQUIRED).map((r) => r.provider)).toEqual(["e2b", "image"]);
	});
});

describe("isBlockingId (status-independent labelling for the summary)", () => {
	test("required provider and sentinel are blocking; best-effort provider is not", () => {
		expect(isBlockingId("daytona-vm", REQUIRED)).toBe(true);
		expect(isBlockingId("image", REQUIRED)).toBe(true);
		expect(isBlockingId("daytona-container", REQUIRED)).toBe(false);
	});
});

describe("unknownProviderIds", () => {
	test("returns unique unknown ids without filtering valid required providers", () => {
		expect(unknownProviderIds(["e2b", "typo", "daytona-vm", "typo"])).toEqual(["typo"]);
	});
});
