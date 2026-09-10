# Architecture

How the repository itself is put together: the workspace, its enforced boundaries, the command
contract, and the gates that hold them. For how a *measurement* is produced, see
[methodology](./methodology.md).

## Provider sandbox evidence (Run v5 and v6)

The provider adapter owns billing API interaction. After the harness attempts and awaits sandbox
teardown, its optional hook returns one validated sandbox-scoped observed/missing record. The harness
persists it under the existing raw `data/` tree as `provider-cost-evidence.json`; normalization and
aggregation carry it through using only `@sandbox-benchmarks/schema`, with no provider SDK dependency.
Historical v2-v4 documents remain unchanged and cannot carry evidence.
The sandbox collection archive cannot supply that reserved filename: collection rejects it before
copying any entry, and only the post-teardown host writer may create it. Schema validation establishes a
bounded, structurally valid provider-observed record; it does not authenticate the provider response.

Run v6 adds one host-owned `provider-artifact-evidence.json` per benchmark cell. The provider adapter
records the exact artifact adjacent to the create options that boot it, and the harness writes that
request fallback before its first sandbox operation. For a canonical release artifact, the harness
then reads the bounded `/toolchain-manifest.json` from the ready guest and atomically upgrades the
record to `guest-fingerprint`. The expected image name/version is never supplied by the producer: the
schema derives it from release constants plus the provider's canonical artifact mapping and rejects a
stale manifest. Arbitrary overrides remain honest request fallbacks. Collection reserves both evidence
filenames, normalization binds the record to its run/provider/suite/replicate cell, and aggregation
rejects conflicts, sandbox reuse, or a mixture of v6 and older shards that could drop attribution.

## The repository

This repo is a **Bun workspace monorepo** with a strict, enforced dependency DAG and a uniform
package shape. The guiding rule: *"can I import this?"* is answered by the path alone, and
boundary violations fail CI.

## Source-first, no build step

Every package's `exports` map points at TypeScript **source** (`./src/index.ts`), and Bun resolves
workspace sources natively. There is no compile step: `bun install` → `typecheck` → `test` →
`lint` are all green with zero compilation. The committed `bun.lock` pins the whole graph.

## Layout

```text
packages/   importable libraries   — scope @sandbox-benchmarks/*
  schema/       shared types + arktype schemas, vendored PTS profiles + generated metric catalog (bottom of the DAG)
  providers/    provider adapters → schema + computesdk
  templates/    per-provider template builders + toolchain Docker images (images/)
  harness/      benchmark timing → providers + schema
  results/      normalization + the comparison surface → schema, figures
  figures/      realworld charts: Run → figure model → HTML → WebP (headless Chrome) → schema
apps/
  cli/          entrypoint with bin commands → every packages/* library
tooling/        dev-only            — scope @repo/*
  tsconfig/     shared source-first TS configs (config-only)
  repo-checks/  boundary + package-meta invariant tests
lib/        in-sandbox benchmark runner (bench.sh), realworld PTS runner overlay, isolation probe
data/       committed benchmark dataset (published run results)
scripts/    maintainer scripts (dataset backfill, leaderboard update)
docs/       methodology, ADRs, CI & secrets
```

## Dependency DAG (enforced)

| Member                      | Internal deps (`workspace:*`)                   | External (catalog)                  |
|-----------------------------|-------------------------------------------------|-------------------------------------|
| `@sandbox-benchmarks/schema`     | —                                               | `arktype`                           |
| `@sandbox-benchmarks/driver`     | schema                                          | `arktype`                           |
| `@sandbox-benchmarks/drivers`    | driver                                          | `arktype`, provider SDKs (`catalog:computesdk`) |
| `@sandbox-benchmarks/providers`  | schema                                          | `arktype`, computesdk packages (`catalog:computesdk`) |
| `@sandbox-benchmarks/templates`  | providers, schema                               | `computesdk` (`catalog:computesdk`) |
| `@sandbox-benchmarks/harness`    | providers, schema                               | —                                   |
| `@sandbox-benchmarks/figures`    | schema                                          | `arktype`, fonts (`@fontsource/*`)  |
| `@sandbox-benchmarks/results`    | schema, figures                                 | `arktype`, XML tooling (`catalog:xml`) |
| `@sandbox-benchmarks/cli` (app)  | schema, driver, drivers, providers, templates, harness, results, figures | `arktype`, `dotenv`, `@actions/core`, provider SDKs (`catalog:computesdk`) |
| `@repo/tsconfig`            | —                                               | —                                   |
| `@repo/repo-checks`         | —                                               | —                                   |

## Native SDK driver configuration

E2B and both Modal variants allocate through the catalog-pinned native SDKs. `_native.ts` projects
those exact SDK handles into the shared driver session machinery; it does not invoke ComputeSDK
wrappers or cast between vendored SDK copies. Provider create-option schemas validate the boundary,
and each request mapper must satisfy its schema's inferred type. Native SDK error classes reach the
provider's retry predicate before the shared bridge normalizes and redacts the error.

`DriverError.vendorHttpStatus` carries HTTP response status; `vendorExitCode` carries process exit
status. Only the HTTP field participates in the 429 retry rule. CLI readiness can return
`{ terminal, retryable }`; the kit releases a retry mark only after failed-create cleanup succeeds.
Tama 0.1.17 exposes a status and diagnostic detail, but no documented capacity reason code. Its
terminal rows explicitly decline retry rather than interpreting `status_detail` as a typed signal.

## Driver end-to-end validation (`driver-check`)

`apps/cli/src/lib/driver-run.ts` is the ADR-0007 composition root: it loads a driver module, parses
that provider's declared env slice, resolves the lane's artifact, and constructs the driver. It also
holds the two adapters that let a port `SandboxSession` drive today's `StepRunner`; both are
temporary and disappear when `harness` flips from `providers` to `driver`.

`driver-check` is the local lane that exercises the whole path against a real sandbox:

```sh
bun apps/cli/src/bin/driver-check.ts --provider e2b
bun apps/cli/src/bin/driver-check.ts --provider tama --phase candidate --workload-seconds 10
```

It runs create → readiness → exec (including the exit-7 and split-stream clauses) → a filesystem
round-trip → a real workload on BOTH transports → destroy → idempotent destroy → control-plane
convergence, then prints a JSON conformance report. It writes **no Run document** because it is a
contract check, not a benchmark measurement; the benchmark harness is the Run v6 artifact-evidence
producer.

The durable step uses a timeout at or above the module's declared `syncCapMs`, forcing
`StepRunner` onto the detached transport. The actual workload lasts `--workload-seconds` and must
produce an observable done-file. The short default proves transport routing and completion; it does
not claim to prove a workload outlives the sync cap. Increase the workload duration for that check.

Use `--require-pass` for release validation: any failed or skipped check exits nonzero, and `--keep`
is rejected so an intentionally retained sandbox cannot produce passing release evidence. Use
`--report-file <path>` for machine-readable JSON: StepRunner emits workload logs to stdout, so the
default stdout stream contains those logs followed by the final report.

A provider whose credentials are absent SKIPS with exit 0. A provider that has not migrated yet
(see `packages/drivers/migration-waivers.json`) is rejected outright rather than silently falling
back to the legacy adapter.

## Driver conformance (`@sandbox-benchmarks/driver/conformance`)

ADR-0008's contract ships with the suite that verifies it. `runConformance({ module, context, tier })`
drives one driver module through the closed clause inventory and returns a report:

```ts
import { runConformance, formatConformanceReport } from "@sandbox-benchmarks/driver/conformance";

const report = await runConformance({ module, context, tier: "smoke" });
console.log(formatConformanceReport(report));
```

Three properties are load-bearing and easy to lose:

- **The inventory is closed.** Every ADR-0008 §2 row appears in every report. A row the suite could
  not observe reports `unverified` rather than being omitted, because a missing row reads as green.
- **`unverified` blocks admission exactly like `fail`.** §5 admits a provider only when every row is
  `pass` or `not-applicable`. An unobserved claim and a false claim are indistinguishable to a
  published measurement, so an honest report is frequently *not* admissible — including for a driver
  that breaks nothing.
- **Absence is not a skip where the contract defines the absent path.** A session without `files`
  exercises the kit's exec fallback, which the harness leans on just as hard; a driver without
  `probes` reports `unverified` for destroy convergence, never a pass.

The suite is verified the way a TCK should be: against deliberately-broken fake drivers, one per
violation, so each clause is shown to actually *catch* the failure it claims to. A driver that
fabricates an exit code, resolves `destroy` while the sandbox still runs, advertises a filesystem
whose reads lie, or returns a session for a GPU it cannot provide each produce a `fail`.

Secret diagnostics is `unverified` unless the caller supplies its spawn/log diagnostic surfaces,
and the GPU row is `unverified` unless a `gpu` axis is supplied. A fully observed run supplies both
along with artifact fingerprint and allocation-order evidence; the suite has a regression proving
that such a conforming report is actually admissible rather than permanently blocked.

`results` depends on `schema` and `figures` alone — it must normalize without any provider SDK,
and it now also builds the leaderboard's chart documents. `@repo/repo-checks` enforces that no
package reaches across boundaries or into another package's private `lib/`.

`figures` is typed by `schema` — the workspace's one Run contract and registry shapes — so it
re-describes nothing the workspace already owns, but the registries still arrive as ARGUMENTS:
there is no module-level dataset, so its guards run against synthetic runs instead of whatever
the committed dataset contains. Its charts are pure string building (HTML with fonts inlined
from pinned packages), and `results` owns the seam that passes the real registries. The one
impure step — headless Chrome, via `Bun.WebView` — lives behind its own entry point,
`@sandbox-benchmarks/figures/screenshot`, imported only by the CLI: everything that merely reads
the Run model or builds a document never spawns a browser.

## Command contract

| Command              | What it does                                                            |
|----------------------|-------------------------------------------------------------------------|
| `bun install`        | Resolve the graph, symlink workspaces, install catalogs (≥7-day-old releases). |
| `bun run typecheck`  | `tsc --noEmit` per member — proof of source-first/no-build.             |
| `bun run test`       | Browser-free `bun test` per member, including repo-checks invariants, excluding the Chrome-backed figures suite. |
| `bun run test:figures` | Chrome-backed figures screenshot tests; CI's `figures` job runs this on a hosted runner with pinned headless Chrome. |
| `bun run lint`       | `biome check . --error-on-warnings` — CI gate; warnings fail (root-only Biome config). |
| `bun run format`     | `biome format . --write` — formatting only (no import sorting / lint fixes). |
| `bun run lint:fix`   | `biome check . --write` — formatting + import sorting + safe lint fixes. |
| `bun run lint:fix:unsafe` | `biome check . --fix --unsafe` — also applies behavior-changing fixes; review the diff. |
| `bun run spell`      | `typos` — source-code spell check (run it before pushing).              |
| `bun run spell:fix`  | `typos --write-changes` — apply typos' suggested corrections.            |
| `bun run lint:shell` | `shellcheck` on the repo's shell scripts (toolchain images, `lib/`, mise tasks) and the `run:` blocks embedded in `.github/actions/` composite actions. |
| `bun run lint:docker`| `hadolint` on the toolchain-image Dockerfiles (`packages/templates/images`). |
| `bun run smoke`      | Boot each provider's sandbox from the baked image and smoke-test it (providers without credentials are skipped). |
| `bun run check:catalog-drift` | Fails if the generated PTS catalog drifted from the vendored profiles. |
| `bun run check:provider-registry-drift` | Fails if the correlated provider metadata index drifted from `PROVIDER_IDS`. |

Run a single bin during development: `bun apps/cli/src/bin/plan-matrix.ts`.

## Toolchain (mise)

Non-Bun tools are version-pinned in [`mise.toml`](../mise.toml) and managed with
[mise](https://mise.jdx.dev): [`typos`](https://github.com/crate-ci/typos) (spell check),
`shellcheck` + `hadolint` (shell/Dockerfile lint for the toolchain images), and
`actionlint` + `zizmor` (workflow lint + security audit, run by the `ci-lint` workflow). After
cloning, run `mise install` (and `mise trust` once) so the pinned binaries are available; the
`bun run` wrappers invoke these tools through `mise exec`, so they always use the pinned versions.
mise fetches from official release sources with checksum verification — no npm republisher and no
install-time postinstall.

## Continuous integration

`.github/workflows/ci.yml` runs the command contract on every pull request and every push to
`main`: `bun install --frozen-lockfile --ignore-scripts` → `bun run lint` (the Biome gate) →
`bun run lint:shell` → `bun run lint:docker` → `bun run typecheck` → browser-free `bun run test` →
`bun run check:catalog-drift` → `bun run check:provider-registry-drift` → `bun run spell` (typos, set up via [mise](https://mise.jdx.dev)).
A second `figures` job runs pinned-Chrome `bun run test:figures` on a hosted `ubuntu-24.04` runner —
the same image that renders the committed figures, and the one where Chrome can keep its sandbox.
A separate `ci-lint.yml` lints the workflows themselves (actionlint + zizmor). The browser-free
checks run locally; CI additionally exercises the Chrome-backed figures suite with its pinned browser.

CI runs on a maintainer-controlled runner, so it never executes fork-PR code — the gate runs only
for pushes and same-repo pull requests. Anything that needs provider credentials additionally runs
only from `main`, behind Environment [`privileged`](./ci-secrets.md); pull requests never
receive provider secrets.

## Git hooks (pre-commit)

[Lefthook](https://lefthook.dev) runs a fast local mirror of CI on every commit, configured in
`lefthook.yml`:

- **Biome** on staged files (`biome check --write`, restaging any auto-fixes; unfixable issues or
  warnings block the commit).
- **Typos** repo-wide (`bun run spell`) — read-only, so run `bun run spell:fix` to apply corrections.
- **Lockfile** check (`bun install --frozen-lockfile`) when a manifest or `bun.lock` is staged, so
  `package.json` and `bun.lock` can't drift apart.

`bun install` wires the hooks automatically via the project's own `prepare` script
(`lefthook install`) — no third-party postinstall runs. Re-install them with `bunx lefthook
install`, and bypass a single commit with `LEFTHOOK=0 git commit`.

## Supply-chain posture

`bunfig.toml` sets `minimumReleaseAge = 604800` (7 days) so freshly published — possibly
compromised — releases are not installed, and **no third-party lifecycle scripts run** (empty
`trustedDependencies`). The git hooks above are wired by the project's own first-party `prepare`
script, not a dependency's postinstall, and CI installs with `--ignore-scripts` so it runs none
either. Lint and formatting are root-only via a single `biome.json`.
