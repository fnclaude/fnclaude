# Design proposal: @rhombus-std adoption (transform dialect)

> **Status: proposed** — decision pending the open questions (§5).
> **Date:** 2026-07-26. Distilled from a three-stance adversarial design
> debate (research → frame → propose → attack/rebut ×4 → synthesis); the
> full corpus (5 research reports, 3 stance proposals, debate transcripts)
> is preserved outside the repo.

This proposal consolidates a three-stance adversarial design debate on how
fnclaude adopts the @rhombus-std libraries (`di`/`hosting`/`config`,
transform dialect). All three stances reached UNSETTLED-at-cap — none
died, none was dominated — so the recommendation below scores each
stance's final amended form and grafts the strongest pieces of all three
into one design.

---

## 1. Recommendation

**Winner: `three-roots-refactor-first` (amended) as the architectural skeleton — with two decisive grafts: the dev-loop/testing doctrine from `host-everywhere-flag-day`'s round-4 form, and the packaging model from `strangler-di-under-main`'s round-4 form.**

### Why this skeleton

The debate converged, from three directions, on the same discovery: **planning is a distinct phase with its own service family, and the session is the thing with Run() semantics.** Stance 1 ended up jamming the plan phase *inside* the Host (PlannerService as first hosted service), which forced three convention-enforced invariants — a plan-data ctor ban, a three-state PlanSlot with guard lines in every service, and a throwing-getter construction test — purely to work around the fact that hosted-service ctor graphs construct before any `start()` runs. Stance 3's shape — a small **plan root** (plain `ServiceManifest`) that produces a frozen `LaunchPlan`, then a **run root** (Host) built *with* the plan as a value — gets the same separation with zero by-convention invariants: session services can take plan-derived data naturally because the plan exists before the run root builds. Fewer invariants enforced by discipline = more correct under the top-weighted correctness axis (§3). It also matches the `System.CommandLine`/.NET precedent (parse/plan outside, host per invocation) better than planning-as-a-hosted-service does, and it keeps the ~57–115 ms hosting import off the plan/error/dump paths entirely.

Stance 3's **refactor-first sequencing** is also the best fit for fnclaude's TDD + auto-merge-on-green regime: the riskiest bet (the shared prefix factors into one `planLaunch`) is falsified by a pure `refactor:` PR under the existing e2e oracle — and that bet was *attacker-verified* in round 1 (A5: `main.ts:106–527` is a contiguous pipeline, no PTY/renderer/listener coupling). Stance 1's flag-day PR-6 concentrates the same risk into one large PR; stance 2 defers the topology payoff longest.

### The two decisive grafts

**Graft 1 — from stance 1 (host-everywhere), round 4: kill the runtime preload; sugar confinement + build-if-stale dist.** This is the debate's most important *adjudicated* fact. Stance 1's attack D1 measured the runtime-lowering tax **at fnclaude scale** (186 files, warm shared cache): 3.0–4.1 s per `bun test` process, 2.9–3.9 s even for a single-file run (the whole-project transform is per-process), 7.1 s post-edit. Stances 2 and 3 settled their preload-based loops on smaller-scale numbers (66 files ≈ 1 s; an 877 ms fresh-root probe) — a shared optimistic blind spot; the at-scale measurement is controlling. Stance 1's response is also the most elegant resolution in the debate: since di.core's tokenless guards throw at **call** time, not import time (verified), confining sugar to registration files/roots/contracts means **unit tests run plugin-free at today's speed**, composition/lifecycle tests import lowered code from `dist`, and the dev loop becomes "build-if-stale (~1.5–2 s warm for cli's 87 src files, per stance 3's own K3 measurement), run dist" — one mechanism serving `ffnc`, `bun test`, e2e children, the `fnc mcp` re-entry, and execve restarts uniformly. This deletes wholesale: bunfig preloads, the scoped-filter shim, root-preload merging, tsconfig-include-of-test hazards, renderer TSX contamination (stance 3's K1), the tsconfig-less-package wedge (stance 1's D2), the FNC_DEV arming saga (four revisions in stance 2), and the e2e env-scrub problem.

**Graft 2 — from stance 2 (strangler), round 4 (A34): inline the entire @rhombus-std runtime into the published bundle.** Stance 2 empirically demonstrated that the di family's internal caret ranges (`di@alpha5 → ^0.0.0-alpha5` on di.core/primitives) mean a fresh end-user install can resolve **duplicate copies of primitives/di.core** (demonstrated: 2 di.core dirs, 3 primitives dirs under version skew) — forking the augmentation registry and the prototype-patched `ServiceManifest`, i.e. `configure is not a function` at runtime on a user machine, and npm ignores a dependency's own `overrides`. Stances 1 and 3 both kept the runtime external and never confronted this. The fix is category-correct, not a patch: std's "workspace deps stay external" doctrine protects **libraries that share a container**; fnc is an **app** whose container no external package shares (the cli↔renderer contract is deliberately structural, non-DI). Inlining the sub-1-MB runtime into `dist/main.js` makes registry/prototype identity trivially single-copy, moves all @rhombus-std packages to devDependencies, and gives end users a zero-@rhombus-std install.

### Other grafts (by source)

From **stance 1**: factory-closure hosted-service bridge (`addHostedService((sp) => new Svc(sp.resolve<X>(), …))` — only the empirically verified `resolve<T>` lowering, no hand token arrays); `GuardedBackgroundService` + `guardedContinuation` per-service fault policy with host-wide `backgroundServiceErrorBehavior = Ignore` via `asHostBuilder().configureHostOptions` (verified route); the `process.on('unhandledRejection')` backstop (verified: Bun honors an installed handler and survives); the JSONL `ILoggerProvider` bridge as the sole logging provider in both Host roots; `IReexecutor` demoted to a root-owned, **never-registered** object (tail-only-by-construction); the CI composition-validation dry-run test (converged with stance 3); two-lane options (converged with stance 2); the PR-scoped type-debt budgeting (src first, tests later); the publishing-pause coordination gate.

From **stance 2**: curated env/argv **memory-source tables** instead of mechanical provider ingestion (kills both the `FNC_LOG`→flat-key mismatch and bootstrap-var leakage by construction — cleaner than stance 1's prefix-preserving transformation, which still ingests `FNC_ARGS_JSON` et al.); coercing delegate configure steps (the auto-bind `configure(token, section)` assigns raw strings — verified type-unsound); the non-literal renderer import specifier (type-isolates renderer from cli's program — verified TS6142 today); the full `ttscEnv` vendoring including the GOROOT positive-pin + `GOBIN=''` (build-package.ts:60–103, not just 60–78); the exit-code regression matrix pinned against current `main.ts` before any restructure; `IVersionProvider` depth-1 dedup (bundle-safe `import.meta.url`); publish-job cache/build provisioning; the single-graph pinned-SHA `link:` recipe for the spike window.

From **stance 3** (native, kept): plan/run/mcp roots; `LaunchPlan` contract; mode-parameterized hosted set with the renderer→PTY→inherit ladder inside one `ClaudeSessionService` (matches today's degrade at `main.ts:662–709`); the expected-failure no-throw protocol + `Symbol.asyncDispose` guaranteed cleanup (H3 — Host `start()` aborts without rollback and `runAsync`'s `finally` only disposes, verified); `SessionOutcome` carrier + warnings seeding across the root boundary (K4); the `IPtySession` port + FakePty closing research seam #15 (J5) — the only stance to close the codebase's worst-tested spot; the four-extras hermetic publish gate (J6 — a std republish fixing only di.extras must not pass); `ensureFreshDist` self-healing rebuild (K3); the renderer-session characterization harness before the mount reshape (H4); renderer latent-type-error hygiene + tsc gate (K1); the explicit `createScope('singleton')` doctrine (J1); untagged transient MCP handlers (J4 — per-connection scopes are untypable on the host manifest, verified); the sync `Bun.TOML.parse` config source (B3).

### Adjudications the recommendation rests on (cross-checked)

1. **Frameless provider / no root scope** — verified this session against `di.core/src/IServiceManifest.ts` ("There is no root scope… resolves transiently"; example: `build()` → `createScope("singleton")`). Found independently by stances 1 (C1) and 3 (J1); **stance 2's final sketches still contain this bug** (root resolves directly off `build()`) — its debate never caught it. Plain roots must open the singleton frame explicitly; the Host opens its own (`internal/Host.ts:161`).
2. **Host validation impossible under `disableDefaults`** — verified this session (`HostApplicationBuilder.ts:104–111`: "With defaults disabled there is no factory, so the build stays unvalidated"). Found independently by stances 1 (C2) and 3 (H2). Resolution: CI dry-run composition tests via `manifest.build({ validateOnBuild: true })` (verified side-effect-free) over every root variant.
3. **Runtime-preload cost at scale** — stance 1's D1 measurement (186 files) controls; drop the preload everywhere (Graft 1).
4. **Schema has no array/open-map kind** — found by stances 1 (A4) and 2 (A23); **stance 3 was blind to it** (its `ContextNoticeOptions`/`ExecEnvOptions` via `withType` was unimplementable). Two-lane options is the settled shape.
5. **Published extras cannot lower** — triple-verified; all four consumed extras are broken, not just di.extras (stance 3 J6 verified `config.extras files:["ttsc.mjs"]` — confirmed this session).
6. **Registry-fork hazard in external runtime deps** — stance 2's A34 empirical demonstration stands unrebutted by the other stances; bundling adopted (Graft 2).
7. **`.tsx` through the Go host works** (stance 2's react-jsx probe; stance 3's K5) — banked for a future renderer-dialect decision; not load-bearing since no runtime preload exists in the final design.
8. **Startup latency** — ~94 ms first-pass for a 40-registration manifest; hosting import ~57–115 ms. Roots are dynamically imported after the dispatcher's short-circuits; the plan root imports only di.

---

## 2. The consolidated design

All paths below are relative to this repo's root unless noted; `std` refers to the sibling `@rhombus-std` monorepo.

### 2.0 Doctrine (the rules everything below obeys)

1. **Roots resolve; libraries contribute.** Only `src/entry/*.ts` references `@rhombus-std/di`'s engine (`ServiceManifest.build`, `createScope`) or `@rhombus-std/hosting`. Every module exports `add<Module>(services): IServiceManifest` contributions importing di.core + di.extras only, never resolving.
2. **`'singleton'` is a tag, not a lifetime.** Plain roots open exactly one frame: `await using scope = provider.createScope('singleton')` (the engine's typing forces the argument). The Host opens its own frame internally. Untagged registration = transient.
3. **Sugar confinement.** Tokenless calls (`addClass<I>`, `addFactory`, `addValue<T>`, `resolve<T>`, `.as<>()`, `addOptions<T>`, `withType<T>`, `tokenfor<T>`) appear ONLY in `src/*/add-*.ts` registration files, the three entry roots, and `src/contracts/`. Service implementations are plain classes with plain constructors. Consequence: unit tests `new Service(fakes)` with no plugin, no container, no lowering.
4. **Execve after disposal.** Nothing inside a container ever calls `process.exit`, `execve`, or replaces the image. Hosted services record into `SessionOutcome` and call `stopApplication()`; the entry tail — after `runAsync` returns and the host is disposed — does the only exit/re-exec. `LibcReexec` is constructed directly by the entry and **never registered** (tail-only by construction).
5. **Expected failures never throw from `start()`.** Host `start()` aborts on first error with no rollback, and `runAsync`'s `finally` only disposes (never stops). So: expected failures (claude not found, renderer degrade exhausted) write stderr, record the exit code, call `stopApplication()`, and return normally — the already-aborted `applicationStopping` makes `runAsync` proceed to a full reverse-order stop. Cleanup-critical services (the socket listener) also implement `Symbol.asyncDispose` as an idempotent stop-if-running, so unlink happens even on an unexpected start abort.
6. **Fault policy is fnc code, not host config.** Host-wide `backgroundServiceErrorBehavior = Ignore` (via `builder.asHostBuilder().configureHostOptions(...)`); each background service owns its policy inside `execute()`: monitor → log ERROR, retire quietly; awaiter → log ERROR, warn into `SessionOutcome`, one-shot in-session notice. Every floating continuation in a lifecycle service is wrapped by `guardedContinuation` (catch → log → record → stopApplication). The entry installs `process.on('unhandledRejection')` before `start()` (log, record, stopApplication; 5 s hard-exit failsafe if already stopping) — Bun honors the handler (verified).
7. **Curated ambient ingestion.** env and argv enter config only through explicit mapping tables rendered into memory sources — never mechanical prefix providers. Bootstrap vars are absent from the tables by construction.
8. **NullLifetime, never ConsoleLifetime.** fnc deliberately swallows SIGINT/SIGTERM (`main.ts:715–716`) because claude owns Ctrl-C.
9. **Renderer stays structural.** No cross-package DI tokens; the dynamic import uses a non-literal specifier so renderer sources never enter cli's TS program; renderer stays off the dialect in v1.

### 2.1 Composition topology

Three roots, one dispatcher, one tail.

**`bin/fnc.js`** — Node→Bun preflight + `FNC_ARGS_JSON` dance unchanged. Bun branch becomes:

```js
// bun branch (after the typeof Bun check)
const srcEntry  = new URL('../src/main.ts', import.meta.url);
const distEntry = new URL('../dist/main.js', import.meta.url);
const isDevCheckout = existsSync(fileURLToPath(srcEntry))
                   && existsSync(fileURLToPath(new URL('../scripts/build.ts', import.meta.url)));
if (isDevCheckout && process.env.FNC_NO_BUILD !== '1') {
  ensureFreshDist();   // content-hash check vs dist/.build-manifest.json; on mismatch/missing,
                       // spawnSync `bun scripts/build.ts` (~1.5–2 s warm); throw only on build failure
}
await import(distEntry.href);   // dev and prod both execute dist — one artifact, one behavior
```

Published installs ship no `src/` and no `scripts/build.ts`, so `isDevCheckout` is false and the guard is inert (asserted by the package-files e2e). The `fnc mcp` child (`<bunExec> <fncBin> mcp`, verified `inject-config.ts`) and every execve relaunch (`[bunExec, fncBin, ...argv]`, verified `awaiter.ts:236`) re-enter this shim, so freshness covers all self-invocations with zero per-flow plumbing. There is **no runtime ttsc preload anywhere** and no `FNC_DEV`.

**`src/main.ts`** — ~50-LOC dispatcher; pre-DI bootstrap tier only:

```ts
const argv = readArgv();                                      // FNC_ARGS_JSON intake
if (process.env.FNC_INTERNAL_DUMP_ARGV === '1') dumpArgvAndExit(argv);
if (wantsHelp(argv))    { process.stdout.write(helpText); process.exit(0); }
if (wantsVersion(argv)) { process.stdout.write(`fnc ${await getVersion()}\n`); process.exit(0); }

if (isMcpSubcommand(argv)) {
  const { runMcpEntry } = await import('./entry/mcp.js');      // lazy — hosting never loads on
  process.exit(await runMcpEntry(parseMcpFlags(argv.slice(1))));    // help/version/dump paths
}
const { planLaunch } = await import('./entry/plan.js');
const plan = await planLaunch(argv);                           // may return an exit outcome
if (plan.kind === 'exit') { plan.stderr && process.stderr.write(plan.stderr); process.exit(plan.code); }
const { runSessionEntry } = await import('./entry/run.js');
process.exit(await runSessionEntry(plan.value));
```

**`src/entry/plan.ts`** — plain-manifest root producing the frozen `LaunchPlan`:

```ts
export async function planLaunch(argv: readonly string[]): Promise<PlanResult> {
  const parsed = parseArgs(argv);                              // pure, pre-DI
  if (!parsed.ok) return { kind: 'exit', code: 2, stderr: `${parsed.error}\n` };

  let services: IServiceManifest<'singleton'> = new ServiceManifest<'singleton'>();
  services = services.addValue<ParsedArgs>(parsed);
  services = addFncCore(services, ambient());                  // the 10 ports (§2.2)
  services = addFncConfig(services, { argv });                 // §2.3 provider stack + options
  services = addRepo(services);
  services = addWorktree(services);
  services = addAutoName(services);
  services = addPrompts(services);
  services = addLaunchPlanning(services);

  await using provider = services.build({ validateScopes: DEV, validateOnBuild: DEV });
  await using scope = provider.createScope('singleton');       // MANDATORY — no root scope exists
  return scope.resolve<ILaunchPlanner>().plan();               // async; bootstrap confirm lives here
}
```

`LaunchPlan` (the frozen product of today's `main.ts:106–527`): `{ mode: 'pty'|'renderer'|'inherit', cwd, claudeArgs, childEnv, socketPath?, ownSessionId?, usedNoopFallback, isUltracode, ultracodeSeedPrompt?, origArgs, warnings: readonly string[], logSettings }`. All early exits (the ~20 `process.exit` sites in the plan region) become `{kind:'exit', code, stderr}` returns. `FNC_INTERNAL_DUMP_PLAN` fires at the **end** of `plan()` — after env composition, **before any claude lookup** — preserving today's ordering and the claude-free CI e2e suite (`findClaude` moves into `ClaudeSessionService.start()`, same stderr + exit 127).

**`src/entry/run.ts`** — the session Host (all post-plan execution, every mode):

```ts
export async function runSessionEntry(plan: LaunchPlan): Promise<number> {
  const outcome  = new SessionOutcome();                       // entry-owned; read after disposal
  const trigger  = createHandoffTrigger();
  const warnings = new WarningBuffer(plan.warnings);           // seeded across the root boundary
  const logger   = createFileJsonlLogger(plan.logSettings);    // eager, entry-owned (std pattern)

  const builder = Host.createEmptyApplicationBuilder();        // no appsettings/RHOMBUS_/console-logger
  builder.asHostBuilder().configureHostOptions(o => {
    o.backgroundServiceErrorBehavior = BackgroundServiceErrorBehavior.Ignore;
  });
  let s = builder.services;                                    // getter/setter slot — ALWAYS reassign
  s = s.addValue<LaunchPlan>(plan).addValue<SessionOutcome>(outcome)
       .addValue<IHandoffTrigger>(trigger).addValue<IWarningBuffer>(warnings)
       .addValue<IFncLogger>(logger).addValue<PlatformInfo>(platformInfo());
  s = addFncCore(s, ambient());
  s = addFncConfig(s, { argv: plan.origArgs });
  s = addLogBridge(s);                                         // JsonlLoggerProvider: SOLE ILoggerProvider —
  s = addHandoff(s);                                           //   host-internal logs go to the JSONL file,
  s = addMcpParent(s);                                         //   never claude's terminal
  s = addUsage(s);
  s = addSlash(s);
  s = addLaunch(s);

  // Hosted services — factory-closure bridge (verified resolve<T> lowering; no token arrays).
  // Registration order = start order; stop runs in reverse.
  if (plan.socketPath !== undefined) {                         // win32: no AF_UNIX — degrade preserved
    s = s.addHostedService((sp) => new McpListenerService(
      sp.resolve<IMcpSocketServer>(), sp.resolve<IFncLogger>()));
  }
  s = s.addHostedService((sp) => new ClaudeSessionService(     // renderer→PTY→inherit ladder inside
    sp.resolve<LaunchPlan>(), sp.resolve<IClaudeLocator>(), sp.resolve<IPtySession>(),
    sp.resolve<IRendererMount>(), sp.resolve<IControlSeam>(), sp.resolve<SessionOutcome>(),
    sp.resolve(HOST_APPLICATION_LIFETIME_TOKEN)));
  if (plan.mode !== 'inherit') {
    s = s.addHostedService((sp) => new ContextMonitorService(  // GuardedBackgroundService
      sp.resolve<ISessionJsonlReader>(), sp.resolve<IControlSeam>(), sp.resolve<IClock>(),
      sp.resolve<IOptions<MonitorOptions>>(), sp.resolve<IFncLogger>()));
  }
  s = s.addHostedService((sp) => new HandoffAwaiterService(
    sp.resolve<IHandoffTrigger>(), sp.resolve<IProcessRunner>(), sp.resolve<SessionOutcome>(),
    sp.resolve<IFncLogger>(), sp.resolve(HOST_APPLICATION_LIFETIME_TOKEN)));
  builder.services = s;

  const host = builder.build();
  installRejectionBackstop(host, outcome, logger);             // doctrine rule 6
  await host.runAsync();                                       // one top-level resolve; disposes host

  // ── the tail: everything that must outlive host disposal ──
  const stashed = trigger.getStashedArgv();
  const teardown = decidePostExitTeardown({ handoffStashed: stashed !== undefined,
                                            useTerminal: outcome.useTerminal });
  if (stashed !== undefined) new LibcReexec().exec(stashed);   // never registered — tail-only
  const relaunch = decideCrossCwdRelaunch({ exitCode: outcome.exitCode, origArgs: plan.origArgs,
                                            ringSnapshot: outcome.ringSnapshot, /* … */ });
  if (relaunch !== undefined) new LibcReexec().exec(relaunch.argv);
  warnings.flush(process.stderr);
  return outcome.exitCode ?? 1;
}
```

Lifecycle mapping: `McpListenerService.start()` binds (before spawn — today's ordering), `stop()` unlinks, `[Symbol.asyncDispose]` = idempotent stop-if-running. `ClaudeSessionService.start()` runs the mode ladder (renderer mount attempt → PTY probe → inherit, exactly `main.ts:662–709`); the child-exit / renderer-close continuation is `guardedContinuation`-wrapped and records `exitCode` + `useTerminal` + `ringSnapshot` into `SessionOutcome`, then self-stops (`stopApplication()` — the std example's own pattern). The renderer mount is kicked without awaiting (PR-A6 makes `maybeMountRenderer` return a handle instead of blocking/exiting/reexecing internally). `ContextMonitorService` is the `BackgroundService` citizen (poll loop on `IClock`, stoppingSignal replaces the ad-hoc stop closure). `HandoffAwaiterService.execute()` awaits the trigger; on fire it runs kill-and-exec's SIGTERM→200 ms→SIGKILL against the child, records the handoff, and self-stops — the execve itself is in the tail. Reverse-order stop reproduces today's `finally`: monitor → session teardown → listener unlink → (dispose) log flush.

**`src/entry/mcp.ts`** — the subprocess root, converted first (the spike): `Host.createEmptyApplicationBuilder()` + one hosted `StdinPumpService` (stdin NDJSON → JSON-RPC dispatch → `dialAndCall(FNC_SOCKET)` → stdout; EOF → record code → self-stop) + the JSONL log bridge (stdout is the JSON-RPC channel — nothing else may write to it). Kills `mcp/dispatch.ts`'s `testServer` and `cachedVersion` module singletons.

### 2.2 Service map

**Cross-cutting ports** — `src/contracts/` interfaces, registered by `addFncCore` (all `'singleton'`-tagged):

| Port | Wraps | Replaces (verified pain) |
|---|---|---|
| `IProcessRunner` | `Bun.spawn` (exec/stdio-inherit variants) | ~14 direct `Bun.spawn` sites |
| `IPtySession` | `Bun.Terminal`: `spawn → {write, resize, onData, exited}` | research seam #15 — the PTY branch, "hardest to unit test today"; enables FakePty unit tests of the notice-splice |
| `IGhCli` | `gh api`/`clone`/`repo create` + clone-failure classification | `gh-runner.ts` closures |
| `IGitCli` | `git init`, `worktree list` | `git-runner.ts` + `worktree/git-list.ts` |
| `IClock` | `now`/`setTimeout`/`setInterval`/`sleep` (+ `FakeClock`) | 3 divergent ad-hoc injection shapes; the TimeProvider precedent |
| `ISessionJsonlReader` | `~/.claude/projects/<cwd>/*.jsonl` walk/read/parse | THREE independent readers (live-permission, monitor, session-usage) |
| `IStateLayout` | exeDir realpath'd **once**, XDG dirs, 4-tier asset search, `packageJson()` | 5 re-realpath sites in main.ts; duplicated tier-search (`prompts/dir` + `noop/template-source`); `log-path`/`socket-path` XDG logic; both `import.meta.url` version reads (`IVersionProvider` folds in here) |
| `IClipboard` | wl-copy/xclip/pbcopy/clip.exe, platform-selected at registration | call-time platform sniff |
| `ILlmClient` | SDK vs `claude -p` (root picks impl by `ANTHROPIC_API_KEY` at registration) | the untestable branch in the composition root (`main.ts:369–387`) |
| `IFileSystem` | narrow read/stat/readdir/mkdir/append/unlink surface | the per-module optional-fs-params pattern |

**Not registered, deliberately:** `IReexecutor`/`LibcReexec` (entry-owned, tail-only by construction — owns the `cachedExecve` dlopen memo).

**Module services** (`src/<module>/add-<module>.ts`; singleton-tagged unless noted; "plain" = stays functions):

| Module | Service(s) | Notes |
|---|---|---|
| `argv/` | — pure, pre-DI; `ParsedArgs` enters via `addValue` | System.CommandLine precedent |
| `plan/` (new) | `ILaunchPlanner` → `LaunchPlan` | sequences today's `main.ts:106–527` |
| `config/` | provider stack + typed options (§2.3) | `TomlConfigSource` (sync `Bun.TOML.parse`) |
| `repo/` | `IRepoResolver`, `IRepoBootstrapper`; url/ref/template/settings-parsing plain | over `IGhCli`/`IGitCli`; repo-settings/host-aliases stay domain readers (claude's files, claude's precedence) |
| `worktree/` | `IWorktreePlanner` | intercept + auto-tmux over `IGitCli` |
| `name/` | `IAutoNamer` | over `ILlmClient` + `IClock` (15 s timeout deterministic under FakeClock) |
| `prompts/` | `IPromptComposer` | over `IStateLayout`/`IFileSystem` |
| `noop/` | `INoopSeeder` | over `IStateLayout` |
| `launch/` | `IClaudeLocator`, `IEnvComposer` (plain), `IRendererMount` (structural contract; non-literal dynamic specifier), `ClaudeSessionService` (hosted) | ring-buffer/cross-cwd-parse plain, inside the session service |
| `log/` | `IFncLogger` (entry-constructed value), `JsonlLoggerProvider : ILoggerProvider` (the bridge) | file-only JSONL is a product constraint; the bridge is the *only* logging-family adoption in v1 |
| `mcp/` parent | `IMcpSocketServer`, `McpListenerService` (hosted), `IParentDispatcher`, nine `IMcpToolHandler`s (**untagged = transient** — per-connection scope is untypable on the host manifest; fresh handler per resolve matches one-NDJSON-line-per-connection), `IControlSeam` = `ControlSeamHolder` (queue-until-bind, zero-dep constructible; bind sites: PTY seam in `ClaudeSessionService.start()`, renderer seam in the mount callback, noop seam in inherit/win32 mode), `IMcpWire` (+`WireOptions`, kills the hardcoded 10 s/10 s) | |
| `mcp/` subprocess | `StdinPumpService` (hosted), `IJsonRpcServer`, tool table | kills `testServer`/`cachedVersion` |
| `handoff/` | `IHandoffTrigger` (entry value), `HandoffAwaiterService` (hosted); kill-and-exec/clean-env/summary/teardown plain | |
| `usage/` | `ContextMonitorService` (hosted), `ISessionUsageReader`; own-session plain | over `ISessionJsonlReader`/`IClock` |
| `slash/` | `ISlashRegistry` | over `IHandoffTrigger` |
| `warnings/` | `IWarningBuffer` (entry value, seeded from `plan.warnings`) | |
| `restart/` | plain `restart-core`; live-permission reader folds into `ISessionJsonlReader` | |
| `path/` | plain; `ensureCwd` takes `IFileSystem` | |

**Token/bridge rules:** interfaces live in stable `src/contracts/*` modules from the first port PR (tokens embed package + module path — moving a file changes its token). Hosted-service wiring uses factory closures (`resolve<T>` only). Where a bare token value is unavoidable, `tokenfor<T>()` (verified identical derivation to the sugar, by construction). Framework tokens via exported constants (`HOST_APPLICATION_LIFETIME_TOKEN`, `RESOLVER_TOKEN`).

### 2.3 Config / options plumbing

**Bootstrap tier — ambient forever, never enters config:** `FNC_ARGS_JSON`, `FNC_INTERNAL_DUMP_ARGV/PLAN/DISABLE_AUTONAME/DISABLE_SESSION_ID`, `FNC_SOCKET` (subprocess dial target), `FNC_NO_BUILD`. These select which root runs or wire subprocesses; a unit test asserts none of them ever appears as a config key.

**App tier** — one `buildFncConfig()` shared by all roots; precedence = source order (last wins):

```ts
const cfg = new ConfigManager();
cfg.add(new TomlConfigSource({ path: xdgConfigPath('fnclaude/config.toml'), optional: true }));
    // FileConfigSource subclass; SYNC load via Bun.TOML.parse (IConfigProvider.load(): void);
    // optional+onLoadError preserve today's silent-degrade
cfg.add(memorySource(envConfigPairs(process.env)));
    // CURATED table — the documented env contract, unit-tested:
    //   FNC_LOG → 'log:level'          FNC_RENDERER → 'launch:renderer'
    //   FNC_TMUX/--auto flags → 'launch:*'   FNC_PROMPTS_DIR → 'assets:promptsDir'
    //   FNC_NOOP_TEMPLATE_PATH → 'assets:noopTemplate'   FNC_CONTEXT_* → 'context:*'  …
    // Exact legacy spellings preserved (no FNC_LOG__LEVEL rename); new vars may use FNC_X__Y
    // via a table entry; bootstrap vars are absent by construction.
cfg.add(memorySource(argvConfigPairs(parsed)));
    // typed parse output → curated pairs; raw argv never reaches a config parser
services = services.addValue<IFncConfig>(wrapConfig(cfg));
```

**Typed options — two lanes** (settled by stances 1+2 against verified library behavior):

- *Lane 1, scalars* (`log:level`, `launch:*`, `context:noticeThreshold`, `mcp:*Timeouts`, `name:*`): `addOptions<T>()` sugar + **coercing delegate configure steps** using the section's typed accessors (`getNum`/`getBool` throw loud on unparseable input). The auto-bind `configure(token, section)` overload is banned (assigns raw strings — verified unsound). `withType<T>()` is allowed for read-once flat sections.
- *Lane 2, structural shapes* (`[[context.notice_tiers]]` array, `[exec.env]` open map — `Schema` cannot express either): today's bespoke pickers survive as **named configure steps** registered through the options pipeline (delegate reads `getSection`/`getChildren` or the `FnConfig` value). The ladder parsing moves to `usage/` (killing the `config/`→`usage/` import wart). `MonitorOptions.ladder` stays fully typed (`NoticeTier[]`); only the binding is hand-rolled.

Options classes: `LogOptions`, `MonitorOptions`, `WireOptions`, `LaunchOptions`, `NameOptions`. `validateOnStart` on `LogOptions`/`MonitorOptions` in the hosted roots (StartupValidator fires before hosted services — bad config fails at boot while a terminal is writable). Reload: off everywhere in v1 (one launch per process); the `IOptions<T>.subscribe` seam stays available.

**Runtime dependency set** (inlined into the bundle at publish; devDeps in the repo): `di`, `di.core`, `config`, `config.core`, `config.file`, `options`, `options.augmentations` (+ its **bare side-effect import in each root** — the configure/validate prototype members are runtime mounts), `hosting`, `hosting.core`, `primitives`, `fileproviders.*` (transitive). **Authoring devDeps:** `di.extras`, `di.extras.options`, `config.extras` (required for `withType` lowering — its declaration lives in `@rhombus-std/config`, so it does NOT enter the types arrays), `primitives.extras`, `ttsc@^0.18`, `@ttsc/unplugin@^0.18`, `typescript@^7.0.2` (root keeps 5.x for other packages; two entries, documented).

### 2.4 Build / dev / test / publish pipeline

**Hard gate (PR-0, std repo):** republish lowering-capable extras. The hermetic probe (npm-registry installs only, no `file:`/`link:`) must verify **all four** consumed extras: (a) `di.extras`, `di.extras.options`, `config.extras` each ship `src/inline.ts` in the tarball; (b) all four (incl. `primitives.extras`) resolve a reachable Go owner host from the installed layout; (c) runtime exercise — one call per sugar family (`addClass<I>().as<'singleton'>()`, `addOptions<T>()`, `withType<T>()`, `tokenfor<T>()`) with any runtime-stub throw failing the gate. Until it passes: `@rhombus-std/*` are `link:` entries into the std checkout at **one pinned SHA** (recorded in one place; moved only by dedicated `chore:` bump PRs pricing ~2–5 min of sidecar recompile); CI checks out std as a sibling, restores a dist cache keyed on the SHA, and runs `bun install` + `build-all` only on cache miss (both `pull_request` and `merge_group`). Nothing publishes during the interim (publishing is paused anyway).

**tsconfigs** (`packages/cli/`):
- `tsconfig.json` — editor/lint scope: `include: ["src/**/*", "test/**/*", "scripts/**/*"]`, `moduleResolution: "bundler"`, `"types": ["@rhombus-std/di.extras", "@rhombus-std/di.extras.options", "@types/bun"]` (explicit `types` opts out of auto-`@types`; `@types/bun` MUST be restated).
- `tsconfig.build.json` — src-only; what the build and the initial lint gate use.
- `tsconfig.ttsc.json` — `extends: "./tsconfig.build.json"`, restates `types` (the augment must be in the Go program too). **No `plugins` array — never `[]`** (§100 auto-discovery from the direct extras devDeps; `[]` suppresses it).

Because the plugin runs **only inside `scripts/build.ts`**, the runtime-plugin include hard-error class, root-bunfig merging, renderer-TSX contamination, and tsconfig-less-package wedges are all structurally absent.

**`scripts/build.ts`** — (1) `applyTtscEnv()` first: the FULL std `ttscEnv` (build-package.ts:60–103) — `GOTOOLCHAIN=local`, `TTSC_CACHE_DIR`/`GOTMPDIR` under `~/.cache/fnclaude-ttsc/`, `GOCACHE=~/.cache/go-build`, `TMPDIR` off tmpfs, resolve go binary, probe `go env GOROOT` with GOROOT **cleared**, positively pin `GOROOT`, `GOBIN=''`; a header comment cites the std source of truth, re-diffed on every SHA bump. (2) **STAGE**: per-file `Bun.build` with the ttsc plugin, `external:['*']`, emitting `src/**` → `dist/stage/**` at source depth, `sourcemap:'linked'`. (3) **BUNDLE**: `Bun.build` over the stage emit, entry `dist/stage/main.js` → `dist/main.js`, **inlining the whole `@rhombus-std` (+ `@rhombus-toolkit`) graph**, externalizing `@anthropic-ai/sdk` and `@fnclaude/renderer` (also protected by the non-literal dynamic specifier), `sourcemap:'linked'` (sourcesContent embedded — verified — so dropping `src` from `files` keeps stack traces useful). (4) Write `dist/.build-manifest.json`: content hash over sorted `(path, sha)` of `src/**/*.ts` + both build tsconfigs + `scripts/build.ts` + `package.json` (hash, not mtime — worktree-robust). A `bun run warm` script forces the sidecar compile off the interactive path after toolchain/SHA changes; a 3 s timer prints "compiling ttsc sidecar — can take minutes" so a cold compile is an attributed wait, not a silent hang.

**npm artifact:** `"main": "./dist/main.js"`, `files: ["bin", "prompts", "share", "dist", "!dist/stage"]` (drop `src`; std's own `!dist/stage` pattern). All `@rhombus-std/*` move to devDependencies at flip time — end users install **zero** @rhombus-std packages, killing the caret-skew registry-fork hazard outright. `import.meta.url` package.json reads: deduped into `IStateLayout.packageJson()` backed by the depth-1 read (`'../package.json'` resolves correctly from both `src/help-version.ts` and the bundle at `dist/main.js`); `mcp/dispatch.ts`'s depth-2 duplicate is deleted. Asset tiers (`prompts/`, `share/`) are exe-dir-relative from `bin/` — unchanged, safe (verified).

**Tests:**
- **Unit tier (the TDD inner loop): plugin-free.** No bunfig preload anywhere. Tests `new Service(fakes)` against direct src imports at today's speed; hand-written fakes in `test/fakes/` implementing the port interfaces (`FakeClock`, `FakePty`, `FakeLlm`, fake `ISessionJsonlReader`, …); options in tests via `Options.of({...})`, never a mocked `IOptions`. Sugar confinement guarantees no unit test ever executes a tokenless call.
- **Composition tier: from `dist/stage`.** `composition-validate.test.ts` imports the lowered manifest builders (`buildPlanManifest`, `buildRunManifest`, `buildMcpManifest` — the registration assembly factored into pure functions for exactly this) and calls `manifest.build({ validateOnBuild: true, validateScopes: true })` for every variant: plan, run×{pty, renderer, inherit}×{linux, faked-win32 `PlatformInfo`}, mcp. Verified: a dry run — no instance constructed, no sockets bound, all failures aggregated. This is the validation the Host cannot do under `disableDefaults` (verified gap), running on every CI run — strictly stronger than dev-only `validateScopes`. Lifecycle-ordering tests (start order, self-stop, reverse stop, claude-missing → socket unlinked + 127, notice-pre-bind replay, warnings seeding, awaiter-fault → warning recorded + host survives) run against `dist/stage` roots with fakes.
- **e2e tier: against the shipped artifact.** Harness unchanged (spawns `bin/fnc.js`; fake-claude PATH fixture; `script`-wrapped PTY; `FNC_INTERNAL_DUMP_*`). The shim's `ensureFreshDist` (single-flight, self-healing: rebuild on hash mismatch, throw only on build failure) keeps dist fresh in every local flow — fresh worktrees and the stash-sanity recipe both work unchanged because the trigger is the working tree's content hash. e2e + composition suites' setup also calls the shared `ensureFreshDist` helper so a `bun test` run without a prior build self-heals once (~2 s), and unit-only runs never trigger it.
- **dist-smoke (in `verify`):** spawn `bin/fnc.js` from a foreign cwd with `FNC_NO_BUILD=1` against built dist — assert a `DUMP_PLAN` launch dump and one MCP subprocess round-trip. Exercises the exact hazards of the bundle (extensionless specifiers, materialized di.core helper imports, the options.augmentations side-effect import, package.json depth) before release-please can publish.
- **Renderer-session characterization harness** (before the mount reshape): `script`-wrapped spawn with `FNC_RENDERER=1` + fake-claude driving the real workspace renderer through mount → one turn → exit; pins exit-code propagation and the restart tail.

**ffnc:** stays today's alias shape — it just invokes `bin/fnc.js`; the shim's build-if-stale serves working-tree source as fresh dist. Steady-state overhead ≈ a hash scan (ms); post-edit ≈ one warm rebuild (~1.5–2 s measured; ≤10 s ceiling or the incremental-stage investigation fires). Restarts, MCP children, and spawn-session siblings all re-enter the shim and stay fresh automatically.

**moon / CI / publish:** cli `moon.yml`: `build: { command: 'bun scripts/build.ts', outputs: ['dist'], inputs: [src/**, tsconfig*, scripts/build.ts, package.json] }` (the file's own comment reserves this slot); `test: { deps: ['~:build'] }`; `lint` stub → `bun x tsc --noEmit -p tsconfig.build.json` (cli's first-ever type gate; widened to `tsconfig.json` in the cleanup PR). Renderer lint additionally gains `bun x tsc --noEmit` (its 9–10 latent errors are fixed first — real undefined-handling holes). CI `verify` AND the publish job both get cache restore for `~/.cache/fnclaude-ttsc` + `~/.cache/go-build` (keyed on ttsc version + std SHA/lockfile) and the publish job gets `moon run cli:build` inserted before `npm publish` (today nothing builds there — verified). release-please config untouched (`release-type: node` never sees `dist/`). A repo check script asserts the two types arrays stay in sync and every tracked `.ts` is inside a tsconfig or provably outside any tsconfig's tree.

**Publishing-pause coordination:** the packaging flip commits as `feat(cli): publish lowered dist artifact` so release-please cuts an isolated release PR. Because publishing is paused (release PRs excluded from auto-merge), this is an explicit decision point for the maintainer: either manually merge that release PR in-window (isolated smoke-test release) or decline — in which case the **tarball-install smoke** stands in: `npm pack` → temp-prefix install → real launch + MCP round-trip against the installed artifact. Session-root PRs are gated on one of the two having happened.

### 2.5 Migration sequence

All PRs from templated worktrees; conventional commits; auto-merge on green; TDD per repo rules (`refactor:`/`build:`/`ci:`/`test:` are the sanctioned opt-outs; every `feat:`/`fix:` carries a failing-first test). **Wave A is entirely std-free and can start today.**

| # | PR | Type | Contents / failing-first test | Gate |
|---|---|---|---|---|
| 0 | std repo: fix extras publishing (all four packages ship `src/inline.ts` + reachable Go host); optional: `serviceProviderOptions` settings knob issue (non-load-bearing) | upstream | hermetic four-extras probe green | — |
| A1 | `refactor(cli): type-clean src + real tsc lint gate` | refactor/fix | fix the 14 src errors (Bun-typedef noise; `fix:` only if a committed repro proves behavior); moon lint = `tsc -p tsconfig.build.json` | — |
| A2 | `fix(renderer): latent strict-mode type errors` + `ci(renderer): tsc gate` | fix/ci | the 9–10 diagnostics (failing-first where behaviorally reachable); renderer lint += tsc | parallel with A1 |
| A3 | `refactor(cli): extract launch planning → planLaunch/LaunchPlan` | refactor | pure move of `main.ts:106–527`; dump-plan hook at end of `plan()` (pre-findClaude — findClaude moves to session start, exit 127 preserved); oracle = full e2e suite. **Cheapest falsifier of the factoring bet** (already attacker-verified) | — |
| A4 | `refactor(cli): split entry roots + dispatcher main + single exit` | refactor/test | `entry/{plan,run,mcp}.ts` (run still procedural); main → dispatcher; entries return codes. Lands **after** an exit-code regression matrix pinning `--help`/`--version`/resolve-errors/dump short-circuits/warnings-flush against current behavior | A3 |
| A5 | `test(cli): renderer-session characterization harness` | test | `script`-wrapped FNC_RENDERER=1 + fake-claude + real workspace renderer; pins exit propagation + restart tail | — |
| A6 | `refactor(cli): renderer-mount returns a session handle` | refactor | mount stops calling `exit()`/reexec/internal awaiter; returns `{mounted, exited, close}`; caller owns the tail. Under A5's net; draft-park if the harness is flaky | A5 |
| B1 | `build(cli)+feat(cli): ttsc pipeline + dist artifact` | build/feat | tsconfig split; `scripts/build.ts` (stage+bundle+inline-runtime, `applyTtscEnv`, manifest hash, warm script); shim build-if-stale + dist import + published-layout guard; moon build/test-deps; CI caches (both jobs); `ensureFreshDist`; dist-smoke; package-files e2e extended (`dist/main.js` present, `src/` absent, guard inert); publish-job build step. Lands with **zero tokenless source** (identity build — cannot change behavior). Packaging flip = the isolated-release coordination point | PR-0 probe green |
| B2 | `feat(cli): mcp root on Host, tokenless` — **the spike** | feat | `entry/mcp.ts` + `StdinPumpService` + log bridge; kills `testServer`/`cachedVersion`; JSON-RPC handshake e2e (new infra = regression value); mcp composition-validate test; startup-latency measurement (ceiling: short-circuit paths +0 ms by construction; mcp path ≤ +150 ms); options round-trip assertion | B1 |
| B3 | `feat(cli): core ports + plan root on ServiceManifest` | feat | `addFncCore` (10 ports incl. `IPtySession`); `entry/plan.ts` becomes the container root (explicit `createScope('singleton')`; identity unit test: `IWarningBuffer` resolved twice = same instance); `IStateLayout` collapses the duplicated tier-search suites; `ISessionJsonlReader` collapses the three walkers (`refactor:` unless a real divergence is found); plan-path latency gate (Δ ≤ ~15% of 0.38 s baseline) | B1 |
| B4 | `feat(cli): run root on Host` | feat | hosted set; `SessionOutcome` + warnings-seeding cross-root test; `ControlSeamHolder` (+pre-bind replay test); `guardedContinuation` + rejection backstop (fake launcher whose continuation rejects → reverse-order stop still ran, error recorded, process alive); expected-failure protocol test (claude missing → socket unlinked + 127); win32 faked-`PlatformInfo` composition test; FakePty notice-splice unit tests (mid-keystroke defer; defer-then-flush); full e2e green unchanged | B2, B3, A6 |
| B5–B7 | `feat(cli): <cluster> contributions` | feat/refactor | repo+worktree (`IGhCli`/`IGitCli` + shared fakes); mcp-parent handlers (untagged) + `WireOptions` (failing-first: timeout read from config); name (`ILlmClient` — SDK path unit-tested for the first time) ; prompts/noop/slash residue | B3 |
| C1 | `feat(cli): config providers + typed options` | feat | ConfigManager stack; curated env/argv tables + no-bootstrap-leak test; two-lane options + coercing delegates; `validateOnStart`; precedence matrix (toml < env < argv) AND arrival tests (`FNC_LOG=debug` ⇒ `config.get('log:level')==='debug'` — an empty env layer must fail, not pass vacuously); delete `config/load.ts` call sites (parsing survives as configure steps); ladder parsing moves to `usage/` | B4 |
| C2 | `refactor(cli): cleanup` | refactor | delete superseded optional-param seam bags; widen lint gate to `tsconfig.json` (src+test — pays residual test-type debt); docs; decisions.md entries | C1 |

Optional tier (adopt-if-cheap, freely skippable): full `@rhombus-std/logging` adoption beyond the bridge; `caching.memory` memoizing owner-lookup; `fileproviders` beyond what config.file drags in; `diagnostics` (skip — config-only skeleton).

---

## 3. Scorecard

Weights: correctness/robustness 30% · migration risk under TDD/auto-merge 20% · testability payoff 15% · dev-loop ergonomics 15% · maintenance burden 10% · end-user install/launch 5% · .NET/std fidelity 5%. (Correctness is weighted highest; migration risk is weighted high because auto-merge-on-green makes every intermediate state a shipping state.)

| Axis | host-everywhere (final) | strangler-under-main (final) | three-roots (final) |
|---|---|---|---|
| Correctness/robustness | **7** — zero-resolve roots and the tail rule are sound, but planner-as-hosted-service needs three convention-enforced invariants (ctor ban, PlanSlot guards, throwing-getter test) where topology could need none | **6** — best packaging find (A34) and single-exit main, but its final sketches still carry the frameless-resolve bug its own debate never caught, and main stays procedural longest | **9** — plan-then-host needs no by-convention invariants; failure protocol, asyncDispose cleanup, SessionOutcome, win32 conditionality all specified and test-pinned |
| Migration risk | **6** — PRs 3–5 pre-land services but PR-6 flag day concentrates the 988-LOC collapse in one auto-merging PR | **8** — most incremental strangler; but longest hybrid period and the Host payoff lands last | **9** — cheapest falsifier first (attacker-verified bet), every PR independently green, std-free wave A starts today |
| Testability payoff | **9** — sugar confinement + plugin-free units is the debate's best doctrine; construction tests clever | **7** — thorough PR-0 type-clean; tokenless tests pay the preload tax; no PTY port | **8** — only stance to close seam #15 (IPtySession/FakePty) + renderer harness; but tests-author-dialect was mispriced at scale (graft fixes it) |
| Dev-loop ergonomics | **9** — build-if-stale after honestly firing its own falsifier; ~0 ms steady-state, ~2 s post-edit | **4** — runtime preload everywhere at an adjudicated ~3–4 s/process (+ mcp child, + renderer project); arming mechanism took four revisions | **6** — scoped-shim preload (K5-verified) still pays the per-process tax in unit runs; e2e-against-dist with self-healing rebuild is good |
| Maintenance burden | **7** — two roots, but PlanSlot/ctor-ban discipline is forever | **5** — most scaffolding (link-interim, preload wrapper, SHA cadence, arming guard), much deleted at flip | **8** — least residual machinery once the preload graft is applied; hosting quarantined in one entry file with a stated degrade path |
| End-user install/launch | **6** — external runtime deps; A34 skew hazard unaddressed | **9** — inlined runtime, zero @rhombus-std installed, sub-1 MB | **6** — external runtime deps; A34 applies |
| .NET/std fidelity | **7** — Host-everywhere over-applies Run() semantics to the plan phase | **8** — root-resolves licensed by doctrine; Host-late matches "host where hosted" | **9** — plan-outside-host mirrors System.CommandLine; empty builder, self-stop, Add{Feature}, options conventions all straight |
| **Weighted** | **~7.2** | **~6.4** | **~8.2** |

Debate-conduct notes: no stance carried citation-less DEFENDs of consequence (all major DEFENDs cited file:line or live probes). Stance 2's A32 DEFEND introduced a graph contradiction later retracted (A35) — a small process penalty already reflected in its correctness score. Stance 1 deserves explicit credit for executing its own falsifier's consequence (D1) instead of arguing with the measurement — that amendment is what the winning design's dev loop is built on.

---

## 4. Migration / verification checklist (cheapest-to-falsify first)

Ground rule: spikes are production-shaped code/tests on a real branch — each item names its home.

1. **planLaunch extraction (falsifies the factoring bet).** Branch `refactor-extract-launch-planner` → PR-A3. Pure move of `main.ts:106–527`; oracle = existing dump-plan e2e suite, claude-free. Already attacker-verified feasible; ~1 PR to certainty. Std-free.
2. **Exit-code regression matrix + entry split.** Branch `refactor-entry-roots` → PR-A4. The matrix (pinned against *current* main) lands first in the same branch; the split diffs against a pinned contract. Std-free.
3. **Renderer harness + mount handle.** Branches `test-renderer-harness` (PR-A5) then `refactor-renderer-mount-handle` (PR-A6). Falsifies "the mount can stop owning exit/reexec" cheaply, under a real net. Std-free.
4. **Four-extras hermetic publish probe.** Home: std repo, `scripts/verify-published-extras.ts` (production-shaped, kept as the std release gate) + a throwaway consumer dir under the scratchpad. Asserts tarball `src/inline.ts` presence, Go-host reachability from installed layout, and one runtime call per sugar family. This is PR-0's acceptance test and PR-B1's merge gate.
5. **Identity build + dist-smoke (falsifies the bundle/packaging assumptions before any tokenless code).** Branch `build-ttsc-pipeline` → PR-B1. Run `scripts/build.ts` over current token-free src; full e2e green against dist; dist-smoke (foreign cwd, `FNC_NO_BUILD=1`, DUMP_PLAN + MCP round-trip); package-files e2e extended; tarball-install smoke (`npm pack` → temp prefix → launch). Measures the warm rebuild at real scale (ceiling ≤ 10 s; expected ~2 s).
6. **mcp Host spike (falsifies the whole tokenless stack on the smallest graph).** Branch `feat-mcp-host-root` → PR-B2. Lowering, factory closures, empty-builder + log bridge, lifecycle ordering, `addOptions<T>()`→`resolve<IOptions<T>>()` round-trip, startup-latency ceilings. If the factory-closure bridge or the options round-trip fails here, the fallback (`tokenfor` signature arrays / hand tokens) is exercised **inside this PR** before anything else depends on it.
7. **Plan root + ports + scope-identity test.** Branch `feat-core-ports-plan-root` → PR-B3. The `createScope('singleton')` identity test (same `IWarningBuffer` twice) pins the frameless-provider fix; plan-path latency gate vs the 0.38 s baseline.
8. **Composition-validation dry-run suite (falsifies every graph variant continuously).** Lands with B2 (mcp) and grows in B4 (run×mode×platform). Home: `packages/cli/test/composition/`.
9. **Run root** (PR-B4, branch `feat-session-host-root`) with its five named protocol tests (rejection backstop, expected-failure unlink, pre-bind replay, warnings seeding, win32 set).
10. **Config wave arrival tests** (PR-C1, branch `feat-config-providers`): precedence AND arrival (empty-env-layer must fail), no-bootstrap-leak, coercion-throw tests.

Standing measurement gates recorded in PR bodies: warm rebuild ≤ 10 s; short-circuit paths +0 ms (lazy root imports, asserted by a no-@rhombus-loaded test); plan path ≤ +15% p50; session path ≤ +150 ms; e2e suite ≤ +15 s total wall-clock vs the measured 51 s baseline.

---

## 5. Open questions (maintainer's call; recommended defaults)

1. **std upstream work (PR-0).** The four-extras publish fix is a hard prerequisite for every tokenless PR; std is a separate repo, so this is a scheduling call — when does the fix slot in? *Default:* do it before fnclaude wave B; fnclaude wave A proceeds meanwhile. The optional `serviceProviderOptions` settings knob is a nicety issue, not load-bearing.
2. **Inline-runtime bundling vs std's external-deps doctrine.** The design deliberately deviates from "workspace deps stay external" for the *published app artifact* (library rule ≠ app rule; the container is package-private; the caret-skew registry-fork hazard was demonstrated). *Default:* inline (stance 2's A34). The alternative is exact-pinning **plus** an upstream policy change making the di family exact-pin internally, which would require re-cutting §2.4 to that shape — worth deciding explicitly before implementation starts if the external-deps doctrine is preferred instead.
3. **Publishing pause vs the dist-flip release.** PR-B1's packaging flip wants an isolated smoke-test release, which the pause blocks. *Default:* rely on the tarball-install smoke and leave the pause in place; lift it (or hand-merge the one release PR) only when the maintainer is ready to — B4+ is gated on either path having happened, not on the pause lifting.
4. **`fnc mcp` on a Host vs plain root.** The Host there is mostly uniformity + spike value (one pump service). *Default:* Host — it's the cheapest full-stack falsifier and kills the module singletons; degrade to a plain manifest costs ~20 lines if hosting churn bites.
5. **Hosting/config/options are 0.0.0 while di is 10.x.** Exact pins + quarantine (hosting touchpoints confined to `entry/run.ts`/`entry/mcp.ts` + a stated degrade path to hand-sequenced start/stop) is the containment. *Default:* proceed; re-derive the maturity map at PR-B2 time.
6. **Renderer dialect adoption.** `.tsx`-through-the-Go-host is now verified working, but nothing needs it. *Default:* renderer stays off the dialect and out of the DI container in v1 (structural contract preserved); revisit only if a cross-package service contract ever becomes real — which would also mean a deliberate shared contracts package.
7. **Optional-tier libs.** *Default:* adopt only the `JsonlLoggerProvider` bridge (required for host-internal logs anyway); skip full logging-family adoption, `caching.memory`, extra `fileproviders`, and `diagnostics` in v1 — each has a clean later on-ramp.
