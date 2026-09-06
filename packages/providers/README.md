# @sandbox-benchmarks/providers

Provider adapters may own a post-teardown cost-evidence hook. Billing API calls belong here, never in
the SDK-free results package, and observed evidence must identify the benchmark sandbox itself;
organization/account/workspace/shared-app totals are context only. The run.cloud hook does not call
or delta its organization-wide usage API and returns `not_sandbox_scoped`. Modal cost evidence lives
on the Modal DriverModule (`packages/drivers/src/_modal.ts`), not on a leftover adapter.

**Role:** provider wiring — binds each schema provider to a computesdk runtime.

**Public surface (`.`):** `ProviderAdapter`, `ProviderConfig`, `DirectProvider` (types), the
assembled `providers` registry, and the toolchain image constants (`TOOLCHAIN_IMAGE`,
`TOOLCHAIN_VERSION`, `DAYTONA_SNAPSHOT_DEFAULT`).

**Depends on:** `@sandbox-benchmarks/schema` (provider identity / `PROVIDERS`), `computesdk` and the
`@computesdk/*` wrappers where they preserve the required surface, plus focused compatibility
adapters over raw vendor SDKs only where required.

**What lives here:** provider factories and focused compatibility adapters. Most `@computesdk/*`
packages adapt their vendor SDK directly; Microsandbox uses a local `defineProvider` implementation.
Vercel's local provider starts from ComputeSDK's upstream adapter but uses pinned `@vercel/sandbox`
v2, because the published wrapper still pins a pre-VCR SDK. run.cloud also uses a local
`defineProvider` adapter over `@run-cloud/sdk`, for which no `@computesdk/*` wrapper is published.
e2b, tama, modal-gvisor, and modal-vm are registered DriverModules (`packages/drivers`); this
package keeps only the remaining waived adapters. The package also owns benchmark create-time
policy — the pinned `TARGET_SPEC` and toolchain image. The assembled `providers` registry joins
schema metadata with `Record<LegacyAdapterId, ProviderAdapter>`; a waived provider without an
adapter is a compile error. Private glue lives in `src/lib/` and is never imported across a
package boundary.

The join also carries each provider's schema-owned `transport` capability (`ProviderTransport`:
streaming, synchronous cap, detached+poll) onto the `ProviderConfig`, so the harness selects a
per-step exec transport from the declared capability instead of hardcoding one provider's quirks.

## Validate Vercel locally

Vercel uses a project-issued OIDC token at runtime; do not pass a long-lived `VERCEL_TOKEN` to the
benchmark process. Enable OIDC Federation in the linked project's Security settings, then run from a
Vercel-authenticated checkout:

Use the repository-pinned CLI (`./node_modules/.bin/vercel`), not a globally installed one: `vcr` is a
recent subcommand, and an older global `vercel` fails with `"vcr" is not a valid subcommand`.

```sh
# Link the checkout and create the VCR repository once.
./node_modules/.bin/vercel login
./node_modules/.bin/vercel link
./node_modules/.bin/vercel vcr add sandbox-benchmarks-toolchain-vercel
./node_modules/.bin/vercel vcr login docker

# Read the namespace back from the resolved config so this flow and CI cannot drift. Override the
# defaults with VERCEL_TEAM_SLUG / VERCEL_PROJECT_NAME to publish into a fork's team or project.
read -r vcr_owner vcr_project vcr_image <<<"$(bun -e 'import { config } from "@sandbox-benchmarks/providers";
  console.log(`${config.vercelTeamSlug}/${config.vercelProjectName}`, config.vercelProjectName, config.vercelImage)')"

# Build and publish the shared Vercel variant into that namespace.
REGISTRY=vcr.vercel.com IMAGE_OWNER="$vcr_owner" packages/templates/images/build.sh
./node_modules/.bin/vercel vcr push docker "${vcr_image##*/}" --project "$vcr_project"

# Pull a short-lived project OIDC token. The Vercel SDK discovers it directly from the environment.
./node_modules/.bin/vercel pull --yes
./node_modules/.bin/vercel env pull .env.vercel.local
set -a; . ./.env.vercel.local; set +a
trap 'rm -f .env.vercel.local; docker logout vcr.vercel.com >/dev/null 2>&1 || true' EXIT
unset VERCEL_TOKEN

# Other providers skip when their credentials are absent; Vercel is required to boot and pass.
REQUIRE_PROVIDERS=vercel bun apps/cli/src/bin/bench-smoke.ts
```

`vercel link` writes `.vercel/project.json` (the `team_*` / `prj_*` API IDs); CI supplies the same two
values as `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` secrets instead, so no Git integration between the
GitHub repository and the Vercel project is required. `VERCEL_PROJECT_NAME` must name the project that
`prj_*` identifies — `vcr push --project` uses the name, so a mismatch fails loudly rather than
publishing where nothing pulls from.

The VCR path is rooted at the configured human-readable namespace. The `EXIT` trap removes the
temporary environment file and Docker credential even if validation fails. The local ComputeSDK
provider uses the v2 SDK's name-keyed lifecycle, detached current-session execution, non-resuming
reconnects, and permanent delete cleanup. A conservative 60-second synchronous policy cap routes
longer setup and suite steps through native detached execution. Filesystem methods are intentionally
omitted because Vercel's high-level filesystem wrapper can auto-resume a stopped sandbox; the harness
observes detached completion with short `cat` polls through the same non-resuming current session.
