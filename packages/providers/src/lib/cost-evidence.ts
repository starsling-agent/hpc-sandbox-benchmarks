import { types as utilTypes } from "node:util";
import type { MissingProviderCostEvidence, SdkProvenance } from "@sandbox-benchmarks/schema";
import { canonicalJsonString, PROVIDER_RESPONSE_LIMITS } from "@sandbox-benchmarks/schema";
import type { CostEvidenceCaptureInput, ProviderCostEvidenceCapability } from "./types.ts";

export const RUNCLOUD_SDK_PROVENANCE = {
	packageName: "@run-cloud/sdk",
	version: "0.9.0",
} as const satisfies SdkProvenance;

const REDACTED = "[REDACTED]";
const CREDENTIAL_KEYS = new Set([
	"authorization",
	"token",
	"secret",
	"cookie",
	"session",
	"password",
	"apikey",
]);

function isPlainObject(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function credentialKey(key: string): boolean {
	const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
	return [...CREDENTIAL_KEYS].some((credential) => normalized.includes(credential));
}

/** Redact credentials embedded in otherwise non-credential string fields. */
function redactCredentialText(value: string): string {
	return (
		value
			// URL userinfo (`scheme://user:password@host`) is credential material even without a key name.
			.replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
			// Query/header/JSON/assignment forms. Consume an optional auth scheme with its credential so a
			// value such as `access_token=Bearer abc` cannot leave `abc` behind.
			.replaceAll(
				/((?:x[_-]?)?api[_-]?key\s*["']?\s*[:=]\s*["']?\s*|(?:access[_-]?token|token|secret|password|cookie|session)\s*["']?\s*[:=]\s*["']?\s*)(?:(?:bearer|basic)\s+)?[^&\s"',;}]+/gi,
				"$1[REDACTED]",
			)
			// Bare authorization text can appear in logs without an `Authorization` key.
			.replaceAll(/\b(bearer|basic)\s+[^\s"',;}]+/gi, "$1 [REDACTED]")
	);
}

/** Canonical, redacted JSON suitable for durable evidence. */
export function sanitizeProviderResponse(value: unknown): string {
	if (value === null || typeof value !== "object") {
		throw new Error("provider response must contain an object or array");
	}
	const active = new Set<object>();
	const encoder = new TextEncoder();
	let traversedBytes = 0;
	let nodes = 0;
	const charge = (text: string): void => {
		traversedBytes += encoder.encode(text).byteLength;
		if (traversedBytes > PROVIDER_RESPONSE_LIMITS.maxBytes) {
			throw new Error("sanitized provider response exceeds 64 KiB");
		}
	};
	const visit = (input: unknown, depth: number): unknown => {
		if (++nodes > PROVIDER_RESPONSE_LIMITS.maxNodes) {
			throw new Error("provider response exceeds node limit");
		}
		if (depth > PROVIDER_RESPONSE_LIMITS.maxDepth) {
			throw new Error("provider response exceeds nesting depth");
		}
		if (typeof input === "string") {
			if (input.length > PROVIDER_RESPONSE_LIMITS.maxStringLength) {
				throw new Error("provider response string is too long");
			}
			const redacted = redactCredentialText(input);
			charge(JSON.stringify(redacted));
			return redacted;
		}
		if (input === null || typeof input === "boolean") {
			charge(String(input));
			return input;
		}
		if (typeof input === "number") {
			if (!Number.isFinite(input))
				throw new Error("provider response contains a non-finite number");
			charge(String(input));
			return input;
		}
		if (typeof input !== "object") throw new Error("provider response contains a non-JSON value");
		if (utilTypes.isProxy(input)) throw new Error("provider response contains a Proxy object");
		if (active.has(input)) throw new Error("provider response contains a cycle");
		active.add(input);
		try {
			if (Array.isArray(input)) {
				const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
				if (
					!lengthDescriptor ||
					!("value" in lengthDescriptor) ||
					typeof lengthDescriptor.value !== "number" ||
					!Number.isSafeInteger(lengthDescriptor.value) ||
					lengthDescriptor.value < 0 ||
					!lengthDescriptor.writable ||
					lengthDescriptor.enumerable ||
					lengthDescriptor.configurable
				) {
					throw new Error("provider response array has an unexpected length descriptor");
				}
				const length = lengthDescriptor.value;
				if (length > PROVIDER_RESPONSE_LIMITS.maxArrayLength) {
					throw new Error("provider response array is too long");
				}
				const keys = Reflect.ownKeys(input);
				if (
					keys.length !== length + 1 ||
					keys.some((key) => key !== "length" && !/^\d+$/.test(String(key)))
				) {
					throw new Error("provider response array is sparse or has unexpected properties");
				}
				const values = new Array<unknown>(length);
				for (let index = 0; index < length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
					if (
						!descriptor ||
						!("value" in descriptor) ||
						!descriptor.enumerable ||
						!descriptor.configurable ||
						!descriptor.writable
					) {
						throw new Error(
							"provider response array index has an accessor or unexpected descriptor",
						);
					}
					values[index] = descriptor.value;
				}
				charge(`[]${",".repeat(Math.max(0, length - 1))}`);
				if (length === 2 && typeof values[0] === "string" && credentialKey(values[0])) {
					return [visit(values[0], depth + 1), visit(REDACTED, depth + 1)];
				}
				return values.map((item) => visit(item, depth + 1));
			}
			if (!isPlainObject(input))
				throw new Error("provider response contains an unsupported prototype");
			const keys = Object.keys(input).sort((a, b) => a.localeCompare(b, "en"));
			if (keys.length > PROVIDER_RESPONSE_LIMITS.maxObjectKeys) {
				throw new Error("provider response object has too many keys");
			}
			const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
			charge(`{}${",".repeat(Math.max(0, keys.length - 1))}`);
			for (const key of keys) {
				if (key.length > PROVIDER_RESPONSE_LIMITS.maxKeyLength) {
					throw new Error("provider response key is too long");
				}
				charge(`${JSON.stringify(key)}:`);
				const descriptor = Object.getOwnPropertyDescriptor(input, key);
				if (!descriptor || !("value" in descriptor)) {
					throw new Error("provider response contains an accessor property");
				}
				const redact = credentialKey(key);
				const sanitized = redact ? REDACTED : visit(descriptor.value, depth + 1);
				if (redact) charge(JSON.stringify(REDACTED));
				Object.defineProperty(output, key, {
					value: sanitized,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return output;
		} finally {
			active.delete(input);
		}
	};
	return canonicalJsonString(visit(value, 0));
}

/** Fixed safe detail: provider error text, headers, response bodies, and stacks are never persisted. */
export function sanitizeEvidenceDetail(_error: unknown): string {
	return "Provider cost evidence operation failed; provider-supplied error details were not persisted.";
}

function baseMissing(
	input: CostEvidenceCaptureInput,
	sdk: SdkProvenance,
	reason: MissingProviderCostEvidence["reason"],
	detail: string,
	context: Record<string, string> = {},
): MissingProviderCostEvidence {
	return {
		kind: "missing",
		cell: input.cell,
		subject: { kind: "sandbox", sandboxId: input.sandboxId, ...context },
		capturedAt: new Date().toISOString(),
		sdk,
		reason,
		detail,
	};
}

async function runcloudCapture(
	input: CostEvidenceCaptureInput,
): Promise<MissingProviderCostEvidence> {
	if (!input.teardown.completed) {
		return baseMissing(
			input,
			RUNCLOUD_SDK_PROVENANCE,
			"sandbox_teardown_unconfirmed",
			"Sandbox teardown was not confirmed; no provider usage was considered.",
		);
	}
	return baseMissing(
		input,
		RUNCLOUD_SDK_PROVENANCE,
		"not_sandbox_scoped",
		"The installed public run.cloud usage API is organization-wide cumulative usage and was not called or delta-attributed to this sandbox.",
	);
}

export const runcloudCostEvidence: ProviderCostEvidenceCapability = {
	sdk: RUNCLOUD_SDK_PROVENANCE,
	captureAfterTeardown: runcloudCapture,
};
