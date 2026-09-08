# Benchmark execution

This context describes performing benchmark work and recording the evidence used for comparison.

## Language

**Benchmark step**:
A command workload executed as part of benchmark preparation, measurement, or collection, with
its own completion outcome. A step is not necessarily a measured sample.

**Lifecycle measurement**:
A measurement of sandbox creation, first successful command execution, teardown, or an exposed
control-plane operation. Operational readiness alone does not define the measured first success.

**Result gap**:
A recorded absence of a benchmark result, such as a skipped or failed workload. A gap is not a
zero-valued measurement.
