# CI & secrets

Provider credentials and release mutations live only in the GitHub Environment **`privileged`**.
Repository-level copies of those secrets must not exist: that is how we keep them unavailable to
PR workflows, forks, and any job that forgot to declare the environment.

`tooling/repo-checks` enforces the workflow side of this posture (see `workflow-hardening.ts`):
custom secrets and `contents: write` / `packages: write` jobs must set `environment: privileged`,
and toolchain publish must not trigger on `push`.

## What is gated

| Workflow | Job | Why |
| --- | --- | --- |
| `toolchain-image.yml` | `publish` | Provider bake secrets + `packages: write` (GHCR release) |
| `bench-suite.yml` | `bench` | Provider API keys (the reusable benchmark cell BOTH `bench-matrix.yml` and `bench-smoke.yml` call) |
| `commit-dataset.yml` | `commit` | Dataset JSON commit (`contents: write` + `pull-requests: write`) |
| `update-leaderboard.yml` | `leaderboard` | Public `LEADERBOARD.md` commit (`contents: write` + `pull-requests: write`) |

`bench-matrix.yml` and `bench-smoke.yml` are **not** listed: neither reads a provider secret itself.
`bench-smoke.yml` is a `plan` job plus a suite-matrix job that calls `bench-suite.yml`;
`bench-matrix.yml` is the same, plus a `publish` job that calls `commit-dataset.yml`. Both callees are
in the table above and carry their own `privileged` gate, so a dispatch lane's jobs only plan and
orchestrate. A smoke dispatch is gated exactly as a matrix cell is — same approval, same Environment
secrets, same callee — it simply has no third phase to gate.

Two of these are reusable workflows whose `privileged` gate lives on their own job, because a `uses:`
caller can't declare `environment:` (the workflow-hardening drift gate checks the callee and passes the
local caller):

- `bench-suite.yml` runs one suite across a provider matrix. It is the single benchmark-cell
  implementation: `bench-matrix.yml`'s suite-matrix job calls it once per planned suite, and
  `bench-smoke.yml`'s calls it once for the dispatched suite. Environment secrets on `privileged`
  resolve from the reusable job's own `environment:` declaration (a `uses:` caller can't set
  `environment:`). Both callers pass `secrets: inherit` for repository-level secrets / token context.
- `commit-dataset.yml` commits the machine-readable dataset: `bench-matrix.yml`'s `publish` job calls it
  at the end of a matrix run, and a maintainer can dispatch it standalone to backfill (see rule 6). It
  lands `data/dataset/` only — the public `LEADERBOARD.md` is regenerated separately (see rule 7), so the
  dataset can accumulate a run per matrix run without moving the published comparison surface.
- `update-leaderboard.yml` regenerates `LEADERBOARD.md` from a committed dataset run. It is
  maintainer-dispatched (never called by the matrix), so the published table only moves on a deliberate
  action — see rule 7.

Ungated: `ci.yml`, `ci-lint.yml`, and the toolchain `pr-gate` (Docker smoke, no secrets).

## Release rules (public-safe)

1. **No publish on merge.** Toolchain GHCR promote is `workflow_dispatch` only (never `push`).
2. **Main only, this repo only.** Privileged jobs require
   `github.ref == 'refs/heads/main'` and
   `github.repository == 'starslingdev/hpc-sandbox-benchmarks'`. The benchmark matrix and the smoke
   dispatch additionally permit an explicitly opted-in non-main dispatch (`allow_branch`) for
   pre-merge validation; those runs still require `privileged` approval, and every mutation of the
   repo — dataset publishing, GHCR promote, leaderboard — remains main-only.
3. **Environment approval.** `privileged` must require at least one reviewer and restrict
   deployments to `main` plus whatever branch pattern you want `allow_branch` to reach. Write access
   alone cannot finish a release.
4. **Fork PRs.** Same-repo guard on self-hosted PR jobs; fork PR code never runs on
   `starsling-ubuntu-24.04-2`. Forks never receive Environment secrets on `pull_request`.
5. **Dataset lands via PR, lint-gated.** `main` is protected by a "changes must be made through a
   pull request" ruleset, so `commit-dataset.yml`'s `commit` job cannot push the promoted dataset
   straight to `main` (a direct push is rejected with `GH013`). It opens a `dataset/publish-<run-id>`
   PR instead (hence `pull-requests: write`) and merges it the same way the leaderboard flow does
   (rule 7): a direct `gh pr merge` — GitHub still enforces the ruleset on that call; it succeeds
   because the ruleset has no required status checks and `data/dataset/` is unowned. Deliberately not
   `--auto`: arming auto-merge on a `GITHUB_TOKEN` PR whose required check will never run would leave
   the PR stranded behind a green job. As a fast pre-flight, the job first runs the
   Biome gate on the generated dataset (`biome check data/dataset`, the same rules ci.yml runs) —
   Biome formats JSON, so an unformatted Run document would fail the PR — and aborts before opening a
   doomed PR on a miss. The push/PR step is idempotent: a re-run reuses the existing open PR instead of
   colliding on the deterministic branch. Leaderboard landing follows the same `GITHUB_TOKEN` + PR
   pattern, path-fenced to exactly `LEADERBOARD.md` and `docs/figures/*.webp` (rule 7).

   > **`GITHUB_TOKEN` caveat.** A PR opened with the default `GITHUB_TOKEN` does **not** trigger
   > `ci.yml` (GitHub suppresses workflow events raised by the Actions token). So if the Biome/CI
   > check ever becomes a *required* status on the main ruleset, the direct merge fails and the
   > publish job goes red — a maintainer completes the merge (their merge to `main` runs `ci.yml`
   > normally). Today the ruleset requires no status checks, so this caveat only bites if one is
   > added — the in-job Biome pre-flights already guarantee the generated content is clean either
   > way. For fully hands-off merging *with* required checks, the PR would need to be opened with a
   > GitHub App installation token or PAT instead of `GITHUB_TOKEN`; we deliberately avoid
   > provisioning one until that trade-off is actually needed.
6. **Backfilling a failed dataset commit.** The commit logic is the reusable `commit-dataset.yml`, so
   when a matrix run's dataset commit fails (or was never reached) a maintainer can re-run it standalone:
   **Actions → Commit dataset → Run workflow**, passing the original run's id — or, from a
   gh-authenticated clone, `scripts/backfill-dataset.sh <run-id>` (a thin `gh workflow run` wrapper that
   also warns if the run's shard artifacts have already expired). It re-downloads that run's `bench-*`
   shard artifacts by run-id (needs `actions: read`), re-aggregates, and opens the same lint-gated
   dataset PR — no re-benching. This only works while that run's shard artifacts are still within the
   repo's artifact-retention window. Dispatch is still gated by Environment `privileged` (main-only,
   required reviewer), so it is effectively maintainer-only. (`workflow_dispatch` is only offered for the
   copy of the workflow on the default branch, so `commit-dataset.yml` must be merged to `main` before
   it can be dispatched.)

7. **Updating the public leaderboard (github-actions bot, path-fenced).** `LEADERBOARD.md` is regenerated
   separately from the dataset commit, on a deliberate maintainer action: **Actions → Update
   leaderboard → Run workflow** — or `scripts/update-leaderboard.sh [run-id]` from a gh-authenticated
   clone. Leave `run_id` blank to render from the newest committed dataset run (the first entry in
   `data/dataset/index.json`), or pass an explicit run id to point the table at a specific run. The
   workflow renders `LEADERBOARD.md` from `data/dataset/runs/<run-id>.json` — the **committed** dataset,
   never the gitignored `data/runs/` scratch tree (what the `leaderboard-artifact-sync` gate enforces) —
   so the run must already be committed (via a bench-matrix run or rule 6) before the leaderboard can
   name it. It then:

   1. Pushes `leaderboard/update-<run-id>` and opens the PR as the built-in **github-actions bot**
      (`GITHUB_TOKEN` — no extra App or PAT; requires the "Allow GitHub Actions to create and approve
      pull requests" toggle, see operator setup).
   2. Runs `scripts/assert-paths-allowlisted.sh` on the staged index **and** the PR file list; anything
      other than `LEADERBOARD.md` and `docs/figures/*.webp` aborts before any merge is attempted.
   3. Merges the PR with a direct `gh pr merge` (deliberately not `--auto`: on a `GITHUB_TOKEN` PR a
      required check never runs, so arming auto-merge could only ever strand the PR behind a green
      job). GitHub still enforces the ruleset on the merge call; this is not a bypass — it succeeds
      only because the ruleset has no required status checks, code-owner review is the sole review
      requirement, and `LEADERBOARD.md` is intentionally unowned.

   Because the render is deterministic, the resulting `LEADERBOARD.md` is exactly what
   `leaderboard-artifact-sync` expects, so subsequent CI stays green. The job also pre-flights the
   repo-wide Biome gate (`biome check .`, the same command ci.yml's lint job runs) before opening the
   PR — it must be repo-wide, not `biome check LEADERBOARD.md`: Biome has no Markdown handler under
   this config, so a Markdown-only invocation processes zero files and exits non-zero.

   This is intentionally **not** a ruleset bypass for `github-actions`. Public contributors who open a
   PR that modifies `.github/` still need a code-owner approval (see operator setup), and the dispatch
   itself is gated by Environment `privileged` (main-only + required reviewer), so fork PRs can never
   drive this flow.

8. **Adding one provider to a version everyone else already runs (scoped backfill).** A provider added
   after a toolchain version was cut has no artifact for it, and the two obvious recoveries are both
   wrong: a version bump re-benches the whole fleet, and `force_republish` regenerates *every*
   provider's artifact in place — destructively for Daytona, which deletes each snapshot before
   recreating it. `toolchain-image.yml` therefore takes three optional dispatch inputs that narrow the
   release instead (all default to the full release, so a normal version bump is unchanged):

   | Input | Effect |
   | --- | --- |
   | `providers` | Comma-separated provider ids the release covers; blank = all. Scoping produces only those bake cells, and makes promote a **backfill**: it publishes just those providers' version artifacts onto the already-published version and never rewrites the public base or anyone else's artifact. Every provider a scoped dispatch names is **required** — you asked for it, so it must ship. |
   | `build` | `full` rebuilds the base (the default). `skip` skips the build job outright and derives everything from what the registry already holds. A backfill wants `skip`: it attaches to the **published** base, so the new provider gets exactly the bytes the fleet already runs — and since the toolchain build is not reproducible, a rebuild would quietly hand it a different `:vN`. |
   | `promote` | Uncheck to bake + verify only; the publish job is skipped. |

   A backfill needs no shared build phase: every provider derives its candidate or version artifact
   from the one already-published toolchain base during bake/promote. Runloop builds a named Blueprint
   whose Dockerfile starts from that digest. Vercel mirrors the same base into VCR because its platform
   cannot pull GHCR directly (and injects its own session agent at boot, so there is no provider delta).

   `force_republish` is rejected together with a `providers` list — they are opposite operations, and
   silently picking one would do something the operator did not ask for. A scoped promote also refuses
   if the version is **not** yet published: there is nothing to backfill onto, so run a full release
   first. Two more refusals keep a scoped release honest, both fail-fast in the plan or before the
   public base moves:

   - **`providers: blaxel` is refused.** It still boots a vendor stock image, so the release lane has
     no artifact a scoped backfill can publish. Generated credentials let an *unscoped* release
     validate it best-effort, but validation alone cannot turn the stock image into a release output.
     Runloop is scopable: its protected `RUNLOOP_API_KEY` builds and validates a candidate Blueprint,
     and a scoped Runloop dispatch is required/fail-closed.
   - **A drifted candidate base is refused** when the scope contains a provider that bakes its artifact
     *from* the base (e2b, daytona, novita, runloop). Those providers' candidates are verified but their version
     artifacts are rebuilt, so the two are the same bytes only while `:vN-candidate` still is `:vN` —
     bump `TOOLCHAIN_VERSION` and cut a full release. Providers that don't bake from the base (vercel,
     modal, namespace, microsandbox) are unaffected: their version artifact is a retag of the exact
     candidate that was just booted.

   The Runloop-on-v8 flow, as an example — two dispatches, neither of which touches another provider,
   and neither of which runs a build job:

   1. **Actions → Toolchain image → Run workflow** with `providers=runloop`, `build=skip`, `promote`
      unchecked. Builds the candidate Blueprint from the published GHCR `:v8` digest, boots it, and
      runs the smoke spec. Nothing public moves.
   2. Same dispatch with `promote` checked. Re-validates the candidate Blueprint and builds the
      version-named Blueprint from the pinned base. The GHCR base `:v8` is never rewritten.

   The release pulls exactly **one** GHCR package (`sandbox-benchmarks-toolchain`), anonymously, so the
   one-time Public bootstrap it needs has already been done. Adding a provider never adds a package —
   which matters because GHCR creates a package private on first push and offers **no API to flip it**,
   so a per-provider package would put a manual, un-automatable step in the middle of every new
   provider's first release. The plan's visibility guard still checks the package and warns if it is
   ever not public.

> **Approval gates per bench-matrix run: one per collection round, plus `publish`.** Every batch
> job (each calling `bench-suite.yml` with `environment: privileged`) and the `publish` job carry the
> environment. GitHub approves only the jobs that are pending at that moment, so the workflows are
> shaped to make jobs pend together: a round's batch jobs are created at once (no `max-parallel`;
> the `benchmark-account-<domain>` concurrency queue serialises them), and every account's first
> round starts as soon as `plan` finishes, so one approval of `privileged` releases the whole first
> wave. An account with more batches than one round holds (64, see `ROUND_BATCH_LIMIT`) raises a
> further gate when its next round starts; `publish` becomes pending only after the last account
> finishes, raising the final gate before the dataset is committed. A reviewer who approves only the
> first wave and walks away leaves the run parked at the next gate until an approval lands or the
> protection rule times out.

## Operator setup (before flipping the repo public)

Do this in the GitHub UI (Settings → Environments / Rules / Actions), then delete any matching
**repository** secrets.

### Environment `privileged`

1. Create Environment **`privileged`**.
2. **Required reviewers:** at least one maintainer (two preferred).
3. **Deployment branches:** `Selected branches` → `main`.

   This rule is a SECOND gate, independent of each workflow's `if:`. `bench-matrix.yml` and
   `bench-smoke.yml` both offer an `allow_branch` dispatch input for pre-merge validation, but a
   branch dispatch still fails at the environment with *"Branch is not allowed to deploy to
   privileged"* until this list admits the branch. To use `allow_branch`, add the branch patterns you
   want to reach it — e.g. `claude/*`, or a dedicated `bench/*` prefix maintainers push validation
   branches to. Patterns use branch-protection syntax, where `*` does not match `/`: a bare `*` admits
   `main`-style names only, so a `codex/…` branch needs its own entry or a `codex/*` pattern (a smoke
   dispatch on such a branch otherwise fails in 2 s with *"not allowed to deploy to privileged"*).
   Prefer a narrow pattern over `All branches`: anyone who can push a matching branch can
   then request a `privileged` run (a reviewer still has to approve it, and the workflows' own
   same-repo guard still excludes forks, so this widens *who can ask*, not *what runs unattended*).
   Leave the list at `main` alone if you do not want branch dispatches at all — the input is inert
   without it.
4. Add these **environment** secrets (then delete repository-level copies if present):

   <!-- >>> generated: provider-secrets — bun run generate-provider-wiring -->
   | Secret | Used by |
   | --- | --- |
   | `E2B_API_KEY` | E2B provider runtime and validation |
   | `DAYTONA_API_KEY` | Daytona (VM), Daytona (container) provider runtime and validation |
   | `BL_API_KEY` | Blaxel provider runtime and validation |
   | `BL_WORKSPACE` | Blaxel provider runtime and validation |
   | `MSB_API_KEY` | Microsandbox Cloud provider runtime and validation |
   | `MODAL_TOKEN_ID` | Modal (gVisor), Modal (VM) provider runtime and validation |
   | `MODAL_TOKEN_SECRET` | Modal (gVisor), Modal (VM) provider runtime and validation |
   | `NOVITA_API_KEY` | Novita provider runtime and validation |
   | `RUNLOOP_API_KEY` | Runloop provider runtime and validation |
   | `RUN_CLOUD_API_KEY` | run.cloud provider runtime and validation |
   | `TAMA_TOKEN` | tama provider runtime and validation |
   <!-- <<< end generated: provider-secrets -->

   Vercel bootstrap credentials are workflow infrastructure, not provider runtime inputs, so they
   remain an explicit list:

   | Secret | Used by |
   | --- | --- |
   | `VERCEL_TOKEN` | Bootstrap only: Vercel CLI pulls a short-lived project OIDC token |
   | `VERCEL_ORG_ID` | Links the Vercel CLI to the repository's organization (`team_*`) |
   | `VERCEL_PROJECT_ID` | Links the Vercel CLI to the repository's project (`prj_*`) |

   `MSB_API_URL` is an optional Microsandbox Cloud endpoint override for staging or private deployments. Leave it unset to use the SDK's `https://api.microsandbox.dev` default.

   Enable **OIDC Federation** in the linked Vercel project's Security settings and create the
   `sandbox-benchmarks-toolchain-vercel` VCR repository once (for example with `vercel vcr add`). The
   shared `vercel-auth` composite runs the pinned Vercel CLI's `pull` and `env pull` commands, masks
   `VERCEL_OIDC_TOKEN`, exports it through `GITHUB_ENV`, and immediately deletes its temporary env
   file. Toolchain jobs additionally run `vercel vcr login docker`, use `vercel vcr push docker` for
   publication, and always run `docker logout vcr.vercel.com`.

   Put ordinary, non-credential provider configuration in GitHub Actions **variables** (Settings →
   Secrets and variables → Actions → Variables), *not* secrets. The generated workflow accepts the
   legacy secret location as a migration fallback, but new configuration should use variables:

   <!-- >>> generated: provider-variables — bun run generate-provider-wiring -->
   | Variable | Used by | Default |
   | --- | --- | --- |
   | `E2B_TEMPLATE` | E2B | — |
   | `DAYTONA_TARGET` | Daytona (VM) | <code>us-west-2</code> |
   | `DAYTONA_SNAPSHOT` | Daytona (VM) | — |
   | `DAYTONA_CONTAINER_TARGET` | Daytona (container) | <code>us-west-2</code> |
   | `DAYTONA_CONTAINER_SNAPSHOT` | Daytona (container) | — |
   | `MSB_API_URL` | Microsandbox Cloud | — |
   | `NOVITA_TEMPLATE` | Novita | — |
   | `RUNLOOP_BLUEPRINT` | Runloop | — |
   | `VERCEL_TEAM_SLUG` | Vercel Sandbox | — |
   | `VERCEL_PROJECT_NAME` | Vercel Sandbox | — |
   | `TAMA_CLI` | tama | — |
   <!-- <<< end generated: provider-variables -->

   Optional values with a declared provider default use it when unset. The two Vercel namespace
   values fall back to `VERCEL_TEAM_SLUG_DEFAULT` /
   `VERCEL_PROJECT_NAME_DEFAULT` in `packages/schema/src/toolchain.ts`, which is the single place the
   default namespace is defined. Set them only to publish into a different team or project.

   These are the human-readable **names**; `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` are the `team_*` /
   `prj_*` **API IDs** that `vercel pull` links with. The two pairs are not interchangeable, and
   passing an ID where a name belongs is rejected at config load rather than becoming a registry path
   segment. `VERCEL_PROJECT_NAME` must name the same project as `VERCEL_PROJECT_ID`: the mirror step
   passes it to `vercel vcr push --project`, so a mismatch fails the push instead of publishing into a
   repository the providers never pull from.

### Main ruleset (public-safe bot merges)

Configure the `main` ruleset so the bot-authored dataset/leaderboard PRs can merge hands-off
**without** letting a public contributor merge a PR that edits `.github/`:

1. Ruleset on `main` (or default branch):
   - Require a pull request before merging.
   - **Required approving review count: `0`.**
   - **Require review from Code Owners: on.**
   - **No required status checks** — `GITHUB_TOKEN`-authored PRs never run them (the caveat in
     rule 5), so a required check would strand every bot PR on a maintainer merge. The bot-landed
     content is guarded instead by the in-job Biome pre-flights, the deterministic renderer, and the
     path allowlist.
2. Keep [`.github/CODEOWNERS`](../.github/CODEOWNERS) owning **everything by default** (`*` owner)
   with ownerless overrides for exactly the bot-landed artifacts (`/LEADERBOARD.md`,
   `/data/dataset/`, `/docs/figures/*.webp` — a CODEOWNERS entry with no owner un-owns its paths;
   last match wins). Those must stay unowned so code-owner review is not required for the bot's PRs;
   everything else — in particular the leaderboard renderer and its backing packages, whose output a
   `privileged` job commits — must stay owned so no code change can merge without maintainer review.

   > **Keep this list in lockstep with the landing jobs' path allowlists.** The un-owned set must be
   > a superset of everything `assert-paths-allowlisted.sh` permits the bot to commit. Widening a
   > job's fence without un-owning the new path is a silent break: the PR still opens, GitHub
   > requests a code-owner review, and the direct merge fails with *"the base branch policy
   > prohibits the merge"* — a red job on an otherwise-correct PR. This is exactly how #311 broke
   > the leaderboard flow: it started committing `docs/figures/*.webp`, which `*` still owned.
3. **Do not** add `github-actions` (or a broad actor) as a ruleset bypass. The bot does not need
   bypass when code-owner review is the only review requirement and its two landing paths are
   unowned.
4. **Settings → General → Pull Requests → Allow auto-merge** is not needed by these flows: the
   workflows use a direct `gh pr merge`, never `--auto` (arming auto-merge on a `GITHUB_TOKEN` PR
   whose required check can never run would strand it behind a green job).

With that posture: a fork/public PR that touches `/.github/` still needs `@dbworku`; a
`leaderboard/update-*` PR that only changes `LEADERBOARD.md` and its rendered `docs/figures/*.webp`
merges as soon as the workflow opens it.

### Other Actions settings

1. Confirm the GHCR package `sandbox-benchmarks-toolchain` is **public** so providers can pull
   the candidate base anonymously (Org → Packages → package settings).
2. Enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create
   and approve pull requests"** — both `commit-dataset.yml` and `update-leaderboard.yml` use
   `GITHUB_TOKEN` for `gh pr create`. Prefer the default **Read** repository contents permission;
   elevated `contents` / `pull-requests` stay on individual jobs.

Optional bootstrap (creates the empty environment; reviewers/secrets still need a human):

```sh
./scripts/setup-privileged-environment.sh
```

## Local credentials

Copy [`.env.example`](../.env.example) to a gitignored `.env` and fill in the providers you have
(Bun auto-loads `.env` when you run a bin). A missing credential is a skip, not a failure. Never
commit them; never paste them into issues or pull requests. See [SECURITY.md](../SECURITY.md).

`microsandbox-cloud` needs `MSB_API_KEY`; `MSB_API_URL` is an optional endpoint override. The cloud adapter keeps the key in the SDK control-plane backend and never adds it to sandbox metadata, create-time environment variables, or guest commands.

Runloop needs `RUNLOOP_API_KEY`. The release lane keeps it in the SDK control-plane client while
building versioned Blueprints from digest-pinned public toolchain images; the runtime adapter boots the
released Blueprint by name. The credential is never copied into Blueprint parameters, Devbox create
options, or the guest. `RUNLOOP_BLUEPRINT` is an optional local runtime override; leave it unset to use
the canonical version-scoped Blueprint. Runloop disk snapshots remain temporary lifecycle-benchmark
measurements; they are not release artifacts and are never selected for ordinary benchmark startup.

run.cloud needs `RUN_CLOUD_API_KEY`. Its SDK reads the key directly from the benchmark process; the adapter never adds it to sandbox metadata, create-time environment variables, or guest commands.

tama needs `TAMA_TOKEN`, minted with `tama tokens create`. It publishes no SDK, so the bench cell
installs the checksum-pinned CLI (`.github/actions/setup-tama`) and the adapter drives that binary as a
subprocess. The token is adopted into the CLI's own profile on the first control-plane call and never
reaches sandbox metadata, create-time environment variables, or guest commands; every diagnostic that
quotes an argument vector redacts it. A fresh runner has no profile, so the secret is what authenticates
it — locally the adapter probes an existing `tama login` profile first and only falls back to the token,
because `tama login --token` REPLACES the stored credential.

The `tooling/repo-checks` secret-hygiene gate enforces this: it fails CI if any tracked file is a
credential file (`.env`, `*.pem`, `id_rsa`, …) or contains a high-signal secret token.
