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
production dispatch now emits and executes manifests, with live publication requiring account admission
and complete verified attempts.

## Durable account journal integration

Account queues alone cannot detect an interrupted create that has not yet appeared in inventory.
Before create, CLI composition appends an intent to a protected, account-specific GitHub journal
branch. After create returns it appends the sandbox reference; release requires the control plane
to observe the sandbox as no longer running (absent, or terminal for vendors that retain terminated
records), never a destroy response alone.
Unknown creates block admission. Updates are fast-forward only and existing records cannot be
replaced. Independent accounts use different branches; concurrent cells serialize journal appends.

This is an evidence log using GitHub's existing Git storage, not a distributed quota or lease service.
Actions artifacts remain immutable attempt archives, but cannot serve as the only ownership journal:
expiry or deletion could erase an unresolved intent. The operational cost is protected journal branch
provisioning and narrowly scoped write permission on the privileged worker. A missing branch fails
closed; it never authorizes an empty account. Legacy allocating paths must use separate accounts until
they adopt the owner. Account-wide capacity is guaranteed only after that admission condition holds.

See [GitHub's reference API](https://docs.github.com/en/rest/git/refs) for fast-forward ref updates and
[tree API](https://docs.github.com/en/rest/git/trees) for complete tree enumeration. Truncated histories
and competing ref updates fail admission rather than discarding ownership facts.
