# Mastra workload v2

The default Mastra suite now uses `local/realworld-mastra-v2-1.0.0` for every provider. It keeps source commit `b6eeb9d08ebeaf27bc6fd16b6b88087040aaf767`, build preparation, and the original tool-builder test exclusion. Only core-test concurrency and the Node old-space limit change:

```sh
NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter ./packages/core exec vitest run --exclude '**/tool-builder/**' --maxWorkers=1
```

The 4096-MiB limit applies to each Node process's old-generation heap, not its total memory usage. One Vitest worker leaves memory for the coordinator, typechecking, and other allocations within the existing task memory cap.

Microsandbox diagnostics on a 4-vCPU, 8-GiB sandbox found:

| Configuration | Result |
| --- | --- |
| Original default heap and concurrency | Node heap exhaustion near 2 GiB |
| 4096-MiB old-space limit, three workers | Two OOM kills at the 6.78-GiB task cap |
| 4096-MiB old-space limit, two workers | Two OOM kills at the same cap; exit 1 |
| 4096-MiB old-space limit, one worker | Passed core tests and typechecking |

These diagnostics establish a working configuration on Microsandbox, not an optimal worker count or validation on every provider. Other providers require fresh runs. No successful core-test metric was found in upstream's 26 published datasets or 411 retained Mastra artifacts across 46 runs checked on 2026-09-09; their failure causes were not established by that artifact scan.

V2 uses separate `realworld_mastra_v2_task_*` metric IDs. Historical profiles and metric IDs remain available; no old result is relabeled. Clone, install, lint, and build commands are unchanged, but core-test timings must not be compared with the original workload. Use fresh V2 runs for comparisons across providers.
