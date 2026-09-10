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

**Execution receipt**:
Evidence binding benchmark step outcomes to a particular sandbox and logical replicate. Launch
acceptance and recognizable output are not successful completion outcomes.

**Cleanup confirmation**:
Observation that the allocated sandbox is absent after teardown. A successful request to destroy it
is only an acknowledgement until removal is observed.
