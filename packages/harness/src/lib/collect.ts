/**
 * Results collection for a suite run: pulls benchmark-results/ back to the host via a base64 tar
 * stream over stdout (no temp file in the sandbox, so it works even when the sandbox disk is full —
 * exactly when partial results matter), and writes harness skip markers. The pulled files are the
 * raw inputs the normalizer consumes — the committed raw tool output is the dataset's source of truth.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	GapCause,
	GapOutcome,
	ProviderArtifactEvidence,
	ProviderCostEvidence,
} from "@sandbox-benchmarks/schema";
import {
	harnessGapMarkerJson,
	isGapMarkerFile,
	isPtsResultFile,
	providerArtifactEvidenceFile,
	providerArtifactEvidenceJson,
	providerCostEvidenceFile,
	providerCostEvidenceJson,
	sandboxGapMarkerFile,
} from "@sandbox-benchmarks/schema";
import type { StepRunner } from "./execute.ts";
import { LogReadbackError, MIN } from "./execute.ts";
import { DIR } from "./setup.ts";

const RESULTS_BEGIN = "__BENCH_RESULTS_TGZ_BEGIN__";
const RESULTS_END = "__BENCH_RESULTS_TGZ_END__";
/** Attempts for the in-sandbox collect step. A marker miss can be a transient read-back hiccup, not
 *  a dead sandbox (Blaxel, 2026-07-19: a completed suite's 4 valid samples were discarded over one),
 *  and the tar|base64 emit is idempotent while the sandbox is destroyed only after collection — so
 *  re-running the whole step is safe and beats throwing finished results away. */
const COLLECT_MAX_ATTEMPTS = 3;

function writeHostEvidence(resultsDir: string, filename: string, contents: string): void {
	mkdirSync(resultsDir, { recursive: true });
	const target = join(resultsDir, filename);
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, contents);
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Validate and atomically persist the artifact attribution owned by this suite sandbox. */
export function writeProviderArtifactEvidence(
	resultsDir: string,
	record: ProviderArtifactEvidence,
): void {
	writeHostEvidence(
		resultsDir,
		providerArtifactEvidenceFile(),
		providerArtifactEvidenceJson(record),
	);
}

/** Validate and atomically persist the one provider cost record owned by this suite sandbox. */
export function writeProviderCostEvidence(resultsDir: string, record: ProviderCostEvidence): void {
	writeHostEvidence(resultsDir, providerCostEvidenceFile(), providerCostEvidenceJson(record));
}

/** The in-sandbox collect command: emit a marker-bounded, newline-stripped base64 tar of
 *  benchmark-results/ on stdout. No temp file in the sandbox, so it works even when the sandbox disk
 *  is full; the tar|base64 emit is idempotent, so re-running it on a transient failure is safe. */
const COLLECT_SCRIPT =
	`cd ${DIR} && mkdir -p benchmark-results && ` +
	`echo ${RESULTS_BEGIN} && tar -czf - benchmark-results | base64 | tr -d '\\n' && echo && echo ${RESULTS_END}`;

/**
 * A collected results tree that carries no PTS result or gap marker — the suite produced nothing
 * usable. Deterministic across re-collects (the in-sandbox tree does not change between collect
 * steps), so {@link collectResults} fails on it immediately instead of burning retries on a re-run
 * that cannot change the outcome. Distinguished from the RETRYABLE decode/extract failures.
 */
class CollectedResultsEmptyError extends Error {}
class ReservedCollectedFileError extends Error {}

/** Pull the sandbox's benchmark-results/ into `resultsDir` on the host. */
export async function collectResults(
	runner: Pick<StepRunner, "phase"> & {
		step: (...args: Parameters<StepRunner["step"]>) => Promise<{ stdout?: string }>;
	},
	resultsDir: string,
): Promise<void> {
	runner.phase = "collect";
	// One retry boundary wraps the ENTIRE idempotent collect — the in-sandbox tar|base64 step, the
	// marker scan, AND the host-side decode + tar extract. A read-back transport failure, a marker
	// miss, or a marker-bounded-but-corrupt payload are all transient conditions a re-run can fix
	// while the sandbox is still alive (it is destroyed only after collection), so each retries here
	// rather than discarding a finished suite's results. Command failures and timeouts are real and
	// propagate unchanged; the content gate (no PTS result / marker) is deterministic and does not retry.
	for (let attempt = 1; ; attempt++) {
		// Capability-driven transport: on a capped provider the tar|base64 payload lands in the step's log
		// file and is read back, so a large or slow collect can't 408 the synchronous exec mid-stream; on an
		// uncapped provider it streams straight back over a direct exec. Both populate `result.stdout`, and
		// the BEGIN/END markers bound the base64 within that captured output either way.
		let stdout: string;
		try {
			const result = await runner.step("collect benchmark-results", COLLECT_SCRIPT, 5 * MIN, {
				// Silent: the step's stdout IS the base64 tarball — echoing it would flood the CI log.
				silent: true,
			});
			stdout = result.stdout || "";
		} catch (err) {
			// A completed step whose log no transport could read is RETRYABLE here — the transport can
			// recover between attempts and tar|base64 is idempotent. Command failures and timeouts are
			// not: they propagate unchanged.
			if (!(err instanceof LogReadbackError) || attempt >= COLLECT_MAX_ATTEMPTS) throw err;
			console.log(
				`[collect benchmark-results] attempt ${attempt}/${COLLECT_MAX_ATTEMPTS} lost the step log ` +
					`to a read-back transport failure; re-running the collect step`,
			);
			continue;
		}

		const begin = stdout.indexOf(RESULTS_BEGIN);
		const end = stdout.indexOf(RESULTS_END);
		if (begin !== -1 && end !== -1 && end > begin) {
			const base64 = stdout.slice(begin + RESULTS_BEGIN.length, end).trim();
			// Decode + tar extract live INSIDE the retry boundary: a marker-bounded payload that won't
			// base64-decode or untar is transient stream corruption (a cut mid-stream can still land END)
			// the idempotent re-collect can fix, so treat it like a marker miss one stage later and retry
			// rather than discard the suite. The content gate is the one thing that does NOT retry.
			try {
				const archiveKiB = await decodeAndExtract(base64, resultsDir);
				validateCollected(resultsDir);
				console.log(`Results extracted to ${resultsDir} (${archiveKiB.toFixed(1)} KiB archive)`);
				return;
			} catch (err) {
				if (
					err instanceof CollectedResultsEmptyError ||
					err instanceof ReservedCollectedFileError ||
					attempt >= COLLECT_MAX_ATTEMPTS
				) {
					throw err;
				}
				const reason = err instanceof Error ? err.message : String(err);
				console.log(
					`[collect benchmark-results] attempt ${attempt}/${COLLECT_MAX_ATTEMPTS} decoded a payload ` +
						`that failed to extract (${reason}); re-running the collect step`,
				);
				continue;
			}
		}

		// Empty stdout means the step's output never came back at all (a read-back transport failure);
		// non-empty-but-markerless means a truncated or malformed payload — different failures, so name
		// the right one, both here and in the final throw.
		const diagnosis =
			stdout.length === 0
				? "stdout was empty — the step's output never came back (transport failure)"
				: `stdout had ${stdout.length} chars but no usable markers (truncated or malformed payload)`;
		// Diagnostics stay CONTENT-FREE: the stdout is (possibly a complete) base64 archive of the
		// suite's results, and an excerpt of a short payload would publish the whole thing into the CI
		// log. Marker presence + lengths pin down the failure shape (e.g. BEGIN-without-END is a
		// truncated stream) without disclosing a byte of payload.
		console.log(
			`[collect benchmark-results] attempt ${attempt}/${COLLECT_MAX_ATTEMPTS} found no payload: ${diagnosis}` +
				(stdout.length === 0
					? ""
					: ` [markers: BEGIN=${begin !== -1} END=${end !== -1}${
							begin !== -1 && end !== -1 ? ` order-inverted=${end <= begin}` : ""
						}]`),
		);
		if (attempt >= COLLECT_MAX_ATTEMPTS) {
			throw new Error(
				`Could not locate results payload markers in sandbox output after ` +
					`${COLLECT_MAX_ATTEMPTS} attempts: ${diagnosis}`,
			);
		}
	}
}

/**
 * Untar `archive` into `stage` with `Bun.spawn`, throwing tar's own diagnostics on a non-zero exit.
 *
 * Async, not `Bun.spawnSync`/`execFileSync`: one process now drives R replicate sandboxes at once
 * (apps/cli/src/lib/replicates.ts), and each one's detached step is kept alive by a poll loop on this
 * same event loop. A synchronous extract stalls every PEER's polling for its whole duration — and a
 * poll that cannot run is indistinguishable, to the loop's consecutive-failure guard, from a sandbox
 * that stopped answering. Awaiting the child yields instead.
 *
 * tar's stderr is included in the error because it names the actual corruption ("unexpected EOF"),
 * and unlike the collect stdout it carries none of the payload — the content-free diagnostics rule in
 * {@link collectResults} is about the base64 archive, not about tar's complaints regarding it.
 */
async function extractArchive(archive: string, stage: string): Promise<void> {
	const proc = Bun.spawn(["tar", "-xzf", archive, "-C", stage], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		throw new Error(
			`tar exited ${exitCode} extracting the results archive: ${stderr.trim() || "(no stderr)"}`,
		);
	}
}

/**
 * Decode the marker-bounded base64 tar to disk and extract benchmark-results/ into `resultsDir`,
 * returning the archive size in KiB (for the success log). Throws on any decode/extract failure —
 * {@link collectResults} treats that as retryable stream corruption.
 */
async function decodeAndExtract(base64: string, resultsDir: string): Promise<number> {
	const archive = join(tmpdir(), `bench-results-${process.pid}-${randomUUID()}.tgz`);
	try {
		// The archive write and the tree copy yield, for the reason {@link extractArchive} documents:
		// R replicates enter collect at roughly the same time, so whatever blocks here blocks R-1 peers'
		// poll loops. Converting only the `tar` child would have left the multi-MB write and the
		// recursive copy stalling them. `Uint8Array.fromBase64` itself is a synchronous decode with no
		// async alternative, but it is ~0.2 ms/MB — three orders under the poll interval — so it stays.
		// It is also the Bun-native spelling of the old `writeFileSync(…, "base64")`: no Node Buffer in
		// package code, and it throws on a corrupt payload the old encoding would have silently dropped.
		const bytes = Uint8Array.fromBase64(base64);
		await Bun.write(archive, bytes);
		const target = resolve(resultsDir);
		// The tarball holds a top-level benchmark-results/ directory. Extract into a unique staging
		// dir (not `parent`, which is shared across providers) so concurrent collects can't clobber
		// each other, then copy its contents into the target (`<provider>`, not `benchmark-results`).
		const stage = join(tmpdir(), `bench-extract-${process.pid}-${randomUUID()}`);
		await mkdir(stage, { recursive: true });
		try {
			await extractArchive(archive, stage);
			const collectedRoot = join(stage, "benchmark-results");
			assertNoReservedEvidenceFile(collectedRoot);
			await cp(collectedRoot, target, { recursive: true });
		} finally {
			await rm(stage, { recursive: true, force: true });
		}
		return Bun.file(archive).size / 1024;
	} finally {
		await rm(archive, { force: true });
	}
}

/** Evidence is host-owned provenance. A sandbox may not forge it into its collected archive. */
function assertNoReservedEvidenceFile(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (
			entry.name === providerCostEvidenceFile() ||
			entry.name === providerArtifactEvidenceFile()
		) {
			throw new ReservedCollectedFileError(
				`Collected sandbox results contain reserved host-owned file ${entry.name}`,
			);
		}
		if (entry.isSymbolicLink()) {
			throw new ReservedCollectedFileError(
				`Collected sandbox results contain forbidden symbolic link ${entry.name}`,
			);
		}
		if (entry.isDirectory()) {
			assertNoReservedEvidenceFile(join(directory, entry.name));
		} else if (!entry.isFile()) {
			throw new ReservedCollectedFileError(
				`Collected sandbox results contain forbidden non-regular entry ${entry.name}`,
			);
		}
	}
}

/**
 * Validate the collected tree carries real signal: at least one PTS result or skip marker (the #39
 * naming contract). A suite that produced neither — the benchmark crashed before writing anything
 * AND no marker was recorded — is silent data loss; fail loudly rather than let an empty results
 * directory upload and report as a green run. Throws {@link CollectedResultsEmptyError} so the caller
 * knows this is deterministic (a re-collect of the same tree can't help) and must NOT retry.
 */
function validateCollected(resultsDir: string): void {
	const collected = readdirSync(resolve(resultsDir));
	if (!collected.some((name) => isPtsResultFile(name) || isGapMarkerFile(name))) {
		throw new CollectedResultsEmptyError(
			`Collected results for ${resultsDir} contain no PTS result or gap marker ` +
				`(found: ${collected.join(", ") || "nothing"}); the suite produced no usable output`,
		);
	}
}

/**
 * Record that a whole suite × provider produced no result, and WHY — `skipped` when a precondition
 * refused it before anything ran, `failed` when it ran and broke.
 *
 * A failure that leaves no marker does not become a non-event: the suite is simply absent from the
 * provider's slice of the Run, and the leaderboard reports it as a `missing` gap it can say nothing
 * about. Writing the marker is what turns "we have no idea" into "it crashed, here is the error".
 */
export function writeGapMarker(
	resultsDir: string,
	provider: string,
	suite: string,
	outcome: GapOutcome,
	reason: string,
	// The structured classification, when the caller has one. A marker written without it is not
	// downgraded — `reason` still says what happened — but nothing downstream will guess a kind for it.
	cause?: GapCause,
): void {
	mkdirSync(resultsDir, { recursive: true });
	writeFileSync(
		join(resultsDir, sandboxGapMarkerFile(provider, suite, outcome)),
		harnessGapMarkerJson(provider, suite, outcome, reason, cause),
	);
}
