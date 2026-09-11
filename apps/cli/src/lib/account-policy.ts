import type { ProviderId } from "@sandbox-benchmarks/driver";
import { quotaDomain } from "@sandbox-benchmarks/schema";

/** Reviewed inventory scopes (ADR-0011), bound to the experiment's source revision. */
export function accountInventoryScope(id: ProviderId): "account" | "benchmark" {
	const account = quotaDomain(id);
	return account === "daytona" || account === "novita" ? "benchmark" : "account";
}
