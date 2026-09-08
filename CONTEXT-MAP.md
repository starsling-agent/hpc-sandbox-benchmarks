# Context map

## Contexts

- [Sandbox drivers](./packages/driver/CONTEXT.md): sandbox sessions and their observable behavior.
- [Benchmark execution](./packages/harness/CONTEXT.md): benchmark steps, lifecycle measurements,
  and result gaps.

Add other package glossaries as their terminology is resolved. Package responsibilities and
reading routes are recorded in [domain documentation](./docs/agents/domain.md).

## Relationships

- Benchmark execution uses sandbox sessions to perform work and observe outcomes.
- Driver capabilities describe what an integration exposes; benchmark execution records a gap
  when a requested measurement cannot be performed.
- Driver readiness establishes usability; lifecycle measurement separately observes the first
  successful command according to the benchmark's measurement definition.
