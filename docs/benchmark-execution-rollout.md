# Benchmark execution rollout

This is an implementation status record, not a claim that the live fleet meets the new contract.

## Implemented

- Schema 1 experiment plans and attempt receipts; schema 7 Run linkage with historical Run readers.
- Pure `planExperiment`: unchanged logical replicate identities, default capacity one, CPU/RAM/GPU
  limits, phase budgets plus one 15-minute host margin, 180-minute batch ceiling, collection rounds
  of at most 256 batches, and uniform reviewed exclusions. Retries default to zero.
- Pure coverage evaluation and deterministic whole-attempt aggregation. Missing work, bad provenance,
  conflicting attempts, unapproved retries, missing metrics and unknown cleanup block completeness.
- File-boundary verification of normalized and raw digests; atomic, no-overwrite JSON publication.
- Account concurrency groups shared by benchmark/smoke, toolchain validation, and Modal GPU jobs,
  with `queue: max` and no cancellation of running work.
- Required-provider admission in the shared benchmark workflow. A failed Namespace credential setup
  can still reach normalization, but cannot produce a green all-skipped provider job.
- Separate workflow-attempt artifact names, unconditional diagnostic upload, and upload paths limited
  to this run's raw data and shards. Existing attempts are never overwritten.
- Atomic identity-bound detached command receipts in the shared step runner. Launch, polling and
  readback are bounded; execution and cleanup evidence is retained in the raw directory.
- Explicit bounded diagnostic projection with credential redaction and primary/cleanup failure
  preservation. Tama authentication is serialized across driver contexts; a failed post-login list
  retains its vendor diagnostic without triggering another login.
- Native command projections retain their errors until the shared redaction boundary, instead of
  replacing them with a generic callback failure. Regression tests cover both exec and launch.
- A narrow complete-inventory driver capability and Tama ownership projection. Account reconciliation
  validates all variant inventories before deletion, requires observed absence after deletion, and
  checks every inventory again before admission. Unavailable inventory, foreign resources, cancellation,
  timeout, or new allocations block admission. This module is not yet wired into fleet dispatch.
- Strict `promote` requires the original plan and attempt directories and independently reconstructs
  the candidate before writing the dataset. Legacy Runs remain available for validation and reading.
- Publication verifies identity-bound execution and cleanup receipts, including observed absence,
  benchmark and collection completion, and sandbox attribution. Matching byte digests alone do not
  satisfy the gate. Unterminated allocation intents also block publication.
- Aggregation selects only planned eligible measurements. Published Runs carry a comparison cohort
  digest covering workload/environment revisions, passes, resources and eligible metrics; leaderboard
  output displays it. Legacy aggregation refuses to merge completed experiment Runs and discard their
  linkage.
- Launch-settlement timeouts now collect diagnostic tails through the same recovery path as polling
  timeouts. Unreadable output has an unknown cause, not an inferred memory or agent failure.
- Raw exception formatting in the reviewed CLI and collection failure sinks uses diagnostic projection.
  Failed teardown fails suite execution; driver-session execution observes absence after destruction.
  Implicit create retries default to zero. Explicit retries cannot follow an owner timeout or unresolved
  failed-create cleanup.

## Important current limitation

**The existing matrix dispatcher does not yet produce or execute the new experiment manifest. Its
dataset publication therefore fails closed.** Account queues limit overlapping jobs, but the legacy
per-job replicate fleet still requires migration to planned batches. Queueing alone does not enforce
the new sandbox/resource budgets or establish cleanup after runner loss.

Do not enable fleet publication by bypassing the manifest requirement or synthesizing receipts from
green GitHub jobs. A launch receipt, valid XML, and “All tasks passed” are insufficient evidence.

## Remaining rollout work

1. Wire immutable plan creation, account-domain batch dispatch and incremental attempt uploads into
   matrix/smoke and publication workflows. Bind each worker's actual resolved environment and artifact
   to the plan before allocation. Keep batch matrices sequential within each quota domain.
2. Add driver inventory/reconciliation and move remaining managed adapters onto the driver port.
   Cancellation and ambiguous creates must retain ownership until observed removal or confirmed expiry.
   Direct development credentials must stay separate from coordinated publication credentials.
   The initial Tama inventory and reconciliation implementation still needs durable allocation intents,
   cross-job recovery history, and the remaining vendor inventories. An empty scan by itself cannot
   prove that an interrupted create request will not allocate later.
3. Reproduce E2B launch/descendant/filesystem/exec behaviors and Daytona's nested launch failure through
   the shared executor. The new receipt implementation is not yet a verified fix for the six live E2B
   timeouts. Compare isolated and bounded concurrent Microsandbox startup before changing readiness.
4. Restore the Namespace GitHub App association for `starslingdev`; this is external account setup.
5. Reproduce and version workload repairs: OpenClaw shrinkwrap quarantine, descriptor exhaustion and
   resource failures; Mastra HOME/path behavior; fixed two-pass CPU/memory publication; lossless PTS
   fio serialization. Do not remove failing tests, fabricate missing values, or adjust values to evade
   deduplication. Admit revised workloads only after baseline and two different provider environments.
6. Run privileged provider conformance and canaries, then collect a fresh complete experiment. Preserve
   run 34437329093 as diagnostic history.

## Commands

Local verification after the correctness follow-up: 2,047 repository tests pass. Typecheck, Biome, spelling, catalog/registry/wiring
drift checks, ShellCheck, Hadolint, queue-compatible actionlint and the configured offline zizmor gate
pass. Live provider conformance and workload admission have not been run for these changes.

```sh
bun apps/cli/src/bin/plan-experiment.ts request.json plan.json capacity-policy.json
bun apps/cli/src/bin/evaluate-experiment.ts plan.json attempt-directory
bun apps/cli/src/bin/aggregate-experiment.ts plan.json attempts-root candidate-directory
bun apps/cli/src/bin/promote.ts candidate-directory/runs/experiment-id.json data/dataset plan.json attempts-root
```

The planner accepts explicit versioned requests. It does not infer credential ownership or turn
arbitrary legacy artifacts into completion evidence. An attempt directory contains `attempt.json`,
its optional `run.json`, and its original `raw/` tree. All failed attempts in a retry lineage must be
present. Inspection does not allocate resources or contact providers.

## Workflow linter compatibility

GitHub documents `queue: max`, but actionlint 1.7.12 and upstream revision
`011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7` do not parse that property. `bun run lint:workflows`
first validates every queue configuration, then suppresses only actionlint's exact unsupported-queue
diagnostic. Tests reject invalid values and cancellation and check shared account group identity.
All other actionlint rules remain enabled. Replace this compatibility path with a mise-pinned upstream
release when it supports queues; do not broadly ignore workflow syntax errors.
