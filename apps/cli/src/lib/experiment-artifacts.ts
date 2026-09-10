import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AttemptWithRun } from "@sandbox-benchmarks/results";
import { evidenceDigest, verifyExperimentPlan } from "@sandbox-benchmarks/results";
import {
	cleanupReceiptSchema,
	executionReceiptSchema,
	experimentAttemptSchema,
	parseRun,
} from "@sandbox-benchmarks/schema";

/** Stable path-and-content binding; links cannot smuggle evidence from outside the raw tree. */
export function rawTreeDigest(directory: string): string {
	const files: Array<{ path: string; digest: string }> = [];
	const visit = (relative: string): void => {
		const path = join(directory, relative);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("raw evidence must not contain symbolic links");
		if (stat.isDirectory()) {
			for (const entry of readdirSync(path).sort())
				visit(relative ? `${relative}/${entry}` : entry);
		} else if (stat.isFile()) {
			files.push({
				path: relative,
				digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
			});
		} else throw new Error("raw evidence must contain only regular files and directories");
	};
	visit("");
	if (files.length === 0) throw new Error("raw evidence is empty");
	return evidenceDigest(files);
}

export function readExperimentPlan(path: string) {
	if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
		throw new Error("plan must be a regular file");
	return verifyExperimentPlan(JSON.parse(readFileSync(path, "utf8")));
}

export function readExperimentAttempt(directory: string): AttemptWithRun {
	if (lstatSync(directory).isSymbolicLink())
		throw new Error("attempt directory must not be a symbolic link");
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink())
			throw new Error("attempt artifacts must not contain symbolic links");
	}
	const evidence = experimentAttemptSchema.assert(
		JSON.parse(readFileSync(join(directory, "attempt.json"), "utf8")),
	);
	const run =
		evidence.runDigest === undefined
			? undefined
			: parseRun(JSON.parse(readFileSync(join(directory, "run.json"), "utf8")));
	if (run && evidenceDigest(run) !== evidence.runDigest)
		throw new Error(`shard digest mismatch: ${evidence.id}`);
	if (
		evidence.rawDigest !== undefined &&
		rawTreeDigest(join(directory, "raw")) !== evidence.rawDigest
	) {
		throw new Error(`raw digest mismatch: ${evidence.id}`);
	}
	return {
		evidence,
		...(run ? { run } : {}),
		...(evidence.rawDigest ? readAttemptReceipts(join(directory, "raw")) : {}),
	};
}

export function readAttemptReceipts(
	directory: string,
): Pick<AttemptWithRun, "execution" | "cleanup"> {
	const executionFiles: string[] = [];
	const cleanupFiles: string[] = [];
	const scan = (path: string): void => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isSymbolicLink()) throw new Error("receipt must not be a symbolic link");
			if (entry.isDirectory()) scan(child);
			else if (/^execution-.*\.json$/.test(entry.name)) executionFiles.push(child);
			else if (/^cleanup-.*\.json$/.test(entry.name)) cleanupFiles.push(child);
		}
	};
	scan(directory);
	if (executionFiles.length > 1 || cleanupFiles.length > 1)
		throw new Error("conflicting attempt receipts");
	const execution = executionFiles[0]
		? executionReceiptSchema.assert(JSON.parse(readFileSync(executionFiles[0], "utf8")))
		: undefined;
	const cleanup = cleanupFiles[0]
		? cleanupReceiptSchema.assert(JSON.parse(readFileSync(cleanupFiles[0], "utf8")))
		: undefined;
	return { ...(execution ? { execution } : {}), ...(cleanup ? { cleanup } : {}) };
}

/** Refuse overwrites even if a caller accidentally reuses an attempt identity. */
export function writeImmutableJson(path: string, value: unknown): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(descriptor);
		// link is atomic and refuses an existing destination; rename would overwrite it.
		linkSync(temporary, path);
	} finally {
		closeSync(descriptor);
		unlinkSync(temporary);
	}
}

/** Discover only terminal attempt directories; launch intents cannot masquerade as receipts. */
export function readExperimentAttempts(root: string): AttemptWithRun[] {
	const attempts: AttemptWithRun[] = [];
	const visit = (directory: string): void => {
		if (lstatSync(directory).isSymbolicLink())
			throw new Error("attempt directory must not be a symbolic link");
		const entries = readdirSync(directory, { withFileTypes: true });
		if (entries.some((entry) => entry.name === "attempt.json" && entry.isFile())) {
			attempts.push(readExperimentAttempt(directory));
			return;
		}
		if (entries.some((entry) => entry.name === "intent.json")) {
			throw new Error(
				"unterminated allocation intent; experiment completeness and cleanup remain unresolved",
			);
		}
		for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isSymbolicLink())
				throw new Error("attempt artifacts must not contain symbolic links");
			if (entry.isDirectory()) visit(join(directory, entry.name));
		}
	};
	visit(root);
	return attempts;
}
