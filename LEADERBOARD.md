# Sandbox provider leaderboard

Run [`33804295335`](https://github.com/starslingdev/hpc-sandbox-benchmarks/actions/runs/33804295335) · commit [`4ab39ba645fd5ca535074d3fdd6b4eef786198cf`](https://github.com/starslingdev/hpc-sandbox-benchmarks/commit/4ab39ba645fd5ca535074d3fdd6b4eef786198cf) ·
dataset [`data/dataset/runs/33804295335.json`](data/dataset/runs/33804295335.json) · generated 2026-09-03T21:35:15.563Z

Requested target for every provider: **4 vCPU · 8 GiB RAM · 40 GB disk**. This run contains **527 metric records**
backed by **5065 retained trial observations**, across **46 metrics** and
**12 providers**; every emitted, catalogued metric has a ranked table below
(median across sandboxes), grouped by dimension with its headline first — some behind a disclosure triangle, none omitted.
Generated from the published Run dataset — do not edit by hand. Methodology:
[`docs/methodology.md`](docs/methodology.md).

**How to read:** value = median across sandboxes (one machine, one vote) · interval = cluster bootstrap,
labelled 95% but ≈77% actual coverage at 3 sandboxes (see methodology) · rows share a rank only
when statistically indistinguishable or tied on the median (see details below) · a coverage gap means unmeasured, never a score of zero.
CPU/RAM comparability uses observed vCPU and RAM (±10% RAM); disk is a workload-capacity gate
surfaced through coverage gaps, not part of the compute-match verdict.

**Document order:** the real-world developer workflows lead, because what a developer or a CI job
actually waits on is what this benchmark exists to measure. The synthetic microbenchmarks (`cpu`, `disk`, `memory`, `network`, `system`)
load one hardware axis in isolation — a real question, but a different one — so each is collapsed by
default; expand a section to read its tables.

**The `realworld` section is drawn, not tabulated.** One stacked chart per repo, each bar a
whole pipeline on one environment and each segment a task. Its per-task rankings — the medians,
intervals and trial counts every bar is built from — are still here, one triangle down: the charts
are what the section is FOR, and the tables are how you check them.

## Providers in this run

Each provider's isolation technology — the **declared** technology is authoritative; **detected**
is a best-effort in-sandbox probe that cannot separate every isolation type (a container and a
microVM can both read `kvm`; gVisor and a microVM can both read `unknown`), shown only as a
cross-check.

| Provider | Isolation (declared) | Detected |
| --- | --- | --- |
| Blaxel | microVM | vm |
| Daytona (VM) | microVM (Linux VM) | vm |
| E2B | Firecracker microVM | vm |
| Microsandbox Cloud | libkrun microVM (cloud) | vm |
| Modal (gVisor) | gVisor container | gvisor |
| Modal (VM) | microVM (VM runtime) | vm |
| Namespace | microVM (dedicated instance) | vm |
| Novita | microVM | vm |
| run.cloud | Firecracker microVM | vm |
| Runloop | microVM | vm |
| tama | container (shared kernel) | unknown |
| Vercel Sandbox | Firecracker microVM | vm |

_Not present in this run: Daytona (container), microsandbox-local — registered providers that reported no data (not dispatched, or every cell was lost before reporting anything)._

> **Comparability warning:** tama's observed compute did not match the requested CPU/RAM target; its observed allocation was **64 vCPU · 1512 GiB RAM · 48.9 GB disk**. Its measured ranks are not like-for-like with compute-matched providers.

## realworld

What a developer or a CI job actually waits on: each bar is one environment's whole pipeline
for that repo, segmented by task in execution order. The charts share one time scale, so a second is the same length in all of them.

<img src="docs/figures/realworld-better-auth.webp" width="960" alt="Better-Auth: 10 pipeline tasks across 12 environments, stacked by task and sorted fastest-first">

<img src="docs/figures/realworld-mastra.webp" width="960" alt="Mastra: 4 pipeline tasks across 12 environments, stacked by task and sorted fastest-first">

<img src="docs/figures/realworld-openclaw.webp" width="960" alt="OpenClaw: 5 pipeline tasks across 10 environments, 2 disclosed as incomplete, stacked by task and sorted fastest-first">

<details>
<summary><strong>Per-task rankings</strong> · 19 tasks, with medians, intervals and trial counts</summary>

### Mastra: cold install _(headline)_

Seconds · lower is better

_Blaxel, Daytona (VM), run.cloud and Novita share the top on this metric (lower is better)._

| Rank | Provider | Mastra: cold install (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Blaxel | 38.31 | 37.34 – 47.12 | 12 | 12 | — |
| 1 | Daytona (VM) | 38.53 | 38.08 – 40.42 | 12 | 12 | tied |
| 1 | run.cloud | 41.02 | 38.31 – 48.7 | 10 | 10 | tied |
| 1 | Novita | 42.54 | 41.69 – 43.34 | 12 | 12 | tied |
| 5 | Namespace | 47.13 | 46.79 – 69.88 | 12 | 12 | — |
| 5 | Modal (VM) | 52.86 | 51.37 – 55.87 | 12 | 12 | tied |
| 5 | Microsandbox Cloud | 55.73 | 50.24 – 60.33 | 4 | 4 | tied |
| 5 | Vercel Sandbox | 56.64 | 55.7 – 60.09 | 12 | 12 | tied |
| 5 | tama | 57.54 | 54.5 – 100.7 | 3 | 3 | tied |
| 5 | Modal (gVisor) | 58.12 | 56.57 – 65.4 | 12 | 12 | tied |
| 11 | E2B | 69.36 | 64.85 – 71.41 | 12 | 12 | — |
| 12 | Runloop | 160.3 | 159.2 – 161.9 | 12 | 12 | — |

### Better-Auth: build

Seconds · lower is better

_Daytona (VM) leads · Blaxel is ~1.2× higher (lower is better)._

| Rank | Provider | Better-Auth: build (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 52.47 | 51.46 – 53.31 | 12 | 12 | — |
| 2 | Blaxel | 61.14 | 60.19 – 71.06 | 12 | 12 | — |
| 2 | run.cloud | 63.22 | 56.55 – 100.6 | 11 | 11 | tied |
| 2 | Novita | 66.63 | 64.46 – 68.29 | 12 | 12 | tied |
| 5 | Modal (VM) | 74.47 | 70.44 – 79.61 | 12 | 12 | — |
| 5 | Namespace | 78.79 | 71.06 – 116.4 | 12 | 12 | tied |
| 5 | Microsandbox Cloud | 88.36 | 74.91 – 98.67 | 12 | 12 | tied |
| 5 | Modal (gVisor) | 89.77 | 82.59 – 97.34 | 12 | 12 | tied |
| 5 | Vercel Sandbox | 92.87 | 90.96 – 94.26 | 12 | 12 | tied |
| 5 | E2B | 94.45 | 83.44 – 101.3 | 12 | 12 | tied |
| 5 | tama | 95.31 | 72.79 – 99.47 | 4 | 4 | tied |
| 12 | Runloop | 224.1 | 223.3 – 228.4 | 12 | 12 | — |

### Better-Auth: cold install

Seconds · lower is better

_Daytona (VM) leads · Blaxel is ~1.1× higher (lower is better)._

| Rank | Provider | Better-Auth: cold install (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 11.06 | 10.91 – 11.45 | 12 | 12 | — |
| 2 | Blaxel | 12.39 | 12.11 – 15.23 | 12 | 12 | — |
| 2 | Novita | 13.41 | 13.11 – 13.82 | 12 | 12 | tied |
| 2 | run.cloud | 14.61 | 12.48 – 20.76 | 11 | 11 | tied |
| 2 | Namespace | 15.12 | 12.77 – 16.31 | 12 | 12 | tied |
| 2 | Microsandbox Cloud | 15.97 | 14.95 – 17.25 | 12 | 12 | tied |
| 7 | Modal (VM) | 19.21 | 18.66 – 19.68 | 12 | 12 | — |
| 7 | E2B | 19.5 | 17.76 – 20.09 | 12 | 12 | tied |
| 7 | Vercel Sandbox | 20.53 | 19.88 – 21.22 | 12 | 12 | tied |
| 10 | Modal (gVisor) | 22.25 | 21.99 – 22.89 | 12 | 12 | — |
| 10 | tama | 29.9 | 16.55 – 32.66 | 4 | 4 | tied |
| 12 | Runloop | 38.72 | 38.21 – 40.84 | 12 | 12 | — |

### Better-Auth: git clone

Seconds · lower is better

_Namespace and Blaxel share the top on this metric (lower is better)._

| Rank | Provider | Better-Auth: git clone (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Namespace | 0.7575 | 0.709 – 0.9025 | 12 | 12 | — |
| 1 | Blaxel | 0.85 | 0.8015 – 0.9055 | 12 | 12 | tied |
| 3 | Vercel Sandbox | 0.992 | 0.952 – 1.011 | 12 | 12 | — |
| 3 | Modal (VM) | 1.089 | 0.8375 – 1.141 | 12 | 12 | tied |
| 5 | Modal (gVisor) | 1.177 | 1.14 – 1.298 | 12 | 12 | — |
| 5 | Daytona (VM) | 1.377 | 1.171 – 1.534 | 12 | 12 | tied |
| 5 | Microsandbox Cloud | 1.468 | 1.449 – 1.49 | 12 | 12 | tied |
| 8 | E2B | 1.567 | 1.549 – 2.33 | 12 | 12 | — |
| 9 | Novita | 2.001 | 1.703 – 2.203 | 12 | 12 | — |
| 9 | tama | 2.103 | 1.033 – 2.385 | 4 | 4 | tied |
| 9 | run.cloud | 2.212 | 2.05 – 2.449 | 11 | 11 | tied |
| 9 | Runloop | 2.755 | 2.144 – 3.592 | 12 | 12 | tied |

### Better-Auth: lint (Biome)

Seconds · lower is better

_Daytona (VM) leads · run.cloud is ~1.1× higher (lower is better)._

| Rank | Provider | Better-Auth: lint (Biome) (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 2.792 | 2.743 – 2.825 | 12 | 12 | — |
| 2 | run.cloud | 3.15 | 3.021 – 5.013 | 11 | 11 | — |
| 2 | Novita | 3.194 | 3.136 – 3.228 | 12 | 12 | tied |
| 4 | Blaxel | 3.375 | 3.269 – 3.49 | 12 | 12 | — |
| 4 | Namespace | 3.553 | 3.229 – 4.277 | 12 | 12 | tied |
| 4 | Microsandbox Cloud | 3.803 | 3.741 – 4.225 | 12 | 12 | tied |
| 4 | Modal (VM) | 3.936 | 3.857 – 4.109 | 12 | 12 | tied |
| 8 | Vercel Sandbox | 4.316 | 4.175 – 4.45 | 12 | 12 | — |
| 9 | E2B | 4.758 | 4.371 – 4.998 | 12 | 12 | — |
| 9 | tama | 6.402 | 4.385 – 6.895 | 4 | 4 | tied |
| 11 | Modal (gVisor) | 7.984 | 7.275 – 8.47 | 12 | 12 | — |
| 12 | Runloop | 9.049 | 8.569 – 9.381 | 12 | 12 | — |

### Better-Auth: lint deps (Knip)

Seconds · lower is better

_Daytona (VM) leads · Blaxel is ~1.1× higher (lower is better)._

| Rank | Provider | Better-Auth: lint deps (Knip) (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 9.294 | 9.149 – 10 | 12 | 12 | — |
| 2 | Blaxel | 10.66 | 10.34 – 10.95 | 12 | 12 | — |
| 2 | run.cloud | 10.83 | 9.804 – 20.15 | 11 | 11 | tied |
| 2 | Novita | 11.24 | 10.99 – 11.42 | 12 | 12 | tied |
| 2 | Namespace | 11.71 | 10.71 – 14.48 | 12 | 12 | tied |
| 2 | Microsandbox Cloud | 12.73 | 11.82 – 13.59 | 12 | 12 | tied |
| 2 | Modal (VM) | 13.32 | 13.01 – 13.57 | 12 | 12 | tied |
| 8 | Vercel Sandbox | 14.89 | 14.48 – 15.27 | 12 | 12 | — |
| 9 | tama | 15.85 | 15.42 – 16.51 | 4 | 4 | — |
| 10 | Modal (gVisor) | 17.21 | 16.6 – 17.91 | 12 | 12 | — |
| 10 | E2B | 18.07 | 14.91 – 19.49 | 12 | 12 | tied |
| 12 | Runloop | 31.62 | 30.63 – 32.23 | 12 | 12 | — |

### Better-Auth: lint format

Seconds · lower is better

_Daytona (VM) leads · Namespace is ~1.1× higher (lower is better)._

| Rank | Provider | Better-Auth: lint format (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 2.611 | 2.497 – 2.657 | 12 | 12 | — |
| 2 | Namespace | 2.792 | 2.692 – 4.5 | 12 | 12 | — |
| 2 | run.cloud | 2.956 | 2.73 – 5.539 | 11 | 11 | tied |
| 2 | Novita | 3.074 | 2.833 – 3.279 | 12 | 12 | tied |
| 2 | Blaxel | 3.145 | 3.043 – 3.219 | 12 | 12 | tied |
| 2 | Microsandbox Cloud | 3.441 | 3.139 – 3.673 | 12 | 12 | tied |
| 2 | Modal (VM) | 3.619 | 3.457 – 3.72 | 12 | 12 | tied |
| 8 | tama | 4.338 | 3.665 – 5.821 | 4 | 4 | — |
| 8 | Modal (gVisor) | 4.347 | 4.117 – 4.486 | 12 | 12 | tied |
| 8 | Vercel Sandbox | 4.37 | 4.293 – 4.422 | 12 | 12 | tied |
| 8 | E2B | 4.884 | 3.915 – 5.189 | 12 | 12 | tied |
| 12 | Runloop | 8.558 | 8.205 – 8.993 | 12 | 12 | — |

### Better-Auth: lint packages

Seconds · lower is better

_Daytona (VM) leads · run.cloud is ~1.1× higher (lower is better)._

| Rank | Provider | Better-Auth: lint packages (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 2.36 | 2.309 – 2.411 | 12 | 12 | — |
| 2 | run.cloud | 2.553 | 2.471 – 4.108 | 11 | 11 | — |
| 2 | tama | 2.566 | 2.415 – 3.78 | 4 | 4 | tied |
| 2 | Blaxel | 2.643 | 2.564 – 2.784 | 12 | 12 | tied |
| 2 | Namespace | 2.7 | 2.615 – 4.043 | 12 | 12 | tied |
| 2 | Novita | 2.705 | 2.599 – 2.882 | 12 | 12 | tied |
| 7 | Microsandbox Cloud | 3.128 | 2.96 – 3.231 | 12 | 12 | — |
| 7 | Modal (VM) | 3.215 | 3.159 – 3.425 | 12 | 12 | tied |
| 9 | Vercel Sandbox | 3.733 | 3.688 – 3.795 | 12 | 12 | — |
| 10 | E2B | 4.163 | 3.929 – 4.457 | 12 | 12 | — |
| 11 | Modal (gVisor) | 5.643 | 5.021 – 5.929 | 12 | 12 | — |
| 12 | Runloop | 8.24 | 7.718 – 8.841 | 12 | 12 | — |

### Better-Auth: lint spell

Seconds · lower is better

_Daytona (VM) leads · Blaxel is ~1.2× higher (lower is better)._

| Rank | Provider | Better-Auth: lint spell (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 6.132 | 6.066 – 6.571 | 12 | 12 | — |
| 2 | Blaxel | 7.294 | 7.067 – 7.453 | 12 | 12 | — |
| 3 | Novita | 7.617 | 7.456 – 7.886 | 12 | 12 | — |
| 3 | run.cloud | 7.864 | 6.746 – 12.98 | 11 | 11 | tied |
| 3 | Namespace | 8.308 | 7.588 – 12 | 12 | 12 | tied |
| 3 | Modal (VM) | 9.057 | 8.77 – 9.774 | 12 | 12 | tied |
| 3 | Microsandbox Cloud | 9.254 | 8.946 – 10.24 | 12 | 12 | tied |
| 8 | Modal (gVisor) | 10.78 | 9.966 – 11.13 | 12 | 12 | — |
| 8 | Vercel Sandbox | 11.12 | 10.88 – 11.47 | 12 | 12 | tied |
| 8 | tama | 11.45 | 10.56 – 12.1 | 4 | 4 | tied |
| 8 | E2B | 12.52 | 10.94 – 13.56 | 12 | 12 | tied |
| 12 | Runloop | 22.6 | 22.05 – 23.56 | 12 | 12 | — |

### Better-Auth: lint types

Seconds · lower is better

_Daytona (VM) leads · Blaxel is ~1.2× higher (lower is better)._

| Rank | Provider | Better-Auth: lint types (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 23.31 | 22.89 – 24.88 | 12 | 12 | — |
| 2 | Blaxel | 27.89 | 27.28 – 30.35 | 12 | 12 | — |
| 3 | Novita | 30.53 | 29.81 – 32.77 | 12 | 12 | — |
| 4 | run.cloud | 33.44 | 32.03 – 44.05 | 11 | 11 | — |
| 4 | Modal (VM) | 35.57 | 34.02 – 39.78 | 12 | 12 | tied |
| 4 | tama | 38.11 | 34.47 – 41.13 | 4 | 4 | tied |
| 4 | Namespace | 38.22 | 34.96 – 59.02 | 12 | 12 | tied |
| 4 | Microsandbox Cloud | 43.31 | 36.44 – 54.01 | 12 | 12 | tied |
| 4 | Vercel Sandbox | 44.73 | 43.8 – 45.72 | 12 | 12 | tied |
| 4 | E2B | 49.61 | 43.9 – 53.97 | 12 | 12 | tied |
| 11 | Modal (gVisor) | 55.07 | 51.04 – 74.22 | 12 | 12 | — |
| 12 | Runloop | 121.8 | 119.5 – 123.9 | 12 | 12 | — |

### Better-Auth: typecheck

Seconds · lower is better

_Daytona (VM) leads · run.cloud is ~1.1× higher (lower is better)._

| Rank | Provider | Better-Auth: typecheck (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 38.36 | 36.87 – 39.23 | 12 | 12 | — |
| 2 | run.cloud | 42.47 | 40.41 – 75 | 11 | 11 | — |
| 2 | Novita | 43.52 | 41.69 – 44.58 | 12 | 12 | tied |
| 2 | Blaxel | 43.59 | 42.5 – 50.24 | 12 | 12 | tied |
| 5 | tama | 51.94 | 50.07 – 54.95 | 4 | 4 | — |
| 5 | Namespace | 52.47 | 47.51 – 80.44 | 12 | 12 | tied |
| 5 | Modal (VM) | 52.92 | 50.06 – 56.31 | 12 | 12 | tied |
| 5 | Microsandbox Cloud | 54.35 | 49.77 – 59.5 | 12 | 12 | tied |
| 5 | Modal (gVisor) | 55.33 | 51.6 – 61.17 | 12 | 12 | tied |
| 10 | Vercel Sandbox | 67.72 | 66.36 – 71.73 | 12 | 12 | — |
| 10 | E2B | 71.87 | 59.99 – 75.96 | 12 | 12 | tied |
| 12 | Runloop | 153.6 | 151.1 – 155.6 | 12 | 12 | — |

### Mastra: build:core

Seconds · lower is better

_Daytona (VM) leads · run.cloud is ~1.1× higher (lower is better)._

| Rank | Provider | Mastra: build:core (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 66.94 | 65.11 – 71.08 | 12 | 12 | — |
| 2 | run.cloud | 73.08 | 70.47 – 74.91 | 10 | 10 | — |
| 2 | Blaxel | 74.34 | 72.52 – 80.97 | 12 | 12 | tied |
| 2 | Novita | 77.81 | 73.53 – 78.72 | 12 | 12 | tied |
| 5 | Namespace | 88.66 | 87.12 – 135.8 | 12 | 12 | — |
| 5 | tama | 93.11 | 89.02 – 101.4 | 3 | 3 | tied |
| 5 | Modal (VM) | 94.26 | 92.1 – 110.4 | 12 | 12 | tied |
| 5 | Microsandbox Cloud | 108.3 | 92.71 – 134.1 | 4 | 4 | tied |
| 5 | Modal (gVisor) | 109.2 | 105.8 – 120.9 | 12 | 12 | tied |
| 5 | Vercel Sandbox | 112.4 | 111.2 – 114.6 | 12 | 12 | tied |
| 11 | E2B | 127.4 | 124 – 131.1 | 12 | 12 | — |
| 12 | Runloop | 248.3 | 245 – 250.3 | 12 | 12 | — |

### Mastra: git clone

Seconds · lower is better

_Blaxel leads · Namespace is ~1.1× higher (lower is better)._

| Rank | Provider | Mastra: git clone (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Blaxel | 1.695 | 1.68 – 1.798 | 12 | 12 | — |
| 2 | Namespace | 1.832 | 1.774 – 2.152 | 12 | 12 | — |
| 3 | Daytona (VM) | 2.385 | 2.189 – 3.756 | 12 | 12 | — |
| 3 | Modal (VM) | 2.405 | 2.163 – 2.562 | 12 | 12 | tied |
| 3 | Vercel Sandbox | 2.415 | 2.395 – 2.639 | 12 | 12 | tied |
| 6 | Microsandbox Cloud | 2.891 | 2.683 – 3.434 | 4 | 4 | — |
| 6 | run.cloud | 2.972 | 2.921 – 3.111 | 10 | 10 | tied |
| 6 | Novita | 3.19 | 2.726 – 3.8 | 12 | 12 | tied |
| 6 | Modal (gVisor) | 3.303 | 3.07 – 3.585 | 12 | 12 | tied |
| 6 | E2B | 3.489 | 3.376 – 4.058 | 12 | 12 | tied |
| 6 | tama | 3.895 | 3.844 – 9.882 | 3 | 3 | tied |
| 6 | Runloop | 6.382 | 5.945 – 7.572 | 12 | 12 | tied |

### Mastra: lint:format

Seconds · lower is better

_Daytona (VM) and run.cloud share the top on this metric (lower is better)._

| Rank | Provider | Mastra: lint:format (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 83.58 | 82.53 – 88.81 | 12 | 12 | — |
| 1 | run.cloud | 86.96 | 83.65 – 89.03 | 10 | 10 | tied |
| 3 | Blaxel | 89.63 | 87.65 – 113.3 | 12 | 12 | — |
| 3 | Namespace | 95.83 | 94.51 – 170.8 | 12 | 12 | tied |
| 3 | Novita | 96.07 | 92.6 – 99.17 | 12 | 12 | tied |
| 6 | Modal (VM) | 115.8 | 112.2 – 140.4 | 12 | 12 | — |
| 6 | tama | 118.3 | 116.3 – 129 | 3 | 3 | tied |
| 8 | Microsandbox Cloud | 129.1 | 128.7 – 148.1 | 4 | 4 | too few sandboxes |
| 8 | Modal (gVisor) | 133 | 125.9 – 143.7 | 12 | 12 | tied |
| 8 | Vercel Sandbox | 140.6 | 137.4 – 142 | 12 | 12 | tied |
| 11 | E2B | 163.4 | 154.2 – 165.3 | 12 | 12 | — |
| 12 | Runloop | 309.5 | 305.9 – 311.9 | 12 | 12 | — |

### OpenClaw: cold install

Seconds · lower is better

_Blaxel and Daytona (VM) share the top on this metric (lower is better)._

| Rank | Provider | OpenClaw: cold install (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Blaxel | 11.88 | 11.6 – 13.4 | 12 | 12 | — |
| 1 | Daytona (VM) | 11.9 | 11.61 – 12.41 | 12 | 12 | tied |
| 3 | Namespace | 13.95 | 12.52 – 14.16 | 12 | 12 | — |
| 4 | Novita | 14.39 | 13.84 – 15.14 | 12 | 12 | — |
| 4 | run.cloud | 15.19 | 13.33 – 19.14 | 11 | 11 | tied |
| 4 | Microsandbox Cloud | 17.26 | 16.38 – 17.97 | 12 | 12 | tied |
| 7 | Vercel Sandbox | 18.29 | 17.43 – 19.33 | 12 | 12 | — |
| 7 | Modal (VM) | 18.85 | 18.35 – 19.64 | 12 | 12 | tied |
| 9 | E2B | 20.37 | 19.55 – 21.81 | 12 | 12 | — |
| 9 | Modal (gVisor) | 20.49 | 19.05 – 20.77 | 12 | 12 | tied |
| 11 | Runloop | 37.76 | 28.39 – 39.07 | 12 | 12 | — |

### OpenClaw: git clone

Seconds · lower is better

_Blaxel leads · Namespace is ~1.1× higher (lower is better)._

| Rank | Provider | OpenClaw: git clone (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Blaxel | 2.572 | 2.45 – 2.761 | 12 | 12 | — |
| 2 | Namespace | 2.882 | 2.828 – 3.031 | 12 | 12 | — |
| 2 | Daytona (VM) | 3.025 | 2.826 – 4.121 | 12 | 12 | tied |
| 2 | Microsandbox Cloud | 3.513 | 3.478 – 3.638 | 12 | 12 | tied |
| 5 | Vercel Sandbox | 3.759 | 3.71 – 3.948 | 12 | 12 | — |
| 6 | E2B | 4.704 | 4.623 – 5.318 | 12 | 12 | — |
| 6 | run.cloud | 4.738 | 3.814 – 10.35 | 11 | 11 | tied |
| 6 | Modal (gVisor) | 5.301 | 5.181 – 5.625 | 12 | 12 | tied |
| 9 | Runloop | 7.689 | 6.712 – 9.375 | 12 | 12 | — |
| 9 | Modal (VM) | 8.338 | 4.611 – 9.272 | 12 | 12 | tied |
| 9 | Novita | 10.62 | 6.23 – 11.69 | 12 | 12 | tied |

### OpenClaw: lint (extension channels)

Seconds · lower is better

_Daytona (VM) leads · run.cloud is ~1.1× higher (lower is better)._

| Rank | Provider | OpenClaw: lint (extension channels) (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 55.82 | 55.15 – 56.61 | 12 | 12 | — |
| 2 | run.cloud | 62.96 | 61.87 – 71.17 | 11 | 11 | — |
| 2 | Blaxel | 65.14 | 61.04 – 69.25 | 12 | 12 | tied |
| 2 | Novita | 67.72 | 66.57 – 68.59 | 12 | 12 | tied |
| 5 | Microsandbox Cloud | 76.99 | 75.16 – 83.77 | 12 | 12 | — |
| 5 | Modal (VM) | 79.9 | 75.58 – 82.25 | 12 | 12 | tied |
| 5 | Namespace | 81.6 | 74.51 – 98.36 | 12 | 12 | tied |
| 8 | Vercel Sandbox | 99.76 | 95.31 – 102.1 | 12 | 12 | — |
| 9 | E2B | 107.4 | 99.53 – 112.5 | 12 | 12 | — |
| 9 | Modal (gVisor) | 108.9 | 98.55 – 115.7 | 12 | 12 | tied |
| 11 | Runloop | 234.5 | 166.6 – 238.1 | 12 | 12 | — |

### OpenClaw: typecheck (test tree)

Seconds · lower is better

_Daytona (VM) leads · run.cloud is ~1.2× higher (lower is better)._

| Rank | Provider | OpenClaw: typecheck (test tree) (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 92.41 | 91.03 – 94.19 | 12 | 12 | — |
| 2 | run.cloud | 110.6 | 105.5 – 112.7 | 11 | 11 | — |
| 2 | Novita | 115.8 | 110.9 – 117.4 | 12 | 12 | tied |
| 4 | Microsandbox Cloud | 126.4 | 122.6 – 130.2 | 12 | 12 | — |
| 4 | Modal (VM) | 126.7 | 120.9 – 131.8 | 12 | 12 | tied |
| 4 | Namespace | 126.8 | 122.5 – 150.2 | 12 | 12 | tied |
| 7 | Vercel Sandbox | 153.9 | 150.7 – 154.9 | 12 | 12 | — |
| 8 | Modal (gVisor) | 175.7 | 158.4 – 204.6 | 12 | 12 | — |
| 8 | E2B | 186.8 | 167.6 – 189.8 | 12 | 12 | tied |
| 10 | Runloop | 257.3 | 246.9 – 264.8 | 12 | 12 | — |

### OpenClaw: typecheck (tsgo)

Seconds · lower is better

_Daytona (VM) leads · Blaxel is ~1.1× higher (lower is better)._

| Rank | Provider | OpenClaw: typecheck (tsgo) (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 15.71 | 15.57 – 16.15 | 12 | 12 | — |
| 2 | Blaxel | 17.13 | 16.77 – 18.33 | 12 | 12 | — |
| 2 | run.cloud | 17.85 | 17.08 – 18.56 | 11 | 11 | tied |
| 4 | Microsandbox Cloud | 21.37 | 20.24 – 24.76 | 12 | 12 | — |
| 4 | Novita | 21.43 | 20.55 – 22.34 | 12 | 12 | tied |
| 4 | Namespace | 22.1 | 20.44 – 26.73 | 12 | 12 | tied |
| 4 | Modal (VM) | 22.4 | 21.85 – 23.61 | 12 | 12 | tied |
| 8 | Vercel Sandbox | 26.78 | 25.95 – 27.46 | 12 | 12 | — |
| 8 | Modal (gVisor) | 28.21 | 21.9 – 51.52 | 12 | 12 | tied |
| 8 | E2B | 36.74 | 34.13 – 37.48 | 12 | 12 | tied |
| 11 | Runloop | 55.97 | 41.06 – 57.08 | 12 | 12 | — |

</details>

## cpu

<details>
<summary><strong>1 synthetic metric</strong> · headline: Node.js web tooling</summary>

### Node.js web tooling _(headline)_

runs/s · higher is better

_Daytona (VM) leads · ~1.1× Blaxel on median (higher is better)._

| Rank | Provider | Node.js web tooling (runs/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 21.66 | 18.85 – 21.92 | 3 | 21 | — |
| 2 | Blaxel | 20.08 | 20.03 – 20.37 | 3 | 45 | too few sandboxes |
| 3 | Novita | 18.64 | 18.19 – 19.45 | 3 | 21 | too few sandboxes |
| 4 | Microsandbox Cloud | 18.16 | 17.83 – 18.21 | 3 | 30 | too few sandboxes |
| 5 | Modal (VM) | 15.78 | 15.02 – 15.82 | 3 | 11 | too few sandboxes |
| 6 | Modal (gVisor) | 14.55 | 11.32 – 14.68 | 3 | 33 | too few sandboxes |
| 7 | Vercel Sandbox | 12.99 | 10.11 – 13.41 | 3 | 9 | too few sandboxes |
| 8 | Namespace | 11.62 | 9.005 – 21.49 | 3 | 30 | too few sandboxes |
| 9 | E2B | 11.3 | 10.62 – 13.05 | 3 | 18 | too few sandboxes |
| 10 | run.cloud | 8.475 | 8.46 – 8.49 | 2 | 6 | too few sandboxes |
| 11 | Runloop | 6.03 | 5.84 – 6.245 | 3 | 33 | too few sandboxes |

</details>

## disk

<details>
<summary><strong>9 synthetic metrics</strong> · headline: fio rand read 4KB, O_DIRECT (IOPS)</summary>

### fio rand read 4KB, O_DIRECT (IOPS) _(headline)_

IOPS · higher is better

_Microsandbox Cloud leads · ~1.4× Blaxel on median (higher is better)._

| Rank | Provider | fio rand read 4KB, O_DIRECT (IOPS) (IOPS) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Microsandbox Cloud | 348500 | 231500 – 358500 | 3 | 6 | — |
| 2 | Blaxel | 257500 | 248000 – 289000 | 3 | 6 | too few sandboxes |
| 3 | Vercel Sandbox | 246000 | 224500 – 248000 | 3 | 6 | too few sandboxes |
| 4 | Daytona (VM) | 232500 | 221000 – 233000 | 3 | 6 | too few sandboxes |
| 5 | Modal (VM) | 224500 | 223500 – 230500 | 3 | 6 | too few sandboxes |
| 6 | Namespace | 206500 | 197500 – 207500 | 3 | 6 | too few sandboxes |
| 7 | run.cloud | 115500 | 105600 – 177000 | 3 | 6 | too few sandboxes |
| 8 | Runloop | 89450 | 88600 – 91650 | 3 | 6 | too few sandboxes |
| 9 | Modal (gVisor) | 84600 | 82800 – 206500 | 3 | 6 | too few sandboxes |
| 10 | Novita | 74900 | 71900 – 77600 | 3 | 6 | too few sandboxes |
| 11 | tama | 72050 | 57600 – 77750 | 3 | 6 | too few sandboxes |
| 12 | E2B | 48050 | 47150 – 51550 | 3 | 6 | too few sandboxes |

### fio rand read 4KB, O_DIRECT (MB/s)

MB/s · higher is better

_Microsandbox Cloud leads · ~1.4× Blaxel on median (higher is better)._

| Rank | Provider | fio rand read 4KB, O_DIRECT (MB/s) (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Microsandbox Cloud | 1360 | 905.5 – 1399 | 3 | 6 | — |
| 2 | Blaxel | 1005 | 970 – 1130 | 3 | 6 | too few sandboxes |
| 3 | Vercel Sandbox | 962 | 878 – 968.5 | 3 | 6 | too few sandboxes |
| 4 | Daytona (VM) | 908 | 863 – 910.5 | 3 | 6 | too few sandboxes |
| 5 | Modal (VM) | 875 | 873 – 902 | 3 | 6 | too few sandboxes |
| 6 | Namespace | 808 | 771 – 810.5 | 3 | 6 | too few sandboxes |
| 7 | run.cloud | 451.5 | 412.5 – 691.5 | 3 | 6 | too few sandboxes |
| 8 | Runloop | 349.5 | 346 – 358 | 3 | 6 | too few sandboxes |
| 9 | Modal (gVisor) | 330.5 | 323.5 – 806 | 3 | 6 | too few sandboxes |
| 10 | Novita | 292.5 | 281 – 303 | 3 | 6 | too few sandboxes |
| 11 | tama | 281.5 | 225 – 304 | 3 | 6 | too few sandboxes |
| 12 | E2B | 187.5 | 184 – 201.5 | 3 | 6 | too few sandboxes |

### fio rand write 4KB, O_DIRECT (IOPS)

IOPS · higher is better

_Vercel Sandbox leads · ~1.1× Blaxel on median (higher is better)._

| Rank | Provider | fio rand write 4KB, O_DIRECT (IOPS) (IOPS) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Vercel Sandbox | 310500 | 307000 – 312500 | 3 | 6 | — |
| 2 | Blaxel | 281500 | 212000 – 328000 | 3 | 6 | too few sandboxes |
| 3 | Namespace | 233500 | 231000 – 251000 | 3 | 6 | too few sandboxes |
| 4 | Modal (VM) | 207000 | 205500 – 211000 | 3 | 6 | too few sandboxes |
| 5 | Daytona (VM) | 196500 | 187000 – 201500 | 3 | 6 | too few sandboxes |
| 6 | run.cloud | 112500 | 111000 – 182000 | 3 | 6 | too few sandboxes |
| 7 | Runloop | 100850 | 99650 – 104550 | 3 | 6 | too few sandboxes |
| 8 | Microsandbox Cloud | 93550 | 65650 – 96250 | 3 | 6 | too few sandboxes |
| 9 | Modal (gVisor) | 84000 | 81400 – 222000 | 3 | 6 | too few sandboxes |
| 10 | Novita | 79150 | 78900 – 79500 | 3 | 6 | too few sandboxes |
| 11 | tama | 65200 | 49450 – 70950 | 3 | 6 | too few sandboxes |
| 12 | E2B | 49950 | 48000 – 58500 | 3 | 6 | too few sandboxes |

### fio rand write 4KB, O_DIRECT (MB/s)

MB/s · higher is better

_Vercel Sandbox leads · ~1.1× Blaxel on median (higher is better)._

| Rank | Provider | fio rand write 4KB, O_DIRECT (MB/s) (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Vercel Sandbox | 1213 | 1199 – 1221 | 3 | 6 | — |
| 2 | Blaxel | 1100 | 828.5 – 1282 | 3 | 6 | too few sandboxes |
| 3 | Namespace | 913 | 902 – 980.5 | 3 | 6 | too few sandboxes |
| 4 | Modal (VM) | 809 | 803.5 – 824.5 | 3 | 6 | too few sandboxes |
| 5 | Daytona (VM) | 767.5 | 731 – 787 | 3 | 6 | too few sandboxes |
| 6 | run.cloud | 439 | 432 – 710.5 | 3 | 6 | too few sandboxes |
| 7 | Runloop | 394.5 | 389 – 408.5 | 3 | 6 | too few sandboxes |
| 8 | Microsandbox Cloud | 365 | 256.5 – 375.5 | 3 | 6 | too few sandboxes |
| 9 | Modal (gVisor) | 328 | 318 – 868.5 | 3 | 6 | too few sandboxes |
| 10 | Novita | 309.5 | 308 – 310.5 | 3 | 6 | too few sandboxes |
| 11 | tama | 255 | 193 – 277 | 3 | 6 | too few sandboxes |
| 12 | E2B | 195 | 187.5 – 228.5 | 3 | 6 | too few sandboxes |

### fio seq read 1MB, O_DIRECT (IOPS)

IOPS · higher is better

_Modal (gVisor) leads · ~3.3× Novita on median (higher is better)._

| Rank | Provider | fio seq read 1MB, O_DIRECT (IOPS) (IOPS) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Modal (gVisor) | 40800 | 22900 – 43050 | 3 | 6 | — |
| 2 | Novita | 12400 | 12000 – 13600 | 3 | 6 | too few sandboxes |
| 3 | Blaxel | 7843 | 7196 – 8573 | 3 | 6 | too few sandboxes |
| 4 | Microsandbox Cloud | 7717 | 6424 – 8203 | 3 | 6 | too few sandboxes |
| 5 | Daytona (VM) | 6512 | 4490 – 7353 | 3 | 6 | too few sandboxes |
| 6 | run.cloud | 5177 | 4117 – 9987 | 3 | 6 | too few sandboxes |
| 7 | Vercel Sandbox | 4885 | 3923 – 5371 | 3 | 6 | too few sandboxes |
| 8 | Namespace | 2190 | 2174 – 2530 | 3 | 6 | too few sandboxes |
| 9 | Runloop | 2081 | 2052 – 2321 | 3 | 6 | too few sandboxes |
| 10 | Modal (VM) | 1747 | 1701 – 2275 | 3 | 6 | too few sandboxes |
| 11 | tama | 824.5 | 779.5 – 1852 | 3 | 6 | too few sandboxes |
| 12 | E2B | 599 | 599 – 599.5 | 3 | 6 | too few sandboxes |

### fio seq read 1MB, O_DIRECT (MB/s)

MB/s · higher is better

_Blaxel leads on median (higher is better); see notes for how ranks are decided._

| Rank | Provider | fio seq read 1MB, O_DIRECT (MB/s) (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Blaxel | 7845 | 7198 – 8574 | 3 | 6 | — |
| 2 | Microsandbox Cloud | 7719 | 6425 – 8205 | 3 | 6 | too few sandboxes |
| 3 | Daytona (VM) | 6513 | 4492 – 7354 | 3 | 6 | too few sandboxes |
| 4 | run.cloud | 5179 | 4119 – 9675 | 3 | 5 | too few sandboxes |
| 5 | Vercel Sandbox | 4886 | 3924 – 5373 | 3 | 6 | too few sandboxes |
| 6 | Namespace | 2192 | 2175 – 2532 | 3 | 6 | too few sandboxes |
| 7 | Runloop | 2083 | 2054 – 2322 | 3 | 6 | too few sandboxes |
| 8 | Modal (VM) | 1748 | 1703 – 2276 | 3 | 6 | too few sandboxes |
| 9 | tama | 826.5 | 781 – 1854 | 3 | 6 | too few sandboxes |
| 10 | E2B | 601 | 600.5 – 601 | 3 | 6 | too few sandboxes |

### fio seq write 1MB, O_DIRECT (IOPS)

IOPS · higher is better

_Novita leads · ~1.1× Blaxel on median (higher is better)._

| Rank | Provider | fio seq write 1MB, O_DIRECT (IOPS) (IOPS) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Novita | 6624 | 5936 – 6690 | 3 | 6 | — |
| 2 | Blaxel | 5825 | 4658 – 5874 | 3 | 6 | too few sandboxes |
| 3 | Microsandbox Cloud | 4782 | 4117 – 6079 | 3 | 6 | too few sandboxes |
| 4 | Modal (gVisor) | 4018 | 3985 – 5680 | 3 | 6 | too few sandboxes |
| 5 | Daytona (VM) | 3621 | 3425 – 3792 | 3 | 6 | too few sandboxes |
| 6 | Vercel Sandbox | 3586 | 2420 – 4522 | 3 | 6 | too few sandboxes |
| 7 | Modal (VM) | 3143 | 2956 – 3743 | 3 | 6 | too few sandboxes |
| 8 | run.cloud | 2310 | 2184 – 4946 | 3 | 6 | too few sandboxes |
| 9 | Namespace | 1362 | 1307 – 1790 | 3 | 6 | too few sandboxes |
| 10 | tama | 1329 | 947.5 – 1618 | 3 | 6 | too few sandboxes |
| 11 | Runloop | 901 | 784.5 – 1322 | 3 | 6 | too few sandboxes |
| 12 | E2B | 599.5 | 599 – 599.5 | 3 | 6 | too few sandboxes |

### fio seq write 1MB, O_DIRECT (MB/s)

MB/s · higher is better

_Novita leads · ~1.1× Blaxel on median (higher is better)._

| Rank | Provider | fio seq write 1MB, O_DIRECT (MB/s) (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Novita | 6626 | 5938 – 6692 | 3 | 6 | — |
| 2 | Blaxel | 5826 | 4659 – 5875 | 3 | 6 | too few sandboxes |
| 3 | Microsandbox Cloud | 4783 | 4119 – 6081 | 3 | 6 | too few sandboxes |
| 4 | Modal (gVisor) | 4019 | 3986 – 5682 | 3 | 6 | too few sandboxes |
| 5 | Daytona (VM) | 3622 | 3426 – 3794 | 3 | 6 | too few sandboxes |
| 6 | Vercel Sandbox | 3588 | 2422 – 4524 | 3 | 6 | too few sandboxes |
| 7 | Modal (VM) | 3144 | 2957 – 3744 | 3 | 6 | too few sandboxes |
| 8 | run.cloud | 2312 | 2185 – 4948 | 3 | 6 | too few sandboxes |
| 9 | Namespace | 1363 | 1309 – 1791 | 3 | 6 | too few sandboxes |
| 10 | tama | 1331 | 949.5 – 1620 | 3 | 6 | too few sandboxes |
| 11 | Runloop | 903 | 786 – 1324 | 3 | 6 | too few sandboxes |
| 12 | E2B | 601 | 600.5 – 601.5 | 3 | 6 | too few sandboxes |

### Hardlink throughput

bogo ops/s · higher is better

_Daytona (VM) leads · ~1.3× Blaxel on median (higher is better)._

| Rank | Provider | Hardlink throughput (bogo ops/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 25.45 | 25.11 – 25.68 | 3 | 6 | — |
| 2 | Blaxel | 19.77 | 18.29 – 19.86 | 3 | 6 | too few sandboxes |
| 3 | Novita | 12.15 | 12.14 – 12.19 | 3 | 6 | too few sandboxes |
| 4 | Vercel Sandbox | 11.11 | 11.09 – 11.16 | 3 | 6 | too few sandboxes |
| 5 | Runloop | 11.04 | 10.93 – 11.29 | 3 | 6 | too few sandboxes |
| 6 | Microsandbox Cloud | 10.88 | 10.79 – 13.44 | 3 | 6 | too few sandboxes |
| 7 | Modal (VM) | 8.12 | 8.07 – 8.22 | 3 | 6 | too few sandboxes |
| 8 | tama | 7.64 | 7.59 – 7.92 | 3 | 6 | too few sandboxes |
| 9 | Namespace | 5.09 | 5.09 – 5.19 | 3 | 6 | too few sandboxes |
| 10 | run.cloud | 5.005 | 4.99 – 7.135 | 3 | 6 | too few sandboxes |
| 11 | Modal (gVisor) | 3.19 | 3.085 – 5.055 | 3 | 6 | too few sandboxes |
| 12 | E2B | 1.4 | 1.33 – 1.43 | 3 | 6 | too few sandboxes |

</details>

## memory

<details>
<summary><strong>4 synthetic metrics</strong> · headline: STREAM Triad</summary>

### STREAM Triad _(headline)_

MB/s · higher is better

_Daytona (VM) leads · ~1.6× Blaxel on median (higher is better)._

| Rank | Provider | STREAM Triad (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 174100 | 170800 – 178600 | 3 | 15 | — |
| 2 | Blaxel | 105758 | 95620 – 131200 | 3 | 15 | too few sandboxes |
| 3 | Modal (gVisor) | 98570 | 82560 – 112223 | 3 | 15 | too few sandboxes |
| 4 | Modal (VM) | 95940 | 63540 – 129700 | 3 | 15 | too few sandboxes |
| 5 | Microsandbox Cloud | 56930 | 47689 – 58149 | 3 | 15 | too few sandboxes |
| 6 | Novita | 52550 | 51820 – 53500 | 3 | 15 | too few sandboxes |
| 7 | Vercel Sandbox | 52190 | 47170 – 53420 | 3 | 15 | too few sandboxes |
| 8 | E2B | 47440 | 45460 – 48170 | 3 | 15 | too few sandboxes |
| 9 | Namespace | 28760 | 26640 – 31880 | 1 | 5 | too few sandboxes |
| 10 | run.cloud | 27320 | 27250 – 27400 | 2 | 10 | too few sandboxes |
| 11 | Runloop | 22430 | 20040 – 27330 | 1 | 5 | too few sandboxes |

### STREAM Add

MB/s · higher is better

_Daytona (VM) leads · ~1.6× Blaxel on median (higher is better)._

| Rank | Provider | STREAM Add (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 173500 | 171000 – 178700 | 3 | 15 | — |
| 2 | Blaxel | 105300 | 96400 – 133900 | 3 | 15 | too few sandboxes |
| 3 | Modal (VM) | 95370 | 62940 – 127633 | 3 | 15 | too few sandboxes |
| 4 | Modal (gVisor) | 94710 | 90370 – 105100 | 3 | 15 | too few sandboxes |
| 5 | Microsandbox Cloud | 53810 | 48090 – 56790 | 3 | 15 | too few sandboxes |
| 6 | Novita | 52670 | 51450 – 53440 | 3 | 15 | too few sandboxes |
| 7 | Vercel Sandbox | 51790 | 46340 – 53180 | 3 | 15 | too few sandboxes |
| 8 | E2B | 47440 | 45860 – 47700 | 3 | 15 | too few sandboxes |
| 9 | Namespace | 28220 | 25840 – 31950 | 1 | 5 | too few sandboxes |
| 10 | run.cloud | 27330 | 27290 – 27380 | 2 | 10 | too few sandboxes |
| 11 | Runloop | 21833 | 20450 – 22360 | 1 | 5 | too few sandboxes |

### STREAM Copy

MB/s · higher is better

_Daytona (VM) leads · ~1.6× Blaxel on median (higher is better)._

| Rank | Provider | STREAM Copy (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 199600 | 196900 – 207400 | 3 | 50 | — |
| 2 | Blaxel | 122800 | 114600 – 143000 | 3 | 52 | too few sandboxes |
| 3 | Modal (gVisor) | 97820 | 96090 – 109400 | 3 | 75 | too few sandboxes |
| 4 | Modal (VM) | 96680 | 74180 – 115500 | 3 | 30 | too few sandboxes |
| 5 | Vercel Sandbox | 79570 | 39840 – 81210 | 3 | 15 | too few sandboxes |
| 6 | E2B | 74440 | 73630 – 76900 | 3 | 67 | too few sandboxes |
| 7 | Microsandbox Cloud | 69420 | 68390 – 70210 | 3 | 70 | too few sandboxes |
| 8 | Novita | 58040 | 57282 – 58380 | 3 | 15 | too few sandboxes |
| 9 | run.cloud | 38450 | 38280 – 38620 | 2 | 10 | too few sandboxes |
| 10 | Namespace | 38340 | 37410 – 39960 | 1 | 25 | too few sandboxes |
| 11 | Runloop | 29110 | 25620 – 33390 | 1 | 20 | — |

### STREAM Scale

MB/s · higher is better

_Daytona (VM) leads · ~1.7× Blaxel on median (higher is better)._

| Rank | Provider | STREAM Scale (MB/s) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 165800 | 161500 – 170300 | 3 | 15 | — |
| 2 | Blaxel | 97720 | 88470 – 123878 | 3 | 15 | too few sandboxes |
| 3 | Modal (VM) | 90940 | 62050 – 131900 | 3 | 15 | too few sandboxes |
| 4 | Modal (gVisor) | 85190 | 84840 – 97450 | 3 | 15 | too few sandboxes |
| 5 | Novita | 49670 | 48790 – 50830 | 3 | 15 | too few sandboxes |
| 6 | Vercel Sandbox | 44450 | 42660 – 45740 | 3 | 15 | too few sandboxes |
| 7 | E2B | 43080 | 42830 – 45940 | 3 | 15 | too few sandboxes |
| 8 | Microsandbox Cloud | 41710 | 39420 – 47340 | 3 | 15 | too few sandboxes |
| 9 | Namespace | 25800 | 23440 – 29100 | 1 | 5 | too few sandboxes |
| 10 | run.cloud | 24640 | 24630 – 24650 | 2 | 10 | too few sandboxes |
| 11 | Runloop | 21420 | 19310 – 22070 | 1 | 5 | too few sandboxes |

</details>

## network

<details>
<summary><strong>5 synthetic metrics</strong> · headline: iperf3 loopback TCP, 1 stream</summary>

### iperf3 loopback TCP, 1 stream _(headline)_

Mbits/sec · higher is better

_Novita leads · ~1.6× Blaxel on median (higher is better)._

| Rank | Provider | iperf3 loopback TCP, 1 stream (Mbits/sec) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Novita | 154526 | 132200 – 158853 | 3 | 6 | — |
| 2 | Blaxel | 98718 | 86248 – 102600 | 3 | 6 | too few sandboxes |
| 3 | Daytona (VM) | 78420 | 78045 – 78880 | 3 | 6 | too few sandboxes |
| 4 | Microsandbox Cloud | 73540 | 71140 – 74460 | 3 | 6 | too few sandboxes |
| 5 | E2B | 56740 | 53610 – 66240 | 3 | 6 | too few sandboxes |
| 6 | Vercel Sandbox | 56465 | 52317 – 67859 | 3 | 6 | too few sandboxes |
| 7 | Namespace | 49560 | 38200 – 49990 | 3 | 6 | too few sandboxes |
| 8 | run.cloud | 45610 | 15354 – 59210 | 3 | 6 | too few sandboxes |
| 9 | Runloop | 40521 | 40330 – 42490 | 3 | 6 | too few sandboxes |
| 10 | Modal (gVisor) | 26284 | 20790 – 26960 | 3 | 6 | too few sandboxes |
| 11 | Modal (VM) | 16250 | 15720 – 29970 | 3 | 6 | too few sandboxes |

### iperf3 loopback TCP, 10 streams

Mbits/sec · higher is better

_Novita leads · ~1.4× Blaxel on median (higher is better)._

| Rank | Provider | iperf3 loopback TCP, 10 streams (Mbits/sec) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Novita | 151358 | 150508 – 154289 | 3 | 6 | — |
| 2 | Blaxel | 106853 | 95770 – 114676 | 3 | 6 | too few sandboxes |
| 3 | Daytona (VM) | 90870 | 61240 – 95540 | 3 | 6 | too few sandboxes |
| 4 | Microsandbox Cloud | 70404 | 67622 – 75970 | 3 | 6 | too few sandboxes |
| 5 | Vercel Sandbox | 54470 | 53407 – 55140 | 3 | 6 | too few sandboxes |
| 6 | run.cloud | 52420 | 26750 – 75321 | 3 | 6 | too few sandboxes |
| 7 | Namespace | 50550 | 40680 – 53703 | 3 | 6 | too few sandboxes |
| 8 | E2B | 49648 | 45823 – 52860 | 3 | 6 | too few sandboxes |
| 9 | Runloop | 33220 | 26840 – 34186 | 3 | 6 | too few sandboxes |
| 10 | Modal (gVisor) | 24010 | 18812 – 25790 | 3 | 6 | too few sandboxes |
| 11 | Modal (VM) | 18644 | 17540 – 19770 | 3 | 6 | too few sandboxes |

### iperf3 loopback UDP, 10G objective

Mbits/sec · higher is better

_Modal (VM) leads on median (higher is better); see notes for how ranks are decided._

| Rank | Provider | iperf3 loopback UDP, 10G objective (Mbits/sec) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Modal (VM) | 10000 | 10000 – 10000 | 3 | 6 | — |
| 2 | Blaxel | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes |
| 2 | Daytona (VM) | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 2 | E2B | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 2 | Microsandbox Cloud | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 2 | Namespace | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 2 | Novita | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 2 | run.cloud | 9999 | 9996 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 2 | Runloop | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 2 | Vercel Sandbox | 9999 | 9999 – 9999 | 3 | 6 | too few sandboxes, equal medians |
| 11 | Modal (gVisor) | 322.5 | 291.5 – 327.5 | 3 | 6 | too few sandboxes |

### iperf3 WAN download

Mbits/sec · higher is better

_Vercel Sandbox leads · ~1.4× Daytona (VM) on median (higher is better)._

| Rank | Provider | iperf3 WAN download (Mbits/sec) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Vercel Sandbox | 8660 | 8273 – 9029 | 3 | 6 | — |
| 2 | Daytona (VM) | 6335 | 6163 – 11080 | 3 | 6 | too few sandboxes |
| 3 | Novita | 5439 | 3584 – 5883 | 3 | 6 | too few sandboxes |
| 4 | Microsandbox Cloud | 5404 | 5271 – 6066 | 3 | 6 | too few sandboxes |
| 5 | Modal (gVisor) | 3278 | 3177 – 3514 | 3 | 6 | too few sandboxes |
| 6 | Blaxel | 2106 | 1722 – 2164 | 3 | 6 | too few sandboxes |
| 7 | run.cloud | 1756 | 937.3 – 2581 | 3 | 6 | too few sandboxes |
| 8 | Modal (VM) | 1478 | 1383 – 1512 | 3 | 6 | too few sandboxes |
| 9 | Runloop | 1212 | 1202 – 1330 | 3 | 6 | too few sandboxes |
| 10 | E2B | 1100 | 1082 – 3793 | 3 | 6 | too few sandboxes |
| 11 | Namespace | 193.8 | 178.8 – 260.3 | 3 | 6 | too few sandboxes |

### iperf3 WAN upload

Mbits/sec · higher is better

_Modal (VM) leads · ~1.6× Namespace on median (higher is better)._

| Rank | Provider | iperf3 WAN upload (Mbits/sec) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Modal (VM) | 7906 | 6315 – 9225 | 3 | 6 | — |
| 2 | Namespace | 4957 | 1474 – 5324 | 3 | 6 | too few sandboxes |
| 3 | Modal (gVisor) | 4069 | 83.55 – 4170 | 3 | 6 | too few sandboxes |
| 4 | Novita | 3736 | 2305 – 4940 | 3 | 6 | too few sandboxes |
| 5 | Vercel Sandbox | 2910 | 87.66 – 5024 | 3 | 6 | too few sandboxes |
| 6 | Daytona (VM) | 2450 | 1415 – 4672 | 3 | 6 | too few sandboxes |
| 7 | Blaxel | 2200 | 2170 – 2401 | 3 | 6 | too few sandboxes |
| 8 | Microsandbox Cloud | 1275 | 846 – 1774 | 3 | 6 | too few sandboxes |
| 9 | E2B | 1032 | 610.5 – 2250 | 3 | 6 | too few sandboxes |
| 10 | run.cloud | 935 | 908 – 9303 | 3 | 6 | too few sandboxes |
| 11 | Runloop | 743.4 | 597.2 – 837.8 | 3 | 6 | too few sandboxes |

</details>

## system

<details>
<summary><strong>7 synthetic metrics</strong> · headline: PyBench</summary>

### PyBench _(headline)_

Milliseconds · lower is better

_Namespace leads · Daytona (VM) is ~1.1× higher (lower is better)._

| Rank | Provider | PyBench (Milliseconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Namespace | 373.5 | 369.5 – 379 | 3 | 6 | — |
| 2 | Daytona (VM) | 414 | 407.5 – 417.5 | 3 | 6 | too few sandboxes |
| 3 | Modal (VM) | 449.5 | 447.5 – 618 | 3 | 6 | too few sandboxes |
| 4 | Blaxel | 468.5 | 465 – 512 | 3 | 6 | too few sandboxes |
| 5 | Novita | 482 | 480 – 483 | 3 | 6 | too few sandboxes |
| 5 | run.cloud | 482 | 478.5 – 490.5 | 3 | 6 | too few sandboxes, equal medians |
| 7 | Microsandbox Cloud | 520 | 513.5 – 529.5 | 3 | 6 | too few sandboxes |
| 8 | tama | 539.5 | 537.5 – 596 | 3 | 6 | too few sandboxes |
| 9 | Vercel Sandbox | 763.5 | 763.5 – 765.5 | 3 | 6 | too few sandboxes |
| 10 | Modal (gVisor) | 774 | 666.5 – 912.5 | 3 | 6 | too few sandboxes |
| 11 | E2B | 806 | 806 – 807.5 | 3 | 6 | too few sandboxes |
| 12 | Runloop | 1247 | 1244 – 1259 | 3 | 6 | too few sandboxes |

### Git common operations

Seconds · lower is better

_run.cloud leads on median (lower is better); see notes for how ranks are decided._

| Rank | Provider | Git common operations (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | run.cloud | 35.48 | 35.27 – 37 | 3 | 6 | — |
| 2 | Daytona (VM) | 37.04 | 35.78 – 37.19 | 3 | 6 | too few sandboxes |
| 3 | Modal (VM) | 39.17 | 39.06 – 44.12 | 3 | 6 | too few sandboxes |
| 4 | Namespace | 41.13 | 40.84 – 43.99 | 3 | 6 | too few sandboxes |
| 5 | Blaxel | 42.13 | 41.9 – 45.24 | 3 | 6 | too few sandboxes |
| 6 | Novita | 44.3 | 44.27 – 44.53 | 3 | 6 | too few sandboxes |
| 7 | Microsandbox Cloud | 52.07 | 51.43 – 53.18 | 3 | 6 | too few sandboxes |
| 8 | tama | 54.93 | 54.83 – 55.2 | 3 | 6 | too few sandboxes |
| 9 | Vercel Sandbox | 60.81 | 60.16 – 61.02 | 3 | 6 | too few sandboxes |
| 10 | Modal (gVisor) | 61.79 | 51.97 – 74.5 | 3 | 6 | too few sandboxes |
| 11 | E2B | 66.13 | 65.53 – 67.05 | 3 | 6 | too few sandboxes |
| 12 | Runloop | 114.7 | 110.1 – 117.8 | 3 | 6 | too few sandboxes |

### pgbench RO (s100, 50c)

TPS · higher is better

_tama leads · ~1.9× Blaxel on median (higher is better)._

| Rank | Provider | pgbench RO (s100, 50c) (TPS) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | tama | 643200 | 502000 – 645100 | 3 | 6 | — |
| 2 | Blaxel | 341200 | 314700 – 343600 | 3 | 6 | too few sandboxes |
| 3 | Daytona (VM) | 286100 | 285500 – 296200 | 3 | 6 | too few sandboxes |
| 4 | Novita | 283800 | 282500 – 291600 | 3 | 6 | too few sandboxes |
| 5 | Microsandbox Cloud | 241000 | 230600 – 247200 | 3 | 6 | too few sandboxes |
| 6 | Namespace | 206600 | 206500 – 216400 | 3 | 6 | too few sandboxes |
| 7 | Modal (VM) | 195100 | 189100 – 287100 | 3 | 6 | too few sandboxes |
| 8 | E2B | 168700 | 164200 – 241300 | 3 | 6 | too few sandboxes |
| 9 | Vercel Sandbox | 168200 | 166000 – 170500 | 3 | 6 | too few sandboxes |
| 10 | run.cloud | 163400 | 107500 – 219300 | 2 | 4 | too few sandboxes |
| 11 | Modal (gVisor) | 68060 | 65740 – 103600 | 3 | 6 | too few sandboxes |
| 12 | Runloop | 64950 | 64290 – 66040 | 3 | 6 | too few sandboxes |

### pgbench RO latency (s100, 50c)

ms · lower is better

_tama leads · Blaxel is ~1.9× higher (lower is better)._

| Rank | Provider | pgbench RO latency (s100, 50c) (ms) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | tama | 0.0775 | 0.0775 – 0.0995 | 3 | 6 | — |
| 2 | Blaxel | 0.1475 | 0.1455 – 0.1585 | 3 | 6 | too few sandboxes |
| 3 | Daytona (VM) | 0.175 | 0.169 – 0.175 | 3 | 6 | too few sandboxes |
| 4 | Novita | 0.1775 | 0.1725 – 0.1775 | 3 | 6 | too few sandboxes |
| 5 | Microsandbox Cloud | 0.2075 | 0.2025 – 0.217 | 3 | 6 | too few sandboxes |
| 6 | Namespace | 0.242 | 0.2315 – 0.242 | 3 | 6 | too few sandboxes |
| 7 | Modal (VM) | 0.2565 | 0.174 – 0.2645 | 3 | 6 | too few sandboxes |
| 8 | E2B | 0.2965 | 0.2075 – 0.306 | 3 | 6 | too few sandboxes |
| 9 | Vercel Sandbox | 0.2975 | 0.2935 – 0.301 | 3 | 6 | too few sandboxes |
| 10 | run.cloud | 0.3465 | 0.228 – 0.465 | 2 | 4 | too few sandboxes |
| 11 | Modal (gVisor) | 0.735 | 0.483 – 0.7625 | 3 | 6 | too few sandboxes |
| 12 | Runloop | 0.77 | 0.7575 – 0.7775 | 3 | 6 | too few sandboxes |

### pgbench RW (s100, 50c)

TPS · higher is better

_Novita leads · ~1.1× Blaxel on median (higher is better)._

| Rank | Provider | pgbench RW (s100, 50c) (TPS) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Novita | 27340 | 26040 – 27530 | 3 | 6 | — |
| 2 | Blaxel | 24430 | 24380 – 24920 | 3 | 6 | too few sandboxes |
| 3 | Namespace | 19460 | 18350 – 19690 | 3 | 6 | too few sandboxes |
| 4 | Vercel Sandbox | 17800 | 17400 – 18020 | 3 | 6 | too few sandboxes |
| 5 | run.cloud | 16470 | 14230 – 18710 | 2 | 4 | too few sandboxes |
| 6 | Daytona (VM) | 16060 | 15610 – 16080 | 3 | 6 | too few sandboxes |
| 7 | Microsandbox Cloud | 14870 | 14770 – 15380 | 3 | 6 | too few sandboxes |
| 8 | Modal (VM) | 13640 | 13630 – 17830 | 3 | 6 | too few sandboxes |
| 9 | E2B | 11500 | 11130 – 14150 | 3 | 6 | too few sandboxes |
| 10 | tama | 10910 | 10040 – 19580 | 3 | 6 | too few sandboxes |
| 11 | Modal (gVisor) | 8134 | 8112 – 10900 | 3 | 6 | too few sandboxes |
| 12 | Runloop | 6521 | 5820 – 6607 | 3 | 6 | too few sandboxes |

### pgbench RW latency (s100, 50c)

ms · lower is better

_Novita leads · Blaxel is ~1.1× higher (lower is better)._

| Rank | Provider | pgbench RW latency (s100, 50c) (ms) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Novita | 1.829 | 1.816 – 1.921 | 3 | 6 | — |
| 2 | Blaxel | 2.05 | 2.01 – 2.05 | 3 | 6 | too few sandboxes |
| 3 | Namespace | 2.577 | 2.554 – 2.748 | 3 | 6 | too few sandboxes |
| 4 | Vercel Sandbox | 2.809 | 2.774 – 2.872 | 3 | 6 | too few sandboxes |
| 5 | run.cloud | 3.094 | 2.673 – 3.515 | 2 | 4 | too few sandboxes |
| 6 | Daytona (VM) | 3.115 | 3.109 – 3.205 | 3 | 6 | too few sandboxes |
| 7 | Microsandbox Cloud | 3.362 | 3.252 – 3.39 | 3 | 6 | too few sandboxes |
| 8 | Modal (VM) | 3.666 | 2.809 – 3.669 | 3 | 6 | too few sandboxes |
| 9 | E2B | 4.359 | 3.534 – 4.495 | 3 | 6 | too few sandboxes |
| 10 | tama | 4.613 | 2.562 – 5.253 | 3 | 6 | too few sandboxes |
| 11 | Modal (gVisor) | 6.147 | 4.588 – 6.164 | 3 | 6 | too few sandboxes |
| 12 | Runloop | 7.668 | 7.569 – 8.594 | 3 | 6 | too few sandboxes |

### SQLite Speedtest

Seconds · lower is better

_Daytona (VM) leads · Modal (VM) is ~1.1× higher (lower is better)._

| Rank | Provider | SQLite Speedtest (Seconds) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Daytona (VM) | 31.84 | 31.38 – 31.88 | 3 | 6 | — |
| 2 | Modal (VM) | 33.78 | 33.33 – 59.37 | 3 | 6 | too few sandboxes |
| 3 | Blaxel | 37.64 | 36.99 – 45.61 | 3 | 6 | too few sandboxes |
| 4 | Novita | 40.34 | 39.65 – 40.89 | 3 | 6 | too few sandboxes |
| 5 | Microsandbox Cloud | 51.57 | 51.41 – 53.47 | 3 | 6 | too few sandboxes |
| 6 | run.cloud | 57.12 | 55.8 – 64.19 | 3 | 6 | too few sandboxes |
| 7 | Namespace | 60.28 | 59.3 – 67.87 | 3 | 6 | too few sandboxes |
| 8 | tama | 61.59 | 61.28 – 61.67 | 3 | 6 | too few sandboxes |
| 9 | Vercel Sandbox | 65.88 | 65.09 – 65.9 | 3 | 6 | too few sandboxes |
| 10 | E2B | 70.48 | 70.11 – 75.22 | 3 | 6 | too few sandboxes |
| 11 | Runloop | 125.5 | 116.5 – 129.2 | 3 | 6 | too few sandboxes |
| 12 | Modal (gVisor) | 207.1 | 173.6 – 254.8 | 3 | 6 | too few sandboxes |

</details>

## economics

### Hourly cost _(headline)_

USD/hr · lower is better

_tama is cheapest · Novita is ~3.2× higher (lower is better)._

| Rank | Provider | Hourly cost (USD/hr) | 95% bootstrap interval | Sandboxes | Trials | Note |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | tama | 0.074 | — | 1 | 1 | — |
| 2 | Novita | 0.2333 | — | 1 | 1 | — |
| 3 | Daytona (VM) | 0.3312 | — | 1 | 1 | — |
| 3 | E2B | 0.3312 | — | 1 | 1 | equal values |
| 5 | Runloop | 0.6336 | — | 1 | 1 | — |

## Coverage gaps

79 uncovered results across 12 providers (Blaxel 2, Daytona (VM) 2, E2B 2, Microsandbox Cloud 10, Modal (gVisor) 3, Modal (VM) 2, Namespace 3, Novita 3, run.cloud 8, Runloop 3, tama 39, Vercel Sandbox 2). A gap is a missing result — the provider **failing to cover** that workload — never a tie or a zero.

<details>
<summary>Full coverage table</summary>

| Provider | Benchmark | Outcome | Detail |
| --- | --- | --- | --- |
| Blaxel | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Blaxel | realworld-openclaw | **failed** | PTS ran but every trial failed for 4 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_types (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| Daytona (VM) | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Daytona (VM) | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| E2B | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| E2B | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-4afcf175-d7bc-4941-b8b3-9715a63131cd" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-9804b2d1-62c1-4fec-b65c-f76091247a98" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-ccdd6045-8384-4d15-bde0-583685e29e43" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-a4202de9-e295-4066-87e9-a75878adb681" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-5aefeea5-1e99-4035-bf93-8e87efe0bddd" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-a818cdd3-e061-4b31-9854-c9f41c68a032" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-a6b22206-7acf-46cc-8629-4a34f85ea18e" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-mastra | **failed** | Failed to create sandbox: Failed to create microsandbox-cloud sandbox "bench-cloud-65c6e886-27e9-41c5-a0ca-070ee107d95f" through the cloud control plane: runtime error: POST /v1/sandboxes: error code: 502 |
| Microsandbox Cloud | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| Modal (gVisor) | disk | **failed** | PTS duplicate-value dedup dropped 1 fio twin result (MB/s == IOPS at this block size, so the duplicate-valued &lt;Result&gt; was never written): fio_type_sequential_read_engine_linux_aio_direct_yes_block_size_1mb_job_count_1_disk_target_default_test_directory_mb_per_s (twin survived in disk/pts_fio-seq-read.xml) |
| Modal (gVisor) | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Modal (gVisor) | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| Modal (VM) | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Modal (VM) | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| Namespace | memory | **failed** | Step "mise run benchmark:memory:all" timed out after 1800s |
| Namespace | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Namespace | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| Novita | disk | **failed** | PTS duplicate-value dedup dropped 1 fio twin result (MB/s == IOPS at this block size, so the duplicate-valued &lt;Result&gt; was never written): fio_type_sequential_read_engine_linux_aio_direct_yes_block_size_1mb_job_count_1_disk_target_default_test_directory_mb_per_s (twin survived in disk/pts_fio-seq-read.xml) |
| Novita | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Novita | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| run.cloud | cpu-node | **failed** | Step "mise run benchmark:cpu:node" lost its sandbox: 12 consecutive detached polls failed (last: run.cloud API 1011: Sandbox command disconnected) — the sandbox stopped responding, not a quiet long step |
| run.cloud | memory | **failed** | Step "mise run benchmark:memory:all" lost its sandbox: 12 consecutive detached polls failed (last: run.cloud API 1011: Sandbox command disconnected) — the sandbox stopped responding, not a quiet long step |
| run.cloud | pgbench | **failed** | Step "mise run benchmark:pgbench:all" lost its sandbox: 12 consecutive detached polls failed (last: run.cloud API 1011: Sandbox command disconnected) — the sandbox stopped responding, not a quiet long step |
| run.cloud | realworld-better-auth | **failed** | Failed to create sandbox: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch() |
| run.cloud | realworld-mastra | **failed** | Step "mise run benchmark:realworld:pts:mastra" lost its sandbox: 12 consecutive detached polls failed (last: run.cloud API 1011: Sandbox command disconnected) — the sandbox stopped responding, not a quiet long step |
| run.cloud | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| run.cloud | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| run.cloud | realworld-openclaw | **failed** | Step "mise run benchmark:realworld:pts:openclaw" lost its sandbox: 12 consecutive detached polls failed (last: run.cloud API 1011: Sandbox command disconnected) — the sandbox stopped responding, not a quiet long step |
| Runloop | memory | **failed** | Step "mise run benchmark:memory:all" timed out after 1800s |
| Runloop | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Runloop | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |
| tama | cpu-node | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-2bbfd0b0-c0b6-41c3-8d89-0a6e69d8d7c4 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | cpu-node | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-16490abb-d2b1-440e-88e9-6696f5b6b327 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | cpu-node | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-bbbb84a0-94fe-4f39-8b73-fbacb5b740fc --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | memory | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-08b700cb-ba13-4531-a5cb-d3b36baf37a5 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | memory | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-57953c57-ddd6-4e8e-9a4e-6cbaf82a7034 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | memory | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-c0cecb80-b55c-4fdf-94db-431595ec7d9a --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | network | **failed** | Failed to create sandbox: tama machine machine-acs8yf4smupe entered terminal state "failed" |
| tama | network | **failed** | Failed to create sandbox: tama machine machine-oe2avyhgxxtk entered terminal state "failed" |
| tama | network | **failed** | Failed to create sandbox: tama machine machine-bq3cz8k3a08j entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-gilm263woywz entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-5onni9esjjdq entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-l0omgrzqcno9 entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-exs7ygj1ib1p entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-wmbc8ifev2kx entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-q7z47xlnnt8r entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-lzvipuo3njju entered terminal state "failed" |
| tama | realworld-better-auth | **failed** | Failed to create sandbox: tama machine machine-lofshl5dpgxb entered terminal state "failed" |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-c4198def-7223-4091-b84a-6fd9865bb846 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-6d174800-aea6-4b0c-bf75-e536bd22faee --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-da0d7fc2-74df-44d0-be16-50bcc37e6d29 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: transport error |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-b4faf28b-5d1d-4a9a-a711-c08e9b2aff0b --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-df146ac8-ca39-48da-b143-cf72ba3bf1c2 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: transport error |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-fff5fa5a-44c1-46a2-8b0b-25c751d510ec --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: transport error |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-4b4812b8-c05b-4bd3-b959-06933e248d67 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-0f394ecf-e56c-4f8e-ac0e-9684c13f435f --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: transport error |
| tama | realworld-mastra | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-c5207837-2fd5-4fa5-ad0f-1eb18b4144f0 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-5d906da2-3a54-4645-9f6b-b0381a2529d5 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-66b1ec38-a5f6-4961-8dac-bf1a27a3bad9 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-43c81c7f-15d1-4955-ac08-4abb2a1a264e --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-5065f002-0819-4543-a356-9aeb2eb971c3 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-10872c6a-8e7b-41b5-9c87-5e4980872ed5 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-fda64265-fe05-4ad0-8eb1-a0ac86376c93 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-59a672bd-3fd8-4b13-b60b-d2781f67986b --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-0e0e5f89-c6b1-46ef-8f49-17800cbe33a5 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-f055cb55-b102-449e-af10-335897c57992 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-93c036df-660e-4977-87fd-5f3cdf21b0cd --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-37158a59-12ab-4467-9e5f-2505fca288c6 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| tama | realworld-openclaw | **failed** | Failed to create sandbox: tama new sandbox-benchmarks-08c3736e-7013-4434-ad55-7e5cb05705c0 --ttl 0 --json --image ghcr.io/starslingdev/sandbox-benchmarks-toolchain:v8 --cpu 4 --memory 8192 exited 1: tama: image build failed |
| Vercel Sandbox | realworld-mastra | **failed** | PTS ran but every trial failed for 1 of 5 declared metrics: realworld_mastra_task_test_core (realworld-mastra/pts_realworld-mastra.xml) — attempted, no value recorded |
| Vercel Sandbox | realworld-openclaw | **failed** | PTS ran but every trial failed for 3 of 8 declared metrics: realworld_openclaw_task_lint_oxlint (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_shrinkwrap_check (realworld-openclaw/pts_realworld-openclaw.xml), realworld_openclaw_task_test_unit_fast (realworld-openclaw/pts_realworld-openclaw.xml) — attempted, no value recorded |

**failed** — the benchmark was attempted and broke: it threw, timed out, or died with the sandbox.
Unlike a skip, this is a reliability fact about the provider, not a decision made on its behalf.

</details>

<details>
<summary>How rankings are decided</summary>

The value is the median of the PER-SANDBOX medians — one machine, one vote — not the median of all
trials pooled together. Pooling would weight each machine by how many trials it ran, and the harness
chooses that count adaptively by watching the variance, so the noisiest machine would carry the most
weight in the published number. The median, not the mean, because a single stalled pass drags a mean
far more than it moves a median.

The interval is a cluster bootstrap of that same statistic (10,000 resamples, seeded from the Run id
so the table is reproducible byte-for-byte): whole sandboxes are resampled with replacement, keeping
each machine's trials intact.

**The interval is labelled 95%, and at these sandbox counts it does not achieve 95%.** Coverage is a
property of how many machines were measured, not of the estimator: simulated at ≈77% for 3 sandboxes,
≈92% at 6, and ≈95% at 20. No percentile bootstrap reaches nominal coverage at 3 clusters. Read a
3-sandbox interval as a resampling envelope over three machines, **not** as a calibrated frequentist
confidence interval. Within-sandbox trials may also be dependent on host scheduling.

Rows are separated only when Mann-Whitney U (two-sided, α = 0.05, enumerated exactly
over the permutation null rather than approximated) finds evidence of stochastic ordering — at these
sample sizes the normal approximation can report a p the exact test cannot actually produce. Where
replicate sandboxes exist that test runs on the PER-SANDBOX MEDIANS, so whole machines are the
exchangeable unit; testing pooled trials instead would treat repeated measurements of one machine as
independent evidence about the provider. KS is reported separately for distribution *shape* and does
not drive the ranking.

**A Note cell always says why a rank is shared, and the reasons are not interchangeable.**
`tied` — the test could have separated those providers and did not, so a faster median earned
inside the noise is not a faster provider. This is the only note that claims two providers are
statistically indistinguishable.
`equal medians` / `equal values` — arithmetic, not a finding: the ranking sorts on the value,
and two identical values have no order between them. It says nothing about the distributions.

Each metric is measured on several independent sandboxes (the **Sandboxes** column), and within each
sandbox the benchmark runs several trials (**Trials**). Trials capture within-machine noise —
neighbours, host contention, virtualization; sandboxes capture the machine-to-machine variation a
user actually experiences when they start a new environment. The ranking and its interval both treat
the SANDBOX as the unit, so more trials on the same machine never make a row look better-evidenced.
Under adaptive trial counts a large **Trials** figure is in fact a sign the machines were unstable
(the harness kept re-running), not that the estimate is precise.

At the sandbox counts this suite produces, a non-significant result means *not enough evidence to
separate*, never *the providers are equal*.

`too few sandboxes` is the extreme of that: the deciding test's best attainable p already exceeds α,
so it could not have separated the rows at any effect size, however far apart their values are.
The floor is a property of the design — here 1 v 2 sandboxes floors at p ≈ 0.67; 2 v 1 sandboxes floors at p ≈ 0.67; 2 v 3 sandboxes floors at p ≈ 0.20; 3 v 1 sandboxes floors at p ≈ 0.50; 3 v 2 sandboxes floors at p ≈ 0.20; 3 v 3 sandboxes floors at p ≈ 0.10; 3 v 3 sandboxes floors at p ≈ 0.20; 3 v 3 sandboxes floors at p ≈ 1.0; 3 v 4 sandboxes floors at p ≈ 0.057.
At three sandboxes a side the floor is 2/C(6,3) = 0.1, which is above α, so **no** three-sandbox
comparison in this table can ever be declared separated. That is a fact about the replicate count,
not about the providers. One shape can appear more than once above with different floors: ties
among a provider's per-sandbox medians raise the floor further (to 1.0 when every median in the
comparison is equal), so the count alone does not determine it.
Such rows are ranked on their observed medians and are **not** claimed to be tied — read the gap
between the values, and treat the p-value as unable to settle them either way. Where such a row
nevertheless shares the rank above it, the note reads `equal medians`: the two values are simply
identical, which is the ranking having nothing to order them by — never a finding that the
providers are alike.

### Pairwise tests (vs. row above)

`p vs. above` is the SANDBOX-LEVEL test that decides the rank wherever replicate sandboxes exist —
Mann-Whitney U on each provider's per-sandbox medians, whole machines as the exchangeable unit.
(Only where a provider ran in a single sandbox does it fall back to Mann-Whitney on pooled trials,
which treats repeated measurements of one machine as independent and is anti-conservative.)
`p (KS)` is Kolmogorov-Smirnov on distribution
*shape* — it does not drive the ranking. A tied Mann-Whitney beside a small KS often means the
same typical speed with different behaviour (e.g. bimodal stalls).
These are unadjusted, exploratory per-comparison p-values; no family-wise or false-discovery-rate
correction is applied across providers or metrics.

| Dimension | Metric | Provider | p vs. above | p (KS) |
| --- | --- | --- | ---: | ---: |
| realworld | Mastra: cold install | Blaxel | — | — |
| realworld | Mastra: cold install | Daytona (VM) | 0.84 (tied) | 0.43 |
| realworld | Mastra: cold install | run.cloud | 0.16 (tied) | 0.43 |
| realworld | Mastra: cold install | Novita | 0.46 (tied) | 0.19 |
| realworld | Mastra: cold install | Namespace | 0.014 | <0.001 |
| realworld | Mastra: cold install | Modal (VM) | 0.27 (tied) | 0.019 |
| realworld | Mastra: cold install | Microsandbox Cloud | 0.60 (tied) | 0.55 |
| realworld | Mastra: cold install | Vercel Sandbox | 0.45 (tied) | 0.32 |
| realworld | Mastra: cold install | tama | 0.73 (tied) | 0.89 |
| realworld | Mastra: cold install | Modal (gVisor) | 0.84 (tied) | 0.67 |
| realworld | Mastra: cold install | E2B | 0.0045 | 0.019 |
| realworld | Mastra: cold install | Runloop | <0.001 | <0.001 |
| realworld | Better-Auth: build | Daytona (VM) | — | — |
| realworld | Better-Auth: build | Blaxel | <0.001 | <0.001 |
| realworld | Better-Auth: build | run.cloud | 0.74 (tied) | 0.35 |
| realworld | Better-Auth: build | Novita | 0.57 (tied) | 0.28 |
| realworld | Better-Auth: build | Modal (VM) | 0.0018 | <0.001 |
| realworld | Better-Auth: build | Namespace | 0.22 (tied) | 0.19 |
| realworld | Better-Auth: build | Microsandbox Cloud | 0.80 (tied) | 0.43 |
| realworld | Better-Auth: build | Modal (gVisor) | 0.38 (tied) | 0.066 |
| realworld | Better-Auth: build | Vercel Sandbox | 0.35 (tied) | 0.19 |
| realworld | Better-Auth: build | E2B | 0.63 (tied) | 0.19 |
| realworld | Better-Auth: build | tama | 0.68 (tied) | 0.81 |
| realworld | Better-Auth: build | Runloop | 0.0011 | 0.0013 |
| realworld | Better-Auth: cold install | Daytona (VM) | — | — |
| realworld | Better-Auth: cold install | Blaxel | <0.001 | <0.001 |
| realworld | Better-Auth: cold install | Novita | 0.41 (tied) | 0.019 |
| realworld | Better-Auth: cold install | run.cloud | 0.61 (tied) | 0.12 |
| realworld | Better-Auth: cold install | Namespace | 0.83 (tied) | 0.96 |
| realworld | Better-Auth: cold install | Microsandbox Cloud | 0.22 (tied) | 0.066 |
| realworld | Better-Auth: cold install | Modal (VM) | <0.001 | <0.001 |
| realworld | Better-Auth: cold install | E2B | 0.84 (tied) | 0.79 |
| realworld | Better-Auth: cold install | Vercel Sandbox | 0.060 (tied) | 0.066 |
| realworld | Better-Auth: cold install | Modal (gVisor) | <0.001 | <0.001 |
| realworld | Better-Auth: cold install | tama | 0.26 (tied) | 0.077 |
| realworld | Better-Auth: cold install | Runloop | 0.0011 | 0.0013 |
| realworld | Better-Auth: git clone | Namespace | — | — |
| realworld | Better-Auth: git clone | Blaxel | 0.16 (tied) | 0.066 |
| realworld | Better-Auth: git clone | Vercel Sandbox | 0.0080 | <0.001 |
| realworld | Better-Auth: git clone | Modal (VM) | 0.50 (tied) | 0.066 |
| realworld | Better-Auth: git clone | Modal (gVisor) | 0.020 | 0.019 |
| realworld | Better-Auth: git clone | Daytona (VM) | 0.32 (tied) | 0.19 |
| realworld | Better-Auth: git clone | Microsandbox Cloud | 0.20 (tied) | 0.019 |
| realworld | Better-Auth: git clone | E2B | <0.001 | <0.001 |
| realworld | Better-Auth: git clone | Novita | 0.037 | <0.001 |
| realworld | Better-Auth: git clone | tama | 0.77 (tied) | 0.81 |
| realworld | Better-Auth: git clone | run.cloud | 0.34 (tied) | 0.66 |
| realworld | Better-Auth: git clone | Runloop | 0.32 (tied) | 0.22 |
| realworld | Better-Auth: lint (Biome) | Daytona (VM) | — | — |
| realworld | Better-Auth: lint (Biome) | run.cloud | <0.001 | <0.001 |
| realworld | Better-Auth: lint (Biome) | Novita | 0.93 (tied) | 0.35 |
| realworld | Better-Auth: lint (Biome) | Blaxel | 0.0083 | 0.019 |
| realworld | Better-Auth: lint (Biome) | Namespace | 0.44 (tied) | 0.19 |
| realworld | Better-Auth: lint (Biome) | Microsandbox Cloud | 0.10 (tied) | 0.019 |
| realworld | Better-Auth: lint (Biome) | Modal (VM) | 0.37 (tied) | 0.19 |
| realworld | Better-Auth: lint (Biome) | Vercel Sandbox | 0.0056 | <0.001 |
| realworld | Better-Auth: lint (Biome) | E2B | 0.039 | <0.001 |
| realworld | Better-Auth: lint (Biome) | tama | 0.078 (tied) | 0.032 |
| realworld | Better-Auth: lint (Biome) | Modal (gVisor) | 0.0011 | 0.0013 |
| realworld | Better-Auth: lint (Biome) | Runloop | 0.014 | 0.019 |
| realworld | Better-Auth: lint deps (Knip) | Daytona (VM) | — | — |
| realworld | Better-Auth: lint deps (Knip) | Blaxel | <0.001 | <0.001 |
| realworld | Better-Auth: lint deps (Knip) | run.cloud | 0.66 (tied) | 0.33 |
| realworld | Better-Auth: lint deps (Knip) | Novita | 0.61 (tied) | 0.12 |
| realworld | Better-Auth: lint deps (Knip) | Namespace | 0.14 (tied) | 0.019 |
| realworld | Better-Auth: lint deps (Knip) | Microsandbox Cloud | 0.48 (tied) | 0.19 |
| realworld | Better-Auth: lint deps (Knip) | Modal (VM) | 0.32 (tied) | 0.19 |
| realworld | Better-Auth: lint deps (Knip) | Vercel Sandbox | <0.001 | <0.001 |
| realworld | Better-Auth: lint deps (Knip) | tama | 0.0038 | 0.012 |
| realworld | Better-Auth: lint deps (Knip) | Modal (gVisor) | 0.0044 | 0.012 |
| realworld | Better-Auth: lint deps (Knip) | E2B | 0.89 (tied) | 0.19 |
| realworld | Better-Auth: lint deps (Knip) | Runloop | <0.001 | <0.001 |
| realworld | Better-Auth: lint format | Daytona (VM) | — | — |
| realworld | Better-Auth: lint format | Namespace | 0.014 | 0.019 |
| realworld | Better-Auth: lint format | run.cloud | 0.58 (tied) | 0.91 |
| realworld | Better-Auth: lint format | Novita | 1.0 (tied) | 0.35 |
| realworld | Better-Auth: lint format | Blaxel | 0.48 (tied) | 0.19 |
| realworld | Better-Auth: lint format | Microsandbox Cloud | 0.052 (tied) | 0.066 |
| realworld | Better-Auth: lint format | Modal (VM) | 0.24 (tied) | 0.19 |
| realworld | Better-Auth: lint format | tama | 0.042 | 0.077 |
| realworld | Better-Auth: lint format | Modal (gVisor) | 1.0 (tied) | 0.98 |
| realworld | Better-Auth: lint format | Vercel Sandbox | 0.89 (tied) | 0.43 |
| realworld | Better-Auth: lint format | E2B | 0.20 (tied) | 0.019 |
| realworld | Better-Auth: lint format | Runloop | <0.001 | <0.001 |
| realworld | Better-Auth: lint packages | Daytona (VM) | — | — |
| realworld | Better-Auth: lint packages | run.cloud | <0.001 | <0.001 |
| realworld | Better-Auth: lint packages | tama | 0.75 (tied) | 0.95 |
| realworld | Better-Auth: lint packages | Blaxel | 0.77 (tied) | 0.81 |
| realworld | Better-Auth: lint packages | Namespace | 0.41 (tied) | 0.43 |
| realworld | Better-Auth: lint packages | Novita | 0.72 (tied) | 0.43 |
| realworld | Better-Auth: lint packages | Microsandbox Cloud | <0.001 | <0.001 |
| realworld | Better-Auth: lint packages | Modal (VM) | 0.12 (tied) | 0.19 |
| realworld | Better-Auth: lint packages | Vercel Sandbox | <0.001 | <0.001 |
| realworld | Better-Auth: lint packages | E2B | 0.0045 | <0.001 |
| realworld | Better-Auth: lint packages | Modal (gVisor) | <0.001 | <0.001 |
| realworld | Better-Auth: lint packages | Runloop | <0.001 | <0.001 |
| realworld | Better-Auth: lint spell | Daytona (VM) | — | — |
| realworld | Better-Auth: lint spell | Blaxel | <0.001 | <0.001 |
| realworld | Better-Auth: lint spell | Novita | 0.020 | 0.019 |
| realworld | Better-Auth: lint spell | run.cloud | 0.74 (tied) | 0.13 |
| realworld | Better-Auth: lint spell | Namespace | 0.53 (tied) | 0.65 |
| realworld | Better-Auth: lint spell | Modal (VM) | 0.48 (tied) | 0.066 |
| realworld | Better-Auth: lint spell | Microsandbox Cloud | 0.48 (tied) | 0.79 |
| realworld | Better-Auth: lint spell | Modal (gVisor) | 0.0023 | 0.019 |
| realworld | Better-Auth: lint spell | Vercel Sandbox | 0.089 (tied) | 0.066 |
| realworld | Better-Auth: lint spell | tama | 0.68 (tied) | 0.32 |
| realworld | Better-Auth: lint spell | E2B | 0.21 (tied) | 0.077 |
| realworld | Better-Auth: lint spell | Runloop | <0.001 | <0.001 |
| realworld | Better-Auth: lint types | Daytona (VM) | — | — |
| realworld | Better-Auth: lint types | Blaxel | <0.001 | <0.001 |
| realworld | Better-Auth: lint types | Novita | 0.0056 | 0.0046 |
| realworld | Better-Auth: lint types | run.cloud | 0.023 | 0.026 |
| realworld | Better-Auth: lint types | Modal (VM) | 0.41 (tied) | 0.036 |
| realworld | Better-Auth: lint types | tama | 0.52 (tied) | 0.81 |
| realworld | Better-Auth: lint types | Namespace | 0.68 (tied) | 0.55 |
| realworld | Better-Auth: lint types | Microsandbox Cloud | 1.0 (tied) | 0.43 |
| realworld | Better-Auth: lint types | Vercel Sandbox | 1.0 (tied) | 0.066 |
| realworld | Better-Auth: lint types | E2B | 0.052 (tied) | 0.0046 |
| realworld | Better-Auth: lint types | Modal (gVisor) | 0.020 | 0.066 |
| realworld | Better-Auth: lint types | Runloop | <0.001 | <0.001 |
| realworld | Better-Auth: typecheck | Daytona (VM) | — | — |
| realworld | Better-Auth: typecheck | run.cloud | <0.001 | <0.001 |
| realworld | Better-Auth: typecheck | Novita | 0.93 (tied) | 0.13 |
| realworld | Better-Auth: typecheck | Blaxel | 0.44 (tied) | 0.43 |
| realworld | Better-Auth: typecheck | tama | 0.042 | 0.032 |
| realworld | Better-Auth: typecheck | Namespace | 0.95 (tied) | 0.32 |
| realworld | Better-Auth: typecheck | Modal (VM) | 0.93 (tied) | 0.43 |
| realworld | Better-Auth: typecheck | Microsandbox Cloud | 0.55 (tied) | 0.79 |
| realworld | Better-Auth: typecheck | Modal (gVisor) | 0.63 (tied) | 0.79 |
| realworld | Better-Auth: typecheck | Vercel Sandbox | <0.001 | <0.001 |
| realworld | Better-Auth: typecheck | E2B | 0.93 (tied) | 0.19 |
| realworld | Better-Auth: typecheck | Runloop | <0.001 | <0.001 |
| realworld | Mastra: build:core | Daytona (VM) | — | — |
| realworld | Mastra: build:core | run.cloud | <0.001 | 0.0076 |
| realworld | Mastra: build:core | Blaxel | 0.25 (tied) | 0.23 |
| realworld | Mastra: build:core | Novita | 0.44 (tied) | 0.43 |
| realworld | Mastra: build:core | Namespace | <0.001 | <0.001 |
| realworld | Mastra: build:core | tama | 0.73 (tied) | 0.44 |
| realworld | Mastra: build:core | Modal (VM) | 0.54 (tied) | 0.89 |
| realworld | Mastra: build:core | Microsandbox Cloud | 0.38 (tied) | 0.55 |
| realworld | Mastra: build:core | Modal (gVisor) | 0.60 (tied) | 0.32 |
| realworld | Mastra: build:core | Vercel Sandbox | 0.51 (tied) | 0.066 |
| realworld | Mastra: build:core | E2B | 0.0045 | <0.001 |
| realworld | Mastra: build:core | Runloop | <0.001 | <0.001 |
| realworld | Mastra: git clone | Blaxel | — | — |
| realworld | Mastra: git clone | Namespace | 0.0053 | 0.0046 |
| realworld | Mastra: git clone | Daytona (VM) | <0.001 | 0.0046 |
| realworld | Mastra: git clone | Modal (VM) | 1.0 (tied) | 0.79 |
| realworld | Mastra: git clone | Vercel Sandbox | 0.39 (tied) | 0.43 |
| realworld | Mastra: git clone | Microsandbox Cloud | 0.013 | 0.012 |
| realworld | Mastra: git clone | run.cloud | 0.61 (tied) | 0.34 |
| realworld | Mastra: git clone | Novita | 0.96 (tied) | 0.087 |
| realworld | Mastra: git clone | Modal (gVisor) | 0.58 (tied) | 0.066 |
| realworld | Mastra: git clone | E2B | 0.35 (tied) | 0.43 |
| realworld | Mastra: git clone | tama | 0.17 (tied) | 0.14 |
| realworld | Mastra: git clone | Runloop | 0.36 (tied) | 0.14 |
| realworld | Mastra: lint:format | Daytona (VM) | — | — |
| realworld | Mastra: lint:format | run.cloud | 0.42 (tied) | 0.045 |
| realworld | Mastra: lint:format | Blaxel | 0.030 | 0.13 |
| realworld | Mastra: lint:format | Namespace | 0.060 (tied) | 0.019 |
| realworld | Mastra: lint:format | Novita | 0.44 (tied) | 0.19 |
| realworld | Mastra: lint:format | Modal (VM) | <0.001 | <0.001 |
| realworld | Mastra: lint:format | tama | 0.54 (tied) | 0.25 |
| realworld | Mastra: lint:format | Microsandbox Cloud | 0.23 (too few sandboxes) | 0.26 |
| realworld | Mastra: lint:format | Modal (gVisor) | 0.86 (tied) | 0.55 |
| realworld | Mastra: lint:format | Vercel Sandbox | 0.18 (tied) | 0.019 |
| realworld | Mastra: lint:format | E2B | 0.0083 | <0.001 |
| realworld | Mastra: lint:format | Runloop | <0.001 | <0.001 |
| realworld | OpenClaw: cold install | Blaxel | — | — |
| realworld | OpenClaw: cold install | Daytona (VM) | 0.67 (tied) | 0.43 |
| realworld | OpenClaw: cold install | Namespace | 0.0018 | 0.0046 |
| realworld | OpenClaw: cold install | Novita | 0.045 | 0.066 |
| realworld | OpenClaw: cold install | run.cloud | 0.65 (tied) | 0.33 |
| realworld | OpenClaw: cold install | Microsandbox Cloud | 0.32 (tied) | 0.040 |
| realworld | OpenClaw: cold install | Vercel Sandbox | 0.045 | 0.066 |
| realworld | OpenClaw: cold install | Modal (VM) | 0.20 (tied) | 0.43 |
| realworld | OpenClaw: cold install | E2B | 0.017 | 0.019 |
| realworld | OpenClaw: cold install | Modal (gVisor) | 0.67 (tied) | 0.99 |
| realworld | OpenClaw: cold install | Runloop | <0.001 | <0.001 |
| realworld | OpenClaw: git clone | Blaxel | — | — |
| realworld | OpenClaw: git clone | Namespace | 0.0056 | 0.0046 |
| realworld | OpenClaw: git clone | Daytona (VM) | 0.35 (tied) | 0.43 |
| realworld | OpenClaw: git clone | Microsandbox Cloud | 0.18 (tied) | 0.019 |
| realworld | OpenClaw: git clone | Vercel Sandbox | 0.0011 | <0.001 |
| realworld | OpenClaw: git clone | E2B | <0.001 | <0.001 |
| realworld | OpenClaw: git clone | run.cloud | 0.98 (tied) | 0.33 |
| realworld | OpenClaw: git clone | Modal (gVisor) | 0.32 (tied) | 0.036 |
| realworld | OpenClaw: git clone | Runloop | <0.001 | <0.001 |
| realworld | OpenClaw: git clone | Modal (VM) | 0.63 (tied) | 0.43 |
| realworld | OpenClaw: git clone | Novita | 0.14 (tied) | 0.066 |
| realworld | OpenClaw: lint (extension channels) | Daytona (VM) | — | — |
| realworld | OpenClaw: lint (extension channels) | run.cloud | <0.001 | <0.001 |
| realworld | OpenClaw: lint (extension channels) | Blaxel | 0.65 (tied) | 0.55 |
| realworld | OpenClaw: lint (extension channels) | Novita | 0.14 (tied) | 0.066 |
| realworld | OpenClaw: lint (extension channels) | Microsandbox Cloud | <0.001 | <0.001 |
| realworld | OpenClaw: lint (extension channels) | Modal (VM) | 0.67 (tied) | 0.43 |
| realworld | OpenClaw: lint (extension channels) | Namespace | 0.35 (tied) | 0.19 |
| realworld | OpenClaw: lint (extension channels) | Vercel Sandbox | 0.039 | <0.001 |
| realworld | OpenClaw: lint (extension channels) | E2B | 0.039 | 0.019 |
| realworld | OpenClaw: lint (extension channels) | Modal (gVisor) | 0.51 (tied) | 0.43 |
| realworld | OpenClaw: lint (extension channels) | Runloop | <0.001 | <0.001 |
| realworld | OpenClaw: typecheck (test tree) | Daytona (VM) | — | — |
| realworld | OpenClaw: typecheck (test tree) | run.cloud | <0.001 | <0.001 |
| realworld | OpenClaw: typecheck (test tree) | Novita | 0.059 (tied) | 0.091 |
| realworld | OpenClaw: typecheck (test tree) | Microsandbox Cloud | <0.001 | <0.001 |
| realworld | OpenClaw: typecheck (test tree) | Modal (VM) | 0.67 (tied) | 0.43 |
| realworld | OpenClaw: typecheck (test tree) | Namespace | 0.41 (tied) | 0.43 |
| realworld | OpenClaw: typecheck (test tree) | Vercel Sandbox | 0.014 | 0.0046 |
| realworld | OpenClaw: typecheck (test tree) | Modal (gVisor) | <0.001 | <0.001 |
| realworld | OpenClaw: typecheck (test tree) | E2B | 1.0 (tied) | 0.43 |
| realworld | OpenClaw: typecheck (test tree) | Runloop | <0.001 | <0.001 |
| realworld | OpenClaw: typecheck (tsgo) | Daytona (VM) | — | — |
| realworld | OpenClaw: typecheck (tsgo) | Blaxel | <0.001 | <0.001 |
| realworld | OpenClaw: typecheck (tsgo) | run.cloud | 0.32 (tied) | 0.55 |
| realworld | OpenClaw: typecheck (tsgo) | Microsandbox Cloud | 0.0013 | <0.001 |
| realworld | OpenClaw: typecheck (tsgo) | Novita | 0.76 (tied) | 0.43 |
| realworld | OpenClaw: typecheck (tsgo) | Namespace | 0.41 (tied) | 0.19 |
| realworld | OpenClaw: typecheck (tsgo) | Modal (VM) | 0.98 (tied) | 0.43 |
| realworld | OpenClaw: typecheck (tsgo) | Vercel Sandbox | <0.001 | <0.001 |
| realworld | OpenClaw: typecheck (tsgo) | Modal (gVisor) | 0.63 (tied) | 0.066 |
| realworld | OpenClaw: typecheck (tsgo) | E2B | 0.44 (tied) | 0.066 |
| realworld | OpenClaw: typecheck (tsgo) | Runloop | <0.001 | <0.001 |
| cpu | Node.js web tooling | Daytona (VM) | — | — |
| cpu | Node.js web tooling | Blaxel | 0.70 (too few sandboxes) | <0.001 |
| cpu | Node.js web tooling | Novita | 0.10 (too few sandboxes) | <0.001 |
| cpu | Node.js web tooling | Microsandbox Cloud | 0.20 (too few sandboxes) | 0.0011 |
| cpu | Node.js web tooling | Modal (VM) | 0.10 (too few sandboxes) | <0.001 |
| cpu | Node.js web tooling | Modal (gVisor) | 0.10 (too few sandboxes) | <0.001 |
| cpu | Node.js web tooling | Vercel Sandbox | 0.40 (too few sandboxes) | 0.029 |
| cpu | Node.js web tooling | Namespace | 1.0 (too few sandboxes) | 0.040 |
| cpu | Node.js web tooling | E2B | 1.0 (too few sandboxes) | 0.016 |
| cpu | Node.js web tooling | run.cloud | 0.20 (too few sandboxes) | <0.001 |
| cpu | Node.js web tooling | Runloop | 0.20 (too few sandboxes) | <0.001 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Microsandbox Cloud | — | — |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Blaxel | 0.70 (too few sandboxes) | 0.32 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Vercel Sandbox | 0.20 (too few sandboxes) | 0.32 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Daytona (VM) | 0.40 (too few sandboxes) | 0.077 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Modal (VM) | 0.70 (too few sandboxes) | 0.32 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | run.cloud | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Modal (gVisor) | 0.70 (too few sandboxes) | 0.077 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | Novita | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | tama | 1.0 (too few sandboxes) | 0.81 |
| disk | fio rand read 4KB, O_DIRECT (IOPS) | E2B | 0.10 (too few sandboxes) | 0.012 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Microsandbox Cloud | — | — |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Blaxel | 0.70 (too few sandboxes) | 0.32 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Vercel Sandbox | 0.10 (too few sandboxes) | 0.32 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Daytona (VM) | 0.40 (too few sandboxes) | 0.077 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Modal (VM) | 0.70 (too few sandboxes) | 0.32 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | run.cloud | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Modal (gVisor) | 0.70 (too few sandboxes) | 0.077 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | Novita | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | tama | 1.0 (too few sandboxes) | 1.0 |
| disk | fio rand read 4KB, O_DIRECT (MB/s) | E2B | 0.10 (too few sandboxes) | 0.012 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Vercel Sandbox | — | — |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Blaxel | 0.70 (too few sandboxes) | 0.077 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Namespace | 0.70 (too few sandboxes) | 0.81 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Modal (VM) | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Daytona (VM) | 0.10 (too few sandboxes) | 0.077 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | run.cloud | 0.10 (too few sandboxes) | 0.012 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Runloop | 0.10 (too few sandboxes) | 0.32 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.32 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Modal (gVisor) | 1.0 (too few sandboxes) | 0.81 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | Novita | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | tama | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand write 4KB, O_DIRECT (IOPS) | E2B | 0.40 (too few sandboxes) | 0.012 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Vercel Sandbox | — | — |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Blaxel | 0.70 (too few sandboxes) | 0.077 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Namespace | 0.70 (too few sandboxes) | 0.81 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Modal (VM) | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Daytona (VM) | 0.10 (too few sandboxes) | 0.012 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | run.cloud | 0.10 (too few sandboxes) | 0.012 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Runloop | 0.10 (too few sandboxes) | 0.32 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.32 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Modal (gVisor) | 1.0 (too few sandboxes) | 0.81 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | Novita | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | tama | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio rand write 4KB, O_DIRECT (MB/s) | E2B | 0.40 (too few sandboxes) | 0.012 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Modal (gVisor) | — | — |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Novita | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Blaxel | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Microsandbox Cloud | 0.70 (too few sandboxes) | 0.81 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Daytona (VM) | 0.40 (too few sandboxes) | 0.077 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | run.cloud | 1.0 (too few sandboxes) | 0.81 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Vercel Sandbox | 0.70 (too few sandboxes) | 0.32 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Runloop | 0.40 (too few sandboxes) | 0.32 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | Modal (VM) | 0.40 (too few sandboxes) | 0.077 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | tama | 0.40 (too few sandboxes) | 0.077 |
| disk | fio seq read 1MB, O_DIRECT (IOPS) | E2B | 0.10 (too few sandboxes) | 0.077 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | Blaxel | — | — |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | Microsandbox Cloud | 0.70 (too few sandboxes) | 0.81 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | Daytona (VM) | 0.40 (too few sandboxes) | 0.077 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | run.cloud | 1.0 (too few sandboxes) | 0.65 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | Vercel Sandbox | 0.70 (too few sandboxes) | 0.65 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | Runloop | 0.40 (too few sandboxes) | 0.32 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | Modal (VM) | 0.40 (too few sandboxes) | 0.077 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | tama | 0.40 (too few sandboxes) | 0.077 |
| disk | fio seq read 1MB, O_DIRECT (MB/s) | E2B | 0.10 (too few sandboxes) | 0.077 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Novita | — | — |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Blaxel | 0.10 (too few sandboxes) | 0.077 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Microsandbox Cloud | 1.0 (too few sandboxes) | 0.81 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Modal (gVisor) | 0.40 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Daytona (VM) | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Vercel Sandbox | 1.0 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Modal (VM) | 1.0 (too few sandboxes) | 0.81 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | run.cloud | 0.70 (too few sandboxes) | 0.81 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Namespace | 0.10 (too few sandboxes) | 0.077 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | tama | 0.70 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | Runloop | 0.20 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (IOPS) | E2B | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Novita | — | — |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Blaxel | 0.10 (too few sandboxes) | 0.077 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Microsandbox Cloud | 1.0 (too few sandboxes) | 0.81 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Modal (gVisor) | 0.40 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Daytona (VM) | 0.10 (too few sandboxes) | 0.0013 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Vercel Sandbox | 1.0 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Modal (VM) | 1.0 (too few sandboxes) | 0.81 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | run.cloud | 0.70 (too few sandboxes) | 0.81 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Namespace | 0.10 (too few sandboxes) | 0.077 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | tama | 0.70 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | Runloop | 0.20 (too few sandboxes) | 0.32 |
| disk | fio seq write 1MB, O_DIRECT (MB/s) | E2B | 0.10 (too few sandboxes) | 0.0013 |
| disk | Hardlink throughput | Daytona (VM) | — | — |
| disk | Hardlink throughput | Blaxel | 0.10 (too few sandboxes) | 0.0013 |
| disk | Hardlink throughput | Novita | 0.10 (too few sandboxes) | 0.0013 |
| disk | Hardlink throughput | Vercel Sandbox | 0.10 (too few sandboxes) | 0.0013 |
| disk | Hardlink throughput | Runloop | 0.70 (too few sandboxes) | 0.81 |
| disk | Hardlink throughput | Microsandbox Cloud | 0.70 (too few sandboxes) | 0.81 |
| disk | Hardlink throughput | Modal (VM) | 0.10 (too few sandboxes) | 0.0013 |
| disk | Hardlink throughput | tama | 0.10 (too few sandboxes) | 0.0013 |
| disk | Hardlink throughput | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| disk | Hardlink throughput | run.cloud | 0.60 (too few sandboxes) | 0.077 |
| disk | Hardlink throughput | Modal (gVisor) | 0.40 (too few sandboxes) | 0.077 |
| disk | Hardlink throughput | E2B | 0.10 (too few sandboxes) | 0.0013 |
| memory | STREAM Triad | Daytona (VM) | — | — |
| memory | STREAM Triad | Blaxel | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Triad | Modal (gVisor) | 0.70 (too few sandboxes) | 0.14 |
| memory | STREAM Triad | Modal (VM) | 1.0 (too few sandboxes) | 0.31 |
| memory | STREAM Triad | Microsandbox Cloud | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Triad | Novita | 0.70 (too few sandboxes) | 0.051 |
| memory | STREAM Triad | Vercel Sandbox | 0.70 (too few sandboxes) | 0.31 |
| memory | STREAM Triad | E2B | 0.40 (too few sandboxes) | 0.0011 |
| memory | STREAM Triad | Namespace | 0.50 (too few sandboxes) | <0.001 |
| memory | STREAM Triad | run.cloud | 0.67 (too few sandboxes) | 0.11 |
| memory | STREAM Triad | Runloop | 0.67 (too few sandboxes) | 0.012 |
| memory | STREAM Add | Daytona (VM) | — | — |
| memory | STREAM Add | Blaxel | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Add | Modal (VM) | 0.40 (too few sandboxes) | 0.017 |
| memory | STREAM Add | Modal (gVisor) | 1.0 (too few sandboxes) | 0.31 |
| memory | STREAM Add | Microsandbox Cloud | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Add | Novita | 0.70 (too few sandboxes) | 0.051 |
| memory | STREAM Add | Vercel Sandbox | 0.70 (too few sandboxes) | 0.31 |
| memory | STREAM Add | E2B | 0.40 (too few sandboxes) | 0.0011 |
| memory | STREAM Add | Namespace | 0.50 (too few sandboxes) | <0.001 |
| memory | STREAM Add | run.cloud | 0.67 (too few sandboxes) | 0.012 |
| memory | STREAM Add | Runloop | 0.67 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | Daytona (VM) | — | — |
| memory | STREAM Copy | Blaxel | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | Modal (gVisor) | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | Modal (VM) | 1.0 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | Vercel Sandbox | 0.40 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | E2B | 0.70 (too few sandboxes) | 0.0075 |
| memory | STREAM Copy | Microsandbox Cloud | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | Novita | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | run.cloud | 0.20 (too few sandboxes) | <0.001 |
| memory | STREAM Copy | Namespace | 1.0 (too few sandboxes) | 0.089 |
| memory | STREAM Copy | Runloop | <0.001 | <0.001 |
| memory | STREAM Scale | Daytona (VM) | — | — |
| memory | STREAM Scale | Blaxel | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Scale | Modal (VM) | 1.0 (too few sandboxes) | 0.051 |
| memory | STREAM Scale | Modal (gVisor) | 1.0 (too few sandboxes) | 0.31 |
| memory | STREAM Scale | Novita | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Scale | Vercel Sandbox | 0.10 (too few sandboxes) | <0.001 |
| memory | STREAM Scale | E2B | 1.0 (too few sandboxes) | 0.59 |
| memory | STREAM Scale | Microsandbox Cloud | 0.70 (too few sandboxes) | 0.14 |
| memory | STREAM Scale | Namespace | 0.50 (too few sandboxes) | <0.001 |
| memory | STREAM Scale | run.cloud | 0.67 (too few sandboxes) | 0.012 |
| memory | STREAM Scale | Runloop | 0.67 (too few sandboxes) | <0.001 |
| network | iperf3 loopback TCP, 1 stream | Novita | — | — |
| network | iperf3 loopback TCP, 1 stream | Blaxel | 0.10 (too few sandboxes) | 0.012 |
| network | iperf3 loopback TCP, 1 stream | Daytona (VM) | 0.10 (too few sandboxes) | 0.012 |
| network | iperf3 loopback TCP, 1 stream | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.012 |
| network | iperf3 loopback TCP, 1 stream | E2B | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 loopback TCP, 1 stream | Vercel Sandbox | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 loopback TCP, 1 stream | Namespace | 0.10 (too few sandboxes) | 0.012 |
| network | iperf3 loopback TCP, 1 stream | run.cloud | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 loopback TCP, 1 stream | Runloop | 0.70 (too few sandboxes) | 0.077 |
| network | iperf3 loopback TCP, 1 stream | Modal (gVisor) | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 loopback TCP, 1 stream | Modal (VM) | 0.70 (too few sandboxes) | 0.077 |
| network | iperf3 loopback TCP, 10 streams | Novita | — | — |
| network | iperf3 loopback TCP, 10 streams | Blaxel | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 loopback TCP, 10 streams | Daytona (VM) | 0.10 (too few sandboxes) | 0.012 |
| network | iperf3 loopback TCP, 10 streams | Microsandbox Cloud | 0.70 (too few sandboxes) | 0.077 |
| network | iperf3 loopback TCP, 10 streams | Vercel Sandbox | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 loopback TCP, 10 streams | run.cloud | 0.70 (too few sandboxes) | 0.81 |
| network | iperf3 loopback TCP, 10 streams | Namespace | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 loopback TCP, 10 streams | E2B | 1.0 (too few sandboxes) | 0.32 |
| network | iperf3 loopback TCP, 10 streams | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 loopback TCP, 10 streams | Modal (gVisor) | 0.10 (too few sandboxes) | 0.012 |
| network | iperf3 loopback TCP, 10 streams | Modal (VM) | 0.20 (too few sandboxes) | 0.32 |
| network | iperf3 loopback UDP, 10G objective | Modal (VM) | — | — |
| network | iperf3 loopback UDP, 10G objective | Blaxel | 0.10 (too few sandboxes) | 0.32 |
| network | iperf3 loopback UDP, 10G objective | Daytona (VM) | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | E2B | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | Microsandbox Cloud | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | Namespace | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | Novita | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | run.cloud | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | Runloop | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | Vercel Sandbox | 1.0 (too few sandboxes, equal medians) | 1.0 |
| network | iperf3 loopback UDP, 10G objective | Modal (gVisor) | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 WAN download | Vercel Sandbox | — | — |
| network | iperf3 WAN download | Daytona (VM) | 0.70 (too few sandboxes) | 0.012 |
| network | iperf3 WAN download | Novita | 0.10 (too few sandboxes) | 0.32 |
| network | iperf3 WAN download | Microsandbox Cloud | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 WAN download | Modal (gVisor) | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 WAN download | Blaxel | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 WAN download | run.cloud | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 WAN download | Modal (VM) | 0.70 (too few sandboxes) | 0.32 |
| network | iperf3 WAN download | Runloop | 0.10 (too few sandboxes) | 0.077 |
| network | iperf3 WAN download | E2B | 0.70 (too few sandboxes) | 0.32 |
| network | iperf3 WAN download | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 WAN upload | Modal (VM) | — | — |
| network | iperf3 WAN upload | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 WAN upload | Modal (gVisor) | 0.40 (too few sandboxes) | 0.077 |
| network | iperf3 WAN upload | Novita | 1.0 (too few sandboxes) | 0.32 |
| network | iperf3 WAN upload | Vercel Sandbox | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 WAN upload | Daytona (VM) | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 WAN upload | Blaxel | 0.70 (too few sandboxes) | 0.32 |
| network | iperf3 WAN upload | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.0013 |
| network | iperf3 WAN upload | E2B | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 WAN upload | run.cloud | 1.0 (too few sandboxes) | 0.81 |
| network | iperf3 WAN upload | Runloop | 0.10 (too few sandboxes) | 0.012 |
| system | PyBench | Namespace | — | — |
| system | PyBench | Daytona (VM) | 0.10 (too few sandboxes) | 0.0013 |
| system | PyBench | Modal (VM) | 0.10 (too few sandboxes) | 0.0013 |
| system | PyBench | Blaxel | 0.70 (too few sandboxes) | 0.077 |
| system | PyBench | Novita | 0.70 (too few sandboxes) | 0.077 |
| system | PyBench | run.cloud | 1.0 (too few sandboxes, equal medians) | 1.0 |
| system | PyBench | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.0013 |
| system | PyBench | tama | 0.10 (too few sandboxes) | 0.012 |
| system | PyBench | Vercel Sandbox | 0.10 (too few sandboxes) | 0.0013 |
| system | PyBench | Modal (gVisor) | 0.60 (too few sandboxes) | 0.077 |
| system | PyBench | E2B | 0.60 (too few sandboxes) | 0.077 |
| system | PyBench | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| system | Git common operations | run.cloud | — | — |
| system | Git common operations | Daytona (VM) | 0.20 (too few sandboxes) | 0.077 |
| system | Git common operations | Modal (VM) | 0.10 (too few sandboxes) | 0.0013 |
| system | Git common operations | Namespace | 0.70 (too few sandboxes) | 0.32 |
| system | Git common operations | Blaxel | 0.40 (too few sandboxes) | 0.32 |
| system | Git common operations | Novita | 0.70 (too few sandboxes) | 0.077 |
| system | Git common operations | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.0013 |
| system | Git common operations | tama | 0.10 (too few sandboxes) | 0.012 |
| system | Git common operations | Vercel Sandbox | 0.10 (too few sandboxes) | 0.0013 |
| system | Git common operations | Modal (gVisor) | 0.70 (too few sandboxes) | 0.077 |
| system | Git common operations | E2B | 0.70 (too few sandboxes) | 0.077 |
| system | Git common operations | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO (s100, 50c) | tama | — | — |
| system | pgbench RO (s100, 50c) | Blaxel | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO (s100, 50c) | Daytona (VM) | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO (s100, 50c) | Novita | 0.40 (too few sandboxes) | 0.32 |
| system | pgbench RO (s100, 50c) | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO (s100, 50c) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO (s100, 50c) | Modal (VM) | 0.70 (too few sandboxes) | 0.077 |
| system | pgbench RO (s100, 50c) | E2B | 0.40 (too few sandboxes) | 0.077 |
| system | pgbench RO (s100, 50c) | Vercel Sandbox | 1.0 (too few sandboxes) | 0.077 |
| system | pgbench RO (s100, 50c) | run.cloud | 1.0 (too few sandboxes) | 0.44 |
| system | pgbench RO (s100, 50c) | Modal (gVisor) | 0.20 (too few sandboxes) | 0.0047 |
| system | pgbench RO (s100, 50c) | Runloop | 0.20 (too few sandboxes) | 0.012 |
| system | pgbench RO latency (s100, 50c) | tama | — | — |
| system | pgbench RO latency (s100, 50c) | Blaxel | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO latency (s100, 50c) | Daytona (VM) | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO latency (s100, 50c) | Novita | 0.30 (too few sandboxes) | 0.32 |
| system | pgbench RO latency (s100, 50c) | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO latency (s100, 50c) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RO latency (s100, 50c) | Modal (VM) | 0.60 (too few sandboxes) | 0.077 |
| system | pgbench RO latency (s100, 50c) | E2B | 0.40 (too few sandboxes) | 0.077 |
| system | pgbench RO latency (s100, 50c) | Vercel Sandbox | 1.0 (too few sandboxes) | 0.077 |
| system | pgbench RO latency (s100, 50c) | run.cloud | 1.0 (too few sandboxes) | 0.44 |
| system | pgbench RO latency (s100, 50c) | Modal (gVisor) | 0.20 (too few sandboxes) | 0.0047 |
| system | pgbench RO latency (s100, 50c) | Runloop | 0.20 (too few sandboxes) | 0.012 |
| system | pgbench RW (s100, 50c) | Novita | — | — |
| system | pgbench RW (s100, 50c) | Blaxel | 0.10 (too few sandboxes) | 0.012 |
| system | pgbench RW (s100, 50c) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RW (s100, 50c) | Vercel Sandbox | 0.10 (too few sandboxes) | 0.012 |
| system | pgbench RW (s100, 50c) | run.cloud | 1.0 (too few sandboxes) | 0.44 |
| system | pgbench RW (s100, 50c) | Daytona (VM) | 1.0 (too few sandboxes) | 0.44 |
| system | pgbench RW (s100, 50c) | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.012 |
| system | pgbench RW (s100, 50c) | Modal (VM) | 0.70 (too few sandboxes) | 0.077 |
| system | pgbench RW (s100, 50c) | E2B | 0.40 (too few sandboxes) | 0.077 |
| system | pgbench RW (s100, 50c) | tama | 0.70 (too few sandboxes) | 0.81 |
| system | pgbench RW (s100, 50c) | Modal (gVisor) | 0.20 (too few sandboxes) | 0.077 |
| system | pgbench RW (s100, 50c) | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RW latency (s100, 50c) | Novita | — | — |
| system | pgbench RW latency (s100, 50c) | Blaxel | 0.10 (too few sandboxes) | 0.012 |
| system | pgbench RW latency (s100, 50c) | Namespace | 0.10 (too few sandboxes) | 0.0013 |
| system | pgbench RW latency (s100, 50c) | Vercel Sandbox | 0.10 (too few sandboxes) | 0.012 |
| system | pgbench RW latency (s100, 50c) | run.cloud | 1.0 (too few sandboxes) | 0.44 |
| system | pgbench RW latency (s100, 50c) | Daytona (VM) | 1.0 (too few sandboxes) | 0.44 |
| system | pgbench RW latency (s100, 50c) | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.012 |
| system | pgbench RW latency (s100, 50c) | Modal (VM) | 0.70 (too few sandboxes) | 0.077 |
| system | pgbench RW latency (s100, 50c) | E2B | 0.40 (too few sandboxes) | 0.077 |
| system | pgbench RW latency (s100, 50c) | tama | 0.70 (too few sandboxes) | 0.81 |
| system | pgbench RW latency (s100, 50c) | Modal (gVisor) | 0.40 (too few sandboxes) | 0.077 |
| system | pgbench RW latency (s100, 50c) | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| system | SQLite Speedtest | Daytona (VM) | — | — |
| system | SQLite Speedtest | Modal (VM) | 0.10 (too few sandboxes) | 0.0013 |
| system | SQLite Speedtest | Blaxel | 0.70 (too few sandboxes) | 0.077 |
| system | SQLite Speedtest | Novita | 0.70 (too few sandboxes) | 0.077 |
| system | SQLite Speedtest | Microsandbox Cloud | 0.10 (too few sandboxes) | 0.0013 |
| system | SQLite Speedtest | run.cloud | 0.10 (too few sandboxes) | 0.0013 |
| system | SQLite Speedtest | Namespace | 0.40 (too few sandboxes) | 0.32 |
| system | SQLite Speedtest | tama | 0.70 (too few sandboxes) | 0.32 |
| system | SQLite Speedtest | Vercel Sandbox | 0.10 (too few sandboxes) | 0.0013 |
| system | SQLite Speedtest | E2B | 0.10 (too few sandboxes) | 0.0013 |
| system | SQLite Speedtest | Runloop | 0.10 (too few sandboxes) | 0.0013 |
| system | SQLite Speedtest | Modal (gVisor) | 0.10 (too few sandboxes) | 0.0013 |
| economics | Hourly cost | tama | — | — |
| economics | Hourly cost | Novita | — | — |
| economics | Hourly cost | Daytona (VM) | — | — |
| economics | Hourly cost | E2B | — (equal values) | — |
| economics | Hourly cost | Runloop | — | — |

</details>

