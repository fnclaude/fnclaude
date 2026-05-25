# fnclaude TS port — arch + language-feature review

*Conducted 2026-05-23 via the `/arch-review` skill against the just-shipped Go → TS port.*

## Summary

The port is solid in posture: real test seams, dependency injection done with intent (not Java-style boilerplate), real PTY and AF_UNIX sockets in tests rather than triple-mocked stubs, careful comments explaining the *why* behind ported behavior. But it reads as **Go-translated-line-by-line**, not TS-native. Stringly-typed unions where TS has discriminated-union exhaustiveness sitting unused; `string`-typed `HandoffMode` carrying "or an integer-as-string" in a comment instead of in the type; the `Args` interface mutated in place across three modules where a builder + immutable result would prevent a real category of bugs; `"" === absent` semantics scattered through `??` and `if (x !== '')` chains where `undefined` + `noUncheckedIndexedAccess` would do the work for free. Architecture-wise the seams are fine but the dependency direction is muddy (an `import` cycle is explicitly worked around in `worktree.ts` by duplicating a 5-line function — that's a code smell pointing at a layering problem), and the `RunDeps` interface has grown to 17 fields that no test fully exercises.

## Findings

### Blocker — none

No correctness or shipping-blocker design problems. The code works and ships.

### High — `HandoffMode` and `Op` are `string` instead of discriminated unions, defeating exhaustiveness

**What:** `HandoffMode` is declared `type HandoffMode = 'never' | 'ask' | string` — the trailing `| string` collapses the union to `string`, so the type system gives you zero help. The comment "or a non-negative integer-as-string" is doing the work the type system should do. Same shape for several string-typed dispatch keys (`Op`, `Action`, the `auto.tmux` mode after env-var assignment in `loadConfig`).

**Where:**
- `packages/cli/src/config.ts:25` — `HandoffMode = 'never' | 'ask' | string`
- `packages/cli/src/config.ts:304` — `cfg.auto.tmux = e.FNCLAUDE_TMUX as TmuxMode` — unchecked cast.
- `packages/cli/src/mcp/socketListener.ts:248-262` — `switch (req.op as Op)` with no `never`-typed default.

**Why it matters:** Single biggest "translated from Go" smell. Refactor safety, IDE autocomplete, and `normalizeHandoffMode` could be subsumed by a template-literal type.

**Status (2026-05-24):** Addressed in PR #70 — `HandoffMode = 'never' | 'ask' | \`${number}\``, `Op` dispatch has exhaustive `never`-typed default.

---

### High — `Args` is mutated in place across three modules; argv-build pipeline is an effectful conveyor belt, not a function

**What:** `parseArgs` returns `Args`; `applyWorktreeIntercept(a, shellCWD)` *mutates* `a` in place; `sanitizeNamesInPassthrough` returns a new slice but the caller writes back to `a.passthrough`; the autoname step also writes to `a.passthrough`. Six pages of pipeline in `run()` (`main.ts:175-273`) thread the same mutable `Args` value through five functions, each free to rewrite it.

The mutability is justified at `worktree.ts:12-14`: *"applyWorktreeIntercept mutates Args in place to match the Go signature `*Args`."* That's the wrong reason. Go uses `*Args` because Go lacks ergonomic value-types and structural narrowing; TS has both.

**Where:**
- `packages/cli/src/main.ts:212-218, 232, 245, 250-253` — mutation chain in `run()`
- `packages/cli/src/worktree.ts:143-174` — `applyWorktreeIntercept`
- `packages/cli/src/args.ts:8-62` — `Args` interface, zero `readonly`

**Why it matters:** (1) every downstream consumer has to defensively assume `Args` could be in any post-mutation state; (2) auto-tmux gating in `buildArgv` depends on `a.worktreeMatched` set by a previous step — ordering invariant lives only in `main.ts`, no compiler enforcement; (3) tests have to carefully construct post-mutation `Args` rather than getting it for free.

**Suggested change:** stage-typed `ParsedArgs → ResolvedArgs → InterceptedArgs → NamedArgs → SanitizedArgs` chain of value-returning functions. Each stage's output type encodes the invariants it establishes.

**Status:** Being addressed in the follow-on Wave 2 PR (stage-typed pipeline).

---

### High — `Op` discriminated union for `Request`

(Folded with HandoffMode above. Addressed in PR #70.)

---

### High — `RunDeps` has 17 fields, no test fully exercises composition; testability theater for some

**What:** `RunDeps` in `main.ts:57-93` exposes 17 injectable seams. Some are load-bearing (`runWithPTY`, `silentRelaunch`, `loadConfig`). Many are 1:1 thin passthroughs to functions that are *already* dependency-injected internally:
- `applyWorktreeIntercept` takes `runner: GitRunner` AND is swappable via `RunDeps.applyWorktreeIntercept` — two-layer injection.
- `resolve` takes `deps: ResolveDeps` AND is swappable via `RunDeps.resolve` — same.
- `seedNoop`, `loadHostAliases`, `loadConfig`, `loadRepoSettings` are bare file readers with zero production variance.

**Where:** `packages/cli/src/main.ts:57-93`, `worktree.ts:143-147`, `resolver.ts:311-313`.

**Why it matters:** `main.test.ts:baseDeps` stubs 14 of them with no-ops for every test; e2e tests undo by passing real implementations back in. Coarse for unit tests, fine-grained for e2e tests — the interface doesn't know what it wants to be.

**Suggested change:** collapse to `RunIO` (truly external — claude binary lookup, PTY runner, relaunch, MCP server entry, clipboard) + `RunConfig` (data: resolved config, prompts, repo settings). Move dependency-of-dependency seams inside the modules that own them.

**Status:** Being addressed in the follow-on Wave 2 PR (RunDeps collapse).

---

### High — `index.ts` re-exports 80+ symbols; no real public API surface

**What:** `packages/cli/src/index.ts` is 115 lines of re-exports covering nearly every named export across every internal module. Published to npm. Every internal helper is now a public API.

**Suggested change:** shrink to only documented-consumer symbols (`main`, `version`, maybe MCP wire-protocol types for downstream integrators). Use `package.json` `"exports"` field to lock the surface, blocking deep imports.

**Status:** Will be addressed in Wave 4 (after stage-typed pipeline + `""→undefined` shapes settle).

---

### Medium — `worktree.ts` duplicates `nameInPassthrough` to break an import cycle

**What:** `packages/cli/src/worktree.ts:177-186` re-implements `nameInPassthrough` with a comment: *"Replicated to avoid an import cycle (argParser → buildArgv → worktree → argParser)."*

**Why it matters:** Two copies "must agree" per the comment — no compile-time enforcement. Cycle's *fix* is to move the helpers into a third module (`passthrough.ts`) that both import from.

**Status:** Being addressed in the follow-on Wave 2 PR (passthrough.ts extract).

---

### Medium — `loadConfig` is sync, returns a value, AND has the side effect of calling `warn()`; three different functions in one signature

**What:** `loadConfig()` reads TOML, applies env overrides, calls normalizers that call `warn()` (global mutable `warnings` array in `warnings.ts`). The `warn` calls aren't part of the return type — a hidden side-channel.

**Suggested change:** `loadConfig()` returns `{ config: Config; warnings: readonly string[] }`. Drop the global `warnings.ts` module.

**Status:** Addressed in PR #70 — loaders return `{ value, warnings }`, global gone.

---

### Medium — string-as-absent pattern: `""` means "not set" 30+ times where `undefined` would do

**What:** `cwd: string = ''`, `worktreeArg: string = ''`, `if (sid === '')`, etc. Go idiom leak (Go's zero value for `string` is `""`); TS programs use `undefined | T`.

**Suggested change:** optional fields → `string | undefined`; required fields drop emptiness checks.

**Status:** Will be addressed in Wave 3 (after stage-typed pipeline lands).

---

### Medium — `selfPath()` duplicated in `spawn.ts:56-65`, `argv.ts:60-68`, inlined in `prompts.ts:107-115`

**What:** Three places implement "prefer `argv[1]`, fall back to `execPath`, try `realpathSync`."

**Suggested change:** extract `resolveSelfPath()` into `paths.ts`.

**Status:** Addressed in PR #70 — `resolveSelfPath` lives in `paths.ts`.

---

### Medium — `parseArgs` returns mutable bag mixing parser output with downstream-set flags

**What:** `parseArgs` returns `Args` which contains `worktreeMatched: false` — a field the parser *never sets to true*; it's reserved for `applyWorktreeIntercept` to set later.

**Suggested change:** stage-typed interfaces (same fix as the Args mutation finding).

**Status:** Being addressed in Wave 2.

---

### Medium — `pty/unix.ts:run` is a 220-line procedural function doing eight things

**What:** `runWithPTY` builds env, starts listener, ensures cwd, spawns PTY, sets raw mode, attaches data tee, registers SIGWINCH, attaches stdin pump, sets up handoff kill timer, awaits exit, tears it all down — one function, no internal structure.

**Suggested change:** TS 5.2 `using` / `Symbol.dispose` per setup phase. Each phase returns a disposable that auto-cleans on scope exit.

**Status:** Addressed in PR #70 — 7 disposable helpers, `await using` / `using` declarations.

---

### Nit — `pty.ts` byte-loop ring buffer

`pty.ts:69-73` loops one byte at a time; `Buffer.copy` would be one call.

**Status:** Addressed in PR #70.

---

### Nit — `config.ts:271` unchecked `as TmuxMode` cast

Validate-before-assign instead.

**Status:** Addressed in PR #70.

---

### Nit — inconsistent error-surfacing across loaders

`loadPrompts` returns `LoadPromptsResult` (good); `loadRepoSettings` and `loadHostAliases` silently drop malformed-file errors.

**Status:** Addressed in PR #70 — all loaders return `{ value, warnings }`.

---

### Nit — `worktree.ts:32-37` uses `execFileSync` not `Bun.spawnSync`

**Status:** Being addressed in Wave 2.

---

### Nit — `crossCwdRe` stateful regex with manual `lastIndex` reset

**Status:** Addressed in PR #70 — `String.prototype.matchAll`.

---

## If I could only change one thing

Modeling the argv pipeline as a chain of stage-typed immutable values instead of a mutable `Args` bag passed through five mutating functions. That single change cascades into most of the other Highs: the `worktreeMatched` field stops being a parser-output lie; the auto-tmux gating invariant moves from a comment to the type system; `applyWorktreeIntercept` becomes pure (which removes the double-injection of `GitRunner` in `RunDeps`); the import cycle in `worktree.ts` becomes irrelevant because helpers naturally regroup along the new stage boundaries; and the discriminated-union refactor of `Op`/`Request` becomes the obvious follow-up because you're already in the mindset of "let the type narrow what each stage can see." Roughly a day of work; nothing user-visible changes; the test suite barely moves. The change that flips the code from "Go-shaped, written in TS" to "TS-shaped, ported from Go."
