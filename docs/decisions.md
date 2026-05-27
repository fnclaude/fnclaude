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

## 2026-05-27 — No Node→Bun preflight, single bun-shebang shim

**Decision:** `packages/cli/bin/fnc.js` is a one-line `#!/usr/bin/env bun` shim that imports `../src/main.ts`. The previous preflight (Node-shebang + decide()-then-reexec-under-Bun) is gone.

**Context:** The previous shim existed because `npm i -g @fnclaude/cli` could link under either Node or Bun depending on what npm itself was running under. The preflight detected the runtime mismatch and re-execed under Bun, passing argv via the `FNC_ARGS_JSON` env var to dodge Bun's `--`-stripping bug.

**Why this:** During the rewrite window we're installing the dev version via a direct symlink in `~/.local/bin`, not via npm-global. The symlink target is invoked directly under Bun (per the shebang). The complexity of the preflight was real protection for a case that doesn't apply right now. When we get back to npm publishing, this decision likely gets revisited — but the right shape then may not be the same preflight either (Bun's `bun install -g` is the cleaner story today).

**Revisit when:** preparing for the first npm publish after the rewrite. Decide then whether to reinstate a preflight or require Bun on the install side.

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

## 2026-05-27 — Document tech decisions in this file as we make them

**Decision:** Every choice made during the rewrite (where alternatives were live) lands here as an entry in the same commit as the code that embodies it.

**Context:** Decisions accumulate context that vanishes if not captured at the moment of choice. Future sessions ask "why this?" months later and have to re-derive the reasoning from scratch.

**Why this:** the cost of capturing is one short paragraph at the moment of choice; the cost of NOT capturing is repeating debates we already settled, or worse, silently undoing a load-bearing constraint we forgot was load-bearing. Memory `feedback-document-decisions.md` covers the rule.
