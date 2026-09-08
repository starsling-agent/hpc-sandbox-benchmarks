# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **Bun workspace monorepo** (source-first, no build step) whose product is a
CLI (`@sandbox-benchmarks/cli`) that plans, runs, normalizes, and renders sandbox-provider
benchmarks. There is no server or web UI — everything is exercised through Bun and the CLI bins.

### Toolchain (provisioned by the startup update script)
- The startup update script is self-healing: it installs `mise` (2026.7.11) and `bun` (1.4.0) if
 they are missing, symlinks `mise`, `bun`, and **`bunx`** into `/usr/local/bin` (so they resolve on a
 bare `PATH`), then runs `mise install` (pinned non-Bun tools) + `bun install --ignore-scripts`. The
 `bunx` symlink is load-bearing: `bun run check:catalog-drift` spawns `bunx biome`, so a missing
 `bunx` on `PATH` fails that gate with `Executable not found in $PATH: "bunx"`.
- Non-Bun tools (`typos`, `shellcheck`, `hadolint`, `actionlint`, `zizmor`) are pinned in
 `mise.toml` and invoked via `mise exec` — never install them ad hoc.
- **Phoronix Test Suite (PTS) is NOT installed by the update script** (it is heavy and network-bound,
 and every benchmark leaf skips gracefully without it — see below). Install it on demand.

### Phoronix Test Suite (PTS)
The `.mise/tasks/benchmark/**` leaves call `phoronix-test-suite` (via `lib/bench.sh`). In provider
sandboxes PTS is baked into the toolchain image (`packages/templates/images/base/scripts/20-pts.sh`);
on this host VM install it on demand (the update script does not).

- Install + configure on the host (idempotent, needs sudo):
 `cd /workspace && SUDO=sudo bash -c 'source lib/bench.sh && ensure_pts'`. `ensure_pts` apt-installs
 PTS (pin 10.8.4, matching `packages/templates/src/lib/pins.ts`) plus its build deps and `stress-ng`,
 then puts PTS in batch mode. It returns 1 (never aborts) if PTS can't be made available — leaves
 then skip rather than fail.
- Verify: `phoronix-test-suite version` (expect `Phoronix Test Suite v10.8.4`).
- Cheap end-to-end mise leaf on the host (no provider keys):  
  `mise run benchmark:disk:pts:hardlink` — needs `stress-ng` (`apt-get install -y stress-ng`).
  Writes under `benchmark-results/` (local output; do not commit).
- Full OpenBenchmarking profiles (c-ray, fio, zstd, …) download/build on first use and are heavy;
  prefer the hardlink leaf or the Docker `benchmark:realworld:selftest` when validating PTS wiring.
- `benchmark:realworld:selftest` requires Docker (not installed in this Cloud VM by default).

### Running checks / the app
The command contract lives in the root `package.json` and `docs/architecture.md`; run those scripts
directly:
- `bun run lint`, `bun run typecheck`, `bun run test`, `bun run spell`, `bun run check:catalog-drift`,
  `bun run lint:shell`, `bun run lint:docker`.
- Run a CLI bin directly, e.g. `bun apps/cli/src/bin/plan-matrix.ts --list-providers` or
  `bun apps/cli/src/bin/leaderboard.ts data/dataset/runs/<id>.json`. Bins are listed under
  `apps/cli/package.json` `bin`.

### Non-obvious gotchas
- Use `bun install --ignore-scripts`. The `prepare` script runs `lefthook install`, which **fails**
  in Cursor because `core.hooksPath` is set to a custom agent-hooks directory. `--ignore-scripts`
  skips it (this is exactly what CI does) and dependencies still resolve fully. Git pre-commit hooks
  are therefore not wired here — run the gate scripts manually before committing.
- Live provider benches (E2B/Daytona/Modal/Blaxel/Novita) need per-provider API keys from `.env`
  (see `.env.example`). Without keys a provider is recorded as a **skip, not a failure**, so lint /
  typecheck / test / spell and the offline CLI bins (`plan-matrix`, `leaderboard` over the committed
  `data/dataset` runs) all work with no credentials.
- Mise PTS leaves that lack `phoronix-test-suite` (or a leaf-specific tool like `stress-ng` /
  `nc`) call `skip_result` and exit 0 — a green task exit does **not** prove the benchmark ran.
  Check for `benchmark-results/<prefix>.xml` (success) vs `benchmark-results/<prefix>--skipped.json`.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues. Read
`docs/agents/issue-tracker.md` before tracker operations.

### Triage labels

Use the five canonical triage labels. Read
`docs/agents/triage-labels.md` before applying triage labels.

### Domain docs

Use a multi-context layout with a root `CONTEXT-MAP.md` linking
to package contexts. Read `docs/agents/domain.md` before exploring.
