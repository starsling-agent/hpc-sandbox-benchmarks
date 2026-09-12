---
status: accepted
---

# Frozen experiments and evidence-based publication

The inventory admission condition is refined by
[ADR-0011](./0011-inventory-admission-scope.md). All other requirements remain.

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

## Operator recovery of a retained allocation identity

From `1b83cdee0272b3cb7131aa3915c6b69db3921b58` onward the executor persists the identity-bound
`allocated` record to the attempt's raw tree *before* appending it to the journal, so a rejected
append no longer loses the vendor identity. That retained record — not an inventory sweep — makes
the intent resolvable, and recovery is therefore identity-based: it is the ordinary release protocol
replayed by an operator, not a clearance.

Recovery validates the attempt's raw and Run digests, requires a failed attempt with no measurement,
no execution or cleanup receipt and unresolved cleanup, and requires the retained allocation to name
the same attempt, cell and plan digest. The journal must still hold exactly that attempt's intent and
no release. The original workflow must have completed, and repository workflow quiescence is checked
before and after removal.

It then appends the lost `allocated` record, observes removal of that exact sandbox through the
control plane (destroying it when it is still running), and appends the ordinary `released/absent`
receipt. Replaying the allocation first is what makes an interrupted recovery safe: `intent` plus
`allocated` is the ordinary interrupted-allocation state, which admission already recovers on its
own, and a bare `released/absent` without its allocation would contradict the journal's consistency
rule and block admission again. No new evidence kind is recorded, because ownership is released by
observation of a known resource rather than by audited account clearance.

This does not recover identifiers missing from attempts written before that revision — use the
completed-create clearance below for that reviewed historical failure — nor an attempt whose evidence
was never uploaded. It is an explicit operator command, never an automatic admission fallback, and it
does not modify the original attempt evidence or make it eligible for publication.

Run `recover-allocated-intent --exclusive-account <original-attempt-directory>` with provider
credentials, `GITHUB_REPOSITORY` and a journal-write `GH_TOKEN`. Obtain the immutable original attempt
artifact first and stop local account writers.

## Operator recovery of a completed create with a lost journal append

A returned create is distinct from an interrupted vendor request. At revision
`b061d9f201d787e3c87045c1fe2a1db24122691e`, the exact premeasurement
`sandbox-create-failed` marker containing `account journal PATCH HTTP 422; allocation blocked`
can only arise after SDK create returned and the subsequent allocation append failed. The intent
append occurs outside the harness and cannot produce this marker. Later revisions persist the
allocation reference locally before appending it; use ordinary identity-based recovery for those.

For that reviewed historical failure only, an operator may append a `released/reconciled` record
without inventing a sandbox reference. Recovery validates the original attempt's raw and Run digests,
source revision, marker and intent identities, absence of measurement and execution receipts, and
absence of an existing allocation record. The original workflow must have completed. All workflow
and local account writers must be stopped; the command checks repository workflow quiescence before
and after reconciliation. It requires complete account inventory, normal owned-resource destruction
and control-plane confirmation, and a second complete empty inventory sweep. The initial recovery
path supports only single-provider quota domains.

The append preserves the operator, confirmation time, original workflow, source revision and attempt
digest in the protected journal. It records account clearance, not a recovered sandbox identity or a
claim that allocation never happened. It does not modify original attempt evidence or make it eligible
for publication. Unknown or still-in-flight creates continue to block even when inventory is empty.
This exception is an explicit operator command, never an automatic admission fallback.

Run `recover-completed-create --exclusive-account <provider> <suite> <original-attempt-directory>`
with provider credentials, `GITHUB_REPOSITORY`, a journal-write `GH_TOKEN`, and `GITHUB_ACTOR` identifying
the operator. Obtain the immutable original attempt artifact first and stop local account writers.
The flag asserts exclusive operational ownership; it does not acquire a distributed lock. Normal
benchmark queues and complete journal admission remain mandatory after recovery.
