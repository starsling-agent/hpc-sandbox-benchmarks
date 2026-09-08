import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RUNCLOUD_SDK_PROVENANCE,
	runcloudCostEvidence,
	sanitizeEvidenceDetail,
	sanitizeProviderResponse,
} from "./cost-evidence.ts";

const input = (completed = true) =>
	({
		cell: { runId: "run-1", providerId: "runcloud", suite: "cpu-node", replicateIndex: 2 },
		providerId: "runcloud",
		sandboxId: "sb-123",
		teardown: {
			completed,
			attemptedAt: "2026-08-08T00:00:00.000Z",
			...(completed ? { completedAt: "2026-08-08T00:00:01.000Z" } : {}),
		},
	}) as const;

function installedVersion(packageName: string): string {
	const entry = fileURLToPath(import.meta.resolve(packageName));
	let directory = dirname(entry);
	for (;;) {
		const manifest = join(directory, "package.json");
		try {
			return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
		} catch {
			const parent = dirname(directory);
			if (parent === directory) throw new Error(`package manifest not found for ${packageName}`);
			directory = parent;
		}
	}
}

describe("provider cost evidence", () => {
	it("canonicalizes responses, recursively redacts credential keys, and rejects unsafe values", () => {
		expect(
			sanitizeProviderResponse({
				z: 1,
				nested: { api_key: "canary", safe: true },
				access_token: "canary2",
			}),
		).toBe('{"access_token":"[REDACTED]","nested":{"api_key":"[REDACTED]","safe":true},"z":1}');
		expect(() => sanitizeProviderResponse({ value: Number.NaN })).toThrow(/non-finite/);
		expect(() => sanitizeProviderResponse(new Date())).toThrow(/unsupported prototype/);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => sanitizeProviderResponse(cycle)).toThrow(/cycle/);
		expect(() => sanitizeProviderResponse({ value: "x".repeat(65 * 1024) })).toThrow(
			/string is too long|64 KiB/,
		);
		expect(() =>
			sanitizeProviderResponse({ values: new Array(9).fill("é".repeat(8_000)) }),
		).toThrow(/64 KiB/);
		expect(() => sanitizeProviderResponse("primitive")).toThrow(/object or array/);
		expect(() => sanitizeProviderResponse(new Array(1_025).fill(0))).toThrow(/array is too long/);
		let nested: unknown = {};
		for (let index = 0; index < 18; index++) nested = { nested };
		expect(() => sanitizeProviderResponse(nested)).toThrow(/nesting depth/);
	});

	it("preserves special JSON keys as data without prototype mutation", () => {
		const special = JSON.parse(
			'{"__proto__":{"safe":true},"constructor":{"safe":false}}',
		) as unknown;
		const parsed = JSON.parse(sanitizeProviderResponse(special)) as Record<string, unknown>;
		expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
		expect(Object.hasOwn(parsed, "constructor")).toBe(true);
		expect(parsed.__proto__).toEqual({ safe: true });
	});

	it("redacts credential assignments, headers, tuples, URL userinfo, and bare auth text", () => {
		const bearer = "bearer.SECRET_SUFFIX_CANARY";
		const basic = "basic.SECRET_SUFFIX_CANARY";
		const sanitized = sanitizeProviderResponse({
			Authorization: `Bearer ${bearer}`,
			logA: `api_key=${bearer}&access_token=${basic} token=${bearer} secret=${basic} password=${bearer}`,
			logB: `cookie=${bearer}; session=${basic}`,
			header: `Authorization: Basic ${basic}`,
			logC: `X-Api-Key: ${bearer}`,
			quoted: `{"authorization":"Bearer ${bearer}"}`,
			bare: `Bearer ${bearer} Basic ${basic}`,
			tuples: [
				["Authorization", `Bearer ${bearer}`],
				["X-Api-Key", bearer],
				["Cookie", `session=${basic}`],
			],
			url: `https://user:${basic}@vendor.invalid/path`,
		});
		expect(sanitized).not.toContain(bearer);
		expect(sanitized).not.toContain(basic);
		expect(sanitizeProviderResponse(JSON.parse(sanitized))).toBe(sanitized);
		expect(JSON.parse(sanitized)).toEqual({
			Authorization: "[REDACTED]",
			bare: "Bearer [REDACTED] Basic [REDACTED]",
			header: "Authorization: Basic [REDACTED]",
			logA: "api_key=[REDACTED]&access_token=[REDACTED] token=[REDACTED] secret=[REDACTED] password=[REDACTED]",
			logB: "cookie=[REDACTED]; session=[REDACTED]",
			logC: "X-Api-Key: [REDACTED]",
			quoted: '{"authorization":"Bearer [REDACTED]"}',
			tuples: [
				["Authorization", "[REDACTED]"],
				["X-Api-Key", "[REDACTED]"],
				["Cookie", "[REDACTED]"],
			],
			url: "https://[REDACTED]@vendor.invalid/path",
		});
	});

	it("rejects root and nested Proxy objects before reflective traversal", () => {
		const root = new Proxy({ safe: true }, {});
		const nested = { nested: new Proxy({ safe: true }, {}) };
		expect(() => sanitizeProviderResponse(root)).toThrow(/Proxy/);
		expect(() => sanitizeProviderResponse(nested)).toThrow(/Proxy/);
	});

	it("rejects root and nested array-index accessors without invoking getters", () => {
		let getterCalls = 0;
		const accessor = (): unknown[] => {
			const value: unknown[] = [];
			Object.defineProperty(value, "0", {
				get: () => {
					getterCalls++;
					return "Bearer secret";
				},
				enumerable: true,
				configurable: true,
			});
			return value;
		};
		expect(() => sanitizeProviderResponse(accessor())).toThrow(/accessor|descriptor/);
		expect(() => sanitizeProviderResponse({ nested: accessor() })).toThrow(/accessor|descriptor/);
		expect(getterCalls).toBe(0);
	});

	it("never persists arbitrary provider error text or credential suffixes", () => {
		const canary = "prefix.SECRET_SUFFIX_CANARY";
		for (const message of [
			`Authorization: Bearer ${canary}`,
			`Authorization: Basic ${canary}`,
			`{"authorization":"Bearer ${canary}"}`,
			`headers={"Authorization":"Basic ${canary}"}`,
		]) {
			const detail = sanitizeEvidenceDetail(new Error(message));
			expect(detail).not.toContain(canary);
			expect(detail).not.toContain("SECRET_SUFFIX_CANARY");
		}
	});

	it("pins provenance to the installed native SDK package", () => {
		expect(String(RUNCLOUD_SDK_PROVENANCE.version)).toBe(installedVersion("@run-cloud/sdk"));
	});

	it("returns explicit missing evidence without calling organization-wide APIs", async () => {
		const runcloud = await runcloudCostEvidence.captureAfterTeardown(input());
		expect(runcloud).toMatchObject({ kind: "missing", reason: "not_sandbox_scoped" });
		if (runcloud.kind !== "missing") throw new Error("run.cloud hook returned observed evidence");
		expect(runcloud.detail).toContain("was not called or delta-attributed");
	});

	it("reports unconfirmed teardown before considering provider usage", async () => {
		expect(await runcloudCostEvidence.captureAfterTeardown(input(false))).toMatchObject({
			kind: "missing",
			reason: "sandbox_teardown_unconfirmed",
		});
	});
});
