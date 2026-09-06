// The runtime half of the remaining PROVIDERS × adapters join. During DriverModule migration,
// `adapters` is `Record<LegacyAdapterId, …>` (waived schema ids only). A compile error still
// catches an in-repo miss; this asserts the two remaining id sets are identical at load so a
// published/installed build or cross-version drift cannot surface as an `undefined` adapter deep
// inside a benchmark run.

/**
 * Assert that the schema provider ids and the harness adapter ids are exactly the same set.
 * Throws an {@link Error} naming every one-sided id (in the schema but missing an adapter, or with an
 * adapter but no schema entry) when they disagree; returns silently when they match. Both id lists
 * are passed in (rather than read from the modules) so the guard stays a pure, unit-testable function
 * the caller wires to the real registries.
 */
export function assertProviderJoin(
	schemaIds: readonly string[],
	adapterIds: readonly string[],
): void {
	const schema = new Set(schemaIds);
	const adapter = new Set(adapterIds);
	const missingAdapter = schemaIds.filter((id) => !adapter.has(id));
	const missingSchema = adapterIds.filter((id) => !schema.has(id));
	if (missingAdapter.length === 0 && missingSchema.length === 0) return;

	const parts: string[] = [];
	if (missingAdapter.length > 0) {
		parts.push(
			`in the schema PROVIDERS registry but missing a harness adapter: ${missingAdapter.join(", ")}`,
		);
	}
	if (missingSchema.length > 0) {
		parts.push(`have a harness adapter but no schema PROVIDERS entry: ${missingSchema.join(", ")}`);
	}
	throw new Error(`Provider registry mismatch — ${parts.join("; ")}`);
}

/** The create-bounding half of an adapter's contract, as {@link assertCreateCeilingDeclared} reads it. */
interface CreateBounds {
	createTimeoutMs?: number | null;
	createAttemptCeilingMs?: number;
}

/**
 * Assert that every adapter which disables the harness's per-attempt create race (`createTimeoutMs:
 * null`) also declares the ceiling it enforces itself. The two fields are one decision — "I own the
 * bound" — and only the pair is usable: the harness's create-retry loop subtracts the ceiling from
 * its remaining budget to decide whether another attempt can still finish in time, so an adapter that
 * opts out without declaring one silently buys back the overrun the budget exists to prevent (a
 * 20-minute readiness wait started at minute 59 of a one-hour budget). Checked at load, next to
 * {@link assertProviderJoin}, because the alternative is discovering it in a matrix job that blew its
 * timeout. Adapters are passed in as plain records so the guard stays a pure, unit-testable function.
 *
 * The ceiling must be POSITIVE, not merely present: zero (or a negative, or a NaN from arithmetic on
 * an unset constant) reserves nothing, which is the same overrun wearing a declared field. A declared
 * ceiling that cannot bound an attempt is worse than a missing one — it reads as compliance.
 */
export function assertCreateCeilingDeclared(
	adapters: Readonly<Record<string, CreateBounds>>,
): void {
	const undeclared = Object.entries(adapters)
		.filter(([, a]) => a.createTimeoutMs === null && !((a.createAttemptCeilingMs ?? 0) > 0))
		.map(([id]) => id);
	if (undeclared.length === 0) return;
	throw new Error(
		`Provider adapter misconfigured — ${undeclared.join(", ")} disabled the harness create timeout ` +
			`(createTimeoutMs: null) without declaring a positive createAttemptCeilingMs, so the ` +
			`create-retry budget cannot bound an attempt`,
	);
}
