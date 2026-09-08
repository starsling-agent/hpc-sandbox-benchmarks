// Shared error-inspection mechanics for the fleet's create-failure classifiers.
//
// Every bridge-backed module answers the same two questions about a rejected create — "did this
// allocate anything?" and "is it worth retrying?" — and each answer is a per-provider predicate over
// a vendor error. The predicate is provider policy and stays in the provider's module; the traversal
// that finds the link to test is mechanics, and belongs here. Three copies of that traversal had
// already drifted apart before this was extracted (one guarded its first `instanceof` against a
// hostile prototype and its second not at all), which is exactly the divergence ADR-0007 collapsed
// `shellQuote` and the `nohup` fallback into one implementation to prevent.

/** How far a wrapper is allowed to nest a vendor error before the walk gives up. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Whether `error`, or any error it wraps as a `cause`, satisfies `matches`.
 *
 * `matches` is asked about EVERY link, including one that is not an `Error` — a wrapper may hand
 * back a plain object carrying an HTTP status, and that link is testable even though the chain
 * cannot continue through it. Once a non-`Error` link fails the predicate the walk stops, because
 * `cause` is only defined on `Error`.
 *
 * The whole loop is hardened rather than a single line of it: a rejected value is attacker-shaped
 * input at this boundary, so a throwing `cause` getter or a `Symbol.hasInstance` that runs user code
 * answers "no match" instead of replacing the vendor's failure with the classifier's own. Depth,
 * self-reference and `undefined` all terminate, so a cyclic or absurdly nested chain cannot hang it.
 */
export function matchesAnyCause(error: unknown, matches: (link: unknown) => boolean): boolean {
	let link: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
		try {
			if (matches(link)) return true;
			if (!(link instanceof Error)) return false;
			const next: unknown = link.cause;
			if (next === undefined || next === link) return false;
			link = next;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * An HTTP status a vendor error carries as a plain field, under any of the three names the
 * ecosystem's clients use. Reads defensively: this runs on values a vendor SDK rejected with, so a
 * hostile or exotic accessor yields "no status" rather than escaping the classifier.
 */
export function vendorHttpStatus(error: unknown): number | undefined {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) {
		return undefined;
	}
	try {
		for (const key of ["status", "statusCode", "httpStatusCode"] as const) {
			const value = Reflect.get(error, key);
			if (typeof value === "number" && Number.isSafeInteger(value)) return value;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
