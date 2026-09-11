// Tama publishes no SDK. Its whole provider integration is this declarative CLI table: argv,
// arktype trust boundaries, readiness policy, and name-to-id failed-create reconciliation. Spawn,
// deadlines, cancellation, secret redaction, retries, output caps, and lifecycle guards live once in
// @sandbox-benchmarks/driver/cli.

import type { DriverContext } from "@sandbox-benchmarks/driver";
import type { CliCreateRequestCoverage } from "@sandbox-benchmarks/driver/cli";
import { defineCliDriver, defineCliSpec } from "@sandbox-benchmarks/driver/cli";
import { type } from "arktype";
import { TAMA_PROVENANCE } from "./provenance.ts";

export { TAMA_PROVENANCE };

export const TAMA_MACHINES = type("string.json.parse").to(
	type({
		id: "string >= 1",
		name: "string >= 1",
		status: "string >= 1",
		"status_detail?": "string",
	}).array(),
);

/** Exact shape observed in committed real Tama runs (for example machine-obusdw8bsyw2). */
export const TAMA_SANDBOX_ID = type(/^machine-[a-z0-9]{12}$/);

/** Only machine-qualified control-plane absence can release cleanup ownership. */
export const TAMA_MACHINE_NOT_FOUND =
	/^(?:error:\s*)?(?:machine(?:\s+machine-[a-z0-9]{12})?\s+not found|no such machine|unknown machine)[.!]?\s*$/i;

/** `tama new` includes the cold image pull and owns failed-create reconciliation. */
export const TAMA_CREATE_CEILING_MS = 25 * 60_000;
export const TAMA_EXECUTION = Object.freeze({
	syncCapMs: 60_000,
	durable: "shell-detach" as const,
});

export const TAMA_REQUEST_COVERAGE = {
	spec: {
		vcpus: "mapped",
		memoryGb: "mapped",
		diskGb: { capacityAtLeast: 40 },
	},
	artifact: "context",
	deadlineMs: "driver",
	gpu: { model: "unsupported", count: "unsupported" },
	env: "unsupported",
} as const satisfies CliCreateRequestCoverage;

/**
 * Build the table from one already-parsed context, so nothing here reads ambient env or resolves an
 * artifact: `env` arrives validated by the registry's declared input slice, and `resolvedArtifact` is
 * the ref the composition root chose for this lane. That is why `create` can assert the request's
 * artifact matches rather than deciding which image to boot.
 */
export function tamaSpec({ env, resolvedArtifact }: DriverContext<"tama">) {
	return defineCliSpec(TAMA_MACHINES, {
		binary: env.TAMA_CLI ?? "tama",
		secretFlags: ["--token"],
		inventoryOwned: (row) =>
			/^bench-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.name),
		commandTimeoutMs: 60_000,
		createCommandTimeoutMs: 20 * 60_000,
		requestCoverage: TAMA_REQUEST_COVERAGE,
		prepare: {
			authenticateFirst: true,
			probe: ["list", "--all", "--json"],
			fallback: ["login", "--token", env.TAMA_TOKEN],
		},
		create: (request, name) => {
			if (request.artifact.kind !== "image" || request.artifact.ref !== resolvedArtifact.ref) {
				throw new Error("the request artifact does not match the resolved Tama image");
			}
			return [
				"new",
				name,
				"--ttl",
				"0",
				"--json",
				"--image",
				resolvedArtifact.ref,
				"--cpu",
				String(request.spec.vcpus),
				"--memory",
				String(request.spec.memoryGb * 1024),
			];
		},
		cleanupCreated: {
			kind: "lookup",
			select: (rows, name) => rows.find((machine) => machine.name === name) ?? null,
			absenceConfirmationMs: 2_000,
		},
		ready: {
			poll: ["list", "--all", "--json"],
			select: (rows, name) => rows.find((machine) => machine.name === name) ?? null,
			classify: (machine) =>
				/^ready$/i.test(machine.status)
					? "ready"
					: /^(failed|error|stopped|terminated|deleted|gone)$/i.test(machine.status)
						? {
								retryable: false,
								terminal: `status=${machine.status}${
									machine.status_detail ? ` (${machine.status_detail})` : ""
								}`,
							}
						: "pending",
		},
		sandboxId: { fromRow: (row) => row.id, parse: TAMA_SANDBOX_ID },
		exec: (id, command) => ["exec", id, "--", "bash", "-lc", command],
		destroy: (id) => ["rm", "-y", id],
		notFound: TAMA_MACHINE_NOT_FOUND,
		// The pinned CLI exposes status and diagnostic text, but no typed capacity reason.
		// Terminal rows explicitly decline retry; status_detail is never parsed as a retry signal.
		// The kit preserves this verdict through reconciliation, so a future documented reason
		// can change provider policy without changing the shared error or readiness machinery.
	});
}

export default defineCliDriver("tama", {
	provenance: TAMA_PROVENANCE,
	execution: TAMA_EXECUTION,
	createAttemptCeilingMs: TAMA_CREATE_CEILING_MS,
	spec: tamaSpec,
});
