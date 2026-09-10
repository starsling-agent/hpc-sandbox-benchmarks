/**
 * Sandbox initialization for a suite run: clone the repo (which carries the in-sandbox producer under
 * /.mise/tasks + /lib/bench.sh), bring a stock image up to the toolchain (no-ops on the pre-baked
 * image), and probe the sandbox's observed specs (we pin a target spec, then always record the actuals).
 *
 * Env:
 *   BENCH_REPO_URL    Repo to clone (default: this repo, so the cloned producer matches the harness).
 *   BENCH_REPO_REF    Ref to check out (default: main; CI passes the commit SHA).
 *   BENCH_REPO_TOKEN  Token for cloning a private repo; stripped from the remote right after clone.
 */
import type { Suite } from "@sandbox-benchmarks/schema";
import { PTS_APT_DEPS } from "@sandbox-benchmarks/schema";
import { MIN } from "./execute.ts";

export const REPO_URL =
	process.env.BENCH_REPO_URL || "https://github.com/starslingdev/sandbox-benchmarks";
export const REPO_REF = process.env.BENCH_REPO_REF || "main";
const REPO_TOKEN = process.env.BENCH_REPO_TOKEN || "";

const CLONE_URL = REPO_TOKEN
	? REPO_URL.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(REPO_TOKEN)}@`)
	: REPO_URL;

// Resolved in-sandbox: images differ on user (root vs daytona), so the checkout lives under $HOME.
export const DIR = '"$HOME/sandbox-benchmarks"';

// Runtime versions for the stock-image fallback path (no-ops on the baked image, which already
// ships them). These MUST equal the pins the image was baked from (packages/templates/src/lib/pins.ts,
// rendered into the image's mise.toml); they stay local constants rather than a templates-package
// import so the harness remains decoupled from the bake, so the equality is held by the drift gate in
// tooling/repo-checks/src/toolchain-runtime-pins.test.ts rather than by the type system.
//
// It is load-bearing, not cosmetic: every version check below is EXACT, so one stale constant makes
// the baked toolchain miss and takes the install fallback on every provider and every sandbox — see
// that gate's header for what it costs. #243 drifted these and it went unnoticed for two weeks.
const MISE_VERSION = "v2026.7.11";
const MISE_SHA256_X64 = "d31578a16ae2708385249b439c95533068e04b9507a118e905aa6768905671fc";
const MISE_SHA256_ARM64 = "e3cb3bf4795f494a0e9be3f69ee1464de9d12a991589f126035eebd973c17796";
const NODE_VERSION = "22.23.1";
const PNPM_VERSION = "10.34.5";
const PTS_VERSION = "10.8.4";

export interface SetupStep {
	label: string;
	script: string;
	timeoutMs: number;
	/** Extra attempts for steps prone to transient network failures. */
	retries?: number;
}

export function setupSteps(suite: Suite, sourceRevision?: string): SetupStep[] {
	if (sourceRevision !== undefined && !/^[a-f0-9]{40}$/.test(sourceRevision))
		throw new Error("managed source revision must be a commit SHA");
	const ref = sourceRevision ?? REPO_REF;
	const steps: SetupStep[] = [
		{
			label: "install base packages",
			// No-op on pre-baked images; fall back gracefully on images that already ship git/curl.
			script:
				"(command -v git && command -v curl && command -v python3) >/dev/null 2>&1 " +
				"|| ($SUDO apt-get update -qq && $SUDO apt-get install -y -qq git curl ca-certificates tar gzip xz-utils unzip python3) " +
				"|| (command -v git >/dev/null && command -v curl >/dev/null)",
			timeoutMs: 10 * MIN,
		},
		{
			label: "clone repo",
			// Drop the token from the remote immediately so later steps can't leak it. Branch refs need
			// the origin/ fallback: bare `checkout --detach <branch>` DWIMs a remote branch into -b mode.
			script: `rm -rf ${DIR} && git clone "${CLONE_URL}" ${DIR} && cd ${DIR} && git remote set-url origin "${REPO_URL}" && (git checkout --detach "${ref}" 2>/dev/null || git checkout --detach "origin/${ref}") && git log -1 --oneline${sourceRevision ? ` && test "$(git rev-parse HEAD)" = "${sourceRevision}"` : ""}`,
			timeoutMs: 5 * MIN,
		},
		{
			label: "install mise",
			// No-op on pre-baked images. Install the same pinned, checksum-verified static binary as the
			// toolchain image; GitHub is already required for the repository clone immediately above.
			script: [
				"command -v mise >/dev/null 2>&1 || {",
				'mkdir -p "$HOME/.local/bin";',
				'arch=$(uname -m); case "$arch" in',
				`aarch64|arm64) a=arm64; sha=${MISE_SHA256_ARM64};;`,
				`x86_64|amd64) a=x64; sha=${MISE_SHA256_X64};;`,
				'*) echo "Unsupported architecture for mise: $arch" >&2; exit 1;; esac;',
				"tmp=$(mktemp); trap 'rm -f \"$tmp\"' EXIT;",
				`curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "$tmp" "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-$a"`,
				'&& printf "%s  %s\\n" "$sha" "$tmp" | sha256sum -c -',
				'&& chmod +x "$tmp" && mv "$tmp" "$HOME/.local/bin/mise"; };',
				"mise --version",
			].join(" "),
			timeoutMs: 5 * MIN,
			retries: 2,
		},
		{
			label: "trust mise config",
			// Trust the cloned task definitions without installing the repository's developer-only tools.
			script: `cd ${DIR} && mise trust --yes`,
			timeoutMs: MIN,
		},
	];

	if (suite.setupNode) {
		steps.push({
			label: "setup node 22 + pnpm 10",
			// Activate only the benchmark runtimes from outside the checkout. Exact Node avoids version
			// discovery, and pnpm comes from npm rather than mise's GitHub-API-backed aqua plugin. Blaxel
			// matrix cells share one unauthenticated egress IP, so even the one pnpm API lookup can hit an
			// exhausted 60-request quota. Later `mise run` commands inherit the global Node config while
			// task auto-install stays off. The pinned baked image takes the fast path for both checks.
			//
			// $SUDO on the mise fallback, because that branch writes to the BAKED image's paths, not the
			// user's: mise installs into MISE_DATA_DIR (/usr/local/share/mise) and `--global` resolves to
			// MISE_CONFIG_DIR (/etc/mise/config.toml), both root-owned 0755. Unprivileged and unelevated,
			// the step dies there. Redirecting both dirs under $HOME is NOT the alternative — measured on
			// a Runloop devbox, mise still reaches back to rebuild `latest` symlinks in the root-owned
			// tree and fails anyway. The pnpm branch stays unelevated: its --prefix is under $HOME by
			// design, and elevating it would plant root-owned files in the sandbox user's own home.
			script: [
				`cd "$HOME"`,
				`(node -e 'process.exit(process.versions.node === "${NODE_VERSION}" ? 0 : 1)' 2>/dev/null || $SUDO mise use --global --yes node@${NODE_VERSION})`,
				`if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm -v)" = "${PNPM_VERSION}" ]; then :; else npm install --global --prefix "$HOME/.local" pnpm@${PNPM_VERSION}; fi`,
				"node -v && pnpm -v",
			].join(" && "),
			timeoutMs: 10 * MIN,
			retries: 2,
		});
	}

	if (suite.setupPts) {
		// Refresh the apt index and ensure PTS's build/runtime deps at runtime unconditionally. A baked
		// image deliberately cleans /var/lib/apt/lists, while a stock-image provider must compile every
		// profile locally; in either case PTS's own dependency install needs a usable package index.
		// Best-effort lets a healthy baked image proceed when a provider cannot reach its distro mirror.
		// The package list is the canonical PTS_APT_DEPS from the schema toolchain contract — the shell
		// consumers (00-apt.sh, lib/bench.sh) are gated against the same constant by repo-checks.
		steps.push({
			label: "ensure PTS build deps + fresh apt index",
			script:
				"$SUDO apt-get -o Acquire::Retries=3 update -qq || true; " +
				`$SUDO apt-get install -y -qq ${PTS_APT_DEPS} || echo "WARNING: apt dep refresh failed (best-effort); relying on the baked image"`,
			timeoutMs: 15 * MIN,
		});
		steps.push({
			label: "setup phoronix-test-suite",
			// No-op on pre-baked images; on stock images the step above already populated apt's index and
			// installed the profile build dependencies.
			script:
				"command -v phoronix-test-suite >/dev/null 2>&1 || { " +
				[
					`curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "https://github.com/phoronix-test-suite/phoronix-test-suite/releases/download/v${PTS_VERSION}/phoronix-test-suite_${PTS_VERSION}_all.deb" -o /tmp/phoronix-test-suite.deb`,
					"($SUDO dpkg -i /tmp/phoronix-test-suite.deb || $SUDO apt-get install -y -qq -f)",
				].join(" && ") +
				"; }; phoronix-test-suite version",
			timeoutMs: 10 * MIN,
			retries: 2,
		});
	}

	return steps;
}

/**
 * Captures the sandbox's actual specs into benchmark-results/observed-specs.json before the suite
 * runs, so the normalizer reads it with the other results. nproc / /proc/meminfo see the HOST on
 * cgroup-limited containers (Daytona: a 4-vCPU quota on a 48-thread host), so prefer the cgroup quota
 * as the effective Sandbox size and keep the host reading as hostVcpus/hostMemoryGb disclosure.
 */
export const OBSERVED_SPECS_SCRIPT = [
	`cd ${DIR} && mkdir -p benchmark-results`,
	"host_vcpus=$(nproc)",
	`host_memory_gb=$(awk '/^MemTotal:/ { printf "%.2f", $2 / 1048576 }' /proc/meminfo)`,
	'vcpus=$host_vcpus; memory_gb=$host_memory_gb; limited=""',
	"if [ -f /sys/fs/cgroup/cpu.max ]; then",
	`  q=$(awk '$1 != "max" { printf "%.2f", $1 / $2 }' /sys/fs/cgroup/cpu.max)`,
	'  [ -n "$q" ] && vcpus=$q && limited=1',
	"fi",
	"if [ -f /sys/fs/cgroup/memory.max ] && grep -qv max /sys/fs/cgroup/memory.max; then",
	`  memory_gb=$(awk '{ printf "%.2f", $1 / 1073741824 }' /sys/fs/cgroup/memory.max) && limited=1`,
	"fi",
	// Report the disk the benchmark actually writes to, not the sandbox root: the PTS data dir when it
	// exists (on Blaxel that's the mounted 40 GiB volume; on baked-image providers it's on the root fs,
	// so identical to `/`), else `/` (a stock gVisor root pre-PTS — Modal). Keep this dir in sync with
	// the harness disk gate and the blaxel volume mount path.
	`disk_src=/var/lib/phoronix-test-suite; [ -d "$disk_src" ] || disk_src=/`,
	// gVisor (Modal) reports the root as 2^63 bytes — a "no limit" sentinel, not a size. Emit diskGb only
	// when df's answer is plausible for a sandbox (positive, < 100 TB); a sentinel, a failed df, or
	// a non-numeric column all leave it unset as unknown.
	`disk_gb=$(df -Pk "$disk_src" | awk 'NR==2 && $2 + 0 > 0 && $2 / 1048576 < 100000 { printf "%.1f", $2 / 1048576 }')`,
	`cpu_model=$(LC_ALL=C lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -1 || true)`,
	"kernel=$(uname -r)",
	`os=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' || true)`,
	"virt=$(systemd-detect-virt 2>/dev/null || echo unknown)",
	// Best-effort isolation classification — a cross-check on the declared per-provider isolation, never
	// authoritative (see run.ts observedSpecs.detectedIsolation: the probe cannot separate every type).
	// gVisor announces itself in /proc/version; a cgroup quota well below the disclosed host means we're
	// seeing THROUGH a container to a bigger host; `systemd-detect-virt --vm` confirms a real hypervisor.
	// (`--vm` restricts detection to VM technologies — bare `systemd-detect-virt` also reports container
	// types like docker/lxc/podman, which must NOT read as a VM here; `--quiet` gives just an exit status.)
	"detected=unknown",
	"if grep -qi gvisor /proc/version 2>/dev/null; then",
	"  detected=gvisor",
	// `vcpus` only drops below `host_vcpus` in the cpu.max branch, which is also the only place that
	// sets `limited` — so `host_vcpus > vcpus` already implies a limit; no separate `[ -n "$limited" ]`.
	`elif awk -v h="$host_vcpus" -v v="$vcpus" 'BEGIN { exit !(h > v + 0.5) }'; then`,
	"  detected=container",
	"elif systemd-detect-virt --vm --quiet 2>/dev/null; then",
	"  detected=vm",
	"fi",
	"user=$(id -un)",
	String.raw`esc() { printf '%s' "$1" | sed 's/["\\]/\\&/g'; }`,
	"{",
	`  printf '{"vcpus":%s,"memoryGb":%s' "$vcpus" "$memory_gb"`,
	`  if [ -n "$disk_gb" ]; then printf ',"diskGb":%s' "$disk_gb"; fi`,
	`  if [ -n "$limited" ]; then printf ',"hostVcpus":%s,"hostMemoryGb":%s' "$host_vcpus" "$host_memory_gb"; fi`,
	`  if [ -n "$cpu_model" ]; then printf ',"cpuModel":"%s"' "$(esc "$cpu_model")"; fi`,
	String.raw`  printf ',"kernel":"%s","os":"%s","virtualization":"%s","detectedIsolation":"%s","user":"%s"}\n' "$(esc "$kernel")" "$(esc "$os")" "$(esc "$virt")" "$(esc "$detected")" "$(esc "$user")"`,
	"} > benchmark-results/observed-specs.json",
	"cat benchmark-results/observed-specs.json",
].join("\n");
