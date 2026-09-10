/**
 * Thin Bun wrappers around the `lib/bench.sh` PTS helpers, so warm staging has one implementation
 * (the bash the benchmark leaves already run) instead of a TypeScript re-code of `pts_user_dir`,
 * the install roots, and the download-cache layout — the exact paths whose per-identity differences
 * `lib/bench.sh` exists to absorb.
 *
 * Every helper is invoked the way a leaf invokes it: export `REPO_ROOT`, source `lib/bench.sh`, call
 * the function. Callers of `lib/bench.sh` must set `REPO_ROOT` before sourcing (see its header).
 */
import { readFileSync } from "node:fs";
import { logInfo, logWarning } from "./actions-log.ts";

export interface SpawnResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function spawnCmd(
	cmd: string[],
	opts: { cwd: string; env?: Record<string, string>; inherit?: boolean },
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
		stdout: opts.inherit ? "inherit" : "pipe",
		stderr: opts.inherit ? "inherit" : "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		opts.inherit ? Promise.resolve("") : new Response(proc.stdout).text(),
		opts.inherit ? Promise.resolve("") : new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

/** Bash-safe rendering of one argument. Single quotes prevent command, variable, and glob expansion. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** `source lib/bench.sh`, then run one helper with string args (SUDO honored for `ensure_pts`). */
async function runBenchHelper(
	root: string,
	helper: string,
	args: readonly string[],
): Promise<SpawnResult> {
	const sudo = process.env.SUDO ?? "";
	const assigns = helper === "ensure_pts" && sudo ? `SUDO=${shellQuote(sudo)} ` : "";
	const argv = args.map(shellQuote).join(" ");
	return runBenchScript(root, `${assigns}${helper}${argv ? ` ${argv}` : ""}`);
}

/** `source lib/bench.sh`, then run one line of bash against its helpers. */
async function runBenchScript(
	root: string,
	line: string,
	opts: { capture?: boolean } = {},
): Promise<SpawnResult> {
	const script = [
		`cd ${shellQuote(root)}`,
		`export REPO_ROOT=${shellQuote(root)}`,
		"source lib/bench.sh",
		line,
	].join(" && ");
	return spawnCmd(["bash", "-c", script], { cwd: root, inherit: !opts.capture });
}

export async function ensurePts(root: string): Promise<void> {
	const { code } = await runBenchHelper(root, "ensure_pts", []);
	if (code !== 0) {
		throw new Error(
			"ensure_pts could not make phoronix-test-suite available (re-run with SUDO=sudo)",
		);
	}
}

export async function seedPtsDownloadCache(
	root: string,
	filename: string,
	sha256: string,
	urls: readonly string[],
): Promise<void> {
	const { code } = await runBenchHelper(root, "seed_pts_download_cache", [
		filename,
		sha256,
		...urls,
	]);
	// bench.sh never fatals on a seed miss — PTS's own downloader is the fallback — so neither do we.
	if (code !== 0) logWarning(`seed_pts_download_cache ${filename} exited ${code}`);
}

export async function installLocalPtsProfile(
	root: string,
	name: string,
	overlays: readonly string[] = [],
): Promise<void> {
	const { code } = await runBenchHelper(root, "install_local_pts_profile", [name, ...overlays]);
	if (code !== 0) throw new Error(`install_local_pts_profile ${name} failed (exit ${code})`);
}

/** Profile ids PTS reports as installed (`pts/fio-2.1.0`, `local/hardlink-1.0.0`, …). */
export async function listInstalledTests(root: string): Promise<Set<string>> {
	const { code, stdout } = await spawnCmd(["phoronix-test-suite", "list-installed-tests"], {
		cwd: root,
	});
	if (code !== 0) return new Set();
	const ids = new Set<string>();
	for (const line of stdout.split("\n")) {
		const id = line.trim().split(/\s+/)[0];
		if (id?.includes("/")) ids.add(id);
	}
	return ids;
}

export async function batchInstall(
	root: string,
	targets: readonly string[],
	env: Record<string, string>,
): Promise<void> {
	if (targets.length === 0) return;
	logInfo(`batch-install: ${targets.join(" ")}`);
	const { code } = await spawnCmd(["phoronix-test-suite", "batch-install", ...targets], {
		cwd: root,
		inherit: true,
		env,
	});
	if (code !== 0) throw new Error(`phoronix-test-suite batch-install failed (exit ${code})`);
}

const SAFE_PATH_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Discard an incomplete install tree before retrying batch-install.
 *
 * A failed install leaves an `INSTALL_FAILED` tombstone that PTS honors on the retry, so a warm that
 * hit a flaky mirror once would report the same profile missing forever. Removing the tree is what
 * the leaves do for the same reason (see the stream leaf's discard branch); `pts_install_root` is
 * read from bench.sh because it differs per identity.
 */
export async function discardInstallTree(root: string, target: string): Promise<void> {
	const slash = target.indexOf("/");
	if (slash <= 0) return;
	const ns = target.slice(0, slash);
	const name = target.slice(slash + 1);
	if (!SAFE_PATH_SEGMENT.test(ns) || !SAFE_PATH_SEGMENT.test(name)) {
		throw new Error(`refusing to discard unsafe install target: ${target}`);
	}
	const { code } = await runBenchScript(
		root,
		`pts_init && rm -rf "$(pts_install_root)/${ns}/${name}"`,
	);
	if (code !== 0) throw new Error(`failed to discard install target ${target} (exit ${code})`);
}

/**
 * Extra payload probes for profiles whose `install.sh` can report success without producing one.
 *
 * PTS marks a profile installed by the launcher its `install.sh` writes, so `list-installed-tests`
 * is install BOOKKEEPING, not evidence of a build. pgbench's upstream `install.sh` is plain `sh`
 * with no `set -e`, and writes that launcher even when configure/make failed — the shape of the
 * 2026-07 ICU/pkg-config half-install, where the count probe passed and the benchmark then had no
 * `pg_/` payload to run. `pgbenchPayloadSmokeCheck` in packages/templates/src/smoke.ts is the bake's
 * probe for the same profile; this is the host-side one, against the install root bench.sh reports.
 *
 * Keyed by profile-name prefix so a version bump keeps the probe. Deliberately a short list of known
 * lying installers rather than a heuristic: a profile whose launcher legitimately drives a system
 * binary (hardlink → stress-ng) has no payload of its own to find.
 */
const PAYLOAD_PROBES: ReadonlyArray<{ prefix: string; relativePath: string }> = [
	{ prefix: "pgbench-", relativePath: "pg_/bin/pgbench" },
];

/**
 * Why `target` is not usably installed, or undefined when it is.
 *
 * Checks what PTS's own bookkeeping cannot: an `install-failed.log` beside the tree (written when
 * an installer exits non-zero, which PTS itself survives), and the built payload for the profiles
 * above.
 */
export async function installPayloadProblem(
	root: string,
	target: string,
): Promise<string | undefined> {
	const slash = target.indexOf("/");
	if (slash <= 0) return undefined;
	const ns = target.slice(0, slash);
	const name = target.slice(slash + 1);
	if (!SAFE_PATH_SEGMENT.test(ns) || !SAFE_PATH_SEGMENT.test(name)) {
		throw new Error(`refusing to probe unsafe install target: ${target}`);
	}
	const dir = `"$(pts_install_root)/${ns}/${name}"`;
	const checks = [
		// pts_init writes core.pt2so, which is how pts_user_dir picks the data dir PTS itself uses.
		"pts_init",
		`if [ -e ${dir}/install-failed.log ]; then echo "PROBLEM:PTS recorded install-failed.log"; fi`,
	];
	const probe = PAYLOAD_PROBES.find((entry) => name.startsWith(entry.prefix));
	if (probe) {
		checks.push(
			`if [ ! -x ${dir}/${probe.relativePath} ]; then echo "PROBLEM:no built payload at ${probe.relativePath}"; fi`,
		);
	}
	// One brace group so the whole probe is a single command in runBenchScript's `&&` chain. Each
	// diagnostic is an `if`, so a healthy tree returns zero without masking setup/probe failures.
	const { code, stdout, stderr } = await runBenchScript(root, `{ ${checks.join("; ")}; }`, {
		capture: true,
	});
	if (code !== 0) {
		throw new Error(
			`failed to probe install target ${target} (exit ${code})${stderr ? `: ${stderr.trim()}` : ""}`,
		);
	}
	// Prefixed lines only: pts_init and friends write to the same stdout.
	const problems = stdout
		.split("\n")
		.filter((line) => line.startsWith("PROBLEM:"))
		.map((line) => line.slice("PROBLEM:".length));
	return problems.length > 0 ? problems.join("; ") : undefined;
}

/**
 * Whether this host runs under gVisor, by the same `/proc/version` probe the STREAM leaf uses to
 * pick its ISA. Getting it wrong compiles a binary the sandbox cannot execute (SIGILL on the first
 * AVX-512 instruction), so the probe is shared rather than approximated.
 */
export function hostIsGvisor(): boolean {
	try {
		return /gvisor/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}
