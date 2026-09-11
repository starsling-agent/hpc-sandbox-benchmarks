---
status: accepted
---

# Inventory admission scope

## Context

Resource ownership and account-wide emptiness are separate admission conditions. Recovery must only
remove resources carrying benchmark ownership markers, regardless of the inventory admission scope.

## Decision

Refine ADR-0010 with two inventory scopes: `account` rejects any unowned resources; `benchmark`
requires benchmark-owned resources to be reconciled while retaining the unowned count for diagnostics.
Use benchmark scope for the `daytona` and `novita` quota domains, including both Daytona variants.
All other domains retain account scope.

CLI composition owns the policy. Drivers continue to report complete inventories and accurate
ownership. The frozen experiment's source revision binds the policy; there is no dispatch flag or
credential-derived override.

Every variant must still supply complete inventory, destroy-by-id and probes. Invalid inventory,
unknown creates, uncertain cleanup and new benchmark-owned allocations block admission under either
scope. Unowned resources are never deleted by reconciliation. Protected journals and benchmark
account queues remain required.

## Consequences

Admission scope does not establish performance isolation or reserve vendor capacity. Capacity limits
bound benchmark allocations; quota failures remain failed attempts. Neither retries nor evidence and
publication requirements change. The account-inventory command displays its scope alongside owned
and unowned counts. Only the durable account owner may use benchmark markers and the journal;
legacy benchmark allocators require separate development accounts until they adopt that owner.
