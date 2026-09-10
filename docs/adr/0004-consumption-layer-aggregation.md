---
status: accepted
---

# Raw-first history, consumption-layer candidate→promote

The publication threshold below is superseded by [ADR-0010](./0010-experiment-completeness.md).
Its raw-first history and candidate→promote decisions remain in force.

## Context

A benchmark run is produced by the CI matrix as one Run document per `(provider, suite)` shard. Those
shards have to become a single comparable Run in the committed dataset. Two failure modes to avoid:
baking parser bugs into frozen committed numbers (a unit fix would never reach old Runs), and
publishing a half-collected run (a shard that produced no real metrics reading as a valid provider
result). GHA artifacts also expire, so the durable evidence can't live only there.

## Decision

**Commit the curated raw tool output as the durable source of truth, and aggregate at the consumption
layer through an explicit candidate→promote pipeline.** `aggregate` (the collect half) merges the
per-shard Run documents into a single **candidate** Run written to a candidate dataset; `promote`
(the publish half) re-validates the candidate against the current schema + Catalog, **gates on at
least one `validated` provider**, and only then writes it into the committed dataset + newest-first
index. Normalization is re-runnable from raw with the current parsers, so a parser fix applies to all
history rather than being frozen at collection time. Every shard is parsed at the boundary on the way
in (ADR-0001), so a malformed artifact fails loudly at aggregation, not mid-merge.

## Consequences

- Parser/Catalog fixes apply retroactively — committed raw is immutable, the canonical Run is
  re-derived, so a bad unit conversion doesn't become permanent history.
- A partial collection with zero validated providers **cannot** be published: the promote gate refuses
  it, so the dataset never shows an empty or unvalidated run.
- The dataset is two-staged (candidate, then promoted): more moving parts than committing one blob,
  bought for the validation gate and the retroactive-fix property. A bad published Run is removed by
  reverting its dataset commit.
- Aggregation is pure over parsed shards and unit-tested without live providers, so the merge logic is
  verifiable from fixtures alone.
