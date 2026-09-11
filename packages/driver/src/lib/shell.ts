// Harness-owned shell mechanics (ADR-0007 §2), written once. These express optional session
// capabilities over the one required primitive (`exec`), so consumers never ask capability
// questions: a session with a native fast path uses it, and one without gets the same behavior
// through the shell. Three byte-identical shellQuote copies and four hand-rolled nohup lines
// across the old adapters collapse into this module.

import { DriverError } from "./errors.ts";
import type { ExecOptions, ExecResult, SandboxSession } from "./port.ts";
import { succeeded } from "./port.ts";

// 64 KiB of base64 is comfortably below ordinary argv limits and is divisible by four, so every
// non-final chunk is independently decodable. The corresponding raw chunk is 48 KiB.
const BASE64_CHUNK_CHARS = 64 * 1024;

/** POSIX single-quote escaping: the only quoting rule any of this module ever uses. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Fire-and-forget a command. Uses the session's native `launch` when the vendor has one;
 * otherwise nohup under `sh -lc`, all stdio detached. The outer shell keeps the child for a
 * short acceptance window: an immediate missing-shell, syntax, or command failure is returned
 * instead of becoming a later readiness timeout. Once the process survives that window,
 * completion is observed by the caller (done-file poll), not by this call.
 */
export async function launchDetached(
	session: SandboxSession,
	command: string,
	options?: ExecOptions,
): Promise<void> {
	if (session.launch) {
		await session.launch(command, options);
		return;
	}
	await execOrThrow(session, "launchDetached", detachedShellCommand(command), options);
}

/**
 * The one shell launcher behind {@link launchDetached}'s fallback, exported so a driver whose
 * vendor exec is synchronous-only can offer the same acceptance contract as its native `launch`
 * instead of hand-rolling a fourth nohup line: the outer shell exits 0 once the child has survived
 * the acceptance window, and non-zero (with the child's status) if it died inside it.
 */
export function detachedShellCommand(command: string): string {
	return `nohup /bin/sh -lc ${shellQuote(command)} </dev/null >/dev/null 2>&1 & child=$!; finish() { wait "$child"; exit $?; }; sleep 0.05; if ! kill -0 "$child" 2>/dev/null; then finish; fi; if command -v ps >/dev/null 2>&1; then state=$(ps -o state= -p "$child" 2>/dev/null || :); case "$state" in *Z*) finish ;; "") if ! kill -0 "$child" 2>/dev/null; then finish; fi ;; esac; fi; exit 0`;
}

/**
 * Read a text file, via the native filesystem capability when present, `cat` otherwise.
 * Returns null when the file is unreadable — a recorded gap, not an exception to catch.
 */
export async function readTextFile(session: SandboxSession, path: string): Promise<string | null> {
	if (session.files) {
		try {
			return await session.files.readFile(path);
		} catch {
			return null;
		}
	}
	const result = await session.exec(`cat ${shellQuote(path)}`);
	return succeeded(result.exit) ? result.stdout : null;
}

/**
 * Write a text file, via the native filesystem capability when present, base64-over-exec
 * otherwise. Base64 (not a heredoc) so arbitrary content — quotes, dollar signs, newlines,
 * even NUL-free binary-ish text — survives the shell without any quoting subtleties.
 */
export async function writeTextFile(
	session: SandboxSession,
	path: string,
	text: string,
): Promise<void> {
	if (session.files) {
		await session.files.writeText(path, text);
		return;
	}
	// Base64 (not a heredoc) preserves arbitrary NUL-free text. Send it in bounded pieces: placing a
	// multi-MB payload in one shell command crosses ARG_MAX before the remote base64 process starts.
	// A sibling temporary keeps a failed write from replacing a previously valid destination.
	const encoded = new TextEncoder().encode(text).toBase64();
	const temporary = `${path}.sandbox-benchmarks-${crypto.randomUUID()}.tmp`;
	try {
		await execOrThrow(session, `writeTextFile(${path})`, `: > ${shellQuote(temporary)}`);
		for (let offset = 0; offset < encoded.length; offset += BASE64_CHUNK_CHARS) {
			const chunk = encoded.slice(offset, offset + BASE64_CHUNK_CHARS);
			await execOrThrow(
				session,
				`writeTextFile(${path})`,
				`printf '%s' '${chunk}' | base64 -d >> ${shellQuote(temporary)}`,
			);
		}
		await execOrThrow(
			session,
			`writeTextFile(${path})`,
			`mv ${shellQuote(temporary)} ${shellQuote(path)}`,
		);
	} catch (error) {
		// Best effort only: preserve the primary typed failure if cleanup also fails.
		await session.exec(`rm -f ${shellQuote(temporary)}`).catch(() => undefined);
		throw error;
	}
}

async function execOrThrow(
	session: SandboxSession,
	operation: string,
	command: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const result = await session.exec(command, options);
	if (!succeeded(result.exit)) {
		throw new DriverError("exec-failed", `${operation} failed: ${describeFailure(result)}`, {
			provider: session.sandboxRef.provider,
			ref: session.sandboxRef,
			vendorMessage: result.stderr,
			vendorExitCode: result.exit.kind === "exited" ? result.exit.code : undefined,
		});
	}
	return result;
}

function describeFailure(result: ExecResult): string {
	const exit = result.exit;
	switch (exit.kind) {
		case "exited":
			return `exit ${exit.code}: ${result.stderr.trim()}`;
		case "signalled":
			return `signal ${exit.signal}`;
		case "unknown":
			return `unknown exit (${exit.detail})`;
	}
}
