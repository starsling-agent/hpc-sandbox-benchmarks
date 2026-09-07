import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "@sandbox-benchmarks/providers";
import type { ProviderTarget } from "./providers-run.ts";
import { bootAndSmoke, smokeFailureReason, smokeOk } from "./smoke-run.ts";

const legacyTarget: ProviderTarget = {
	kind: "legacy",
	id: "daytona-vm",
	// Never reached: the guard under test rejects before anything is constructed or booted.
	config: { name: "daytona-vm" } as unknown as ProviderConfig,
};

describe("bootAndSmoke lane guards", () => {
	test("rejects an artifact override on the leftover lane instead of ignoring it", async () => {
		// The leftover adapter takes its candidate ref through the ProviderConfig the caller builds. If
		// `options.artifact` were silently dropped here, bake would boot the PUBLISHED artifact and
		// report the candidate as validated without ever having touched it.
		const outcome = await bootAndSmoke(legacyTarget, { artifact: { ref: "candidate-template" } });
		expect(outcome.checks).toEqual([]);
		expect(smokeOk(outcome)).toBe(false);
		expect(smokeFailureReason(outcome)).toMatch(/artifact through the provider config/);
	});
});
