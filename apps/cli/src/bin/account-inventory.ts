#!/usr/bin/env bun
// Print each provider account as the reconciliation gate sees it: the benchmark's own leftovers
// (which the next batch's admission would delete) and foreign resources (which block account-scoped
// admission). Read-only — the operator's "clean vendor baseline" check before provisioning an
// account journal or dispatching a matrix. Credentials come from the environment (Bun loads .env).
import { describeDriverFailure } from "@sandbox-benchmarks/driver";
import { diagnosticSecretsFromEnv } from "@sandbox-benchmarks/driver/env";
import type { DriverProviderId } from "@sandbox-benchmarks/drivers";
import { DRIVERS } from "@sandbox-benchmarks/drivers";
import {
	formatAccountInventory,
	inventoryAccounts,
	inventoryBlocksAdmission,
} from "../lib/account-inventory.ts";
import { isDriverProviderId, openDriver } from "../lib/driver-run.ts";

if (import.meta.main) {
	const requested = process.argv.slice(2);
	const unknown = requested.filter((id) => !isDriverProviderId(id));
	if (unknown.length > 0) {
		console.error(
			[
				"usage: account-inventory [provider...]",
				`unknown or unmigrated provider(s): ${unknown.join(", ")}`,
				`migrated providers: ${Object.keys(DRIVERS).join(", ")}`,
			].join("\n"),
		);
		process.exit(2);
	}
	const ids = (requested.length > 0 ? requested : Object.keys(DRIVERS)) as DriverProviderId[];
	const rows = await inventoryAccounts(
		ids,
		(id) => openDriver(id),
		(error) => describeDriverFailure(error, diagnosticSecretsFromEnv(process.env)),
	);
	console.log(formatAccountInventory(rows));
	process.exitCode = inventoryBlocksAdmission(rows) ? 1 : 0;
}
