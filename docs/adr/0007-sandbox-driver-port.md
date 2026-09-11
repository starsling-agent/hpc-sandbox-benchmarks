---
status: accepted
---

# The sandbox driver kit: one port, one file per provider, ComputeSDK as one driver

> Package layout amendment: provider implementations now live in `packages/<provider>` and own
> their SDK dependencies. `packages/drivers` is only the generated lazy loader; shared bridge
> mechanics are explicit `@sandbox-benchmarks/driver` subpaths. Daytona and Modal variants share
> one vendor package. The port, declarative configuration, and behavioral contracts below remain.

## Context

ADR-0006 makes *registering* a provider declarative. This ADR is about the other half: what a
provider has to **implement**, and what it feels like to implement it. That surface is currently
defined by `@computesdk/provider`'s `defineProvider`, and the evidence says it no longer fits.

### ComputeSDK is now the minority case

Census of the 14 registered providers on the post-Tama `main` snapshot immediately preceding this
ADR series:

| How it attaches | Count | Providers |
|---|---|---|
| Published `@computesdk/*` wrapper, unmodified | **3** | `modal-gvisor`, `modal-vm`, `namespace` |
| Published wrapper, patched through its private `.methods` table | **6** | `e2b`, `daytona-vm`, `daytona-container`, `blaxel`, `runloop`, `novita` |
| Hand-written `defineProvider` | **5** | `microsandbox-local`, `microsandbox-cloud`, `vercel`, `runcloud`, `tama` |

**Only 21% consume a wrapper as shipped, and two of those three are the same vendor.** The last
three providers added — runcloud, microsandbox, tama — are all hand-written. tama has no SDK in any
language: its entire control plane is `spawn()` on a CLI binary (`tama.ts:11`).

### The harness never depended on ComputeSDK anyway

`packages/harness` and `apps/cli` contain **zero** imports from `computesdk` or `@computesdk/*`;
`packages/harness/package.json` does not even declare it. The harness already defines its own
structural interfaces that computesdk merely happens to satisfy — five of them, each a subset of the
next: `DestroyableSandbox` (`sandbox-owner.ts:11`), `ReadinessProbeSandbox` (`readiness.ts:52`),
`SandboxFilesystem` and `SandboxHandle` (`execute.ts:117,123`), `LifecycleSandbox`
(`lifecycle.ts:79`).

**The port already exists. It is just unnamed, scattered across five files, and not the thing
providers are asked to implement.**

The GPU work proves it. When the provider abstraction didn't fit, the team routed around it:
`apps/cli/src/lib/gpu/modal.ts:77-89` builds `{ sandboxId, runCommand, destroy }` from the **native
Modal SDK** and feeds it straight to `createOwnedSandbox` / `StepRunner`. It works. A non-computesdk
driver already satisfies the harness today — outside the registry, because the registry has no shape
for it.

### What the harness actually uses vs. what `defineProvider` demands

`SandboxMethods` (`@computesdk/provider/dist/index.d.ts:689`) makes seven methods mandatory:
`create`, `getById`, `list`, `destroy`, `runCommand`, `getInfo`, `getUrl`.

| Member | Harness usage |
|---|---|
| `runCommand` | 9 call sites — the workhorse |
| `destroy` | 4 sites |
| `create` | 3 sites; the only required *provider* method |
| `sandboxId` | cost attribution |
| `getInfo` | 1 site, `lifecycle.ts:283`; return value **never inspected** — a latency probe |
| `list` | 1 site; return value **discarded** — a latency probe |
| `filesystem.readFile`/`exists` | optional fast path; every use has a `cat` fallback |
| `getById` | **never called** |
| `getUrl` | **never called** — implemented 7 times across the adapters |

`writeFile`, `mkdir`, `readdir`, `remove`, `getUrl`, `getInstance`, `runCode` are all unused.
Results don't even move over the filesystem API: they come back as a base64 tar over stdout
(`collect.ts:49-51`), chosen deliberately so it survives a full disk.

Nothing the harness does requires a capability a plain "run a shell command" port lacks. Detached
execution is a `nohup` double-fork *the harness itself writes* (`execute.ts:544-545`) with
completion observed via a done-file; snapshots are an optional lifecycle measurement whose absence is
a clean `skipped` gap.

### What the mismatch costs

**Fabricated values.** A mandatory surface wider than any vendor forces adapters to invent data —
20+ instances, including `createdAt: new Date(0)` and `timeout: 0` (`tama.ts:614,616`), an invented
snapshot id `` `${sandboxId}-snap-${Date.now().toString(36)}` `` (`microsandbox.ts:550`),
`exitCode: result.exitCode ?? 1` inventing a failure (`vercel.ts:96`), a fabricated
`{ stdout: "", stderr: "", exitCode: 0 }` for background launches (`vercel.ts:90`), and a `getUrl`
that only throws, kept because *"Required by SandboxMethods, so it cannot be omitted"*
(`microsandbox.ts:508-515`).

**Duplication the vendors did not cause.** Three byte-identical `shellQuote` implementations
(`tama.ts:214`, `runcloud.ts:359`, `microsandbox.ts:125`); four independent reinventions of the same
`nohup … &` line; five `mapStatus` functions each collapsing a richer vendor state machine into
computesdk's three values, each with a comment defending the same lossy choice; six `{ sandbox,
sandboxId }` rewraps; five near-identical `assertPatchable` guards that exist only because
`defineProvider` returns a generated class with no override point, so wrappers reach into its private
`.methods` table and clone it (`novita.ts:87`, `runloop.ts:31`, `e2b-root.ts:19`,
`blaxel-volume.ts:36`, `daytona-target.ts:37`).

**An eager import wall.** `adapters.ts:5-25` statically imports every vendor SDK, and the
`providers` barrel re-exports the composed record, so **any** import of the barrel — including
`harness/src/index.ts:9` — evaluates all twelve vendor module graphs before a single line of
benchmark code runs. Measured warm (bun 1.3.11, marginal costs sequentially in one process): the
vendor graphs add **~0.9 s** (0.8–1.1 s across runs) on top of `schema`'s ~0.6 s, led by
`@computesdk/blaxel` (~267 ms), `@computesdk/daytona` (~166 ms), `@computesdk/e2b` (~163 ms) and
`@computesdk/modal` (~131 ms). A bench job benchmarks **exactly one provider**; it pays for
fourteen, on every process start, tests included.

**A production incident.** `@computesdk/provider` gives an adapter with no `filesystem` table its
`UnsupportedFileSystem` stub — *a truthy object whose every method throws*. A truthiness check
therefore selects the filesystem poll, and every poll then throws: **12 straight failures killed a
step on namespace**, which the loop could only read as a dead sandbox (`execute.ts:404-411`). The fix
in place today is to string-match `/not supported by .*sandbox environment/i` (`execute.ts:139-152`)
to tell "never going to work" from "wedged for a moment". This is the single genuinely load-bearing
computesdk *behavior* the harness depends on, and it is a workaround for a sentinel that should have
been `undefined`.

The anatomy confirms the shape of the problem: the *long* adapters are the least shim-heavy
(tama and runcloud are ~75% real vendor logic), while the *short* ones are almost pure tax —
`vercel.ts` is ~68% adapter boilerplate over an SDK that already does the work.

### What a steelman of ComputeSDK corrects

A deliberate defense of the incumbent, run against its shipped code, corrects four things this
Context would otherwise overclaim — and each correction sharpened the Decision:

- **The duplication is partly a failure to consume, not only a surface the SDK forced.**
  `@computesdk/cmd` — a dependency of `computesdk`, in `node_modules` the whole time — ships
  `shellEscape` **byte-identical** to all three repo copies, and `shell(cmd, { background: true })`
  emits the same `nohup … >/dev/null 2>&1 &` wrapper the adapters hand-wrote; zero repo files import
  it. The boilerplate indictment stands (the *mandatory surface* still forced the fabrications), but
  §2's "own the shell mechanics once" is a consolidation ComputeSDK also attempted — one package
  deeper than anyone looked.
- **"Didn't tell us" has prior art inside ComputeSDK itself.** `daemond`'s result envelope is
  `{ exitCode: number | null; signal?: string | null; … }` — the `Exit` union's semantics, shipped
  in their newest layer while the older `CommandResult` still forces `exitCode: number`.
- **`getUrl` and the wide surface fund features, not nothing.** `getUrl` is the bootstrap for their
  streaming-exec channel (an in-sandbox daemon reached over SSE), and `getById`/`list` power a
  multi-provider facade with failover and affinity routing. Dead *for this harness* — which is the
  actual argument — not dead by design. ComputeSDK even shipped its own narrow-contract precedent,
  `defineInfraProvider` (create/getById/list/destroy, no fabricated members), and its dominant
  convention is already capability-by-presence; the throwing `UnsupportedFileSystem` stub is the one
  deviation, forced by a consumer-side non-optional field.
- **The inspectable `.methods` table is why patching was possible at all.** Six providers could be
  behavior-patched precisely because `defineProvider` keeps methods in a cloneable table rather than
  sealing them in closures. Any replacement port must preserve that property — which §2's
  method-table layer does by construction, instead of rediscovering it through `assertPatchable`.

## Decision

Own the port, and ship it as a **kit**: a contract package a driver author reads top to bottom in
five minutes, and a fleet package where one file *is* one provider's behavior. Four rules govern
every choice below; each is the repo's existing discipline (ADR-0001/0002/0003) applied to the
provider seam:

1. **One declaration per fact, joined by types.** The registry entry (ADR-0006) declares identity,
   credentials and artifact once; the driver binds to it through a single typed id parameter, and
   the env types, artifact narrowing, loader table, exports map and CI wiring are all *derived* —
   by inference, by construction, or by drift-gated codegen that reads **only the registry**.
2. **A capability is present and working, or absent.** `undefined`, never a stub that lies.
3. **Errors are values, and they all speak one grammar.** The `Exit` union for command outcomes;
   arktype's `<path> must be <expected> (was <actual>)` for every boundary parse; and at authoring
   time, compiler errors that land on the field the author got wrong.
4. **The filesystem is the authoring interface.** A driver's filename is its `ProviderId`; adding a
   provider is adding a file, not threading a record through a barrel.

The original driver-kit prototype typechecked under `--strict --exactOptionalPropertyTypes`,
including its negative (`@ts-expect-error`) cases, and its quoted error messages were captured from
the compiler/runtime. The refinements accepted here—typed handle propagation, `ResolvedArtifact`,
typed create failures, and the fleet-private bridge—MUST receive equivalent compiler and runtime
tests in the implementation. The strongest rejected alternative remains documented in §8.

### 1. Two packages: the contract and the fleet

```text
packages/
  driver/          @sandbox-benchmarks/driver — the port and the kit. Deps: schema, arktype.
    src/
      port.ts        SandboxDriver, SandboxSession, Exit, ExecResult, CreateRequest  (types only)
      define.ts      defineDriver, DriverContext, EnvOf, ArtifactOf
      env.ts         envSchemaFor — the runtime dual of EnvOf
      shell.ts       shellQuote, launchDetached, readFile — harness-owned mechanics, once
      cli.ts         cliDriver — the generic driver for CLI-only vendors
  drivers/         @sandbox-benchmarks/drivers — the fleet. Deps: driver + the vendor SDKs.
    src/
      e2b.ts  daytona-vm.ts  daytona-container.ts  tama.ts  …   filename = ProviderId
      _daytona.ts    shared variant-pair factories (underscore = not a provider, generator skips)
      _computesdk.ts private computeSdkDriver bridge (underscore = not a provider)
      index.ts       the generated loader table (drift-gated)
```

Narrow exports, in the computesdk spirit of small surfaces over a common core:

- `@sandbox-benchmarks/driver` exports `.` (port + `defineDriver` + shell mechanics) and `./cli`.
  It has no ComputeSDK dependency.
- `@sandbox-benchmarks/drivers` exports one subpath per provider (`./tama`, `./e2b`, …) plus a root
  that contains **only** the loader table. The subpath list is generated from the registry and
  drift-gated, like every other projection of it. `_computesdk.ts` is fleet-private, so only
  bridge-backed driver files can import it and its cost remains lazy.

The dependency flip is the architectural payoff: `@sandbox-benchmarks/harness` drops its dependency
on the providers barrel (`harness/package.json` → `@sandbox-benchmarks/providers` today) and depends
on **`driver` for provider behavior** while retaining its existing `schema` dependency. The
harness's five overlapping structural interfaces collapse into the one
named port; vendor SDKs leave its transitive graph entirely, and ADR-0002's DAG check enforces that
they stay out. `apps/cli` is the only place the fleet and the harness meet.

**Generation flows registry → outward, never fleet → inward.** Every generated projection (loader,
exports map, CI regions) needs only the id list and credential names, which the registry already
owns — so the generator never imports a driver module and never evaluates a vendor SDK. The
fleet-side drift check is a file-existence and default-export-shape check, not a
thirteen-vendor-module evaluation on every PR. This directionality is load-bearing; §8 shows what
breaks without it.

The current `@sandbox-benchmarks/providers` package is retired when the migration finishes; it does
not remain as a third owner of provider facts. Its contents move by responsibility:

- adapter behavior and provider-specific cost-evidence capture move to `drivers`;
- the port and cost-evidence hook types move to `driver`/`schema`, so `harness` needs no fleet dep;
- pure toolchain/artifact defaults move down to `schema/toolchain`;
- parsing `process.env`, choosing candidate-versus-version artifacts, and constructing a selected
  driver happen in the CLI composition root; and
- `templates` accepts explicit inputs instead of importing a module that reads ambient env.

This disposition is part of the decision. Adding `driver` and `drivers` while leaving config,
capabilities, or adapter policy in `providers` would create the exact three-way drift this ADR is
meant to remove.

The composition flow is explicit and side-effect-free until the selected module is loaded:

```ts
const module = await loadDriverModule(providerId); // one correlated dynamic import
const env = parseDriverInputs(providerId, rawInputs);
const descriptor = REGISTRY[providerId].artifact;
const resolvedArtifact = await resolveArtifact(providerId, descriptor, lane);
const driver = module.create({ env, artifact: descriptor, resolvedArtifact });
```

`loadDriverModule` does not read ambient env, `resolveArtifact` does not import a vendor SDK, and
the driver never decides whether a run is using a candidate or published artifact. Those are three
different trust/ownership boundaries and remain three small functions rather than one global
`config` object initialized at import time.

### 2. The port: three members, two layers

The port has a consumer face and an author face, and they are different shapes on purpose. The
**harness** consumes sessions — the ergonomic object it already implies:

```ts
export type ResolvedArtifact =
  | { readonly kind: "none" }
  | { readonly kind: "image" | "baked" | "mirror" | "built"; readonly ref: string };

export interface SandboxDriver<Handle = unknown> {
  create(request: CreateRequest, options?: DriverOperationOptions): Promise<SandboxSession<Handle>>;
  /** Optional: destroy by bare id, no session needed — reaper/cleanup lanes. Idempotent. */
  destroyById?(id: SandboxId, options?: DriverOperationOptions): Promise<void>;
  readonly probes?: ControlPlaneProbes;    // control-plane observation + optional latency probes
  readonly snapshots?: SnapshotCapability<Handle>; // optional: lifecycle measurement only
}

export interface SandboxSession<Handle = unknown> {
  readonly sandboxId: SandboxId;
  /** Effective boot artifact; request fallback is tracked as such in evidence. */
  readonly artifact: ResolvedArtifact;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  destroy(options?: DriverOperationOptions): Promise<void>;
  /** The vendor's native handle — the JDBC `unwrap()` idea, typed. */
  readonly native: Handle;
  /** Optional. A WORKING filesystem API — reads and writes — or absent; never a throwing stub. */
  readonly files?: SandboxFiles;
  /** Optional. `undefined` ⇒ the harness wraps `exec` in its own nohup double-fork. */
  launch?(command: string, options?: ExecOptions): Promise<void>;
}

export interface SandboxFiles {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  writeText(path: string, text: string): Promise<void>;
}

export type SandboxObservation =
  | { readonly state: "running" | "terminal" }
  | { readonly state: "absent" };

export interface ControlPlaneProbes {
  /** Required for a driver to enter the published matrix; see ADR-0008. */
  observe(id: SandboxId): Promise<SandboxObservation>;
  describe?(id: SandboxId): Promise<unknown>;
  list?(): Promise<readonly { sandboxId: SandboxId }[]>;
}

export interface SnapshotCapability<Handle = unknown> {
  create(session: SandboxSession<Handle>): Promise<{ readonly id: string }>;
  delete(id: string): Promise<void>;
}
```

`CreateRequest` carries the benchmark's **full** target axis, GPUs included:
`spec`, `artifact`, `deadlineMs`, and `gpu?: { model: string; count: number }` — the
driver maps it to vendor syntax (Modal: `"H100!"`, `"A100:2"`). A GPU provider is therefore a
driver like any other, not a separate lane; a driver that cannot honor a requested `gpu` fails
create loudly rather than silently benchmarking CPU. `files` is all-or-nothing — every vendor
with a working filesystem API (modal, e2b, daytona) does both directions, and staging *writes*
are a real harness need (`gpu/modal.ts:158-165`) — while sessions without it get harness-owned
fallbacks for both directions in `shell.ts`: `cat` for reads, base64-over-exec for writes, so
consumers stay infallible either way.

Six request/result rules complete the port, each earned in prototyping:

- **One spec, one unit system.** `CreateRequest.spec` uses the registry's `targetSpecSchema`
  fields and units (`vcpus` / `memoryGb` / `diskGb?`) — never a parallel spec type. Vendor unit
  conversions (Modal wants MiB) live in exactly one driver-local expression. `diskGb` is
  optional: a spec axis a vendor cannot express, when *present*, fails create loudly
  (`SandboxCreateParams` has no disk knob) — matching the fleet's skip-and-disclose doctrine
  rather than silently dropping a requirement.
- **The request is parsed once, at the plan→request seam.** An arktype schema in
  `packages/schema` — `.onDeepUndeclaredKey("reject")`, positive-value narrows — validates the
  assembled request where CLI/config input becomes trusted data. The kit's own interfaces stay
  plain readonly TypeScript, pinned to the schema by a mutual-`extends` type test so drift is a
  compile error; the port core imports no arktype (arktype enters only through subpaths that
  genuinely parse, like `./cli`). Drivers never re-validate: by the time a request reaches a
  table, it is trusted.
- **Drivers report what they booted when the control plane exposes it.** `MethodTable.create` may
  return the `ResolvedArtifact` it actually booted (for `built` artifacts, the context resolver's product — e.g.
  `kernelImage.imageId`). Omission means “same as `request.artifact`.” A different report is a
  request/reported contradiction: the kit tears down the orphan and fails create before returning a
  session. `kind: "none"` is explicit rather than an empty-string sentinel. Artifact resolvers must
  canonicalize mutable tags to the immutable reference they intend to request before create; a
  vendor-returned digest is not allowed to silently rewrite evidence after the fact. Omission keeps
  the request as the session's effective artifact but does **not** relabel it as vendor-observed.
- **Artifact evidence is persisted with provenance.** The provider execution evidence in the Run
  schema gains the requested artifact, optional driver-reported artifact, and the live guest
  fingerprint used by smoke, written before teardown. Evidence labels the source
  (`driver-reported`, `guest-fingerprint`, or `request-fallback`); request fallback alone is
  `unverified` for matrix admission rather than a guess presented as observation. A typed session
  field that is never serialized would not make the ADR's “published attribution” claim true. This
  is a Run schema-version change: historical documents remain readable without the field, while documents
  emitted by the new driver path require it.
- **Output limits are per-call and visible.** `ExecOptions.maxOutputBytes` is an opt-in cap for
  probes and queries; a capped stream sets `ExecResult.truncated`. There is deliberately **no
  kit-wide default**: results collection is a multi-MB base64 tar over stdout (`collect.ts:49-51`),
  and a blanket cap turns it into a bounded retry loop that can never succeed. `ExecOptions.signal`
  is the cooperative cancellation channel used by bounded readiness probes. Implementations reject
  cancellation only after accepted command work has settled, so a caller can retry without
  overlapping attempts.
- **Create failures are typed at the driver boundary.** Drivers translate failures to `DriverError`
  with a stable `DriverErrorCode`. Invalid requests and credentials are terminal; allocation
  refusals use `create-failed`; broken integration invariants use `vendor-contract-violation`.
  A `create-failed` error may retain the vendor diagnostic only in its designated `vendorMessage`
  field, for logs and human diagnosis — never as the retry classifier. ADR-0008 dropped the
  registry-owned retry patterns this originally served; retry is now decided by
  `isRetryableDriverCreate` from a typed mark the driver sets once it has established that the
  refusal is transient and nothing remains allocated. There is no parallel `SandboxCreateError`
  taxonomy or `retryAfterMs` channel.

A driver **author**, however, writes a *stateless method table* — flat, pure functions over a typed
native handle, capability-by-presence — and the kit assembles sessions from it:

```ts
export interface MethodTable<Handle, Ctx> {
  create(ctx: Ctx, request: CreateRequest): Promise<{
    handle: Handle;
    sandboxId: SandboxId;
    artifact?: ResolvedArtifact;
  }>;
  exec(ctx: Ctx, handle: Handle, command: string, options?: ExecOptions): Promise<ExecResult>;
  destroy(ctx: Ctx, handle: Handle): Promise<void>;
  readonly files?: { readFile(ctx: Ctx, handle: Handle, path: string): Promise<string>; … };
  launch?(ctx: Ctx, handle: Handle, command: string, options?: ExecOptions): Promise<void>;
}
export function driverFromTable<Handle, Ctx>(
  table: MethodTable<Handle, Ctx>,
  ctx: Ctx,
): SandboxDriver<Handle>;
```

`driverFromTable` forwards `ExecOptions` unchanged to both `exec` and optional `launch`. The generic
`Handle` reaches `SandboxSession<Handle>.native`; consumers that do not unwrap a vendor handle can
use the default `unknown`, while native-driver code retains the exact SDK type end to end.

This is ComputeSDK's genuinely good bone structure (`SandboxMethods<TSandbox, TConfig>`) with its
two pathologies removed: only three members are required, and absence is expressed by omitting a
key, never by a stub. Measured in the side-by-side anatomy (§Prior art), the table shape wins three
things closure sessions cannot offer: **one-statement unit tests** (`table.destroy(ctx, missing)`
is a pure call — the closure equivalent needed a five-statement setup *plus a full create/readiness
round-trip* to even reach the not-found path); **extraction safety** (a table is naturally a named
`satisfies MethodTable<…>` const, where extracting a closure spec severs contextual typing); and
**inspectable, patchable behavior** — composing over a table member is exactly what six providers
did to computesdk's `.methods`, now a supported shape instead of a reach into private state.
Per-driver memoized state (tama's once-per-process auth check) lives in `Ctx`, declared rather than
hidden in a closure.

Create, exec, destroy. `getById`, `getUrl`, `writeFile`, `mkdir`, `readdir`, `remove`, `runCode`
and the mandatory `getInfo` are gone, because nothing calls them; `getInstance` survives as the
typed `native` handle.

The rules that make consumers infallible:

- **Absent capabilities are `undefined`, not stubs.** `files?: SandboxFiles` is either a working
  filesystem or absent; the driver — the place that knows — decides, and the stub never escapes it.
  This deletes the string-matching at `execute.ts:139-152` and the entire class of bug that took out
  the namespace step: `StepRunner`'s `pollFs` field, its permanent-abandonment logic and its
  `isUnsupportedFilesystemError` matcher all go away.
- **"Didn't tell us" is representable.**

  ```ts
  export type Exit =
    | { kind: "exited"; code: number }
    | { kind: "signalled"; signal: string }
    | { kind: "unknown"; detail: string };
  ```

  No adapter forges `?? 1` (`vercel.ts:96`) or `127` (`e2b-root.ts:79`); a missing exit code becomes
  evidence in the run document instead of a fake failure — which matters for a project whose output
  is a published measurement.
- **Distinct operations get distinct types.** `exec` returns `ExecResult`; `launch` returns `void`.
  Four adapters currently fabricate a `CommandResult` for background launches; with the split there
  is nothing to fabricate, and the harness supplies the fallback.
- **Shell mechanics live in `shell.ts`, once.** `shellQuote`, the `nohup` double-fork, the done-file
  poll and the `cat` fallback are harness concerns expressed over `exec`. Three byte-identical
  `shellQuote` copies and four `nohup` lines collapse to one each:

  ```ts
  export async function launchDetached(
    s: SandboxSession<unknown>,
    command: string,
    options?: ExecOptions,
  ): Promise<void> {
    if (s.launch) return s.launch(command, options);
    await s.exec(`nohup /bin/sh -lc ${shellQuote(command)} </dev/null >/dev/null 2>&1 &`, options);
  }
  ```

### 3. `defineDriver`: one typed id joins everything

The seam between "what a provider *is*" (the registry, ADR-0006) and "what it *does*" (the driver)
used to be a bare string convention. It becomes one typed parameter, and everything a driver author
touches derives from it:

```ts
export function defineDriver<P extends ProviderId, Handle>(
  id: P,                          // autocompleted; a typo or unregistered id is a compile error
  spec: DriverSpec<NoInfer<P>, Handle>, // spec cannot bend P; Handle is inferred from the table
): DriverModule<P, Handle>;

export interface DriverModule<P extends ProviderId, Handle = unknown> {
  readonly id: P;
  readonly provenance: SdkProvenance;
  readonly createBudget?: CreateBudget;
  readonly readiness: DriverReadinessPolicy<Handle>;
  readonly execution: ExecutionPolicy;
  readonly accelerator?: AcceleratorStrategy;
  readonly costEvidence?: ProviderCostEvidenceCapability<P>;
  readonly driver: (context: DriverContext<P>) => SandboxDriver<Handle>;
}

export interface DriverContext<P extends ProviderId> {
  /** Exactly the resolved inputs the registry declares — defaults already applied. */
  readonly env: EnvOf<P>;
  /** The registry's artifact descriptor, narrowed to ITS literal — not the full union. */
  readonly artifact: ArtifactOf<P>;
  /** The lane-resolved artifact. `ref` does not exist when this provider's kind is `none`. */
  readonly resolvedArtifact: ResolvedArtifactOf<P>;
}
```

`defineDriver` returns an inert `DriverModule`, not an already-configured global. The module owns
behavioral policy next to the implementation: integration provenance, create budget, readiness
strategy, cost-evidence hook, accelerator observation strategy, and execution strategy. Execution is
a discriminated union rather than two independently optional claims:

```ts
type ExecutionPolicy =
  | { syncCapMs: null; durable: "native-launch" | "shell-detach" | "none" }
  | { syncCapMs: number; durable: "native-launch" | "shell-detach" };
```

A finite cap therefore cannot be declared without a durable route to fall back to — the invalid
`{ durable: "none", syncCapMs: number }` combination is unconstructable rather than a runtime check.
The exact `syncCapMs` is a conservative routing policy, not a claim that smoke must wait that long
to prove. The unused `transport.streaming` flag is removed until a consumer actually models
streaming.
`native-launch` requires a `launch` table member; helpers reject the declaration before allocation
when that structure is visible. The common module boundary also verifies the returned session and,
if the capability is absent, tears the contradictory allocation down before it escapes while
retaining retryable cleanup ownership on a teardown double fault. `shell-detach` selects the kit
fallback; both strategies are live-verified by ADR-0008.

The optional accelerator strategy owns guest observation and normalization for the accelerator
family the module accepts. The shared NVIDIA strategy shells out to `nvidia-smi`; a future AMD, TPU,
or other driver supplies its own probe command, parser, and normalized model/count matcher. This
keeps the vendor-neutral `CreateRequest.gpu.model` axis unchanged while giving ADR-0008's
conformance suite a real observation path per module, instead of hard-coding one vendor's tool into
the shared gate.

The strategy's concrete port shape keeps the probe mechanics pluggable while giving the shared gate
one normalized result:

```ts
interface AcceleratorObservation {
  readonly model: string;
  readonly count: number;
}

interface AcceleratorStrategy {
  readonly family: string;
  readonly command: string;
  readonly parse: (stdout: string) => AcceleratorObservation;
  readonly matches: (requested: GpuSpec, observed: AcceleratorObservation) => boolean;
}
```

The gate executes `command`, rejects a failed or truncated command envelope, and passes only
successful stdout to `parse`. The strategy never receives credentials or an ambient process
environment. A module with no strategy must reject a present `CreateRequest.gpu` before allocation
with the port's typed `invalid-create-request` error; that rejection is the GPU row's supported
negative result. Returning a session for a GPU request without a strategy is a conformance failure,
not `unverified`: the suite has no evidence that it is safe to benchmark the allocation as a GPU.

One generic call signature, deliberately not overloads — convex's registration builder documents
the reason and it held up in our error-message tests: overloads prefix every mistake with a
signature dump, while a single signature lands the error on the field the author got wrong.

The whole provider file, in the shape an author actually writes:

```ts
// packages/drivers/src/tama.ts — the provider's behavior. The filename is the id.
import { defineCliDriver, defineCliSpec } from "@sandbox-benchmarks/driver/cli";
import { type } from "arktype";

const Machines = type("string.json.parse").to(
  type({ id: "string", name: "string", status: "string", "status_detail?": "string" }).array(),
);
// Exact shape observed in committed real Tama runs (for example machine-obusdw8bsyw2).
const TamaSandboxId = type(/^machine-[a-z0-9]{12}$/);
const TAMA_CREATE_CEILING_MS = 25 * 60_000;

export default defineCliDriver("tama", {
  // `tama new` blocks until ready (~2m10s cold pull) and owns failed-create cleanup, so the
  // joined helper derives a driver-owned budget — abandoning teardown could strand a machine.
  createAttemptCeilingMs: TAMA_CREATE_CEILING_MS,
  spec: ({ env, resolvedArtifact }) => defineCliSpec(Machines, {
    binary: env.TAMA_CLI ?? "tama",
    secretFlags: ["--token"],
    commandTimeoutMs: 60_000,
    // `new` owns the cold image pull; short list/login/rm/exec calls keep the tighter bound above.
    createCommandTimeoutMs: 20 * 60_000,
    // Every canonical axis is mapped, artifact-pinned, capacity-checked, or rejected pre-spawn.
    requestCoverage: {
      spec: { vcpus: "mapped", memoryGb: "mapped", diskGb: { capacityAtLeast: 40 } },
      artifact: "context",
      deadlineMs: "driver",
      gpu: { model: "unsupported", count: "unsupported" },
      env: "unsupported",
    },
    // Preserve a working developer profile; a fresh CI runner falls back to token login.
    prepare: {
      probe: ["list", "--all", "--json"],
      fallback: ["login", "--token", env.TAMA_TOKEN],
    },
    create: (r, name) => {
      if (r.artifact.kind !== "image" || r.artifact.ref !== resolvedArtifact.ref) {
        throw new Error("the request artifact does not match the resolved Tama image");
      }
      return ["new", name, "--ttl", "0", "--json", "--image", resolvedArtifact.ref,
        "--cpu", String(r.spec.vcpus),
        // Tama's CLI boundary is MiB; the canonical request stays in GiB everywhere else.
        "--memory", String(r.spec.memoryGb * 1024)];
    },
    // `rm` accepts only an id: reconcile the generated name through typed list output first.
    cleanupCreated: {
      kind: "lookup",
      select: (rows, name) => rows.find((m) => m.name === name) ?? null,
      // A just-accepted allocation can lag the name index. Absence is stable only after this.
      absenceConfirmationMs: 2_000,
    },
    ready: {
      // `--all` is mandatory for reconciliation: ordinary list output omits stopped machines.
      poll: ["list", "--all", "--json"],
      select: (rows, name) => rows.find((m) => m.name === name) ?? null,
      classify: (m) => m.status === "ready" ? "ready"
        : /^(failed|error|stopped|terminated|deleted|gone)$/i.test(m.status)
          ? { terminal: `status=${m.status}${m.status_detail ? ` (${m.status_detail})` : ""}` }
          : "pending",
    },
    sandboxId: { fromRow: (row) => row.id, parse: TamaSandboxId },
    exec: (id, command) => ["exec", id, "--", "bash", "-lc", command],
    destroy: (id) => ["rm", "-y", id],
    notFound: /^(?:error:\s*)?(?:machine(?:\s+machine-[a-z0-9]{12})?\s+not found|no such machine|unknown machine)[.!]?\s*$/i,
  }),
});
```

That sequence is pinned against Tama's real CLI contract: only `login` receives `--token`, `new`
does not, and a fallback login is followed by another parsed `list` before allocation. `rm` receives
the module-validated machine id because it has no name-addressed form. A failed `new` therefore
performs a typed `list` lookup by the preallocated unique name before issuing `rm -y <id>`. The
generic driver retains that name as a retryable recovery locator whenever the lookup, validation,
or removal cannot prove the allocation gone. A selected `failed`/`error`/`stopped`/`terminated` row is a
typed terminal readiness result, so the kit begins that same cleanup immediately instead of
spending the remaining create window polling a machine the vendor has already declared unusable.

What the typed join must buy, with each property pinned by implementation tests:

**The env slice is exact, and hovers flat.** `EnvOf<P>` maps the registry entry's input tuple —
required and defaulted inputs are `string`; genuinely optional ones are `string | undefined` via absence (the
`exactOptionalPropertyTypes` distinction), wrapped in a `Prettify` flattener so the hover reads
`{ readonly TAMA_CLI?: string; readonly TAMA_TOKEN: string }`, not an alias soup. Reading a
credential the registry doesn't declare:

```text
error TS2339: Property 'E2B_API_KEY' does not exist on type '{ readonly TAMA_CLI?: string; readonly TAMA_TOKEN: string; }'.
```

and near-misses get the compiler's spelling help:
`Property 'BAZ_API_KEY' does not exist … Did you mean 'BAZ_APIKEY'?`. `adapters.ts`'s "Never read
`process.env` here" comment stops being a comment; the ambient environment is simply not in scope.

**The artifact arrives narrowed, so behavior follows from the type.** For `"tama"`, both
`ctx.artifact.kind` and `ctx.resolvedArtifact.kind` are the literal `"image"`, so
`resolvedArtifact.ref` exists with no cast. For `blaxel`, the narrowed kind is `"none"` and reading
`.ref` is a compile error. Vendor syntax (`--image`, `snapshotId`, a nested SDK option) remains plain
driver code rather than a supposedly-generic registry key. The candidate/version switches that
today manufacture provider create-option bags disappear: the composition root resolves one
artifact and passes it to the selected driver.

**The runtime parser is derived from the same declaration.** `envSchemaFor(id)` builds the arktype
validator from the identical registry tuple `EnvOf` maps, so type and validator cannot drift. A
missing credential reports `BL_WORKSPACE must be a string (was missing)` — the same grammar as every
other boundary in the repo. The CLI parses `process.env` once at `parseDriverInputs` and hands
each driver its typed slice.

**Variant pairs — the fleet's hardest real shape — are safe by construction.** daytona, modal and
microsandbox each register two ids over one implementation (`adapters.ts:41`). A shared factory is
typed by the union it serves, with no `as const` anywhere:

```ts
// packages/drivers/src/_daytona.ts
export function daytonaDriver(): DriverSpec<"daytona-vm" | "daytona-container"> { … }
```

Inside it, `env.DAYTONA_API_KEY` is typed (the union's common slice) and `resolvedArtifact` is
narrowed to `kind: "baked"` with a present `ref`.
Both variant files attach it; attaching it to any id outside its union is rejected by ordinary
function-parameter contravariance, along with the
unregistered-id and wrong-kind negatives, under the repo's compiler settings.

**Policy is declared next to the code it governs, without sentinels.** Today's
`createTimeoutMs: null` means "disable the harness's create race" — a sentinel a reader must know.
It becomes a self-describing union on the module, and `costEvidence` moves in beside it:

```ts
createBudget?:
  | { owner: "harness"; timeoutMs?: number }              // default: harness races create
  | { owner: "driver"; attemptCeilingMs: number };        // driver owns bounds and cleanup
```

The rich rationale comments in `adapters.ts:129-291` move into the driver files they describe —
each provider's story finally lives in one place.

One honest constraint, inherited from how contextual typing works everywhere (convex documents the
same rule): the spec literal lives **inline** in the `defineDriver(...)` call. Extracting it to an
untyped `const` first severs the contextual type and the callback's parameters fall back to
`any`-shaped inference errors. Extracting *typed* pieces — a `DriverSpec<…>`-annotated factory like
`daytonaDriver()` above — keeps every guarantee; that is the supported sharing shape.

### 4. The fleet loads lazily, and existence is compile-checked in both directions

The loader table is a correlated record — each id maps to a dynamic import of exactly its module.
The generated type map retains each module's inferred native handle for literal-id callers:

```ts
export interface DriverModuleMap {
  e2b: typeof import("./e2b.ts").default;
  tama: typeof import("./tama.ts").default;
  // …generated
}

export const DRIVERS: { readonly [P in ProviderId]: () => Promise<DriverModuleMap[P]> } = {
  e2b: () => import("./e2b.ts").then((m) => m.default),
  tama: () => import("./tama.ts").then((m) => m.default),
  // …
};

export const loadDriverModule = <P extends ProviderId>(id: P): Promise<DriverModuleMap[P]> =>
  DRIVERS[id]();
```

Because the table is typed by `ProviderId` and each module's default export carries its literal id,
**both drift directions are compiler errors, not gate findings**: a driver file for an id the
registry doesn't know fails inside the file (`defineDriver("nopé", …)` rejects), and a registry id
with no driver file fails in the generated table (`TS2307: Cannot find module './novita.ts'`). A
mismatched id/module pairing in the table itself also fails. A caller with a literal id retains the
driver's `SandboxSession<Handle>.native` type through `DriverModuleMap`; a caller with a runtime
`ProviderId` receives the safe union and the harness ignores `native`. The generator's own gate
adds only what types cannot see: filename = id, and one module per id. The generated table uses
plain static import specifiers, so editor go-to-definition tunnels through it — the property convex
protects deliberately in its generated `_generated/api`.

This converts the eager import wall into a per-provider cost: a bench job evaluates the one vendor
SDK it benchmarks (median ~60 ms, worst ~270 ms) instead of all twelve (~0.9 s), and harness tests
evaluate none.

### 5. `cliDriver`: vendor stdout is a trust boundary

runcloud, microsandbox and tama arrived in one quarter; two of the three drive CLIs or raw HTTP.
For CLI vendors the *entire* control plane is untyped text crossing a process boundary — exactly
what ADR-0001 says must be parsed, and today it is `JSON.parse` + hand-rolled checks. In the kit,
the table's `parse` fields are arktype pipelines, so a vendor changing its output shape produces a
path-bearing report in the CI log —

```text
value at [0].status must be a string (was missing)
```

— instead of an `undefined` threading through readiness logic. The generic driver owns spawn,
timeout-and-kill, argv secret redaction and not-found matching once; a new CLI vendor is a table of
argv templates and parsers rather than tama's former 636-line adapter, with no
`getUrl` regex-scraping prose, no `createdAt: new Date(0)`, no `mapStatus` collapse. Where a
vendor's CLI needs logic a table can't express, the escape hatch is the port itself — `cliDriver` is
a convenience over `SandboxDriver`, not a second contract.

`cliDriver` compiles its declarative spec down to a §2 method table whose handle is the **parsed
readiness row** (`ready.select` returns the row, not a bare id string) — so every generated member
is unit-testable as a pure function, and `session.native` is the vendor's own typed record rather
than an opaque string. The proof module is about one hundred lines including imports, comments, schemas,
constants, and registration. Provider-specific parsing, eventual-consistency, secret, readiness,
and absence rules remain visible as declarative fields rather than repeated control flow. That is a
large reduction, but it is not a 15-line provider and the ADR does not treat line count as proof of
safety.

Every failed create outcome is reconciled by the generated name, including a nonzero CLI exit that
may have followed a server-side allocation. If that rollback also fails, the driver rejects with a
`FailedCreateCleanupError`: a `SuppressedError` preserving both failures plus a structured
provider/name locator and an idempotent `Symbol.asyncDispose` retry. A generated name is released
only after two absence observations separated by the provider-declared convergence horizon. The
process owner recognizes that standard protocol, retains the rejected create in its bounded cleanup
registry, and releases it only after a retry confirms teardown. A failed rollback therefore cannot
discard the only handle to a billable allocation.

Create and destroy also accept a cooperative `AbortSignal`. On process shutdown the owner aborts a
pending create immediately, and the CLI runner kills the detached process group, cancels inherited
pipes, and waits for the child to be reaped before rejecting. Once that rejection installs the
generated-name recovery record, the owner spends the remainder of its existing bounded shutdown
window on reconciliation; cancellation of that cleanup follows the same kill-and-reap rule. The
signal is an interruption channel, not evidence that the remote allocation is absent, so aborting a
create never releases ownership by itself.

### 6. ComputeSDK becomes a driver

It keeps all its real value — seven maintained vendor translations — and stops being mandatory. The
following is the actual composition section of the E2B proof module; every referenced constant and
helper is a concrete declaration earlier in that same file, not pseudocode:

```ts
import { computeSdkSpec, defineComputeSdkDriver } from "./_computesdk.ts";

export default defineComputeSdkDriver("e2b", {
  spec: ({ env, resolvedArtifact }) => {
    const apiKey = env.E2B_API_KEY;
    return computeSdkSpec(e2b({ apiKey, timeout: E2B_SANDBOX_LIFETIME_MS }), {
      sandboxId: E2B_SANDBOX_ID,     // provider-local arktype trust boundary
      createOptions: {
        coverage: E2B_REQUEST_COVERAGE,
        // `deadlineMs` is a create-attempt budget, not the remotely enforced sandbox lifetime.
        map: (request, unsupported) => {
          if (request.artifact.kind !== "baked" ||
              request.artifact.ref !== resolvedArtifact.ref) {
            unsupported("the request artifact does not match the resolved E2B template");
          }
          return { snapshotId: resolvedArtifact.ref, timeout: E2B_SANDBOX_LIFETIME_MS,
            metadata: { [E2B_ATTEMPT_METADATA_KEY]: `benchmark-${randomUUID()}` } };
        },
      },
      // The wrapper omits E2B's user option. Compose over its public native instance instead of
      // mutating @computesdk/provider's private method table.
      commands: { exec: execE2bCommandAsRoot, launch: launchE2bCommandAsRoot },
      // The published wrapper swallows every teardown error. Direct SDK kill surfaces auth/network
      // faults, while marker-based recovery owns a create whose success response was lost.
      lifecycle: e2bLifecycle(apiKey),
      createRecovery: e2bCreateRecovery(apiKey),
      // E2B does not control disk size at create; verify the allocation and tear it down if short.
      prepareAndVerifyCreatedRequest: (_sandbox, native, request, options) =>
        verifyE2bDiskCapacity(native, request, options),
      probes: e2bProbes(apiKey),
      hasWorkingFilesystem: true,    // explicit, because UnsupportedFileSystem lies
    });
  },
});
```

The complete E2B proof module is a few hundred lines, not the composition excerpt
above. Roughly half is provider-specific safety work the generic wrapper cannot truthfully infer: structural
nonzero-exit decoding across vendored SDK copies, root command execution, canonical-id teardown,
bounded marker reconciliation, conservative paused-state observation, and live disk-capacity
verification. The bridge removes repeated session/error/ownership machinery; it does not make those
vendor semantics disappear. Later shared wrapper factories may reduce repeated policy across
providers, but only where conformance proves the abstraction honest.

Ambiguous-create ownership names its lookup key honestly: either a provider name or a keyed marker
(for example metadata or `externalId`). The bridge snapshots and freezes that locator before create,
so a wrapper cannot mutate the recovery target and a cleanup double fault retains a precise retry.

The nine wrapper-based providers keep working through the bridge, including the
`snapshotId`/`templateId` create-option conventions the bake path relies on. The five hand-written
adapters stop paying the `defineProvider` tax, and `assertPatchable` disappears: an execution
projection is ordinary function composition over the wrapper's typed `getInstance()` value, not a
reach into a generated class's private table.

One typing rule, learned from the GPU prototype: the bridge's `session.native` is typed as **the
wrapper's `getInstance()` type — never the repo's own vendor SDK types**. Wrappers vendor their own
SDK copies (`@computesdk/modal/node_modules/modal`), so the wrapper's `Sandbox` and the repo's are
*different nominal classes*; a cast across them needs `as unknown as` and is wrong the day the
versions diverge. Code that needs the repo's SDK types is code that should be a native driver.

### 7. Where this meets ADR-0006

`CreateRequest.artifact` and `DriverContext.resolvedArtifact` are resolved from ADR-0006 §1's
`artifact` descriptor (for kind `built`, by the composition root at run time), so the
registry decides *what* to boot and the driver decides *how*. §6's provider-input
declarations gain two derived consumers (`EnvOf`, `envSchemaFor`) alongside the CI regions. The
`Record<BakedProviderId, BakeFn>` partition **stays in `apps/cli`, unchanged**: bake modules import
the harness, templates pins, and docker orchestration (`bake/e2b.ts` writes a generated Dockerfile
into `packages/templates/images/e2b/`) — that is release-pipeline altitude, and pulling it into the
fleet package would invert the DAG for a compile-time property the cli-side `Record` already
provides.

### 8. The single-file inversion, tested and rejected

The obvious next step — collapse the registry entry *into* the driver file
(`defineProvider({ id, credentials, artifact, pricing, driver })`, sibling-field inference, registry
generated from the fleet) — was built, adversarially attacked, and rejected on evidence. It is
recorded here because its failure modes are subtle and worth not re-discovering:

- **The flagship guarantee fails silently on the fleet's real shape.** Sibling-field inference
  needs the credentials tuple to stay literal. Factor a shared `const CREDS = [{ name:
  "DAYTONA_API_KEY" }]` — the natural move for the three variant pairs, minus the `as const` nothing
  reminds you to write — and `env` silently degrades to an open string record: `env.E2B_API_KEY`
  compiles for a daytona driver, with zero errors anywhere. The typed join (§3) is structurally
  immune: literalness is established once, in the reviewed registry, and drivers bind by id.
- **The generator would evaluate its own output.** Driver files import the schema barrel, whose
  provider module runs a validation loop that throws on a bad registry — so a broken generated
  registry (interrupted run, merge conflict between two provider PRs, prior emit bug) bricks the
  generator that would repair it. ADR-0003's gate works because its inputs are inert vendored XML;
  this one's inputs would be live modules downstream of its output.
- **Identity would be authored by a leaf's file listing.** Run documents, legacy aliases, figures
  and economics key on `ProviderId` — the DAG root's stability contract. Under the inversion,
  deleting a driver file and regenerating shrinks that vocabulary with no compile error anywhere;
  for a published benchmark, frictionless deletion is the wrong default. Relatedly, `id: string`
  (unavoidable when the fleet defines the namespace) makes §4's correlated loader untypeable.
- **The drift gate would evaluate thirteen vendor SDK graphs on every PR.** All currently import
  clean under `env -i` (measured, 0.88 s) — but the repo has already once fought vendor import-time
  flakiness (`bake/novita.ts`'s `createRequire` dance), and coupling every PR's CI to third-party
  module-graph behavior is a standing liability the registry-→-outward direction avoids entirely.

What the inversion got right is kept: colocation of narrative and behavior (the rationale comments
move into driver files), declarative policy on the module, and the one-command scaffold. What it
got wrong was *which* declaration moves: behavior colocates; identity does not.

### 9. Guardrails: sharp edges reproduced during prototyping

Every item below was a real failure reproduced (compiled or executed) while prototyping this
design, not a hypothetical. Implementation MUST honor them; the kit tier of ADR-0008's suite
pins the runtime ones.

- **`"+": "reject"` and `.onUndeclaredKey("reject")` are SHALLOW.** A nested misspelling
  (`spec.unexpectedField`) passes them untouched. Request boundaries use
  `.onDeepUndeclaredKey("reject")`.
- **Never mint a parallel spec shape.** The prototype briefly carried a third `TargetSpec` with
  clashing units (`memoryMib` vs the registry's `memoryGb`) — a bug class no individually-valid
  schema can catch. One spec vocabulary; conversions at the vendor edge only.
- **The `defineDriver` spec literal stays inline** (or flows through a `DriverSpec<…>`-typed
  factory). An untyped extracted const severs contextual typing — eight implicit-`any` errors,
  silently degraded inference. The method table is the extraction-safe shape; use it for
  anything you want to unit-test.
- **Never cast across vendored SDK copies.** `@computesdk/*` wrappers vendor their own SDK
  builds; their classes are nominally different from the repo's. The bridge exposes wrapper
  types; needing repo SDK types means writing a native driver.
- **A lazy context memo must clear on rejection.** `memo ??= load()` without a catch turns one
  transient plumbing failure into a process-lifetime bricked driver (reproduced). Share the
  in-flight promise; drop it on failure.
- **Teardown must not swallow the primary error.** `finally { await destroy() }` replaces a
  benchmark failure with a teardown failure. Use `SuppressedError` (native in Bun; requires
  `lib: esnext`) so both survive; settle all staged writes before teardown and aggregate their
  failures.
- **Use one streaming `TextDecoder` per stream.** Per-chunk decoders corrupt UTF-8 sequences
  split across chunk boundaries (reproduced: `h��llo`). Decode with `{ stream: true }`.
- **Convergence catches must be narrow.** `destroyById` treats only the vendor's *typed*
  not-found error (Modal: `NotFoundError`) as already-converged; every other failure surfaces.
  String-matching error prose is how the `UnsupportedFileSystem` workaround started.
- **arktype stays out of the port core.** Its cold import is ~288 ms, and the kit is imported by
  every driver file. Schemas live in `packages/schema`; parsing subpaths (`./cli`) may import it;
  the core exposes plain interfaces drift-pinned to the schemas. ADR-0006's eroded identity leaf
  is the standing reminder that this rule decays without a gate.

### Prior art, credited

The shapes here are deliberately stolen from the ecosystem's best current practice — including from
the incumbent this ADR demotes. From **ComputeSDK**: the package model (narrow provider modules over
a small common core — kept as subpaths over a contract package), the stateless
`SandboxMethods<TSandbox, TConfig>` table §2's author layer is modeled on, capability-by-presence
feature detection, `@computesdk/cmd`'s shell mechanics, and `daemond`'s nullable-exit-code
envelope. From the **mature driver ecosystems** that have run "N vendors, one contract" for
decades: JDBC's `unwrap()` (the typed `native` handle), Kubernetes CSI's capability-honesty and
idempotency spec language and Testcontainers' wait-strategy decomposition (both taken further in
ADR-0008), and the TCK discipline that a contract ships with the suite that verifies it. From the
modern TS wave: convex's registration builders (one generic signature instead of overloads, for
error quality; a generated registry that preserves go-to-definition) and its
validate-args-then-infer handler pipeline; elysia's `NoInfer` discipline and
schema-as-single-source route contracts; better-auth's plugin object with optional capability keys
and subpath-per-plugin exports; eve's filesystem-as-authoring-interface and `define*`
default-export modules; arkenv's env-schema-with-injected-source; better-fetch's errors-as-values.
The `Prettify` hover flattener is the ecosystem-standard `{ [K in keyof T]: T[K] } & {}`. Where a
pattern didn't fit (elysia-style method chaining; arkenv's coercion; sibling-field inference per
§8), it was left out — the kit has no builder API because nothing in it accumulates type state. The
side-by-side anatomy that settled §2's two-layer shape — the same tama-style provider written
against real `@computesdk/provider`, as a closure spec, and as a stateless table, all
typechecked — found 134 author lines and 5 fabricated values for the incumbent, 29 lines and 0
fabrications for the declarative spec, and the table layer decisive for testability. Every code
sample and negative (`@ts-expect-error`) case in the original prototype was compiled under the
repo's strict settings; refinements made during acceptance review are normative requirements and
must be added to that executable proof rather than being retroactively described as already run.

## Consequences

**Adding a provider becomes three hand-written edits, each compile-checked against the others:**

1. The id in `schema`'s arktype-free `PROVIDER_IDS` identity leaf — the deliberate act that extends
   the published vocabulary. `Record<ProviderId, …>` immediately demands the next edit.
2. The provider-metadata file — identity, artifact lifecycle, inputs, economics (ADR-0006), with its
   evidence commentary alongside it.
3. The driver file, `packages/drivers/src/<id>.ts` — `defineDriver("<id>", …)` autocompletes the
   id, hands the author their typed env slice and narrowed artifact, and won't compile against an
   unregistered id; the regenerated loader won't compile without the file.

Then `bun run generate-provider-wiring` → review one diff touching the loader table, the exports
map, fleet dependency projection, and the CI regions. A bake module only when
`artifact.kind === "baked"` (the cli `Record`
demands exactly those); the `bench-matrix.yml` promotion stays a deliberate, separate step.
The final migration slice adds `bun run new-provider <id>` (ADR-0006 §9), which scaffolds all three
edits and any new root catalog version pin from one descriptor; until that slice lands, the command
described here is a normative destination rather than an already-available script.

**We accept:**

- **A migration touching every adapter.** Fourteen providers move into `packages/drivers`. It is
  mechanical and compiler-checked, but it is not small, and it should land after ADR-0006 rather
  than alongside it. Until the last adapter lands, `computeSdkDriver` keeps unmigrated providers
  working, so the port and `DirectProvider` coexist during the window. The generated loader exposes
  `DriverProviderId`, the unwaived subset of `ProviderId`, during that window. Every omitted existing
  provider requires a committed owner/reason/expiry waiver; a missing module without one, an expired
  waiver, or a module that lands without removing its waiver fails the wiring gate. After the final
  waiver is removed, `DriverProviderId` equals `ProviderId` and the loader has exactly the complete
  shape in §4 without a second handwritten id list.
- **We own the port.** Today computesdk absorbs upstream vendor churn behind a stable interface.
  Nine providers keep that shelter via the bridge; the five hand-written ones already had no
  shelter, and this ADR only stops them pretending otherwise.
- **The inline-spec rule, narrowed by the table layer.** The `defineDriver` spec literal must stay
  inline (or flow through a `DriverSpec<…>`-typed factory); an untyped extracted const loses the
  contextual types — verified as eight implicit-`any` errors. This is a property of TypeScript's
  contextual typing, shared by convex and elysia. §2's method tables are the pressure valve: a
  table is naturally a named `satisfies MethodTable<…>` const, so the code an author most wants to
  extract and unit-test is exactly the shape that extracts safely.
- **The mapped ComputeSDK options stay open; canonical coverage does not.** The
  `snapshotId`/`templateId` conventions are real ComputeSDK knowledge and remain local to each
  bridge-backed driver, while the type-derived `coverage` declaration makes every new target,
  GPU, environment, artifact, or budget axis a compiler-forced provider review.
- **Losing `getInfo`/`list` as *typed* members.** Both are pure latency probes today. They move to
  the optional `probes` capability, where an absent probe is a recorded gap rather than a stub.
- **Default exports in `packages/drivers`.** The one place the repo uses them, accepted so the
  generated loader is uniform (`m => m.default`) with no id→identifier name mapping.
- **Two more packages under ADR-0002's uniform shape.** The DAG check gains the edges that make the
  design enforceable: `harness → driver` only; vendor SDKs confined to `drivers`.

**We explicitly do not:** collapse the registry into the fleet (§8 — tested, rejected on evidence);
create one workspace package per vendor (computesdk's per-package split earns its keep on npm,
where external consumers install one provider; in a private workspace every SDK lands in `bun.lock`
regardless, so fourteen `package.json`s would buy ceremony, not isolation — per-provider *subpaths*
plus the lazy loader capture the real benefits at zero package overhead); put `bake` on the driver
module (§7 — wrong DAG altitude, and the cli `Record` already provides the compile-time property);
delete or fork `@computesdk/*` (it does real vendor translation for nine providers and remains a
first-class driver); model streaming exec (the current flag has no consumer); or move vendor
quirk-handling into the harness. The port is a shell and a
lifecycle, deliberately nothing more.
