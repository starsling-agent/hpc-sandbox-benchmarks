# Architecture Decision Records

Short records of the load-bearing decisions in this repo — the ones that shape what you can import,
how a measurement becomes a published number, and why the gates are where they are. Each ADR is
**Context / Decision / Consequences**: the problem, the choice, and what we accept by making it.

These describe *why the code is the way it is*; the [methodology](../methodology.md) describes *how a
measurement is produced* and [CONTRIBUTING](../../CONTRIBUTING.md) the local gate. When a decision
here changes, supersede the ADR (leave it in place, note what replaced it) rather than deleting it.

| ADR | Decision |
|-----|----------|
| [0001](./0001-arktype-parse-dont-validate-boundary.md) | arktype parse-don't-validate boundary |
| [0002](./0002-enforced-dependency-dag.md) | Enforced dependency DAG with a uniform package shape |
| [0003](./0003-generated-pts-catalog-and-drift-gate.md) | Generated PTS catalog behind a drift gate |
| [0004](./0004-consumption-layer-aggregation.md) | Raw-first history, consumption-layer candidate→promote |
| [0005](./0005-host-vs-effective-spec-split.md) | Host-vs-effective spec split |
| [0006](./0006-declarative-provider-onboarding.md) | Declarative provider onboarding |
| [0007](./0007-sandbox-driver-port.md) | Sandbox driver kit: one port, one file per provider; ComputeSDK as one driver |
| [0008](./0008-driver-conformance-gate.md) | Driver conformance: the behavioral drift gate |
| [0009](./0009-harness-operations-and-gpu-allocation.md) | Separate harness operations and typed provider-specific GPU allocation |
| [0010](./0010-experiment-completeness.md) | Frozen experiments, immutable attempts and strict completeness |
