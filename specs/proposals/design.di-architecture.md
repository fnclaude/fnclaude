# fnclaude DI architecture

Design spec for adopting `@rhombus-std` dependency injection across the fnclaude CLI. This is the Phase-1 output; a later workflow implements it. Target worktree: branch `feat-di` (draft PR #362 — it stays draft; nothing in this effort merges). Engine reference: `@rhombus-std` at std commit `bd2074fa` (branch `IServiceManifest-repair`).

Evidence discipline: **[V]** = verified (a file read or a command run against that checkout), **[I]** = inferred. Paths under `libraries/…`, `transforms/…`, `tests/…` refer to the std checkout; paths under `packages/cli/…` refer to this repo.

---

## 1. Recommendation

Adopt **`standardLifetime()` on plain `Builder` roots** — four of them: an async **plan** root that emits a frozen `LaunchPlan` and is disposed, an **install** mini-root for `fnc install -y`, a **run** root that owns the claude session, and an **mcp** root for the stdio subprocess — with the full validation stack (`validateUniversalAddresses` + `validateBuildability` + `validateScopes`), a **pure-singleton** container (no scopes today), sugar confined to the entry/registration layer so leaf modules and their unit tests stay byte-for-byte unchanged, the ttsc transform running as a **build-to-dist step behind `bin/fnc.js`** (never in the `bun test` loop), and `@rhombus-std` consumed **now via packed tarballs from the pinned std SHA** with a mechanical, three-gate flip to `@next`.

Four candidate architectures were debated to produce this. Each forced a decision that is now part of the spec:

- **tagged-session-kernel** (taggedLifetime over a `process | session | request` vocabulary) forced the lifetime-model adjudication: fnclaude hosts exactly one session per launcher process (handoff/restart execve-replace the image), nothing injects a service *through* a nested request scope, and `taggedLifetime` structurally cannot have a `validateScopes` [V `libraries/di/src/addons/standard-lifetime/validate-scopes.ts` — `Addon<StandardLifetime>` only]. `standardLifetime`'s singleton/one-flat-scope split expresses fnclaude's only real boundary natively — and here even the scope is unnecessary (§2b). Tagged wins only if per-MCP-tool-call scopes sharing session services ever become a requirement; they are not one today (§12 Q4).
- **hosting-generic-host** forced the Host adjudication: hosting composes **no lifetime model** (its `resolveHost` is a bare `Builder.withServices` [V `libraries/hosting/src/host-composition.ts:189`]), never disposes its provider (empty `Host[Symbol.dispose]` [V]), and drags a ~17–20-package closure with the latest possible `@next` flip. Its one addition — phased hosted-service start/stop — fnclaude cannot use anyway because aggregate resolution order is unpinned, so an explicit ~60-LOC orchestrator is needed either way. Plain `Builder` it is. (Hosting's default lifetime is `NullLifetime` — no signal handlers [V] — so the SIGINT invariant was *not* the reason; the cost/benefit was.)
- **preload-zero-build** forced the transform-placement adjudication: the load-time preload that would keep the dev loop build-free is **verified broken in std's own repo** with an unpinned root cause (a ttsc-host/cache bug class, not a path artifact), was never demonstrated out-of-monorepo, and its checker-driven per-process cost is unmeasured. Build-to-dist is the committed mechanism; the preload survives only as an optional, strictly-later spike (§12 Q2). This stance also contributed the row-by-row leaf-signature verification (§4), the value-door rule for function-shaped seams, the vendor pack-to-staging pipeline (§8), and the `dist/.lowered` sentinel (§7).
- **standard-three-roots** is the chassis this spec is built on: its topology, data-flow-between-roots pattern (config, warnings, ring snapshot all crossing as frozen data), execve-tail hard happens-before, conditional overlays, composition-test matrix, and migration sequence survived four adversarial rounds with every found defect repaired.

One packaging point is adjudicated against the chassis stance: the published artifact targets **external, exact-pinned** `@rhombus-std` runtime deps rather than inlining the runtime (§7, §12 Q1) — publishing is paused and this branch never merges in this effort, so no publish can happen before real `@next` packages exist, which removes the only argument for inlining.

---

## 2. Doctrine

The rules this design obeys. Each is load-bearing; a change to one is a design change, not a style choice.

1. **Build-time validation of the registered graph is the reason to buy DI.** `validateBuildability()` plans every closed address at `build()` and fails any that cannot construct; `validateUniversalAddresses()` rejects a mis-addressed registration. Neither is scope-dependent — both hold for a pure-singleton container [V `libraries/di/src/addons/validation.ts:20,55`]. This catches at build a class of wiring bug the current 968-line hand-wired `main.ts` catches only at first resolve, or never on a branch not taken this run. Conditionally-registered overlays (OOBE, MCP listener, PTY tier) are validated only in a build that includes them — so CI builds **every overlay variant** in an enumerated matrix (§5). Known blind spot, stated: a *wrong-lifetime* registration (an explicit `'transient'` where a singleton was meant) is invisible to every validator; the guard for that class is the composition tier's resolve-twice **identity assertions**, not the validators.
2. **Every value crossing a container boundary rides frozen data, never a live reference.** A `LaunchPlan` is a structurally-frozen, ref-free value emitted by a short-lived container that is then disposed; it carries the branch topology (`useTerminal`, `mcpEnabled`, `socketPath?`, `oobe?`), the **whole loaded config record** (`plan.config` — carrying the whole record makes per-field drift impossible), and the drained plan-phase warnings (`plan.warnings`). Outbound, `SessionOutcome` carries the ring snapshot and run-phase warnings out of the run container **before** disposal. One pattern, four instances; a fifth boundary-crossing value follows it.
3. **Containers are pure-singleton; scopes are held in reserve.** The MCP tool handlers are constructed once into a fixed name→handler map (matching today's `createParentDispatcher` [V `main.ts:609-636`]); none holds a per-call disposable, so no `openScope()` per tool call. `standardLifetime` keeps flat `openScope()` + the dormant `validateScopes()` available for the day a per-call disposable appears, at zero present cost.
4. **Sugar is confined** to `src/entry/*`, the `*/register.ts` files, and the composition-test tier. Leaf modules stay plain injected functions/classes with their existing deps-object signatures untouched. Consequences: today's unit-test style (call the factory with fakes) survives byte-for-byte, and plain `bun test` pays **zero** transform cost. Enforced by a CI grep-guard (§7).
5. **The two execve tails live outside every container and run after disposal.** The MCP-triggered handoff re-exec (`handoff/exec-image.ts`, [V `main.ts:842-895`]) and the cross-CWD silent relaunch ([V `main.ts:909-959`]) both replace the process image; neither is ever registered. The registered detection service does detection + the kill of claude only and returns the stashed argv; `run.ts` invokes the tails **outside** the `await using` block — a hard happens-before where today teardown-vs-execve is a soft race.
6. **No signal handlers from any DI primitive.** SIGINT/SIGTERM stay swallowed no-ops installed by the pre-DI dispatcher [V `main.ts:688-689`].
7. **Fail-open subsystems keep their semantics.** Logging never throws and degrades to noop; config has no runtime schema validation and degrades per field (the loaded record is what rides `plan.config`); `addOptions<T>()` is not used (§6). fngit-absent degrades to real-paths-only via the union-optional idiom (§4).
8. **Wire/behavioral invariants are byte-for-byte acceptance gates.** `design.mcp.md`'s env names, socket/handoff path formulas, wire formats, timeouts, kill sequences, and relaunch argv shapes are untouched by DI — including terminal-error exit codes: MCP bind failure is stderr `fnclaude: <message>` + exit 2 with claude never spawned [V `main.ts:641-644`], mapped through a typed `McpBindError` (§2b).
9. **The dialect is used exactly as the engine defines it.** Three rules, each engine-verified:
   - **(a) Explicit lifetimes everywhere, compile-enforced.** `standardLifetime(): Addon<StandardLifetime>` locks the chain onto a vocabulary with no `undefined` member [V `standard-lifetime.ts:26`, `di.core/src/StandardLifetime.ts`], and `LifetimeArgument` then makes the lifetime argument **required** on every constructed registration [V `di.core/src/LifetimeArgument.ts:2`]. Every registration lambda is annotated `Manifest<StandardLifetime>`; transients say `'transient'` explicitly; no `Manifest<unknown>` loosening anywhere (that is the silent-transient trap).
   - **(b) Values — including function-shaped seams — go through the value door.** The callable `add<T>(fn, lifetime)` overloads register any `Func` as a per-resolution *factory*; the value shape `ButNot`-excludes callables [V `di.extras/src/augmentations/Manifest-Registration-augmentations.ts:11,16,24`]. So a frozen function seam (`defaultWhich`, `dialAndCall`) is registered `addValue<T>(fn)` — the engine hands back the function itself, never its return value.
   - **(c) No async construction.** Async work is a method (`plan()`, `start()`, `pump()`), never a factory's return; every root's `resolve<T>()` stays sync. `resolveAsync<T>()` [V `tests/di.test/test/ask-surface.test.ts`] is the engine-native escape hatch if an async construction ever becomes unavoidable — currently unused.
   - A `describe<T>()` chain's terminus is a bare `Registration`, filed only by handing it to `add(...)`: `m.add(m.describe<T>().asFactory(fn).withLifetime('singleton'))` [V `tests/di.test/test/describe-dialect.test.ts:187-196`]. This design needs no describe chains — the factory overload `add<T>(fn, lifetime)` covers every case — but the filing idiom is the rule for the day `taggedAs` is needed.
10. **Registration sugar lowers anywhere, including function bodies.** The transform's visitor calls `tryInline` on every call expression with no statement-position gate [V `transforms/internal/inlinetransform/stage.go` `fileState.run`], and std's own shipped code uses `add<T>`/`addValue<T>` sugar inside function bodies on parameter-typed receivers, lowered to zero `typefor(` in its bundles [V `libraries/hosting/src/host-composition.ts` `populateFrameworkServices`; `libraries/diagnostics/src/manifests.ts:41-44`]. The contribution-function pattern (`registerRunServices(m, plan)`) is therefore safe. (An older doc claim that registration verbs lower only at module top level is superseded on `bd2074fa`.)
11. **`di` (the engine) lives only at roots; everything else codes against `di.core`.** [V `libraries/di/README.md:5`.] `contracts` and `register` files import `Manifest`/types from `@rhombus-std/di.core`; only `src/entry/*.ts` import `Builder` from `@rhombus-std/di`.
12. Contributor setup assumes **bun only**. The transform's Go SDK ships as an optional dependency of `@rhombus-std/transforms`, fetched automatically; the first build pays a one-time 41–72 s host compile into a shared cache [V measured], and steady state is a warm sidecar.

---

## 2b. Lifetime model and container genesis

### The model: `standardLifetime()`

Chosen over `taggedLifetime<Vocab>()` on fnclaude's actual shape:

- **The only real lifetime boundary is process-outlives-session, and it needs no nesting.** A launcher process hosts exactly one claude session — handoff and restart execve-replace the process image, so "session" is a one-shot teardown boundary, not a reused tier. Under `standardLifetime`, container singletons + explicit disposal express this exactly; under tagged, you would invent a vocabulary to describe a hierarchy that never branches.
- **Even simpler: no scopes at all.** Every service in the map (§4) is a process-lifetime `'singleton'`, a stateless `'transient'`, or a frozen value. `standardLifetime` caches singletons **at the container** (adopted on first ask [V]), so correct sharing needs zero scope machinery. `taggedLifetime`'s built provider caches *nothing* [V `tagged-lifetime.ts:16`] — it would force opening a tag scope just to get caching, i.e. force exactly the apparatus fnclaude doesn't need, and a mistaken bare-provider resolve would silently mint a fresh instance with no guard.
- **`validateScopes()` exists only for standard** [V `validate-scopes.ts` returns `Addon<StandardLifetime>`] — free static captive-dependency insurance the day a `'scoped'` service appears. No equivalent can exist for tagged (tag nesting is decided at runtime; no static order exists).
- **The closed vocabulary is compile-teeth.** With no `undefined` member, every registration must state its sharing intent in source, checked by `tsc` (doctrine 9a). A vocabulary containing `undefined` (tagged's shape) makes omission legal and silently uncached.

The one future condition under which tagged would win — per-MCP-tool-call scopes that resolve *session-scoped* services through a nested chain — is not a requirement today and is not invented to justify machinery (§12 Q4).

### Validation addons and order

All three ride every root. Registration ordering across the validators + the model does not change functional outcome [V — registrations from all addons are collected before any middleware runs]; validators go first for readability, the lifetime model last before services:

```
Builder.useAddon(validateUniversalAddresses())
       .useAddon(validateBuildability())
       .useAddon(validateScopes())      // dormant today (0 scoped services); armed the day one appears
       .useAddon(standardLifetime())    // locks the chain's Lifetime to StandardLifetime
       .withServices(...)               // the lambda receives Manifest<StandardLifetime>
       .build()                         // => IDisposableServiceProvider
```

There is **no** `build({validateOnBuild})` option, no `ServiceManifest`, no `provider.createScope()` — the chain above is the whole genesis API [V `libraries/di/src/di.ts`].

### Genesis chains — every root, real TypeScript

**`src/entry/plan.ts`** — short-lived, **async** (the plan pipeline awaits fngit resolution [V `main.ts:203`] and auto-name [V `main.ts:318`]); `await using` keeps the container alive until `plan()` settles; config is loaded **before** the chain opens — it is an input to composition, plain frozen per-field-degraded data, not a service the container constructs:

```ts
import { Builder, standardLifetime, validateBuildability, validateScopes, validateUniversalAddresses } from '@rhombus-std/di';
import { registerPlanServices } from '../launch/register.ts';
import { loadConfig } from '../config/load.ts';
import type { LaunchInputs, LaunchPlan, IPlanner } from '../launch/contracts.ts';

export async function buildLaunchPlan(inputs: LaunchInputs): Promise<LaunchPlan> {
  const cfg = await loadConfig({ env: inputs.xdg });   // BEFORE the chain — per-field degrade intact
  await using provider = Builder
    .useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices(m => registerPlanServices(m, inputs, cfg))
    .build();
  return await provider.resolve<IPlanner>().plan();    // frozen, ref-free LaunchPlan
}                                                       // provider disposed AFTER the await settles
```

`IPlanner.plan()` copies `cfg` whole onto the frozen plan (`plan.config`) and drains the plan root's warning buffer into `plan.warnings` before freezing.

**`src/entry/install.ts`** — `fnc install -y` is not a launch; it needs `configuredPaths(xdgEnv)`, not the config record:

```ts
export async function runInstall(flags: InstallFlags): Promise<number> {
  await using provider = Builder
    .useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices(m => registerInstallServices(m, flags))
    .build();
  return await provider.resolve<IInstallRunner>().run();  // wraps runInstallNonInteractive
}
```

**`src/entry/run.ts`** — the session root. Both execve tails run **outside** the container, after disposal; MCP bind failure maps to exit 2; warnings flush only on the plain-exit path:

```ts
import type { LaunchPlan, SessionOutcome } from '../launch/contracts.ts';
import { McpBindError } from '../mcp/listener.ts';
import { replaceProcessImage } from '../handoff/exec-image.ts';        // NOT registered — handoff tail
import { reexecSelf } from '../handoff/spawn-launcher.ts';             // NOT registered — cross-CWD tail
import { decideCrossCwdRelaunch } from '../launch/cross-cwd-parse.ts'; // pure decision fn
import { sessionJSONLPath } from '../usage/proc-session-id.ts';
import { flushWarnings } from '../warnings/buffer.ts';
import { existsSync } from 'node:fs';

export async function runSession(plan: LaunchPlan, argv: string[]): Promise<number> {
  let outcome: SessionOutcome;
  {
    await using provider = Builder
      .useAddon(validateUniversalAddresses())
      .useAddon(validateBuildability())
      .useAddon(validateScopes())
      .useAddon(standardLifetime())
      .withServices(m => registerRunServices(m, plan))
      .build();

    try {
      // ISession.run(): starts the listener (pre-spawn), spawns claude, starts the
      // monitor (post-spawn), races proc.exited against the handoff detector; on a
      // handoff it SIGTERM/SIGKILLs claude and returns {handoff: argv}. It captures
      // ringBuffer.snapshot() AND the run warning buffer's drain into the outcome
      // BEFORE returning, so both survive disposal. It never touches OUR image.
      outcome = await provider.resolve<ISession>().run();
    } catch (err) {
      // Bind failure: today stderr + exit 2, claude never spawned (main.ts:641-644).
      // start() throws BEFORE the spawner is called; `await using` disposes on this
      // unwind — the one delta vs today's raw exit(2), proven benign by a test (§9).
      if (err instanceof McpBindError) {
        process.stderr.write(`fnclaude: ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }
  // <-- container disposed HERE (LIFO by capture order), provably before either tail.

  // Tail 1 — MCP-triggered handoff (restart / switch stashed argv).
  if (outcome.handoff) {
    await replaceProcessImage(outcome.handoff);   // execve; never returns on success
  }

  // Tail 2 — cross-CWD silent relaunch, reading the pre-disposal ring snapshot.
  const cross = decideCrossCwdRelaunch({
    exitCode: outcome.exitCode,
    alreadyStashed: outcome.handoff !== undefined,
    ringSnapshot: outcome.ringSnapshot,
    origArgs: argv,
    sessionExists: (cwd, uuid) => existsSync(sessionJSONLPath(cwd, uuid)),
  });
  if (cross.relaunch) {
    await reexecSelf({ argv: cross.argv });       // second execve tail; never returns on success
  }

  // Plain exit: neither tail fired. The silent-relaunch paths above skip the flush
  // BY CONSTRUCTION (execve never returns), preserving main.ts:960-966 exactly.
  flushWarnings(outcome.warnings, process.stderr);
  return outcome.exitCode;
}
```

**`src/entry/mcp.ts`** — the subprocess root (a persistent stdio JSON-RPC pump, spawned once per claude session):

```ts
export async function runMcpServer(flags: McpFlags): Promise<number> {
  await using provider = Builder
    .useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices(m => registerMcpServices(m, flags))
    .build();
  return await provider.resolve<IMcpPump>().pump();  // async METHOD; sync construction
}
```

---

## 3. Composition topology

| Role | Process | Root | Shape | Scopes |
|---|---|---|---|---|
| Launcher (session) | parent | `entry/run.ts` | plain Builder | none (pure-singleton) |
| Plan | parent, before run | `entry/plan.ts` | plain **async** Builder; config loaded pre-chain | none (disposed after `plan()` settles) |
| Install `-y` | parent, exits pre-launch | `entry/install.ts` | plain Builder mini-root | none |
| MCP subprocess | child (spawned by claude) | `entry/mcp.ts` | plain Builder | none |
| Install/OOBE wizard | parent (same as launcher) | `entry/run.ts` with the `plan.oobe` overlay | plain Builder | none (`OobeState` singleton built from frozen plan data) |
| Context monitor / handoff detection / ring buffer | parent, in-process | services **inside** the run container (PTY/unix overlays) | sync-constructed singletons, started by `ISession.run()`, disposed with the container | — |
| **execve tail ×2** | parent | **NOT in any container** | invoked by `run.ts` after disposal | — |

`main.ts` becomes a ~100–140 LOC pre-DI dispatcher: argv intake (env-var round-trip preserved), help/version short-circuit (no container is ever built for these), the two swallowed signal no-ops, the internal test-dump escape hatches, then the role fork:

```ts
import { readArgv } from './argv/intake.ts';
const argv = readArgv();
if (wantsHelp(argv) || wantsVersion(argv)) { printAndExit(argv); }        // no container
if (isMcpSubcommand(argv)) { process.exit(await (await import('./entry/mcp.ts')).runMcpServer(parseMcpFlags(argv))); }
if (isInstallDashY(argv))  { process.exit(await (await import('./entry/install.ts')).runInstall(parseInstallFlags(argv))); }
const plan = await (await import('./entry/plan.ts')).buildLaunchPlan(toLaunchInputs(argv));
process.exit(await (await import('./entry/run.ts')).runSession(plan, argv));
```

`entry/plan.ts` + `registerPlanServices` absorb phases 5–17 of today's `main.ts` (config load through the argv-rewriting pipeline — cwd resolution via fngit, worktree intercept, alias/short-flag expansion, auto-tmux, auto-name, session-id mint, fragment injection, OOBE wizard-arg injection, socket path, env compose, claude location). The **Planner is a thin orchestrator over injected phase services** — each phase is a registered service named in the Planner's ctor, so `validateBuildability` catches a missing phase collaborator at the plan root's `build()`. When `inputs.oobe` is set (bare `fnc install`), the Planner skips ref resolution entirely [V `main.ts:181-185`] and emits `plan.oobe` as frozen data. `useTerminal`/`mcpEnabled` are computed into the plan from `LaunchInputs` (TTY-ness and platform are inputs, for testability).

### File layout under `packages/cli/src` (`+` new, `→` changed; everything else unmoved)

```
main.ts                    → ~100-140 LOC pre-DI dispatcher (was 968)
+ entry/
+   plan.ts                async plan root (loads config pre-chain, emits frozen LaunchPlan)
+   install.ts             fnc install -y mini-root
+   run.ts                 session root + both execve-tail invocations + bind-error mapping
+                          + plain-exit warning flush
+   mcp.ts                 subprocess root
+ launch/contracts.ts      LaunchInputs, LaunchPlan (incl. useTerminal/mcpEnabled/socketPath/
+                          oobe/config/warnings), SessionOutcome, IPlanner, ISession, IToolHandler
+ launch/register.ts       registerPlanServices, registerRunServices (+ overlays)
+ launch/session.ts        Session (plain class, sugar-free)
+ install/register.ts      registerInstallServices
+ mcp/register.ts          registerMcpServices
+ ports/                   contracts.ts + node adapters (IFileSystem minimal, IClock,
+                          IEnvironment, IProcessSpawner, IWhich) + disposal.ts adapters
+ composition/version-reader.ts   consolidates the two duplicate version caches [V]
  argv/ config/ handoff/ install/ launch/ log/ mcp/ name/ noop/ oobe/ path/
  prompts/ repo/ restart/ usage/ warnings/ worktree/   (leaf factories unchanged)
+ test/composition/*.ctest.ts     composition tier (sugar-bearing; own lowering lane, §5/§7)
```

Blast radius, stated honestly: **additive at the leaf level** (no leaf module's signature changes — they already take injectable deps [V fnclaude codebase map]), **not additive at the composition level** — `main.ts` shrinks to a dispatcher, the ~370 LOC of plan logic relocates into the Planner's phase services, and the register files are new.

---

## 4. Service map

Legend: **S** = `'singleton'` (process-lifetime), **T** = `'transient'` (stateless per-resolution; the lifetime argument is compile-required and always written), **V** = value (`addValue` — no lifetime; handed back as registered, never constructed, never disposed; also the door for every **function-shaped** frozen seam, doctrine 9b). Factories take **typed dependency parameters** (the engine reads `asFactory`/`add`'s observed signature and plans each parameter [V — `typefor(implementer)` observes the ctor/function type; `PlannerVisitor.ts:284-286` plans array-typed ctor params as the element type's aggregate]) and call the **unchanged** leaf factories with deps-objects. A **†** marks a disposable adapted to the `Symbol.dispose`/`Symbol.asyncDispose` protocol at its factory (`ports/disposal.ts` — `standardLifetime` captures for teardown only instances offering the Symbol protocol [V], and fnclaude's leaves expose `.stop()` [V `mcp/listener.ts:57`, `usage/context-monitor.ts`]).

### Plan root (`registerPlanServices`)

| Contract | Impl (real leaf) | Life | Notes |
|---|---|---|---|
| `LaunchInputs` | frozen argv/env product | V | |
| `IConfig` | `loadConfig` result (loaded pre-chain) | V | carried whole as `plan.config` |
| `IWarningBuffer` | `warnings/buffer.ts:createWarningBuffer` (zero-arg [V]) | S | drained into `plan.warnings` by `plan()` |
| `IFileSystem` | `ports/node-fs.ts` (minimal, §5) | S | |
| `IProcessSpawner` | `ports/node-spawner.ts` | T | |
| `IWhich` | `defaultWhich` (function-shaped [V `clipboard-backends.ts`]) | V | value door |
| `IFngitRunner` | `repo/fngit.ts:makeFngitRunner` | T | **registered only when `Bun.which('fngit')` resolves**; consumers depend on `IFngitRunner \| undefined` — union settlement resolves the runner if registered, else falls to the reachable `undefined` literal and the resolver takes the real-paths-only branch [V engine union-settlement + `union-resolution.test.ts:67-84` self-supplying literal] |
| `ICwdResolver`, `IWorktreeLister`, `IWorktreeIntercept`, `IAutoNamer`, `IFragmentLoader`, `ISessionIdMinter`, `IEnvComposer`, `ISocketPathComputer`, `IClaudeLocator`, `INoopSeeder` | today's phase factories (main.ts phases 8–17) | T (S where caching pays, e.g. `IAutoNamer`) | one per phase family; Planner's ctor names them all |
| `IPlanner` | `launch/planner.ts` (new orchestrator) | S | `plan()` is the async METHOD |

### Run root (`registerRunServices`) — with conditional overlays

| Contract | Impl | Life | Condition |
|---|---|---|---|
| `LaunchPlan` / `IConfig` / `XdgEnv` | `plan` / `plan.config` / `plan.xdg` | V | always |
| `IWarningBuffer` | seeded factory over `plan.warnings` | S | always |
| `IFileSystem` | node adapter | S | always |
| `ILogger` | factory projecting `initLogging({env, platform, home, …}).logger` [V `log/init.ts:56-77` returns `{logger, logPath}`]; degrade-to-noop is the leaf's own behavior | S | always |
| `IHandoffTrigger` | `handoff/trigger.ts:createHandoffTrigger` (zero-arg [V]; replaces the module-level `handoffTrigger` const) | S | always |
| `IHandoffDetector` | new seam splitting `handoff/awaiter.ts` + `kill-and-exec.ts`: races the trigger, on fire SIGTERM→SIGKILL(200 ms) claude, returns the stashed argv — **no execve** | S | always |
| `IVersionReader` | `composition/version-reader.ts` (consolidates the two duplicate caches [V]) | S | always |
| `IProcessSpawner` | node adapter (`spawnPty`/`spawnInherit` over `Bun.Terminal`/`Bun.spawn`) | T | always |
| `IWhich` | `defaultWhich` | V | always |
| `ILivePermissionReader` | new adapter over the free functions in `launch/live-permission-reader.ts` [V — no factory exists in the leaf], closing over `plan.launchCWD`/`plan.sessionID` via a typed `LaunchPlan` param | S | always |
| `IToolHandler` (multi-registration) | the handler classes/factories: restart, switch_project, spawn_session (injects `IConfig` — `autoSpawnCommand` [V `main.ts:604`]), copy_to_clipboard, request_compact, set_effort, set_model, run_slash (opt-in), get_usage | S each | always (repeated `add` at one address accumulates; an unregistered aggregate resolves `[]` [V `aggregate-resolution.test.ts:17-27`]) |
| `IDispatcher` | `Dispatcher` — ctor `(handlers: IToolHandler[])`, builds the fixed name→handler map once | S | always |
| `ISession` | `launch/session.ts:Session` | S | always |
| `IMcpListener` † | wrapper over `mcp/listener.ts:startMcpListener` — **sync-constructed, explicit async `start()`** that performs the bind and throws typed `McpBindError` on failure; `Symbol.asyncDispose` = stop + socket unlink | S | **`plan.mcpEnabled`** ([V] the leaf throws on win32; `main.ts:474` skips the whole socket block there) |
| `IRingBuffer` | `asFactory(() => new RingBuffer())` (optional ctor param sidestepped [V `ring-buffer.ts:33`]) | S | **`plan.useTerminal`** |
| `IPtyWriterHolder` / `IControlSeamHolder` | `createPtyWriterHolder` / `createControlSeamHolder` (zero-arg [V]; deferred-binding holders — constructed empty pre-spawn, bound after `Bun.spawn`) | S | **`plan.useTerminal`** |
| `IContextMonitor` † | factory over `usage/context-monitor.ts:startContextMonitor` (deps-object [V]); injects `IConfig` for the notice ladder [V `main.ts:798-800`]; `Symbol.dispose` = timer stop | S | **`plan.useTerminal`** |
| `OobeState` + `IToolHandler` ×3 (oobe_next/answer/reask) | `OobeState.fromPlan(plan.oobe!)` + the three handlers | S | **`plan.oobe`** |

**Deliberately absent:** `replaceProcessImage` and `reexecSelf` (the execve tails — doctrine 5), and the raw `startHandoffAwaiter` leaf (it requires the spawned `proc` [V `handoff/awaiter.ts:47-64`] and runs the tail; its detection half becomes `IHandoffDetector`, the race takes `proc` as a method argument).

### MCP root (`registerMcpServices`)

| Contract | Impl | Life |
|---|---|---|
| `McpFlags` / `XdgEnv` | frozen values | V |
| `ILogger` | same `initLogging` projection — **closes the current gap: the MCP subprocess is unlogged today [V]** | S |
| `IWireClient` | `mcp/wire.ts:dialAndCall` (function-shaped [V]) | V |
| `IVersionReader` | consolidated reader | S |
| `IMcpPump` | `McpPump` wrapping `mcp/dispatch.ts`'s stdin pump | S |

### Install root (`registerInstallServices`)

`InstallFlags` (V), `XdgEnv` (V), `IFileSystem` (S), `IInstallRunner` (S, wraps `runInstallNonInteractive`).

### Registration file — run root (representative, real TypeScript)

```ts
// src/launch/register.ts
import type { Manifest, StandardLifetime } from '@rhombus-std/di.core';
import { asAsyncDisposable, asDisposable } from '../ports/disposal.ts';
// … leaf imports elided; every concrete is the leaf's real export.

export function registerRunServices(m: Manifest<StandardLifetime>, plan: LaunchPlan): Manifest<StandardLifetime> {
  let s = m
    .addValue<LaunchPlan>(plan)
    .addValue<IConfig>(plan.config)                       // the WHOLE loaded record rides the plan
    .addValue<XdgEnv>(plan.xdg)
    .addValue<IWhich>(defaultWhich)                       // function-shaped seam → value door
    .add<IWarningBuffer>(() => {
      const b = createWarningBuffer();
      for (const w of plan.warnings) b.add(w);            // seeded from the plan phase's drain
      return b;
    }, 'singleton')
    .add<IFileSystem>(NodeFileSystem, 'singleton')
    .add<IProcessSpawner>(NodeSpawner, 'transient')
    .add<ILogger>(() => initLogging({
      env: process.env, platform: process.platform, home: plan.xdg.home,
    }).logger, 'singleton')                               // leaf returns {logger, logPath}; project .logger
    .add<IHandoffTrigger>(createHandoffTrigger, 'singleton')
    .add<IHandoffDetector>((t: IHandoffTrigger, p: IProcessSpawner) => createHandoffDetector(t, p), 'singleton')
    .add<IVersionReader>(() => createVersionReader(), 'singleton')
    .add<ILivePermissionReader>((p: LaunchPlan) => ({
      read: () => readLivePermissionMode(p.launchCWD, p.sessionID),
    }), 'singleton')
    // Tool handlers as multi-registrations; typed deps in, deps-objects to the
    // unchanged leaf factories (e.g. createRestartHandler({origArgs, launchCWD,
    // trigger, livePermissionModeReader}) keeps its verbatim signature [V restart.ts:43-44]):
    .add<IToolHandler>((t: IHandoffTrigger, live: ILivePermissionReader) =>
      createRestartHandler({ origArgs: plan.origArgs, launchCWD: plan.launchCWD,
                             trigger: t, livePermissionModeReader: live.read }), 'singleton')
    .add<IToolHandler>((cfg: IConfig, w: IWhich, sp: IProcessSpawner) =>
      createSpawnHandler({ autoSpawnCommand: cfg.autoSpawnCommand, which: w, spawn: sp.spawn }), 'singleton')
    // … the remaining handlers, same pattern …
    .add<IDispatcher>(Dispatcher, 'singleton')            // ctor (handlers: IToolHandler[]) — engine plans the aggregate
    .add<ISession>(Session, 'singleton');

  if (plan.mcpEnabled) {                                  // Unix-only overlay [V listener throws on win32]
    s = s.add<IMcpListener>((d: IDispatcher, log: ILogger) =>
      new McpListener(plan.socketPath!, d, log), 'singleton');   // sync ctor; async start() binds
  }
  if (plan.useTerminal) {                                 // PTY-branch overlay [V main.ts:679-822]
    s = s
      .add<IRingBuffer>(() => new RingBuffer(), 'singleton')
      .add<IPtyWriterHolder>(createPtyWriterHolder, 'singleton')
      .add<IControlSeamHolder>(createControlSeamHolder, 'singleton')
      .add<IContextMonitor>((c: IControlSeamHolder, cfg: IConfig, p: LaunchPlan, log: ILogger) =>
        asDisposable(startContextMonitor({
          ladder: cfg.contextNoticeLadder, ownSessionFile: p.sessionJSONLPath,
          sendControl: c.send, log,
        })), 'singleton');
  }
  if (plan.oobe) {                                        // OOBE overlay from FROZEN plan data
    s = s
      .add<OobeState>(() => OobeState.fromPlan(plan.oobe!), 'singleton')
      .add<IToolHandler>((st: OobeState) => createOobeNextHandler({ state: st }), 'singleton')
      .add<IToolHandler>((st: OobeState) => createOobeAnswerHandler({ state: st }), 'singleton')
      .add<IToolHandler>((st: OobeState) => createOobeReaskHandler({ state: st }), 'singleton');
  }
  return s;
}
```

### Representative consumer — `src/launch/session.ts` (plain class, no sugar)

```ts
// Leaf-adjacent composition class: constructor injection only — unit tests call
// `new Session(fakes)` with zero DI and zero transform. Optional deps use
// `T | undefined`: the undefined literal member is SELF-SUPPLYING — no
// registration needed when the overlay is absent [V union-resolution.test.ts:67-84].
export class Session implements ISession {
  constructor(
    private readonly plan: LaunchPlan,
    private readonly spawner: IProcessSpawner,
    private readonly detector: IHandoffDetector,           // detection + kill; returns argv
    private readonly log: ILogger,
    private readonly warnings: IWarningBuffer,             // seeded from plan.warnings
    private readonly listener: IMcpListener | undefined,   // undefined on win32
    private readonly monitor: IContextMonitor | undefined, // undefined on the inherit branch
    private readonly ring: IRingBuffer | undefined,
    private readonly ptyWriter: IPtyWriterHolder | undefined, // holder; bound after spawn
  ) {}

  async run(): Promise<SessionOutcome> {
    await this.listener?.start();          // binds the socket BEFORE spawn — today's order
                                           // (main.ts:577-646); throws McpBindError on failure
    const proc = this.plan.useTerminal
      ? this.spawner.spawnPty(this.plan.claudeArgv, this.plan.env)
      : this.spawner.spawnInherit(this.plan.claudeArgv, this.plan.env);
    this.ptyWriter?.bind(t => proc.terminal!.write(t));    // deferred binding, explicit
    this.monitor?.start(proc);             // AFTER spawn — today's order (main.ts:679-822)
    const handoff = await this.detector.race(proc);        // argv on handoff, or undefined
    const exitCode = await proc.exited;
    // Ring snapshot AND warnings captured HERE, before disposal (doctrine 2).
    return { exitCode, handoff, ringSnapshot: this.ring?.snapshot() ?? '', warnings: this.warnings.drain() };
  }
}
```

```ts
export interface SessionOutcome {
  readonly exitCode: number;
  readonly handoff?: string[];          // MCP-triggered relaunch argv, or undefined
  readonly ringSnapshot: string;        // PTY ring-buffer text, captured BEFORE disposal; '' on inherit
  readonly warnings: readonly string[]; // run buffer drained BEFORE disposal; flushed on plain exit only
}
```

Start is explicit (doctrine 9c); **stop is disposal** — the listener/monitor wrappers carry `Symbol.asyncDispose`/`Symbol.dispose` (via the `ports/disposal.ts` adapters over their `.stop()`, no leaf change), so the container's LIFO teardown replaces today's `finally` block. LIFO by capture order means the eager-resolution order inside `ISession.run()` **pins** the teardown order: the monitor is constructed before the listener finishes starting is irrelevant — what matters is that disposal runs listener-then-monitor equivalently to today's `finally` [V `main.ts:853-860`], asserted by a test (§9 PR-4). `tsconfig.base.json` already enables `ESNext.Disposable`, so `using`/`await using` work today [V].

**Decorator-by-shadowing** is the override idiom [V engine]: a later registration whose factory names its own address resolves that slot from what it shadows. **Optional deps** are `T | undefined` unions with the self-supplying literal.

---

## 5. Ports and test substitution

The one systematic seam gap in the tree is the filesystem [V — 25 files call `fs` inline; spawn/which are already seamed]. Policy: **`IFileSystem` is a minimal, deliberate seam, not a 25-file port** — a leaf keeps inline `fs` unless a hermetic unit test needs substitution (config degrade is the one identified case). The other fs-using files stay covered by real-tmpdir tests, which is today's working pattern.

| Port | Wraps | Test substitute |
|---|---|---|
| `IProcessSpawner` | `Bun.spawn` / `Bun.Terminal` (`spawnPty`/`spawnInherit`) | recording fake (the `run-with-fake-claude.ts` fixture stays for e2e) |
| `IWhich` | `defaultWhich` over `Bun.which` (value-door) | `addValue<IWhich>(fakeWhich)` |
| `IFngitRunner \| undefined` | `repo/fngit.ts` (optional) | register a fake, or leave unregistered (absence path) |
| `IFileSystem` (minimal) | `node:fs` — only where a hermetic test earns it | in-memory fake |
| `IClock` | `{ now(): number }` object contract | fixed clock value |
| `IEnvironment` | frozen env record (de-dupes the 3 `HOME` reads [V]) | frozen fake |
| AF_UNIX sockets | inside `IMcpListener` / `IWireClient` | **real socket on a temp path** — deliberate existing practice [V]; mocks would hide wire bugs |

**Three test tiers:**

1. **Unit** (the existing ~1451-test suite, ~105 s [V measured]): construct leaves directly with fakes. No container, no sugar, no transform. Unchanged.
2. **Composition** (`test/composition/*.ctest.ts`, new, ~10–18 tests): build real containers and assert wiring. The **variant matrix** — plan root; install root; mcp root; run root × {unix+pty+normal, unix+pty+oobe, unix+inherit, win32-inherit} — each build asserting (a) `validateBuildability` passes and (b) **identity**: `resolve<T>()` twice → `toBe` the same instance for every shared singleton (trigger, ring, holders, dispatcher, warning buffer) — the only guard for the wrong-lifetime bug class the validators cannot see (doctrine 1). Rule: any new `if (…)` overlay in a register file adds a matrix row (a CI grep cross-checks overlay-condition count vs matrix size). These files carry `resolve<T>()` sugar and therefore ride their **own lowering lane** (§7) — the `.ctest.ts` suffix keeps them out of bare `bun test`'s discovery, satisfying the plain-`bun test` constraint in letter and intent.
3. **e2e** (existing): spawn `bin/fnc.js` + fake-claude via PATH, drive through `FNC_INTERNAL_DUMP_*`. Invisible to the DI change; the dump-plan and handshake tests become the byte-parity acceptance gates for the migration.

---

## 6. Config, options, logging through DI

- **Config = frozen value, never a live options service.** `loadConfig({env})` runs once in `buildLaunchPlan`, *before* the plan chain opens (it needs only `XdgEnv` from the inputs); the result is `addValue<IConfig>(cfg)` in the plan container, carried **whole** as `plan.config`, and `addValue<IConfig>(plan.config)` in the run root. Run-phase consumers (SpawnHandler's `autoSpawnCommand` [V `main.ts:604`], ContextMonitor's notice ladder [V `main.ts:798-800`]) inject `IConfig`. Per-field degrade is untouched. **`addOptions<T>()` is not adopted**: it has no runtime form (fails via transform diagnostics [V]) and an options lane would fight the no-runtime-validation invariant. Guard: a CI grep confines `loadConfig(` to `entry/plan.ts` + `config/`.
- **Warnings = two seeded buffers bridged by plan data.** Plan root's buffer collects intercept/fragment/prompts-dir warnings [V `main.ts:255/:374/:377`]; `plan()` drains it into `plan.warnings`; the run root's buffer is seeded from it; `Session.run()` drains into `SessionOutcome.warnings`; `run.ts` flushes on the plain-exit path only — both execve tails skip the flush by construction, preserving [V `main.ts:960-966`].
- **Logging** stays file-only, never-throws, degrade-to-noop — all leaf behavior (`initLogging` [V]); DI only changes who hands the logger out. The MCP subprocess's container registers `ILogger` too, closing the currently-unlogged-subprocess gap [V].
- **Paths/`XdgEnv`**: one frozen value object, `addValue<XdgEnv>`, replacing by-value threading.

---

## 7. Build, dev, test, publish pipeline

### Where the transform runs: build-to-dist behind `bin/fnc.js`

Not a `bun test` preload (std's own preload is broken end-to-end with an unpinned root cause [V], and an out-of-monorepo preload was never demonstrated), and not a per-file runtime stage. The sugar surface is small and stable (entry + register files + `.ctest`), and the transform lowers exactly that via the proven two-phase shape [V — the std example app's recipe]:

1. **Stage**: every `src/**/*.ts` compiled as its own entrypoint through `@ttsc/unplugin/bun` into `.ttsc-out/`, driven by `tsconfig.ttsc.json` (extends the base config; `rootDir: src`, `outDir: .ttsc-out`, **no `plugins` array** — its absence is what enables auto-discovery of the one Go host, spawned because `di.extras`/`primitives.extras` are devDependencies carrying the `ttsc` marker [V]).
2. **Bundle**: a plugin-free `Bun.build` over the staged output into `dist/main.js`, with `@rhombus-std/*` **external** (lowered output imports `@rhombus-std/primitives` at runtime — `typefor` folds to a `Type` expression [V]; inlining primitives would fork the intern table).
3. **Sentinel**: `tools/build-dist.ts` asserts the bundle contains **zero `typefor(`** and only then writes `dist/.lowered` as its last step.

**The poisoned-dist trap is closed at both ends** [V — `packages/cli/tsconfig.json` currently declares `outDir: ./dist` with no `noEmit`, so a stray `tsc -p` would emit *un-lowered* JS a naive shim would prefer]: the dev tsconfig gains `"noEmit": true` (emit confined to `tsconfig.build.json`), and `bin/fnc.js` forks on the **sentinel**, which only the build tool can write:

```js
// bin/fnc.js under Bun (the Node→Bun argv preflight is unchanged)
const installed = existsSync(distLowered) && existsSync(distMain);
if (installed) {
  await import(distMain);                    // installed: pre-lowered bundle, no host, no transform
} else if (existsSync(srcMain)) {
  await ensureFreshDist();                   // dev: rebuild iff newest src/** mtime > dist/.lowered mtime
  await import(distMain);
} else {
  process.stderr.write('fnc: dist/.lowered missing and no src/ present — reinstall @rhombus.rocks/fnclaude\n');
  process.exit(1);                           // stripped install fails loud, never weird
}
```

A dist emitted by bare `tsc` carries no sentinel → treated as stale → rebuilt. The packed tarball verifiably ships the sentinel (`bun pm pack` with `files: ["dist","bin"]` lists `package/dist/.lowered` [V — scratch pack test]).

### What each loop costs

| Loop | Transform cost | Status |
|---|---|---|
| `bun test` (unit, packages/cli) | **zero** — no unit test imports `entry/*` or a register file (CI grep-guard) | baseline ~105 s / 1451 tests [V measured]; PR-0 asserts no regression |
| dev `fnc` invocation | `ensureFreshDist()` mtime check (~0 when fresh); warm stage+bundle rebuild when stale — **a regression from today's zero-build dev loop, honestly owned** | warm rebuild at fnclaude scale (87 files) is **UNMEASURED** — the std example app measured 6.6 s warm on a much smaller tree [V]; the prior ~2 s figure is renderer-era and does not bind. **PR-0 measures; no figure may be cited as fact until then** |
| first build on a fresh machine | one-time Go host compile, 41–72 s into a shared cache [V]; no Go install needed (platform SDK is an optional dep of `@rhombus-std/transforms`) | documented in CONTRIBUTING |
| `bun run test:composition` | stage `src/**` + `test/composition/**` via `tsconfig.ttsc.tests.json` (extends `tsconfig.ttsc.json`; `rootDir: "."`, outDir `.ttsc-out-tests/`), plugin-free `Bun.build` per `.ctest.ts` entrypoint (externals: `bun:test` + `@rhombus-std/*`) into `.composition-out/`, then `bun test .composition-out` | CI-gated post-build tier, not part of the plain-bun loop; smoke-proved in PR-1 before the matrix rides it |
| CI | persist `TTSC_CACHE_DIR` + `GOCACHE` keyed on ttsc/host version; **cache persistence is unproven** — accepted-cost fallback is 41–72 s per CI build | checklist item |

### Dependencies (exact)

- **Runtime `dependencies`** (exact-pinned, no caret): `@rhombus-std/di`, `@rhombus-std/di.core`, `@rhombus-std/primitives` — interim as `file:./vendor/*.tgz`, post-flip as exact `@next` versions.
- **`devDependencies`**: `@rhombus-std/di.extras`, `@rhombus-std/primitives.extras`, `@rhombus-std/transforms` (vendored likewise), plus `ttsc` (pin the example app's known-good version, 0.18.1 at spec time) and `@ttsc/unplugin`.
- `@rhombus-std/di.extras.options` is **not** a dependency (no `addOptions` lane).

### Publish packaging: external, exact-pinned (target)

The published `@rhombus.rocks/fnclaude` ships `dist/` (lowered bundle + sentinel) + `bin/`, with the three runtime `@rhombus-std` packages **external and exact-pinned**. The identity argument [V]: what forks the Type intern table is a *second loaded copy* of `primitives`/`di.core`, not bundling per se; version is excluded from the `Type` specifier; an exact pin under the hoisted linker yields exactly one physical copy of each; and `di.core` carries `stampSingleInstance`, converting an accidental double-copy into a loud module-eval throw. External also matches std's own doctrine (runtime deps stay external) and avoids the *silent* hazard inlining carries — `primitives` has **no** self-guard, so a bundling mistake that duplicated it would fork identity silently.

Timing makes this safe to target: publishing is paused and this branch never merges in this effort, so no publish can precede real `@next` packages. **Contingency** (only if a publish is ever forced before `@next` exists, since a registry manifest can name neither placeholder alphas nor `file:` tarballs): inline the runtime with all `@rhombus-std` as devDependencies, gated by a **hard publish blocker** — grep the bundle for exactly one copy of `primitives` AND `di.core`, plus a `stampSingleInstance` smoke import; a trip blocks publishing outright. See §12 Q1.

---

## 8. Consuming `@rhombus-std` now, and the `@next` flip

### npm state (re-check before acting: `npm view @rhombus-std/<pkg> dist-tags`)

As of 2026-09-05 [V]: only `@rhombus-std/primitives` has `@next` (0.1.0-next.0, from std commit `7e98f776` — **older** than `bd2074fa` and predating the whole-ask-surface sugar); `di`, `di.core`, `di.extras`, `primitives.extras` are placeholder alphas; `@rhombus-std/transforms` is not on npm at all. Nothing can consume `@next` today, and **a partial flip is forbidden** — mixing an npm package with a vendored sibling forks the Type intern table.

### Interim: packed tarballs from the pinned checkout, via a pack-to-staging pipeline

`file:`-links + overrides onto the checkout **fork packages** under bun's isolated linker [V — two physical `di.core` copies observed] — dead path. The working path [V]: packed tarballs + bun's **default hoisted linker** (one copy each, structurally). `tools/vendor-std.ts`, run against the read-only std checkout at `bd2074fa`:

1. `bun pm pack --destination "$STAGING"` **in each of the six library dirs** (`di`, `di.core`, `di.extras`, `primitives`, `primitives.extras`, `transforms`) — in place, because the `workspace:^` → concrete-semver rewrite happens only when pack runs inside the monorepo with its lockfile [V]; `--destination` keeps the checkout clean. Assert `git -C <std> status --porcelain` is empty afterward.
2. Extract each tarball in staging.
3. Patch the **extracted** trees:
   - `publishConfig` → top-level merge for `di`, `di.core`, `primitives` (their unswapped `main`/`exports` point at `src/`, which `files` doesn't ship [V]; `*.extras` ship `src` and skip this). Vanishes on real publish.
   - **`.d.ts` repair — load-bearing, upstream blocker**: `di`'s shipped `dist/bundle/index.d.ts` is syntactically broken — `dts-minify` emitted `0extends1&Candidate` in the `Builder.useAddon`/`withServices` conditional-type guards (4 sites: lines 117, 121, 122×2 [V]) — so `tsc --noEmit` against packed di fails on exactly the chain every root uses. Interim: `sed -i 's/0extends1/0 extends 1/g'` (the `/g` matters — line 122 carries two sites) on the extracted tree. **The durable fix is std-side and is a required upstream task**; a correlated `di.extras` "cannot bind the sugar's type argument" diagnostic seen against packed tarballs must be disambiguated from this corruption in PR-0.
4. Re-tar each patched tree in npm layout (`package/` prefix) into `vendor/`.
5. Install via `file:./vendor/*.tgz` specifiers + mirrored `overrides` (concrete ranges) + the `"@rhombus-toolkit/types": "2.0.0"` pin mirroring std's root [V]. Default hoisted linker. Assert exactly one `node_modules/@rhombus-std/<name>` per package.

### The flip — mechanical, gated on THREE conditions

Proceed only when **all** hold:

- **(a)** `npm view` shows `@next` for **all of**: `di`, `di.core`, `di.extras`, `primitives`, `primitives.extras`, `transforms`;
- **(b)** the published surface covers what `entry/` + the register files call — verified by typechecking fnclaude against the `@next` types (guards the known lag: `primitives@next` currently predates the whole-ask-surface sugar);
- **(c)** `di`'s published `dist/bundle/index.d.ts` **parses** — the upstream `0extends1` fix has shipped. Non-negotiable: a `node_modules` `@next` package cannot be cleanly patched, so dropping the interim sed before (c) holds would break `tsc`.

Then, the exact diff:

```diff
- "@rhombus-std/di":               "file:./vendor/rhombus-std-di-0.0.0.tgz",
- "@rhombus-std/di.core":          "file:./vendor/rhombus-std-di.core-0.0.0.tgz",
- "@rhombus-std/primitives":       "file:./vendor/rhombus-std-primitives-0.0.0.tgz",
+ "@rhombus-std/di":               "0.1.0-next.N",   // the exact resolved @next version — pin it
+ "@rhombus-std/di.core":          "0.1.0-next.N",
+ "@rhombus-std/primitives":       "0.1.0-next.N",
  (devDependencies: di.extras / primitives.extras / transforms — same swap)
```

plus: mirror the `overrides` entries, delete `vendor/`, delete `tools/vendor-std.ts` and the `.d.ts` patch step, `bun install`, re-run the composition matrix, re-assert one copy per package. If `@next` lands but lags `bd2074fa`'s surface, **stay on tarballs** — never flip package-by-package.

---

## 9. Migration sequence

Ordered cheapest-to-falsify first. Each PR lands on `feat-di` (draft #362 — never merged in this effort) with the test that proves it; TDD per the project rule, with `build:`/`ci:` carve-outs named where they apply.

**PR-0 — throwaway spike. SPIKE: scratch dir only, zero repo writes; its deliverables are numbers and a go/no-go, and its scripts graduate into PR-1 as deliverable code.**
Reproduce the full chain out-of-monorepo: vendor (pack-to-staging → merge → patch → re-tar → install, hoisted) → `tsc --noEmit` green on a one-file `Builder.useAddon(standardLifetime()).build()` (proves the `.d.ts` patch) → lower a file using the exact PR dialect (`add<T>(fn, 'singleton')` on a `Manifest<StandardLifetime>` parameter inside a function body) to 0 `typefor(` → run it and `resolve<T>()` successfully. Also: **(a)** disambiguate the packed-`di.extras` "cannot bind the sugar's type argument" diagnostic from the `.d.ts` corruption; **(b)** measure warm stage+bundle wall-clock at fnclaude scale (87 files); **(c)** measure bare-`bun test` delta with the new files present (expect ~0); **(d)** assert one copy of each `@rhombus-std/*`. *Falsifier: no lowered out-of-monorepo build can be produced → the design blocks here; escalate the std-side fixes before any repo plumbing.*

**PR-1 — toolchain plumbing (`build:` carve-out).** `tools/vendor-std.ts` + `vendor/`, devDeps, `tsconfig.ttsc.json` + `tsconfig.build.json` + `noEmit` in the dev tsconfig, `tools/build-dist.ts` + sentinel, `bin/fnc.js` fork, the CI grep-guards (sugar confinement; `loadConfig(` confinement; overlay-vs-matrix count), and the **composition-lane smoke**: one `test/composition/smoke.ctest.ts` stages, bundles with 0 `typefor(`, and runs green via `bun run test:composition`. *Falsifier: the `.ctest` lane cannot run under `bun test` → the tier moves to bundled-per-test standalone scripts (same lane, `bun run` runner); the assertions survive.*

**PR-2 — `ports/` + minimal `IFileSystem` (`feat:`).** Port contracts + node adapters + `ports/disposal.ts`; convert only `config/load.ts`. **Test:** in-memory-fs config-degrade unit test; a composition test proving `await using` runs an adapted disposable's `stop()`, and that removing a factory's dependency registration fails `build()` with `ManifestValidationError` (plan-time edge visibility, testably).

**PR-3 — plan + install roots (`feat:`).** `entry/plan.ts`, `entry/install.ts`, `launch/register.ts` (plan side), Planner + phase services, `main.ts` → dispatcher. **Tests:** `FNC_INTERNAL_DUMP_PLAN` e2e output **byte-identical** to pre-DI for fixture argv+config; the returned plan is deep-frozen, ref-free, survives container disposal; a deliberately-missing phase service fails the plan root's `build()`; `plan.config` carry (a run-root consumer resolves the loaded value); `plan.warnings` drain (a worktree-intercept warning survives); `fnc install -y` e2e exit behavior unchanged; help/version never build a container.

**PR-4 — run root + `ISession` + overlays + both tails (`feat:`).** `entry/run.ts`, `registerRunServices` with the three overlays, the listener/monitor wrappers, `IHandoffDetector` (splitting kill from execve), bind-error mapping, plain-exit warnings flush. **Tests:** (a) fake-execve ordering — disposal completes **before** `replaceProcessImage`; (b) cross-CWD tail fails against a snapshot-dropping `SessionOutcome`; (c) the composition **variant matrix** (four run-root builds), each asserting `validateBuildability` + resolve-twice identity for every singleton; (d) the win32 variant constructs `Session` with `listener === undefined`; (e) start order — listener before spawn, monitor after; (f) `time bun test` ≈ 105 s; (g) bind-failure e2e — occupied socket → exit 2, stderr byte-format preserved, fake-claude never invoked (proves the disposal delta benign; if not, the catch moves outside the `await using` block — a two-line change); (h) warnings-flush e2e — prints after plain exit, absent on the handoff path.

**PR-5 — mcp root (`feat:`).** `entry/mcp.ts` + `registerMcpServices`. **Tests:** the existing JSON-RPC handshake test green through the container, byte-for-byte per `design.mcp.md`; a log line now appears from the MCP role.

**PR-6 — publish pipeline (`build:` carve-out, deferred until a publish is actually wanted).** External exact-pinned packaging per §7. If the inline contingency is ever exercised: the two-copy grep + `stampSingleInstance` smoke as a hard publish blocker.

**PR-7 — the `@next` flip (`build:` carve-out).** Only when §8's three gates hold. **Test:** `bun install` on `@next` specifiers, full build, composition matrix green, one copy per package.

**Deferred / optional, explicitly not scheduled:** a broader `IFileSystem` port (adopt only if in-memory `log`/`prompts` tests prove worth the churn against the temp-dir status quo); the dev-loop preload spike (§12 Q2).

---

## 10. Scorecard of the stances

Axes: correctness against the engine as verified; lifetime fit; sugar compliance; dev+test loop cost; testability; migration falsifiability; publish integrity; flip cost; fit with std doctrine + `specs/decisions.md`. Scores are for the **final amended** designs.

| | tagged-session-kernel | standard-three-roots | hosting-generic-host | preload-zero-build |
|---|---|---|---|---|
| Status | DOMINATED (1 round; conceded the model) | UNSETTLED-at-cap (4 rounds; all breaks repaired) | DOMINATED (1 round; by its own fallback) | UNSETTLED-at-cap (4 rounds; spike-gated) |
| Engine correctness | 4 — mechanics verified, incl. nesting; model unjustified for this codebase | **5** — every dialect/lifetime/async/aggregate fact verified against source or tests | 3 — repaired, but the Host adds a strictly weaker container (no model, no disposal) | 4 — final map re-derived row-by-row against real leaf signatures |
| Lifetime fit | 2 — the one tagged-only capability (request-nests-on-session) is unexercised; forfeits `validateScopes` | **5** — singleton/one-boundary matches the codebase; compile-required lifetimes | 2 — `withLifetime` inert at the Host root (silent transient) | 4 — same conclusion as the winner, minimal reach |
| Dev+test loop | 4 | 4 — unit tier untouched; dev pays build-if-stale (unmeasured) | 3 | 5 *if* the spike lands; unproven mechanism with unpinned upstream root cause |
| Testability | 4 | **5** — matrix + identity assertions + a lowering lane for the guard tier | 3 | 4 — minimal reach forgoes plan-tier build validation |
| Migration falsifiability | 4 (PR-0 shape adopted here) | **5** — every risk has a numbered falsifier, riskiest front-loaded | 3 | 5 — kill-switch confines spike failure to one section |
| Publish integrity / flip | 4 — contributed the three-gate flip | 4 — inline argued well but the hard gate is heavy; adjudicated to external | 1 — ~17–20-package closure, latest possible flip | 5 — external + value-door + sentinel all verified |
| **Verdict** | mined | **winner (chassis)** | mined | strong second (mined heavily) |

Salvage record: from **tagged** — the PR-0 scratch-spike shape, the three-gate flip (the `.d.ts` gate specifically), eager-resolution/LIFO teardown-order pinning, the `stage.go` lowering verification, the honest dev-loop-regression framing. From **hosting** — the verified facts that justify rejecting the Generic Host (no lifetime model, no provider disposal, `NullLifetime` default, closure size), and the `ILoggerProvider` bridge noted as available if hosting is ever revisited. From **preload** — the pack-to-staging vendor pipeline, the `/g` `.d.ts` patch detail, the value-door rule, the `dist/.lowered` sentinel + `noEmit` split, the leaf-signature verifications (initLogging projection, live-permission-reader adapter, zero-arg factories, awaiter-needs-proc), the once-per-session MCP-subprocess cost fact, and the preload spike's honest risk framing.

Points neither side verified, adjudicated to the checklist rather than guessed: warm build time at fnclaude scale; the packed-`di.extras` diagnostic's root cause; CI transform-cache persistence; out-of-monorepo preload viability; inline single-copy bundling feasibility; whether `typefor` handles optional ctor params (sidestepped via zero-arg factories).

---

## 11. Verification checklist (cheapest first)

1. `grep -c '0extends1' <staging>/di/package/dist/bundle/index.d.ts` = 4 pre-patch, 0 post-patch (and grep the other five packages for the corruption class).
2. `npm view @rhombus-std/<pkg> dist-tags` for the six packages (re-check; more `@next` may have landed).
3. One-file lower: `add<T>(fn, 'singleton')` in a function body on a `Manifest<StandardLifetime>` parameter → staged output has 0 `typefor(` and runs.
4. `tsc --noEmit` on a `Builder.useAddon(...)...build()` file against the patched tarballs; disambiguate the `di.extras` type-argument diagnostic.
5. `find node_modules -path '*@rhombus-std*' -name package.json` → exactly one per package (hoisted linker; no `.bun` isolated store).
6. `validateBuildability` catches a deliberately-removed registration at `build()` (plan-time edge visibility).
7. Warm `tools/build-dist.ts` wall-clock at fnclaude scale (the §7 UNMEASURED cell).
8. Bare `bun test` delta with entry/register files present ≈ 0; total ≈ 105 s.
9. Composition-lane smoke: one `.ctest.ts` staged, bundled, green.
10. Resolve-twice identity across the variant matrix; disposal runs adapted `.stop()`s LIFO.
11. Fake-execve ordering: disposal happens-before both tails.
12. `FNC_INTERNAL_DUMP_PLAN` and MCP-handshake byte-parity e2e.
13. Bind-failure path: exit 2, stderr format, no spawn, disposal delta benign.
14. CI: second run's transform cache is warm (else adopt the accepted-cost fallback).
15. Flip rehearsal (when gates hold): swap → install → build → matrix → one-copy assert.

---

## 12. Open questions for the owner

1. **Published-artifact packaging: external exact-pinned vs inline runtime.** Recommended default: **external exact-pinned** (§7) — std doctrine, verified identity-safety, no unproven bundling step; viable because nothing publishes before `@next` exists. Choose inline only if a publish must ship before std's runtime packages are real, and then only behind the two-copy hard gate.
2. **Dev-loop: accept build-if-stale, or fund the preload spike?** Recommended default: **accept build-if-stale** and let PR-0's measured warm-rebuild number decide whether the regression from today's zero-build loop is tolerable. The preload would restore zero-build dev but is verified broken in std with an unpinned root cause; if PR-0's number is painful, a time-boxed single-project-preload spike (consuming pre-lowered tarballs, hoisted linker) is the escape — it changes only §7's "where the transform runs" cell.
3. **`IFileSystem` scope.** Recommended default: **minimal** (config-degrade only, §5). Widening to `log`/`prompts` is a later, separately-justified PR; dropping it entirely is also coherent (temp-dir tests already work) if PR-2's hermetic degrade test isn't valued.
4. **Per-MCP-call request scopes.** Recommended default: **no** — no handler holds per-call state or a per-call disposable today. If per-call scopes that share session services ever become a requirement (per-call correlation/cancellation contexts), that is the one condition under which the lifetime-model decision should be reopened toward `taggedLifetime`.
5. **`fnc install -y` as a fourth root vs plain pre-DI code in the dispatcher.** Recommended default: **fourth mini-root** (§2b) for uniformity and buildability validation; the alternative (leave it hand-wired, it's tiny) costs nothing functionally if root count is judged ceremony.

---

## 13. Draft decision-log entries

To be appended to `specs/decisions.md` by the orchestrator (not written there by this spec). Dated 2026-09-05.

---

**2026-09-05 — DI engine and lifetime model: `@rhombus-std/di` `Builder` + `standardLifetime` + full validation stack**

**Decision:** Containers are assembled with `Builder.useAddon(validateUniversalAddresses()).useAddon(validateBuildability()).useAddon(validateScopes()).useAddon(standardLifetime()).withServices(...).build()`. Pure-singleton containers; no scopes; explicit lifetimes on every registration under `Manifest<StandardLifetime>`.

**Why:** fnclaude's only lifetime boundary is process-outlives-one-session, expressed natively by container singletons + disposal. `taggedLifetime` was evaluated and rejected: its sole distinguishing capability (nested request scopes resolving session services) is unused here, its built provider caches nothing (forcing scope machinery just to share instances), and it structurally cannot have a `validateScopes`. The closed vocabulary makes the lifetime argument compile-required, killing the silent-transient class. `validateScopes` rides dormant as free insurance.

---

**2026-09-05 — Four composition roots; every cross-root value is frozen data**

**Decision:** `entry/plan.ts` (async, short-lived, emits a frozen ref-free `LaunchPlan` carrying `config` whole + drained `warnings`, then disposes), `entry/install.ts` (`install -y`), `entry/run.ts` (session; emits `SessionOutcome` carrying exit code, handoff argv, ring snapshot, run warnings **before** disposal), `entry/mcp.ts` (subprocess). `main.ts` is a pre-DI dispatcher. The hosting Generic Host is not used: it composes no lifetime model, never disposes its provider, and needs an explicit ordering orchestrator anyway.

---

**2026-09-05 — Both execve tails live outside every container; teardown happens-before re-exec**

**Decision:** `replaceProcessImage` (handoff) and `reexecSelf` (cross-CWD) are never registered; `run.ts` invokes them after `await using` disposal completes. The registered `IHandoffDetector` does detection + the kill of claude only and returns the stashed argv. This converts today's teardown-vs-execve soft race into an asserted hard happens-before.

---

**2026-09-05 — Sugar confinement + dialect rules**

**Decision:** di.extras sugar appears only in `entry/*`, `*/register.ts`, and `test/composition/*.ctest.ts` (CI grep-enforced). Explicit lifetimes always; function-shaped frozen seams register through `addValue` (the value door); no async construction (async work is a method; `resolveAsync` is the unused escape hatch); optional deps are `T | undefined` unions; tool handlers are multi-registrations aggregated into the dispatcher's `IToolHandler[]` ctor param. Leaf modules keep their deps-object factory signatures untouched; registration factories take typed params and call them.

---

**2026-09-05 — Transform placement: build-to-dist behind `bin/fnc.js`, sentinel-gated**

**Decision:** The ttsc lowering runs as a stage (per-file, `@ttsc/unplugin/bun`, `.ttsc-out`) + plugin-free `Bun.build` bundle, `@rhombus-std/*` external. Dev = `ensureFreshDist()`; installed = pre-built `dist/`. The fork keys on `dist/.lowered`, written by the build tool only after a zero-`typefor(` assertion; the dev tsconfig is `noEmit` (emit lives in `tsconfig.build.json`), closing the un-lowered-dist trap. Plain `bun test` stays transform-free (sugar-free unit tier); composition tests ride their own stage+bundle lane (`bun run test:composition`). A runtime preload was rejected: broken in std with an unpinned root cause, never demonstrated out-of-monorepo.

---

**2026-09-05 — Interim `@rhombus-std` consumption: packed tarballs from std `bd2074fa`; three-gate `@next` flip**

**Decision:** `bun pm pack --destination` per library (checkout untouched) → extract → patch (`publishConfig` merge for di/di.core/primitives; `sed 's/0extends1/0 extends 1/g'` on di's broken `.d.ts` — a flagged upstream std bug) → re-tar into `vendor/` → `file:` + mirrored overrides + the `@rhombus-toolkit/types@2.0.0` pin, default hoisted linker. `file:`-directory links are forbidden (verified to fork package copies). Flip to `@next` only when (a) all six packages carry the tag, (b) the published surface typechecks against our usage, and (c) di's published `.d.ts` parses; then swap specifiers to the exact resolved versions, delete `vendor/` + the patch steps. Never a partial flip.

---

**2026-09-05 — Published artifact: external exact-pinned `@rhombus-std` runtime deps**

**Decision:** `di`, `di.core`, `primitives` are exact-pinned runtime dependencies of the published package; `di.extras`, `primitives.extras`, `transforms` are devDependencies (their sugar is lowered away). Identity safety: one hoisted copy each, version excluded from `Type` specifiers, `di.core`'s `stampSingleInstance` guards loudly. Inlining the runtime is the documented contingency only for a publish forced before real `@next` packages exist, behind a hard single-copy publish gate (`primitives` has no self-guard — a silent-fork hazard).

---

**2026-09-05 — Config stays a frozen value through DI; no `addOptions`**

**Decision:** `loadConfig` runs before the plan chain; the frozen record is `addValue`'d, rides the plan whole as `plan.config`, and is re-registered in the run root. `addOptions<T>()` is not adopted — it has no runtime form and would fight the no-runtime-validation / per-field-degrade invariant. Warnings bridge roots as data (`plan.warnings` in, `SessionOutcome.warnings` out; flush on plain exit only).

---

**2026-09-05 — `IFileSystem` is a minimal, deliberate seam**

**Decision:** A filesystem port exists but only `config/load.ts` is converted (the one hermetic-test payoff). The other fs-using leaves keep inline `fs` behind real-tmpdir tests — the working status quo. A systematic port is a separately-justified future decision, not part of DI adoption.

---

## Appendix: Provenance

This spec is the judged synthesis of a four-stance adversarial design debate (proposal → attack → rebuttal rounds, each claim verified against std `bd2074fa` and fnclaude `feat-di`), preceded by four research passes (engine semantics, build pipeline, fnclaude codebase map, prior-art review of the July 2026 fnioc-adoption proposal — whose engine-API premises were re-derived and largely superseded).

| Stance | Final status | Rounds |
|---|---|---|
| tagged-session-kernel (`taggedLifetime` over `process/session/request`, deep DI reach) | DOMINATED — conceded the model cluster to standardLifetime | 1 |
| standard-three-roots (`standardLifetime`, plan/run/mcp/install roots, sugar confinement, build-to-dist) | UNSETTLED-at-cap — all found defects repaired; adopted as the chassis | 4 |
| hosting-generic-host (Generic Host per long-lived role) | DOMINATED — by its own plain-Builder fallback | 1 |
| preload-zero-build (load-time lowering, zero-build dev loop, minimal reach) | UNSETTLED-at-cap — mechanism spike-gated; heavily mined | 4 |

The debate transcripts and research reports live in the orchestrating workflow's session record; every load-bearing fact they established is restated here with its evidence tag rather than by reference.
