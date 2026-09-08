# Domain docs

How engineering skills navigate this benchmark monorepo's domain vocabulary and decisions.
All paths below are relative to the repository root.

## Read for the task

1. Read `CONTEXT-MAP.md` at the root. Follow links to the package contexts affected by the task,
   including both producers and consumers when a contract crosses a package boundary.
2. Read `docs/adr/README.md`, relevant system-wide ADRs, and relevant `docs/adr/` records inside
   those package contexts. Use the routes below to select the relevant decisions.
3. Read the affected package's README, public exports, implementation, and behavioral tests.
   Use `docs/architecture.md` for architecture and `docs/methodology.md` for measurement meaning.

If the map, a glossary, or a scoped ADR directory is absent, proceed silently using the routes
below and existing documentation. Create domain documents lazily when terminology or decisions
are resolved; missing files alone are not a reason to scaffold empty documents.

## Multi-context layout

`CONTEXT-MAP.md` is the navigation index: link to package glossaries and describe their
relationships. Each context owns its vocabulary in `<package>/CONTEXT.md`; shared benchmark
terms belong in `packages/schema/CONTEXT.md` and other contexts refer to them.

| Context root | Vocabulary and responsibility |
| --- | --- |
| `packages/schema/` | Provider identity and variants, target and observed specs, suites, dimensions, metrics, samples, replicates, Run documents, gaps, pricing, and evidence contracts. |
| `packages/driver/` | Provider-neutral sandbox behavior: driver, session, sandbox reference, command exit, capabilities, execution/readiness policy, teardown, and conformance. |
| `packages/drivers/` | Provider-specific DriverModules: translate vendor behavior into the driver contract and declare provider inputs, policies, and capabilities. |
| `packages/providers/` | Remaining legacy provider adapters and their configuration, compatibility behavior, and runtime metadata join during migration. |
| `packages/templates/` | Toolchain images and provider template builders, pinned tools, manifests, and build recipes. |
| `packages/harness/` | Sandbox ownership, lifecycle timing, readiness, suite execution, transport selection, raw collection, and host-owned evidence persistence. |
| `packages/results/` | Raw extraction and normalization, shard aggregation, host attribution, economics derivation, Run writing, comparison, and leaderboard output. |
| `packages/figures/` | Chart-specific models, pipeline phases, chartability, shared scales, HTML documents, and rasterization. |
| `apps/cli/` | Command composition: planning, provider selection, environment and artifact resolution, replicates, benchmark execution, release lanes, and dataset publication. |
| `tooling/repo-checks/` | Repository invariants: package boundaries, metadata, generated-file alignment, dataset integrity, and workflow checks. |

`tooling/tsconfig/` is shared compiler configuration; consult it for toolchain changes rather than
inventing benchmark vocabulary for it. Package-local ADRs live in `<package>/docs/adr/`.
Decisions affecting multiple contexts stay in the existing root `docs/adr/`.

## Routes across contexts

- **Provider onboarding or migration:** read schema identity/metadata, the driver contract and
  conformance, the selected driver implementation or legacy adapter, and CLI composition.
  Consult ADR-0006, ADR-0007, and ADR-0008. Determine migration status from
  `packages/drivers/src/index.ts`, `packages/drivers/migration-waivers.json`, and CLI routing.
  The harness still consumes legacy shapes through CLI bridges; distinguish today's wiring
  from the intended driver-port architecture.
- **Workload, suite, or metric changes:** read schema suites/catalog, harness execution and
  collection, then results extraction. Follow the actual workload into `.mise/tasks/`, `lib/`,
  and `packages/schema/src/pts-profiles/`. Consult ADR-0003 and `docs/methodology.md`;
  for GPU workloads also read `docs/gpu-benchmark-methodology.md` and the CLI GPU path.
- **Resource comparability or host attribution:** read schema target/observed specs, harness
  probes, and results spec/mixture handling. Consult ADR-0005 and methodology. Preserve the
  distinction between requested resources, effective sandbox resources, and observed host hardware.
- **Cost or artifact evidence:** trace the schema contract through the selected driver/adapter,
  harness persistence, results normalization/aggregation, and reporting. Distinguish declared
  pricing from observed sandbox cost, and requested artifact identity from guest fingerprint
  evidence. Missing evidence is not a zero cost or a verified artifact.
- **Toolchain release:** read templates and image scripts, schema artifact descriptors and
  toolchain identity, CLI build/bake/release composition, and the relevant workflows.
  A toolchain candidate is distinct from a candidate benchmark Run.
- **Dataset publication or reporting:** read results, the Run schema, and CLI aggregate/promote/
  leaderboard commands; consult ADR-0004. For charts, also read figures and its results integration.
  Results owns non-chart derivations and captions; figures owns chart models and rendering.
  Browser capture is a separate figures entry point invoked by the CLI.
- **Dependency or workspace changes:** consult ADR-0001/0002, affected package manifests and
  exports, and `tooling/repo-checks/src/boundary.test.ts` plus `package-meta.test.ts`.
  Read actual declared dependencies instead of copying a dependency table into a glossary.

## Vocabulary and evidence

Keep `CONTEXT.md` files as domain glossaries. Put implementation maps and operating instructions
in package READMEs or architecture documentation; put consequential design trade-offs in ADRs.
Use the owning context's terms in issues, hypotheses, proposals, code, and tests. Where contexts
reuse a word with different meanings, qualify it and describe the translation in the map.

In particular, distinguish provider identity from a provider implementation, a sandbox replicate
from samples collected inside it, operation success from measurement validation, and conformance
admission from a published benchmark result. Consult the relevant schemas and consumers before
treating similarly named statuses or types as interchangeable.

Use source, schemas, manifests, and behavioral tests to establish current behavior; use ADRs to
understand decisions and methodology to understand comparison claims. If they disagree, surface
the discrepancy relevant to the task and distinguish observed behavior from intended policy.
Verify mutable details such as target sizes, migrated providers, versions, and dependency edges
at their source instead of preserving historical values in this configuration.

Explicitly identify proposals that conflict with an ADR and explain the reason to revisit it.
Preserve superseded ADRs and record their successors. Add glossary terms when their meaning is
resolved; link newly created context documents from `CONTEXT-MAP.md` in the same change.
