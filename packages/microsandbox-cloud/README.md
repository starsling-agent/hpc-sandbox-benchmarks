# @sandbox-benchmarks/microsandbox-cloud

Owns the microsandbox-cloud driver implementation, SDK dependencies, and behavioral tests.
The fleet loader selects this package lazily; shared session mechanics live in
`@sandbox-benchmarks/driver`. SDK versions are pinned in the root catalog.

Run `bun run --filter @sandbox-benchmarks/microsandbox-cloud test` or `typecheck` from the repo root.
