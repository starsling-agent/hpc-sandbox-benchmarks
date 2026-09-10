import { isDriverError, isFailedCreateCleanupError } from "./errors.ts";

/** Render only the driver-owned diagnostic projection, never arbitrary SDK object fields. */
export function describeDriverFailure(error: unknown, secrets: readonly string[] = []): string {
	const seen = new Set<unknown>();
	const describe = (value: unknown, depth: number): string => {
		if (depth > 4 || seen.has(value)) return "diagnostic chain truncated";
		seen.add(value);
		if (isFailedCreateCleanupError(value)) {
			return `${describe(value.suppressed, depth + 1)}; cleanup failed: ${describe(value.error, depth + 1)}`;
		}
		if (isDriverError(value)) {
			const parts = [value.message];
			if (value.vendorMessage && !value.message.includes(value.vendorMessage)) {
				parts.push(value.vendorMessage);
			}
			if (value.vendorHttpStatus !== undefined) parts.push(`HTTP ${value.vendorHttpStatus}`);
			if (value.vendorExitCode !== undefined) parts.push(`process exit ${value.vendorExitCode}`);
			return redactDiagnosticText(parts.join("; "), secrets).slice(0, 8192);
		}
		return value instanceof Error
			? value.message
			: typeof value === "string"
				? value
				: "Unknown failure";
	};
	return redactDiagnosticText(describe(error, 0), secrets).slice(0, 16384);
}

/** Redact before truncation so a cutoff cannot expose the beginning of a credential. */
export function redactDiagnosticText(text: string, secrets: readonly string[]): string {
	let output = text;
	for (const secret of [...new Set(secrets)]
		.filter(Boolean)
		.toSorted((a, b) => b.length - a.length)) {
		for (const form of new Set([
			secret,
			encodeURIComponent(secret),
			JSON.stringify(secret).slice(1, -1),
		]))
			output = output.replaceAll(form, "<REDACTED>");
	}
	return output.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 <REDACTED>");
}
