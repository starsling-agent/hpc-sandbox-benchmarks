import { isDriverError } from "@sandbox-benchmarks/driver";

/** Vendor refused create because the account already holds its concurrent sandbox quota. */
export function isConcurrentSandboxAdmissionError(error: unknown): boolean {
	if (!isDriverError(error) || error.code !== "create-failed" || error.vendorHttpStatus !== 429)
		return false;
	const text = `${error.message}\n${error.vendorMessage ?? ""}`.toLowerCase();
	return text.includes("concurrent") && (text.includes("limit") || text.includes("resource"));
}

export function concurrentSandboxAdmissionDetail(
	error: unknown,
	context: { quotaDomain: string; declaredSandboxes: number; batchConcurrency: number },
): string {
	const base = isDriverError(error)
		? `${error.message}${error.vendorMessage ? ` (${error.vendorMessage})` : ""}`
		: error instanceof Error
			? error.message
			: String(error);
	return (
		`vendor concurrent sandbox limit refused create for ${context.quotaDomain} while admission ` +
		`declared ${context.declaredSandboxes} sandboxes and this batch freezes maxConcurrency=` +
		`${context.batchConcurrency}; reconcile BENCH_ACCOUNT_CAPACITY before retrying: ${base}`
	);
}
