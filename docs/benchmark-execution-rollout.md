# Benchmark execution rollout

This is an implementation status record, not a claim that the live fleet meets the new contract.

## Implemented

- Schema 1 experiment plans and attempt receipts; schema 7 Run linkage with historical Run readers.
- Pure `planExperiment`: unchanged logical replicate identities, default capacity one, CPU/RAM/GPU
  limits, phase budgets plus one 15-minute host margin, 180-minute batch ceiling, collection rounds
  of at most 64 batches, and uniform reviewed exclusions. Retries default to zero. A round is the
  approval unit: its batch jobs are created together (the account concurrency queue, not
  `max-parallel`, serialises them), so one `privileged` approval releases a whole round, and 64 keeps
  a released round under the 100 pending jobs a `queue: max` group holds before cancelling overflow.
- Pure coverage evaluation and deterministic whole-attempt aggregation. Missing work, bad provenance,
  conflicting attempts, unapproved retries, missing metrics and unknown cleanup block completeness.
- File-boundary verification of normalized and raw digests; atomic, no-overwrite JSON publication.
- Account concurrency groups shared by benchmark/smoke, toolchain validation, and Modal GPU jobs,
  with `queue: max` and no cancellation of running work. The per-cell group expression is generated
  from each provider's registry `quotaDomain` (`bun run generate-provider-wiring`), the same lookup
  that names the plan's batches and the journal branch.
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
  timeout, or new allocations block admission. It is called once by each account-owned batch before allocation.
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

## Integrated execution

Matrix and smoke now freeze one immutable plan and dispatch account → collection round → batch.
Every allocating worker verifies the plan and source revision, reconciles its account once, and runs
one bounded wave through the existing harness and normalizer. The account and round matrices use
`max-parallel: 1`; independent accounts can proceed together. Fixed suite defaults and replicate
indices are preserved. Convergence is rejected by publication planning until its separately reviewed
measurement revision is admitted; an explicit fixed-pass input is part of the workload identity.

Each attempt uploads independently. The CLI performs those uploads (and the plan's) through
`@actions/artifact`, which needs the run-scoped artifact runtime GitHub injects only into action
steps, so the plan and bench jobs first run `.github/actions/artifact-runtime`; a `run:` step without
it fails at its first upload. Downloads need no runtime. The dataset workflow downloads the original plan and complete
attempt directories, checks durable allocation/release records, and invokes strict aggregate/promote.
Lost terminal uploads leave durable intents that block publication. Workflow reruns reuse the frozen
plan and refuse to measure an already attempted cell again; start a fresh experiment instead of
selecting a favorable rerun. Automatic allocation retries remain disabled.

## Account admission before live rollout

The durable journal uses a separate Git branch per quota domain:
`benchmark-account-journal-<domain>`. It records immutable intent, allocation and release records with
fast-forward-only commits. It is evidence storage, not a lease or an artifact allocation claim;
GitHub account concurrency remains the exclusive scheduling authority. Raw evidence stays in Actions
artifacts. Missing/truncated journals, unresolved creates and unconfirmed removal block allocation.

Each branch starts with `journal.json` containing `{"schemaVersion":"1","account":"<domain>","records":[]}`.
The file is an append-only record sequence; immutable Git commits retain every prior snapshot. Reading
one blob avoids a REST request per historical record on every new batch.

An operator must provision these branches after quiescing existing account writers and confirming a
clean vendor baseline. Protect them against deletion and force pushes, retain their history, and
permit the privileged workflow token to append commits. Do not reset a journal to recover an account.
For an unknown create, obtain the vendor's request outcome and resource identity before recording
recovery; an empty inventory is insufficient. No branch is automatically created or reset by a worker.
The allocating workflow needs `contents: write` for this narrow journal update; checkouts still do not
persist credentials. Accounts without this setup fail admission before allocation.

Managed admission currently requires a migrated driver with complete inventory, observation and
recovery. Tama supplies that capability; other provider migrations remain separate rollout work.
Selected unsupported providers produce failed attempt evidence, never green skips. Toolchain and GPU
jobs share the account queues but still have legacy allocation paths: keep their credentials in
separate development accounts until those paths adopt the same journal owner. Sharing a queue alone
is not a guarantee against an interrupted legacy create. Do not admit a publication account with
uncoordinated legacy writers or direct development credentials.

Publication remains gated on complete evidence and live admission. No provider canary or workload
baseline result has been inferred from offline tests.

## Remaining rollout work

1. Provision protected account journals for the remaining accounts and run each account's integrated
   privileged canary. Done for `tama` on 2026-09-10: branch `benchmark-account-journal-tama` seeded
   with the empty journal (ruleset "Protect benchmark account journals" blocks deletion and
   force-push on `benchmark-account-journal-*`), then smoke run 34537171216 on main (`tama` ×
   `system`, one replicate) wrote intent → allocated → released(absent) as three fast-forward
   commits, uploaded the plan and the attempt from the CLI, confirmed sandbox absence, and its
   downloaded evidence passed collect → evaluate → aggregate → strict promote locally. Artifact
   upload/download and journal permissions are confirmed in the Actions environment.
2. Add complete inventories to remaining provider drivers and migrate legacy allocating paths,
   including GPU and toolchain validation, onto the account owner before sharing publication accounts.
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

Offline integration tests cross the real harness, raw collector, normalizer and completeness evaluator.
They cover account caps, cleanup failure, rerun refusal, missing uploads, interrupted intents, journal
conflicts and matrix partitioning. Live provider conformance and workload admission remain separate.

Final local verification: 2,042 tests pass, with typecheck, Biome, spelling, generated catalog/registry/
wiring checks, ShellCheck, Hadolint, queue-compatible actionlint and configured offline zizmor passing.

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
