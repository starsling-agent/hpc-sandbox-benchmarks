# DriverKit live validation — 2026-09-08

All four migrated providers passed every check using the final driver sources. These are local,
authenticated live checks, not privileged CI matrix-admission reports or benchmark measurements.
The manifest fingerprints the tested source tree, including changes after its recorded base commit.
Each provider JSON records timestamps, allocation identity, resolved artifact, and clause outcomes.

| Provider | Durable workload | Passed checks | Post-teardown observation |
| --- | --- | --- | --- |
| e2b | 65 s | 12 | observed absent |
| modal-gvisor | 10 s | 12 | observed terminal |
| modal-vm | 10 s | 12 | observed terminal |
| tama | 65 s | 12 | observed absent |

Each run covered resolution, creation, readiness, successful and nonzero command exits, separated
stdout/stderr, file round-trip, synchronous and durable StepRunner workloads, teardown, repeated
teardown, and independent control-plane convergence. All test allocations were torn down.
Modal's waited termination was confirmed by a terminal control-plane observation; E2B and Tama
were confirmed absent.

E2B and Tama workloads exceeded their 60-second sync caps. Modal workloads used the actual durable
route selected by a timeout at its 30-minute cap, but ran for 10 seconds; this is not a 30-minute
soak test. Native capacity refusals and cleanup failure/ambiguity are exercised deterministically
in regression tests, without deliberately exhausting production account quotas.

## Reproduce

From the repository root with the declared provider credentials and Tama 0.1.17 installed:

```sh
bun apps/cli/src/bin/driver-check.ts --provider e2b --workload-seconds 65 --require-pass --report-file /tmp/e2b.json
bun apps/cli/src/bin/driver-check.ts --provider tama --workload-seconds 65 --require-pass --report-file /tmp/tama.json
bun apps/cli/src/bin/driver-check.ts --provider modal-gvisor --workload-seconds 10 --require-pass --report-file /tmp/modal-gvisor.json
bun apps/cli/src/bin/driver-check.ts --provider modal-vm --workload-seconds 10 --require-pass --report-file /tmp/modal-vm.json
```

`--require-pass` rejects skips and cannot be combined with `--keep`. `--report-file` writes clean
JSON independently of the harness's stdout workload logs. The evidence contains no credentials.

## Verification

The repository test suite passed, as did focused tests for the new native projection and strict
reporting options. Lint, typecheck, spell, catalog drift, registry drift, provider wiring, shell lint,
and Dockerfile lint passed. Tests that bind localhost or sign temporary Git commits ran outside
the restricted execution sandbox.

## Retry policy

E2B and Modal preserve native SDK error classes rather than matching wrapper message constants.
The kit distinguishes HTTP status from process exit status. CLI readiness preserves an explicit
retry verdict, but only confirmed cleanup releases it to the harness. Tama's pinned CLI does not
provide a documented capacity reason code; its known terminal statuses explicitly decline retry.
Diagnostic text does not manufacture a retry decision.
