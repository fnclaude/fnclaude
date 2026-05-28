# fnclaude — technical decisions log

Choices made during the rewrite. Locked-in implementation facts (where there was no choice to make) live in [`design.md`](design.md) and [`design.mcp.md`](design.mcp.md), not here.

Format: each decision is dated, summarized, contextualized, and justified. Future-us reads this later wondering "why did we go this way?" — the entry answers.

---

## 2026-05-27 — Bun.spawn with stdio inherit for the MVP launcher

**Decision:** The minimal launcher spawns `claude` via `Bun.spawn` with `stdin/stdout/stderr` all set to `"inherit"`. No PTY layer (no `Bun.Terminal`, no `node-pty`, no FFI).

**Context:** The previous TS port used `node-pty 1.2.0-beta.13` under Bun and hit a SIGHUP race that silently exited the wrapper without ever producing visible output. See [`fnc-silent-exit-investigation.md`](fnc-silent-exit-investigation.md) and [`research/bun-pty-spawn.md`](research/bun-pty-spawn.md).

**Why this:** stdio inheritance gives `claude` the user's real TTY fds, so `isTTY === true` in the child and the line discipline forwards `Ctrl-C` / `Ctrl-Z` / `Ctrl-\` and resize signals via the kernel's foreground-process-group routing. No open Bun bugs are in the path. The cost is: no output capture from the parent (can't ring-buffer the tail for cross-cwd resume detection), no programmatic input injection. Both costs are acceptable for the MVP because cross-cwd resume isn't built yet; when it is, we'll switch to `Bun.Terminal` for that feature only.

**Revisit when:** implementing cross-cwd resume (Phase 6 in [`build-plan.md`](build-plan.md)). At that point, the launcher swaps to `Bun.Terminal` and accepts the Ctrl-C interception workaround for [oven-sh/bun#25779](https://github.com/oven-sh/bun/issues/25779).

---

## 2026-05-27 — Node→Bun preflight reinstated (FNC_ARGS_JSON for argv survival)

**Decision:** `packages/cli/bin/fnc.js` is a Node-shebang preflight (`#!/usr/bin/env node`). When invoked under Node, it serialises `process.argv.slice(2)` to JSON, sets `FNC_ARGS_JSON`, and re-execs itself under Bun. When the same file loads under Bun (post-reexec, or when invoked directly via `bun fnc.js`), it imports `../src/main.ts`. `src/argv/intake.ts`'s `readArgv()` prefers `FNC_ARGS_JSON` over `process.argv` when set.

**Context:** Originally (entry above this one, since revised) we tried to ship a single bun-shebang shim with no preflight, on the optimistic assumption that bun had stopped stripping `--` from script argv. Empirical check on bun 1.3.14 disproved that:

```
$ bun probe.js -- "say hi" foo
process.argv: ["bun","probe.js","say hi","foo"]   # `--` GONE
```

vs. Node:
```
$ node probe.js -- "say hi" foo
process.argv: ["node","probe.js","--","say hi","foo"]   # `--` SURVIVES
```

`fnc -- <prompt>` is a load-bearing PRD feature — the inline-prompt syntax. Losing `--` corrupts every prompt-passing invocation.

**Why this:** the Go-port era's Node-shebang preflight is the proven cross-platform fix. Node sees the unstripped argv, serialises it via env, re-execs under Bun. Bun's later argv-strip doesn't matter because main.ts reads `FNC_ARGS_JSON` first. Adds ~30 ms cold-start (one node startup). Worth it for correctness.

Alternatives weighed: `/proc/self/cmdline` works on Linux but Windows + macOS need different hacks — preflight is uniform. A bun-only shim with a custom sentinel (`+` instead of `--`) would diverge from claude's CLI convention and the PRD.

**Revisit when:** [oven-sh/bun#5510](https://github.com/oven-sh/bun/issues/5510) (or the equivalent argv-preservation tracker) ships in a stable bun. At that point we can drop the preflight and ship the single bun-shebang shim originally planned.

---

## 2026-05-27 — No `dist/` build step

**Decision:** `packages/cli/package.json`'s `main` points at `./src/main.ts` directly. The `build` script is a no-op. No `tsc` invocation, no `bun build`, no compiled `dist/`.

**Context:** Bun's module loader runs `.ts` files directly without a build step. Production users invoke `fnc` via the shim, which imports the `.ts` source.

**Why this:** removes a class of build/deploy desync bugs (dist/ stale relative to src/). Reduces moving parts. The shape we ship is the shape we run.

**Revisit when:** we need a single-file bundle for npm distribution (`bun build --target=bun` or similar). Likely necessary before the first post-rewrite npm publish.

---

## 2026-05-27 — Swallow SIGINT/SIGTERM in fnc so claude handles them

**Decision:** `packages/cli/src/main.ts` installs no-op handlers for `SIGINT` and `SIGTERM`. Default exit-on-signal is suppressed; the kernel still delivers the signal to claude (same foreground pgrp), which has its own handlers.

**Context:** With stdio inherit, both fnc and claude are in the foreground process group of the user's terminal. When the user hits `Ctrl-C`, the kernel sends SIGINT to both. Without a handler, fnc would exit with code 130 — and the `await proc.exited` would never resolve to claude's actual exit code. fnc would die before claude finished, and the user's terminal would not receive claude's exit code in the way they'd expect.

**Why this:** lets claude own the `Ctrl-C` interaction (its built-in handler shows a confirmation, or aborts the in-flight operation), while fnc stays alive to propagate claude's exit code on completion. Standard pattern from `nodemon`, `npm`, `pm2`. See [`research/bun-pty-spawn.md`](research/bun-pty-spawn.md) for the alternatives considered.

---

## 2026-05-27 — Direct commits to main; no PRs during the rewrite window

**Decision:** All CLI rewrite work commits directly to `main`. No feature branches, no worktrees for CLI work, no merge queue. CI workflows renamed to `.yml.disabled`; the GitHub merge-queue rule is set to `disabled`.

**Context:** The project `CLAUDE.md` hard rule is "no direct commits to main, all changes via PR". That rule is paused for CLI work during the rewrite — Tom's explicit override.

**Why this:** PR overhead (worktree, branch, push, queue, release-please cycling) doesn't earn its cost while every commit is exploratory and we're not publishing. Direct-to-main keeps the iteration tight.

**Revisit when:** the rewrite reaches a stable shape and we want to re-engage the release pipeline. At that point: rename workflows back to `.yml`, set the merge-queue rule to `active`, restore the PR flow.

---

## 2026-05-27 — Pre-wipe state preserved at git tag `cli-pre-rewrite`

**Decision:** The commit immediately before the source wipe is tagged `cli-pre-rewrite` (annotated; pushed to origin).

**Context:** Wiping `packages/cli/src/` is destructive in a "we can't easily reconstruct this" sense if the rewrite goes sideways. Want a clean restore point.

**Why this:** `git checkout cli-pre-rewrite` or `git branch <new> cli-pre-rewrite` brings the full pre-wipe codebase back in seconds. Combined with `git push origin cli-pre-rewrite`, the state is durable across machine loss.

---

## 2026-05-27 — Naming template lives in shared worktree-paths config, not user prefs directly

**Decision:** The `name@owner` repo-reference template, plus the `cloneTemplate` for repo locations on disk, are read from the same `repoSettings` config block that the `claude-code-worktree-paths` plugin uses (`~/.claude/settings.json`'s `repoSettings.cloneTemplate`). fnc does NOT scrape user prefs (`~/.claude/CLAUDE.md`) for these values.

**Context:** Tom uses a `name@owner` repo naming convention in his user prefs as documentation for himself. The actual template the worktree-paths plugin acts on lives in a shared config block. The question was: do we re-parse user prefs, or use the shared config?

**Why this:** the shared config is the canonical machine-readable source. User prefs are documentation that *references* the shared config. Reading the shared config means fnc and the worktree-paths plugin can't drift; user-pref docs evolve independently without breaking fnc's resolver.

**Revisit when:** the shared-config schema changes, or if the worktree-paths plugin is replaced.

---

## 2026-05-27 — Unit tests in `test/unit/`, integration tests in `test/e2e/`

**Decision:** Two test directories under `packages/cli/test/`:
- `test/unit/` — pure-function tests. Import the module directly, assert on inputs/outputs. No subprocess spawns, no real claude.
- `test/e2e/` — full integration tests. Spawn `bin/fnc.js` (via the preflight path), run against the real `claude` binary on PATH. No fake-claude bash scripts, no mocked Anthropic SDK — the build-plan's "no mocks/fakes" rule applies here.

`bun test` discovers both by default (`**/*.test.ts`).

**Context:** The build-plan's TDD protocol calls for tests in `test/e2e/` but pure parsers (argv intake, token classification, magic-positional state machine) don't need a subprocess to assert behavior — they're pure transformations. Forcing them through real-claude e2e wastes minutes-per-test for assertions a unit test resolves in milliseconds. The "no fakes" rule was specifically about the bash-fake-claude bug class that masked the SIGHUP race; it doesn't apply to pure-function tests because there's no fake to use.

**Why this:** unit tests give fast, deterministic coverage of the parsing layer; e2e tests give honest coverage of the spawn / signal / launch behavior where the bash-fake class of bug actually lives. Right tool for each layer.

---

## 2026-05-27 — Document tech decisions in this file as we make them

**Decision:** Every choice made during the rewrite (where alternatives were live) lands here as an entry in the same commit as the code that embodies it.

**Context:** Decisions accumulate context that vanishes if not captured at the moment of choice. Future sessions ask "why this?" months later and have to re-derive the reasoning from scratch.

**Why this:** the cost of capturing is one short paragraph at the moment of choice; the cost of NOT capturing is repeating debates we already settled, or worse, silently undoing a load-bearing constraint we forgot was load-bearing. Memory `feedback-document-decisions.md` covers the rule.

---

## 2026-05-27 — Bun-native TOML for config loading

**Decision:** `config/load.ts` reads `config.toml` via `import(path, { with: { type: 'toml' } })` — Bun's built-in import attribute support — rather than a third-party TOML parser.

**Context:** fnclaude's config file is TOML (`$XDG_CONFIG_HOME/fnclaude/config.toml`). The options were: (a) a third-party parser (`@iarna/toml`, `smol-toml`, etc.) added as a dep, (b) hand-roll a subset parser, (c) use Bun's native TOML import attribute.

**Why this:** Bun 1.x supports the import attribute natively — zero extra deps, no parse-drift versus the TOML spec, no bundle step complications. The only cost is a dynamic `import()` call (versus a synchronous parse), which is fine given config loading already happens once at startup behind an `await`. The catch: this is Bun-only — Node's module loader doesn't support `{ with: { type: 'toml' } }`. That's acceptable because the preflight already branches on runtime; the TOML import only runs on the Bun code path.

**Revisit when:** Node lands import attributes with TOML support in LTS (currently only JSON is Stage 3+), or if the dep-free approach causes issues with bundlers during a future single-file distribution step.

---

## 2026-05-27 — Discriminated-union return shape for `resolveInput`

**Decision:** `resolveInput()` returns a discriminated union (`kind: 'launch' | 'needs-clone' | 'needs-owner-lookup' | 'ambiguous' | 'error'`) rather than throwing on non-launch paths or returning a nullable.

**Context:** `resolveInput` sits at the boundary between pure path/repo logic and side-effecting operations (gh CLI invocations, actual `git clone`). Three design shapes were available: (a) throw on non-launch paths so the caller uses try/catch, (b) return `null | LaunchCwd` and have separate functions for the error/clone cases, (c) discriminated union so the caller exhaustively switches on what to do next.

**Why this:** control flow via exceptions makes it hard to exhaustively handle every branch — TypeScript doesn't enforce catch coverage. A nullable return collapses two distinct "not ready to launch" cases (needs-clone vs needs-owner-lookup) into one, losing the distinction. The discriminated union makes every variant explicit and TypeScript-checkable: the compiler will warn if a new variant is added but a switch arm is missing. Side effects (gh subprocess calls) stay at the caller boundary — the resolver stays pure-ish (filesystem reads only), which keeps it unit-testable without subprocess mocks.

---

## 2026-05-27 — Dependency injection at orchestrator boundaries for unit testability

**Decision:** Side-effectful operations — `listWorktrees` (runs `git worktree list`), `llmCall` (Anthropic SDK or `claude -p`), `ghApi` / `ghClone` (gh subprocess calls) — are injected as callbacks into their respective orchestrators rather than imported and called directly.

**Context:** These functions touch subprocesses, the network, or the filesystem in ways that can't run in unit tests without real tooling present. The question was whether to mock them at the module boundary (jest/vitest-style `vi.mock`), inject them explicitly, or restructure to avoid them.

**Why this:** explicit injection is transparent at the call site — the orchestrator's signature documents exactly which side effects it needs, and tests wire in synchronous stubs without any module-mock infrastructure. `vi.mock` or equivalent would work but couples tests to module paths and requires a test framework that supports module interception; Bun's test runner supports `mock.module` but the explicit-injection approach works in any runner and makes the dependency graph readable in the type signature alone. Production wiring (`runGhApi`, `runGhClone`, `sdkLlmCall`, real `listWorktrees`) happens in `main.ts` at the top of the call graph.

---

## 2026-05-27 — `realpathSync(process.argv[1])` for exeDir instead of `import.meta.url`

**Decision:** The directory containing the running binary (`exeDir`) is computed as `dirname(realpathSync(process.argv[1]))`, not via `import.meta.url` or `import.meta.dirname`.

**Context:** `exeDir` is needed to locate sibling directories (`../prompts`, `../share/fnclaude/prompts`) relative to the installed binary. Two paths to get there: (a) `import.meta.url` / `import.meta.dirname` — the ESM-native approach, (b) `process.argv[1]` + `realpathSync`.

**Why this:** `import.meta.url` resolves to the source file's URL, not the installed bin entry point. When `npm install -g` creates a symlink in `.bin/fnc → ../../packages/cli/bin/fnc.js`, `import.meta.url` in `main.ts` resolves to `…/packages/cli/src/main.ts` — the source layout, not the install layout. `process.argv[1]` is the script Node/Bun was given on the command line, which is `bin/fnc.js`; `realpathSync` resolves the `.bin/` symlink to the actual file, giving the true install-relative `exeDir`. The prompts directory candidates (`../prompts` relative to bin) then resolve correctly for both local dev (`packages/cli/bin/../prompts`) and global installs.

---

## 2026-05-27 — ensureCwd inode-trick + cleanup callback pattern

**Decision:** When the resolved launch cwd doesn't exist, `ensureCwd` fabricates the full directory tree, returns a `cleanup()` callback, and `main.ts` calls it immediately after `Bun.spawn` returns (before `await proc.exited`). The kernel holds the cwd by inode reference in the child, so the dirs can be removed while the session runs.

**Context:** Cross-cwd resume hands fnclaude a stored cwd that may no longer exist. `Bun.spawn` with a non-existent `cwd` returns `ENOENT` and the error message blames the claude binary, not the missing path. The options were: (a) pre-create and leave the dirs, (b) pre-create + cleanup after the session, (c) skip ensureCwd and add a better error message, (d) the inode-trick: create, spawn, cleanup immediately.

**Why this:** option (a) leaks phantom directories into the user's filesystem. Option (c) is non-starter — missing cwd at a stored path is a valid use case (session started in a temp dir that's since been deleted), not an error. Option (d) is the Go canonical implementation (`src/pty_run.go:154-237`): once the child process has called `chdir`, the kernel pins the inode; the directory entries can be removed from the parent name space without pulling the rug out from under the running child. The cleanup callback is returned alongside the `ok: true` result (rather than being a separate call) so the creation and cleanup stay paired — callers can't forget to clean up, and the function is testable as a unit (create, verify exists, call cleanup, verify gone).

---

## 2026-05-27 — Deferred-flush warnings buffer rather than synchronous stderr writes

**Decision:** Non-fatal launch warnings (worktree-name sanitization, prompt-fragment load failures, missing prompts dir) accumulate in a `WarningBuffer` and flush to stderr after `await proc.exited`, not at the point they're generated.

**Context:** `claude`'s TUI takes over the terminal within milliseconds of spawn. Any `process.stderr.write` that happens before or shortly after spawn scrolls off-screen behind the TUI before the user has time to read it. The options were: (a) suppress warnings entirely, (b) write them before spawn (adds latency on every launch for output nobody will see), (c) write them synchronously at the generation site (same scroll-off problem), (d) buffer + flush post-exit.

**Why this:** option (d) is the only shape where the user actually sees the warning — it lands in the shell after `claude` has exited, at the prompt where the user is about to type. Terminal errors that abort launch (`error` result from `resolveInput`, missing claude binary, clone failure) still write directly to stderr without buffering — those aren't background noise, they're the reason the launch is aborting. The distinction between "warning" (buffered) and "terminal error" (direct) is enforced by call site, not by the buffer itself. Silent-relaunch paths (§9) will need to suppress the flush to avoid writing to a dead terminal; a `// TODO` marks that gate site.

---

## 2026-05-27 — `@anthropic-ai/sdk` for the auto-name fast-path

**Decision:** When `ANTHROPIC_API_KEY` is set, auto-naming (§5.2) calls `claude-haiku-4-5` via `@anthropic-ai/sdk` (`client.messages.create`) instead of shelling out to `claude -p`. The SDK reads the key from `process.env` rather than us passing it explicitly. Same model + system prompt as the subprocess path, both kept in sync via `name/llm-prompt.ts`.

**Context:** The subprocess path works but pays a multi-second cold start on every prompt — claude has to boot, load its config, spin up its own SDK client, then do the API call. When the user already has the API key in env, the launcher might as well skip the middleman.

**Why this:** the official SDK is the lowest-friction integration — handles auth, retries, errors, streaming. No need to hand-roll fetch + JSON for one model call. Cost: a ~125-package transitive dep on the CLI side, but the cold-start savings dominate user-visible latency.

**Why no SDK unit test:** `sdkLlmCall` is a six-line wrapper around `client.messages.create`. A mocked-SDK unit test would assert "we called the SDK with the args we just typed" — tautological. The e2e dispatch-shape test (verify `claude -p` is NOT spawned when key is set) gives real wiring coverage; the SDK itself is tested by Anthropic. If the wrapper grows logic (retry shaping, response post-processing beyond block concatenation), revisit.

**Revisit when:** the SDK's transitive dep weight becomes a concern for cold-start (measured ~25ms to `import @anthropic-ai/sdk` under Bun on this machine — acceptable for now; if it grows, switch to a dynamic `import()` gated on `ANTHROPIC_API_KEY` so the SDK only loads on the fast path), or we want streaming for some other launcher feature.
