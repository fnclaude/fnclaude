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
