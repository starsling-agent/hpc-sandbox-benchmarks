---
status: accepted
---

# Frozen experiments and evidence-based publication

## Decision

An experiment plan owns the expected provider, suite, replicate, metric, revision, artifact, resource,
pass-policy and exclusion set. Account capacity and phase budgets determine bounded batches without
reducing the replicate count. Unknown sandbox capacity defaults to one; GPU allocation requires an
explicit GPU capacity. Provider variants using the same credentials share one quota domain.

Plans and execution attempts have separate identities. Plan digests bind attempts to the original
request. Raw-tree and Run digests bind a terminal receipt to its original observations. Interrupted
launch intents cannot serve as terminal receipts. Whole-attempt selection is deterministic; conflicting
duplicates, measured reruns, unresolved cleanup, unknown command completion and missing eligible metrics
prevent publication. Premeasurement retries require an explicit finite allowance in the original plan.

This supersedes **only the “at least one validated provider” publication rule** in ADR-0004. Raw-first
history, re-normalization, and candidate→promote remain. Historical `validationStatus` keeps its meaning;
experiment completeness is a separate evaluation. Run schema 7 links a complete experiment to its plan
and selected attempts. Older Runs remain readable, with unverified experiment completeness.

CLI composition owns planning, coordination and publication. Drivers own vendor inventory, allocation,
authentication and recovery semantics. The harness owns command execution, completion observation and
collection, preserving ADR-0007. GitHub account queues provide job exclusion; they do not establish
cleanup or replace vendor reconciliation. No artifact is an allocation lock.

Exclusions are revision-specific, metric-scoped, owned, linked to a tracking issue and time-limited.
Their eligibility set must be uniform across a comparison cohort. Aggregation excludes quarantined
metrics from scores while retaining the original attempt evidence. A new plan cannot retroactively
change an old experiment's denominator.

## Rollout

See [implementation and rollout status](../benchmark-execution-rollout.md). The pure contracts are not
proof of live provider conformance. Strict publication rejects legacy candidates without a manifest;
production dispatch must be migrated to emit and execute the manifest before publication can resume.
