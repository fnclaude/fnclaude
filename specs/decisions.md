# fnclaude — technical decisions log

Choices made during the rewrite. Locked-in implementation facts (where there was no choice to make) live in [`design.md`](design.md) and [`design.mcp.md`](design.mcp.md), not here.

Format: each decision is dated, summarized, contextualized, and justified. Future-us reads this later wondering "why did we go this way?" — the entry answers.

Entries whose subject is the **renderer** (`@fnclaude/renderer`) are historical: the package was excised from the monorepo on 2026-09-05 and nothing in the tree implements them any more. They are kept because they record why those choices were made; the renderer's own docs live under [`renderer/`](renderer/).

---

## 2026-09-03 — Docs site is Astro Starlight on GitHub Pages; internal docs move to specs/

**Decision:** The published documentation site lives in `docs/` and is built with Astro + Starlight, deployed to GitHub Pages at `https://fnclaude.rhombus.rocks` by a dedicated `pages.yml` workflow. The internal design docs, specs, and reverse-engineering notes that used to occupy `docs/` moved wholesale to `specs/`, which is not published. The site's moon `build` task is the CI gate for it; there is no unit test.

**Context:** The repo had no published documentation and `docs/` was already taken by internal material — an unusual arrangement that would confuse anyone arriving from a conventional repo, and one that blocks the tooling default of building a site from `docs/`. The rename is a pure `git mv` so `git log --follow` and GitHub both still show it as a rename rather than a delete-plus-add.

**Why Starlight over VitePress and Nextra:** this site will be mostly Claude-maintained, so the deciding axis is how much a generator catches at build time rather than how it looks. Starlight validates every page's frontmatter against a Zod schema, which turns a hallucinated or misspelled key into a build failure instead of a silently-ignored field. It exposes 28 named override components (0.42) through a `components:` config map, so customising a slot is a declared swap rather than a fork of the theme, and the component set it ships (tabs synced by label, asides, cards, steps) covers the usual docs furniture without a bespoke build. VitePress and Nextra are both fine at rendering markdown; neither turns a bad page into a red build.

**Why GitHub Pages:** the artifact is static, the repo already runs its release automation on GitHub Actions, and Pages deployment authenticates through OIDC with no long-lived secret — the same reason npm publishing here is trusted-publisher rather than token-based. The custom domain ships in `docs/public/CNAME` so it travels with the artifact rather than being repo state someone has to remember to re-set.

**Revisit when:** the site outgrows a static build (search that needs a server, per-user content), or Starlight's schema validation stops being the thing that catches bad pages because a stronger check lands upstream.

---

## 2026-06-26 — Renderer stays hybrid (text + targeted images), not full-canvas

**Decision:** The transcript stays real selectable Ink `<Text>`; Kitty graphics images are used only for content that text cannot represent (math, mermaid diagrams, actual `<img>` content). Before any inline-image work, the transcript-history rendering should move to Ink's `<Static>` (finalized events) plus a dynamic live tail.

**Context:** A full-canvas approach — rendering the entire transcript as a sequence of Kitty images for pixel-perfect fidelity — was considered. Separately, `packages/renderer/src/App.tsx` currently renders all events in a single dynamic column with no `<Static>`, which re-renders the full history on every keystroke; past viewport height this flickers and corrupts, and it would re-emit every inline image on every keypress. See [`specs/renderer/research.graphics-interactivity.md`](renderer/research.graphics-interactivity.md) for the full analysis.

**Why this:** rendering the transcript as images breaks native terminal text-selection — selection grabs character cells, and images have no underlying text, so copy yields nothing. Recovering selection requires mouse tracking plus a pixel→text mapping plus an app-owned scroll viewport (since native scroll and mouse tracking are mutually exclusive), all of which is a large, fragile build with worse scroll smoothness than native. The `<Static>`-first approach gives the transcript native scroll, native selection on the real-text parts, and inline images that are emitted once and scrolled by the terminal — the best of both.

**Revisit when:** a custom selection layer (such as the layered transparent-overlay approach described in the research doc) plus an alt-screen viewport are genuinely warranted by a feature need that text rendering cannot satisfy.

---

## 2026-06-26 — Renderer markdown links: no OSC 8; style http, plain non-clickable

**Decision:** http/https/mailto links render blue+underline with no OSC 8 hyperlink escape (Ghostty's own URL matcher handles ctrl+click). Non-clickable hrefs (anchors `#…`, relative paths) render as plain text with no link styling.

**Context:** PR #261 introduced OSC 8 wrapping for all markdown links. It shipped a regression: `string-width` — Ink's internal column measurer — strips CSI escape sequences but not OSC sequences, so OSC 8 bytes inflate the measured column width. Any table cell containing a link misaligned that column. The `TableBlock` added in PR #261 used a `visibleWidth` regex that consumed only the `ESC]` prefix, leaving `8;;<url>\x07` counted as visible characters. PR #263 removed OSC 8 to fix the regression. See [`specs/renderer/research.graphics-interactivity.md`](renderer/research.graphics-interactivity.md) for the `string-width` OSC 8 finding.

**Why this:** preserves the existing good ctrl+click behavior (Ghostty's `link-url` regex matches raw URLs in the cell grid), avoids the string-width layout bug, and avoids styling as a link what the user cannot click (anchors, relative paths have no target in a terminal).

**Revisit when:** `string-width` (or a custom measurer we own) reliably strips OSC 8 bytes, at which point OSC 8 buys reliable clicks on links whose display text differs from the raw URL.

---

## 2026-06-18 — Renderer streaming: deltas are a preview, the `assistant` event is truth

**Decision:** The renderer's token-level streaming (`--include-partial-messages`, `stream_event` lines) does NOT reconstruct canonical content blocks from the SSE deltas. Instead it accumulates them into a transient live preview (`src/live-message.ts`, keyed by `(message.id, index)`) and drops each live block the frame its consolidated `assistant` event lands — the consolidated event, which claude emits per content block mid-stream, is the source of truth and drives the existing committed-render path unchanged. Live text/thinking render RAW (glow disabled); `input_json_delta.partial_json` is accumulated raw and never `JSON.parse`d mid-stream (live tool view is a dim placeholder).

**Context:** "Render the json streaming faithfully" reads like "build the message from deltas, finalize on `content_block_stop`." But a live spike (claude-opus-4-8) showed claude *also* emits a full consolidated `assistant` event per block, mid-stream, before `content_block_stop` — so the deltas and the final block are redundant, and the deltas exactly equal the final text.

**Why this:** finalizing on the `assistant` event (not `content_block_stop`) means we never reconcile deltas vs. final text (they're equal), never run glow on partial markdown (slow + mangles half-fenced code), and never `JSON.parse` an incomplete tool input. The committed-event render path stays byte-for-byte intact; all streaming complexity is an additive surface that's empty between turns. Lower-risk than the reconstruct-and-finalize alternative for identical on-screen output.

**Revisit when:** claude stops emitting consolidated `assistant` events per block (then the reducer must become the finalizer, gated on `content_block_stop` + `message_stop`), or a parse-on-stop live tool view (showing parsed input one frame early) becomes worth the extra branch.

---

## 2026-06-03 — True execve (libc via bun:ffi) for the relaunch path

**Decision:** The handoff / cross-cwd relaunch (`reexecSelf` in `src/handoff/awaiter.ts`) replaces the running fnc process image with a real `execve(2)`, called through `bun:ffi` against libc (`src/handoff/exec-image.ts`). On platforms where the libc binding can't be loaded (Windows, or any `dlopen` failure) it falls back to the previous `Bun.spawn(child) + await child.exited + process.exit` shim. We use `execve` (explicit `envp`), not `execvp`, because Bun's `process.env` writes do not propagate to the libc `environ`, so the relaunched image would otherwise read a stale `FNC_ARGS_JSON` and re-run the original argv.

**Context:** The 2026-05-27 decision recorded that "Bun has no execve binding" and chose spawn-and-wait as the closest analog. That's true for a *short-lived* relaunch, but the in-session `fnc_restart` relaunches a *long-running interactive* claude session that never returns on its own. With spawn-and-wait the parent fnc blocks on `child.exited` indefinitely, so every restart leaves the previous generation alive as an idle ancestor — the process tree grows one generation per restart (issue #205, observed live with three stacked fnc processes on the same session).

**Why this:** `syscall.Exec` is what the Go canonical does, and `execve` is the faithful port — it replaces the image in place, so a restart leaves exactly ONE fnc per session no matter how many times the session self-restarts. `bun:ffi`'s `dlopen` makes libc reachable without a native addon or build step. The spawn fallback keeps Windows (no AF_UNIX MCP socket there anyway, so the relaunch path is cold) and any future FFI-less platform functional, just with the old stacking behaviour. This supersedes the "execve not available" framing of the 2026-05-27 entry for the relaunch path; the plain `Bun.spawn` stdio-inherit launch of claude itself is unchanged.

**Revisit when:** Bun ships a native process-image-replacement primitive (then drop the FFI shim), or the relaunch needs to run on a platform whose libc symbol/name differs from the `libc.so.6` / `libc.dylib` candidates in `exec-image.ts`.

---

## 2026-05-30 — File-only structured logging (always-on JSONL under the state dir)

**Decision:** The launcher writes a structured per-launch JSONL log to a file under the platform STATE dir (`$XDG_STATE_HOME/fnclaude/logs` on Linux, `~/Library/Logs/fnclaude` on macOS, `%LOCALAPPDATA%\fnclaude\logs` on Windows), one file per process (`fnclaude-<epoch-ms>-<pid>.jsonl`). Logging is **always on** at level `INFO` by default, overridable via the `FNC_LOG` env var (`debug`/`info`/`warn`/`error`, or `silent`/`off`/`none` to disable). Old logs are pruned to the most-recent 50 files on each launch. The whole subsystem is best-effort and **never throws** — any fs failure (missing dir, permission error, full disk) degrades silently to a no-op logger. New modules live under `packages/cli/src/log/`; `main.ts` builds the logger once after the launch cwd is resolved and emits boot / ensure-cwd / spawn / exit / relaunch events.

**Context:** `fnc resume` (and the cross-cwd silent relaunch) into a directory that no longer exists fails, and there was no way to observe what happens at the session-transition / re-exec boundary. fnc wraps the real `claude` CLI in a `Bun.Terminal` PTY and tees PTY output to stdout, so during a live session **the controlling terminal IS claude's TUI**. Anything written to stdout/stderr at session time corrupts claude's render.

**Why file-only:** because the session-time terminal belongs to claude, a console sink is unusable — it would garble the TUI. The existing `process.stderr.write("fnclaude: …")` diagnostics stay (they're on pre-terminal/fatal paths where stderr is still safe); this subsystem *adds* a file sink alongside them rather than rerouting them. A persistent file is also the only sink that survives the re-exec boundary where the resume-to-removed-dir bug fires. Epoch-ms filenames keep concurrent sessions from colliding and stay Windows-filename-safe (no colons). Always-on-INFO (rather than opt-in) means the next time the bug reproduces, the evidence is already on disk; best-effort/never-throws means logging can never become a new failure mode for the launcher — same posture as `ensureCwd`'s swallow-on-cleanup.

**Revisit when:** a `[logging] level` key is added to `config.toml` (the `initLogging` precedence already accepts a `configLevel` source — env > config > default — it's just not wired to the config loader yet), or if a session-time sink that doesn't touch claude's TUI (a journald/syslog socket, say) becomes worth the complexity.

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

---

## 2026-05-27 — Bun.Terminal switch for cross-cwd resume capture (§9.0)

**Decision:** When `fnc` runs on a POSIX system with TTY stdin + stdout, it spawns `claude` via `Bun.spawn(..., { terminal: new Bun.Terminal({...}) })` and tees the PTY's `data` callback to `process.stdout`. User stdin is set to raw mode and forwarded to `terminal.write()`; SIGWINCH on the launcher resizes the PTY. On Windows or when either stdio stream isn't a TTY (piped, e2e tests, CI), the launcher falls back to the previous `Bun.spawn` with `stdin/stdout/stderr: 'inherit'`.

**Context:** §9.1+ wants a 64 KB ring buffer scanning PTY output for the "To resume, run: cd <dir> && claude --resume <uuid>" hint so a cross-cwd resume can silently relaunch fnc in the new directory. The inherit shape gives no parent-side visibility into child output, so the ring buffer needs the PTY tee in place first — that's the entire purpose of this commit. Detection + relaunch land in §9.1/§9.2/§9.3.

**Why this (vs. always-inherit):** there's no other way to read what claude wrote. `Bun.Terminal` is the only POSIX-stable Bun-native PTY primitive (the alternatives — `node-pty` and `bun-pty` — were rejected in [`research/bun-pty-spawn.md`](research/bun-pty-spawn.md)).

**Why fall back on Windows + non-TTY:** Bun.Terminal is documented POSIX-only as of 1.3.14. Non-TTY launches (piped stdin, e2e harness, CI) have no foreground terminal to forward and no shell prompt to return control to; raw-mode forwarding is meaningless and `setRawMode` would throw. The inherit branch covers both cleanly and keeps the existing test surface working unchanged.

**Why no Ctrl-C byte interception:** [oven-sh/bun#25779](https://github.com/oven-sh/bun/issues/25779) (PTY `write("\x03")` not delivering SIGINT through the PGRP) was open at research time but has since been fixed in Bun 1.3.14. Verified empirically before this change: a 10s `sleep` under `Bun.Terminal` exits in ~500ms with trap code 42 when `terminal.write("\x03")` fires. The byte-loop SIGINT/SIGQUIT/SIGTSTP intercepts in `research/bun-pty-spawn.md` are no longer needed; raw stdin forwards straight to `terminal.write`.

**Why no unit tests:** `Bun.Terminal` doesn't mock cleanly — it allocates a real kernel PTY. The dump-plan e2e tests (`FNC_INTERNAL_DUMP_PLAN=1`) short-circuit before the spawn block and stay green; `find-claude-e2e` exercises the inherit fallback path (its stdio is piped, so `useTerminal` is false) and still exits 127 cleanly. Manual smoke: launch `fnc` from an interactive shell — output renders, Ctrl-C lands on claude, resize works.

**Revisit when:** Bun.Terminal lands on Windows, or §9.1 lands the ring buffer (which will extract this spawn block into its own module).

---

## 2026-05-27 — `preserve-args.ts` reuses `MODELS` / `EFFORTS` from `classify.ts`

**Decision:** The magic-word alphabets the Go canonical kept as private `modelAliases` / `effortLevels` maps in `preserve_args.go` are imported from `argv/classify.ts`'s exported `MODELS` / `EFFORTS` constants rather than duplicated. The new `preserve-args.ts` module wraps them in private `Set<string>` views for O(1) membership.

**Context:** `classify.ts` already exports `MODELS = ['opus', 'sonnet', 'haiku']` and `EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']` for the magic-positional scanner. The Go canonical re-listed these inline in `preserve_args.go` because Go's package layout made shared constants awkward to thread through; the TS layout has no such cost.

**Why this:** single source of truth. If the spec ever adds a model alias (e.g. `opus-4-7`), it lands in `MODELS` once and both the magic scanner and the override-strip helper pick it up. Duplicating the alphabets would invite the classic drift bug where one half of the parser knows about a new alias and the other doesn't.

---

## 2026-05-27 — `OverrideRequest` uses plain `boolean | undefined`, not pointer-bool

**Decision:** The TS `OverrideRequest` interface models the three-state bool fields (`brief`, `chrome`, `ide`, `verbose`) as `boolean | undefined` rather than reproducing Go's `*bool` shape with a wrapper type.

**Context:** Go's `*bool` is the canonical way to distinguish "field not set" from "field explicitly false" — nil pointer vs. `&false`. The Go test uses a `ptrBool(b bool) *bool` helper to construct these. TS has the same need (preserve vs. strip-only vs. strip-and-append) but has a native idiom for it: an optional field, where `undefined` means "not set" and the runtime distinguishes `undefined` / `true` / `false` directly.

**Why this:** native idiom beats faux-pointer wrappers. Caller writes `{ brief: true }` / `{ brief: false }` / `{}` instead of `{ brief: ptrBool(true) }` etc. The branching inside `applyBoolOverride` is the same shape either way (`if (b === undefined) return …`), so there's no behavioral cost — only readability gain.

---

## 2026-05-27 — Self-MCP `--mcp-config` uses `process.execPath` + script path (§7.4)

**Decision:** The injected MCP config sets `command` to `process.execPath` (the bun binary that's running fnclaude) and `args[0]` to `realpathSync(process.argv[1])` (the fnc.js script). The Go canonical uses a single resolved exe path; the TS port needs the two-element shape.

**Context:** Go ships a single self-contained binary, so `filepath.EvalSymlinks(os.Executable())` gives one path that's both runtime and program. The TS port's `fnc.js` is a script — running just `fnc.js` would invoke the `#!/usr/bin/env node` shebang and re-preflight into a fresh process tree (correct but wasteful), and using the `node` binary directly would skip the bun-only runtime the MCP server needs.

**Why this (vs. just `fncBin`):** the subprocess `claude` spawns receives this argv literally; whatever `command` resolves to is what runs. Setting `command=process.execPath` (bun) and feeding `fncBin` as the first arg lets bun execute the script via its CLI shape (`bun /abs/fnc.js mcp`). The same shape works under `npm i -g`, under a version manager's shim, and on the in-repo `bun packages/cli/bin/fnc.js` dev path — all of them resolve `process.execPath` to whichever bun is hosting the launcher.

**Why `realpathSync` on `process.argv[1]`:** npm installs link the bin via `.bin/fnc → ../@rhombus.rocks/fnclaude/bin/fnc.js`. `process.argv[1]` is the symlink path; realpath resolves to the actual on-disk script. Same reasoning as the §5.5 prompts dir + §19 noop template seed — both already realpath here.

**Why skip when `argv[1] === ''`:** vanishingly rare (would need fnclaude invoked from an embedded runtime that doesn't populate argv[1]) but the alternative — emitting an empty `args[0]` — would silently produce a broken MCP config. Skipping the injection lets claude launch normally without MCP tools, which degrades gracefully.

**Revisit when:** the TS rewrite either bundles into a single binary (via `bun build --compile`) or moves to a model where the script path is reliably the entry, at which point both `bunExec` and `fncBin` could collapse back to one path like Go.

---

## 2026-05-28 — Process image replacement via `Bun.spawn` (no native execve)

**Decision:** §8.5's kill-and-exec sequence finishes by spawning a child (`Bun.spawn(process.execPath, [<bin>, ...stashedArgv])`), awaiting it, and `process.exit`ing with the child's code — instead of true `execve`-style in-place process image replacement. Implementation: `defaultExecve` in [`handoff/awaiter.ts`](../packages/cli/src/handoff/awaiter.ts).

**Context:** Go canonical's handoff finishes via `syscall.Exec` (the Unix `execve` syscall) — same PID, same controlling terminal, fresh address space, deferred cleanup actions skipped. The parent process *becomes* the new fnclaude invocation; the kernel never reaps a second child. [`design.mcp.md` §6.2](design.mcp.md) calls out the exact semantics.

TS/Bun has no execve binding. `node:child_process` only exposes spawn / exec / fork (all of which keep the parent alive). Bun's `process` module mirrors Node's; `Bun.spawn` is the closest stable primitive. Options considered:

1. **`Bun.spawn` child + `process.exit(<code>)` after the child exits** — what we shipped. Parent stays alive briefly to await the child, then exits with the child's code. From the user's shell prompt POV, the wrapping is invisible: input + output go through inherited stdio; the only observable difference is a brief moment where two fnclaude PIDs co-exist instead of one PID swapping its image.
2. **FFI bindings to libc `execve`** — possible via Bun's native FFI (`bun:ffi`), but fragile cross-platform: glibc / musl ABIs differ, macOS / Windows ABIs differ, and the call surface is small enough that a binding maintained for one syscall isn't worth the platform-matrix support cost.
3. **A separate compiled helper binary** — write a tiny C / Zig launcher that calls execve and ship it alongside fnc. Same maintenance cost objection as the FFI route, plus a build / packaging story.

**Why option 1:** the user-visible difference between true execve and spawn-then-exit is essentially nil — both look like "fnc exits with code X" from the shell. The internal differences (parent stays around for the child's lifetime, controlling terminal handoff is via inheritance rather than the kernel transparently routing it to the new image, deferred cleanups in main.ts DO run) are tolerable for the handoff flow specifically because:
- The MCP listener's `mcpListenerStop` is in a `try/finally` that runs before we'd reach the awaiter's re-exec anyway (the awaiter blocks on `proc.exited` first; once that resolves, the finally fires, then the awaiter's exec). The new child binds a new socket at its own PID.
- The warnings buffer flush at the end of main.ts won't reach the user under handoff (the relaunch path replaces the shell view); same as Go canonical's behavior, where `defer` actions are skipped by execve.
- Controlling-terminal continuity is preserved by stdio inheritance — the child sees the same TTY fds.

**Cost:** one extra PID alive briefly on every handoff. Exit code propagation requires `process.exit(code)` because the parent's natural exit-code-from-claude path (`exitCode = await proc.exited` then `process.exit(exitCode)`) is short-circuited by the awaiter. Documented + accepted.

**Why test seam injection:** `KillAndExecArgs.execve` and `StartHandoffAwaiterArgs.execve` are both injectable so unit tests can substitute a recording stub without actually re-execing. Production wires `defaultExecve`; tests pass a callback that captures the argv.

**Revisit when:** Bun grows a native `process.execve` (tracked nowhere yet) or the brief two-PID window during handoff causes an observable bug — e.g. a tmux pane double-counts fnc PIDs, or a shell tab-tracking integration loses the connection. Neither has surfaced; we'd hear about it during real-session use.

## 2026-05-28 — Live permission-mode reader is DI-optional (§8.1)

**Decision:** `createRestartHandler` accepts an optional `livePermissionModeReader` callback; production wiring in [`main.ts`](../packages/cli/src/main.ts) currently omits it (no live capture), with the file IO port deferred to a follow-up commit. Restart still functions — auto-capture is the optional layer; explicit `permission_mode` overrides and preserved `--permission-mode` flags continue to work.

**Context:** Go canonical's `handleRestart` calls `readLivePermissionMode(launchCWD, sessionID)` inline, which scans `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` for the latest `{"type":"permission-mode",...}` record. Porting that requires the path-encoder (trivial), a streaming JSONL scanner (claude can write large tool-result bodies), and HOME resolution. All three are testable, but together they balloon the §8.1 PR; splitting the file-IO half into its own commit keeps each PR a single conceptual unit.

**Why DI seam:** future readers wire into the same callback the unit tests already exercise — no second control-flow path through restart.ts. When the file-IO commit lands, it ports `session_state.go` to TS, then changes one line in main.ts to pass the new reader.

**Revisit:** when the live-capture port lands. Drop the optional marker once production callers always supply a reader.

---

## 2026-05-28 — Live permission-mode reader ported (resolves §8.1 deferral)

**Decision:** `readLivePermissionMode(launchCWD, sessionID)` is ported from Go canonical ([`session_state.go`](../../fnclaude@fnrhombus/src/session_state.go)) to [`packages/cli/src/launch/live-permission-reader.ts`](../packages/cli/src/launch/live-permission-reader.ts). [`main.ts`](../packages/cli/src/main.ts) now binds `launchCWD` at construction time and passes the resulting `(sessionId) => string | null` reader to both `createRestartHandler` and `createSwitchHandler`. The optional DI marker on each handler stays — unit tests still inject null readers — but production wiring no longer omits it.

**Why this signature shape:** the two handlers previously diverged — restart took `(launchCWD, sessionID) => string` and switch took `(sessionId) => string | null`. main.ts has `cwd` in scope at handler-construction time, so binding it via closure means each handler reduces to the per-call `sessionId` shape. Switch's `string | null` form wins over restart's empty-string sentinel because `null` makes "no record found" structurally distinct from "found but empty" (the latter is now a defensive skip inside the reader itself, not a signaling value), and TypeScript's strict-null-checks flag mis-handling at the call site instead of letting a stale `""` silently leak through.

**Why sync IO + read-whole-file (not streaming):** session JSONLs are bounded — even a heavy session is well under the bandwidth where streaming pays for itself, and `JSON.parse` on a per-line string handles big tool-result lines natively (Go's `bufio.Scanner` needs an explicit 16 MiB buffer config; the TS shape doesn't). The reader fires only on MCP-dispatched restart / switch, never on a hot path. Simplicity wins.

**Why `process.env.HOME` first, then `os.homedir()` fallback (Go reverses this):** Bun's `homedir()` caches HOME at startup and doesn't reflect subsequent `process.env.HOME` mutations — meaning unit tests that override HOME per-test can't influence the reader's path resolution if `homedir()` is called first. Reading `process.env.HOME` directly is the canonical POSIX shape, respects test-time overrides, and is what `claude` itself uses to locate `~/.claude/`. The `homedir()` fallback covers the rare case the env var is unset (cron, bare systemd unit). The order swap vs. Go is a Bun-runtime-behavior accommodation, not a semantic change — on a healthy system both resolve to the same value.

**What changed:**
- New: [`packages/cli/src/launch/live-permission-reader.ts`](../packages/cli/src/launch/live-permission-reader.ts) (three exports: `encodeCWDForProjects`, `sessionJSONLPath`, `readLivePermissionMode`).
- New: [`packages/cli/test/unit/live-permission-reader.test.ts`](../packages/cli/test/unit/live-permission-reader.test.ts) (encoding table, path-build, JSONL last-wins + edge cases).
- Modified: [`packages/cli/src/mcp/handlers/restart.ts`](../packages/cli/src/mcp/handlers/restart.ts) — `LivePermissionModeReader` retyped to `(sessionID) => string | null`; call site drops `launchCWD` arg and treats `null` as "no live override."
- Modified: [`packages/cli/test/unit/restart-handler.test.ts`](../packages/cli/test/unit/restart-handler.test.ts) — DI fakes updated to the unified signature.
- Modified: [`packages/cli/src/main.ts`](../packages/cli/src/main.ts) — imports `readLivePermissionMode`, constructs the bound reader, passes to both handler factories.

`switch.ts` was already on the unified shape; no behavioral change there.

---

## 2026-05-28 — Switch handler branches on `req.permission_mode === 'never'` (not config-side `auto.handoff`)

**Decision:** §8.2's switch handler triggers the paste-flow branch when the wire request carries `permission_mode: 'never'`. Go canonical branches on `cfg.Auto.Handoff == "never"` instead — a config-side flag, separate from the wire's permission-mode override field.

**Context:** The TS rewrite's wire format (per [`design.mcp.md` §3.1](design.mcp.md)) carries `permission_mode` as an override field whose vocabulary is claude's documented set: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`. The §8.2 brief reuses that same wire field with one extra reserved value, `'never'`, that signals "do not auto-handoff; render the relaunch command and put it on the clipboard." The Go shape (separate config flag piping through `FNCLAUDE_HANDOFF` env into the handler's state) is one option; reusing the request override is another.

**Why this:** the wire-carried form keeps the per-call state at the wire boundary, where the model already negotiates other overrides (`model`, `effort`, `allowed_tools`). The model owns the decision per-call rather than the user's static config owning it; if a user wants the paste-flow once, they don't have to flip a config knob beforehand. The Go form (`cfg.Auto.Handoff == "never"`) is still expressible — the launcher can default the request's `permission_mode` to `'never'` when config says so — so the two shapes are mostly interconvertible. Per-call wins because it's the model's choice point.

**'never' as control signal, not real value:** the literal string `'never'` is not a permission mode claude understands. The handler treats it as a route selector and strips it from `OverrideRequest.permissionMode` before rendering the relaunch command — otherwise the paste-flow command line would carry `--permission-mode never`, which `claude` would reject. Tested explicitly (`switch-handler.test.ts` → "paste-flow command includes magic prefix + preserved/override flags").

**Revisit when:** the config-driven mode comes back into play (e.g. `auto.handoff = "never"` is wired through the launcher so the model doesn't need to set it explicitly), in which case the handler probably takes both signals — config OR wire — through a single `mode === 'never'` check. Not yet needed since the model receives the user's preference via system-prompt fragments at session start.

---

## 2026-05-28 — §9.3 cross-cwd relaunch reuses §8.5's re-exec primitive

**Decision:** Cross-cwd silent relaunch (§9.3) and MCP handoff (§8.5) share the same `reexecSelf({argv, bunExec?, fncBin?})` helper exported from [`handoff/awaiter.ts`](../packages/cli/src/handoff/awaiter.ts). The pure decision lives in [`launch/cross-cwd-relaunch.ts`](../packages/cli/src/launch/cross-cwd-relaunch.ts) as `decideCrossCwdRelaunch(input): {relaunch: false} | {relaunch: true, argv}`. main.ts's post-exit block consults the decision, stashes the argv on the handoff trigger (so a late MCP-handoff dispatch sees the slot taken), then calls `reexecSelf`.

**Context:** §8.5 shipped first with `defaultExecve` doing `Bun.spawn(process.execPath, [bin, ...argv])` + `process.exit(<child-code>)`. §9.3 needs the same primitive in a different call site — after `await proc.exited`, no kill sequence, no MCP-trigger plumbing in front. Two choices:

1. **Duplicate the spawn-and-await logic in main.ts.** Tightly couples §9.3 to the implementation detail (which bun bin, which fnc bin, which env shape) and means future tweaks (say, dropping `cwd: process.cwd()` to inherit from the parent's controlling tty in a tmux-aware way) need editing in two places.
2. **Factor out `reexecSelf` and call it from both sites.** What we shipped. `defaultExecve` becomes a thin wrapper for §8.5's injection-seam shape; §9.3 in main.ts calls `reexecSelf` directly with `Promise<never>` typing so TS catches dead-code mistakes after the call.

**Why option 2:** the two flows have identical observable semantics — same parent process becoming a child process that inherits stdio, same exit-code propagation, same env carry-over. The only difference is the argv composition, which both sites resolve before the call. Sharing the implementation means changes to the spawn shape (e.g. if we ever swap to a native bun execve binding) land once.

**Stashing on the cross-cwd path:** `handoffTrigger.stashArgv(argv)` is called even though there's no MCP path to race here at the point we'd stash — claude has already exited, the awaiter's blocked on `awaitTrigger()` (which never fired). The stash exists as a defensive invariant: any future code that consults `handoffTrigger.getStashedArgv()` post-exit (debug dumps, future telemetry) sees the canonical "this is what we're relaunching with" record, regardless of which path produced the relaunch.

**Decision skips the warnings flush:** §9.3 explicitly bypasses `warnings.flush(process.stderr)` before the re-exec — the new fnclaude process re-evaluates its inputs and will re-queue any warning that still applies. Showing stale warnings from the previous invocation right before the new claude session boots would be confusing and is exactly what "silent" in "silent relaunch" rules out.

**Revisit when:** an observable difference shows up between handoff-exec and cross-cwd-exec — same controlling TTY, same exit-code semantics, same one-extra-PID cost. If a divergence ever surfaces (say, controlling-terminal handoff differs because §8.5 went through a kill sequence and §9.3 didn't), the seam stays but the bodies split.

---

## 2026-05-28 — Centralised `insertFlagsBeforeSentinel` helper; all flag-append sites must use it

**Decision:** Adding a flag pair (`--name X`, `--mcp-config <json>`, `--tmux`, `--append-system-prompt <body>`) to the claudeArgs passthrough goes through one helper — `insertFlagsBeforeSentinel(args, ...flags)` in [`packages/cli/src/argv/sentinel.ts`](../packages/cli/src/argv/sentinel.ts) — instead of being open-coded at each call site with `[...args, FLAG, value]`. The helper splices before the first `--` if present, else pushes at the end.

**Context:** cli 2.0.0 shipped with three sites doing the naive append:

- [`main.ts:288`](../packages/cli/src/main.ts) — auto-tmux `--tmux`
- [`main.ts:317`](../packages/cli/src/main.ts) — auto-name `--name <slug>`
- [`mcp/inject-config.ts:55`](../packages/cli/src/mcp/inject-config.ts) — self-MCP `--mcp-config <json>`

When the user passes a prompt body via the `--` sentinel (`fnc -- "say hi"`), those appended pairs landed AFTER `--`, which claude reads as positional prompt content. The MCP server config became part of the user's prompt instead of being registered, so `fnc -- "say hi"` produced sessions with no MCP tools. A fourth site — [`prompts/load.ts:injectFragments`](../packages/cli/src/prompts/load.ts) — had ALREADY worked around this with the right pattern inline, but the pattern wasn't reused elsewhere.

**Why a single helper instead of per-site fixes:** every place that appends a flag is conceptually the same operation: "add this flag pair to the launcher's pre-prompt argv segment". Spreading the splice-vs-push branch across four sites is how the regression slipped in originally — one branch maintainer remembered, three didn't. The centralisation is what makes adding a fifth site (e.g. a future `--brief` auto-toggle) impossible to get wrong: there's no append idiom at all, only `insertFlagsBeforeSentinel`. The existing `findPromptSentinel` already lives in the sentinel module, so co-locating the splice helper there matches the file's responsibility — "everything about the `--` boundary."

**Revisit when:** a future change needs to insert flags AT a non-sentinel boundary (e.g. before a specific other flag for grouping), in which case the helper grows a `before` predicate parameter or splits into per-axis helpers. The current shape covers every present need.

---

## 2026-05-28 — §7.5 dispatch wires §7.3's `createJsonRpcServer`; tool-schema port lands here, not in §7.3

**Decision:** The MCP subprocess ([`packages/cli/src/mcp/dispatch.ts`](../packages/cli/src/mcp/dispatch.ts)) routes every JSON-RPC line through [`createJsonRpcServer`](../packages/cli/src/mcp/jsonrpc-server.ts) (the §7.3 scaffold), and ships the four tool descriptions + JSON Schemas in a new module [`mcp/tool-schemas.ts`](../packages/cli/src/mcp/tool-schemas.ts) ported verbatim from Go canonical. `dispatch.ts:buildTools` returns a `Record<string, JsonRpcMcpTool>` (description + inputSchema + handler) keyed by MCP tool name, which feeds `createJsonRpcServer({tools, initializeResponse})` directly.

**Context:** §7.3 landed the JSON-RPC scaffold (parse, route `initialize` / `tools/list` / `tools/call` / notifications, error envelopes) but the §7.5 wiring step that connects it to `runMcpServer`'s stdin loop was deferred — the placeholder loop only routed `tools/call` and returned `-32601 method not implemented yet (§7.3)` for `initialize`. cli 2.0.0 shipped with that placeholder still in place, which broke claude's MCP handshake: claude's first message is `initialize`, the subprocess errored, claude reported "Failed to connect" on the MCP server, the four tools never appeared in the session. Two questions surfaced as part of fixing it:

1. **Where do the tool descriptions + JSON Schemas live?** Go canonical has them inline in `src/mcp.go` (one big `mcpTool` literal per tool). For TS, options were (a) inline in `dispatch.ts` (mirrors Go), (b) one schema-per-tool file, or (c) one `tool-schemas.ts` file with all four entries.
2. **Should `buildTools` return an array (the §7.5 placeholder shape) or a record (what `createJsonRpcServer` wants)?**

**Why one `tool-schemas.ts` file:** the descriptions are long and pure data — text that drives prompt UX, not logic. Inline in `dispatch.ts` would bury the wiring shape under three pages of description literals. Per-tool files would fragment a coherent reference table across four siblings with no logic to differentiate them. One file co-locates all four schemas as a single reference users can diff against Go canonical (`grep "var tool" src/mcp.go`) when updating either side. The `TOOL_SCHEMAS: Record<McpToolName, McpToolSchema>` shape makes the record-keyed `buildTools` natural and lets the type system catch a missing tool at compile time.

**Why record over array for `buildTools`:** `createJsonRpcServer` reads tools by name in `tools/call` dispatch and iterates `Object.entries(tools)` for `tools/list`. The previous array shape forced an extra `.find(t => t.name === ...)` step everywhere. The record shape eliminates that, makes the test surface cleaner (`tools['fnc_restart']` instead of `tools.find(...)`), and matches the §7.3 contract directly. Existing `mcp-tools.test.ts` cases were rewritten for the record shape in the same change — five tests, mechanical update.

**Tool-error envelope migration deferred:** Go canonical surfaces tool failures (e.g. socket unavailable) as MCP tool-level errors (`isError: true` inside the JSON-RPC `result`), NOT as JSON-RPC protocol errors. The current scaffold catches handler throws and emits `-32603 Internal error` instead. The `mcp-handoff-e2e.test.ts` "parent socket missing" test was updated to assert `-32603` for now; the §8 work that ports the canonical tool-level error envelope will migrate it off `-32603` into the result-content shape.

**Revisit when:** Go canonical drifts on a tool description or schema (rare — these are stable enough to be considered API surface), or the §8 tool-error envelope work lands. Both will edit `tool-schemas.ts` and/or `dispatch.ts:buildTools`.

---

## 2026-05-28 — Batch-2 slash tools wrap the C0 keystone; env-var opt-in for the generic tool

**Decision:** The four Batch-2 MCP tools (`request_compact`, `fnc_set_effort`, `fnc_set_model`, `fnc_run_slash_command`) are thin per-tool handlers in [`mcp/handlers/slash-tools.ts`](../packages/cli/src/mcp/handlers/slash-tools.ts), each translating its wire args into a single call on the C0 keystone (`formatSlashCommand` + the bound `PtyWriter`). They share one deferred-bound PTY writer (`createPtyWriterHolder`) wired in `main.ts` and bound to `term.write` right after the terminal spawns. The generic `fnc_run_slash_command` is gated behind `FNC_ENABLE_SLASH_TOOL=1` and omitted from `tools/list` entirely when unset.

**Context:** #60 (#170 for `request_compact`). The keystone (#175) deliberately captures no output and stays generic; per-tool validation (effort/model vocabularies from `argv/classify.ts`) lives in the wrappers. `request_compact` takes an optional `follow_up` that queues a second NON-slash prompt line after `/compact` so the model auto-resumes; the simple queued-both approach ships now, with a `TODO(#170)` noting the JSONL-polling fallback if a line queued during compaction proves lossy. The effort/model tools slash-inject on the default assumption that `/effort` and `/model` are live TUI slash commands; if confirmed otherwise the fallback is the restart-with-override path `fnc_restart` already supports — flagged as an open question, not built.

**Why an env var for the opt-in (not config.toml):** fnclaude's config is TOML with a small hand-rolled picker surface (`config/load.ts`); the generic slash tool is a power-user escape hatch where an env var is the lowest-ceremony gate that's trivially testable (`buildTools({ env })`) and needs no schema churn. The gate lives in `dispatch.ts:buildTools` (registration-time `continue`) so an un-opted tool never reaches `tools/list`, and is mirrored as `slashToolEnabled()` for callers that want the predicate directly.

**Revisit when:** the slash-vs-restart open question for effort/model resolves (may remove the slash-inject path for one or both), or the `follow_up` queued-both approach proves lossy in live use (build the JSONL-polling fallback).

---

## 2026-05-30 — Detect-on-failure bootstrap for missing repos (PR #189)

**Decision:** When `gh repo clone` fails because the remote repo doesn't exist, fnclaude no longer hard-fails. It classifies the exit as a not-found condition and offers to bootstrap a new repo instead: local-only first (mkdir + git init + git remote add origin), then a separate explicit prompt before creating the GitHub remote. New modules: [`packages/cli/src/repo/clone-failure.ts`](../packages/cli/src/repo/clone-failure.ts) (`isRepoNotFoundError` — pure stderr classifier), [`packages/cli/src/repo/clone-url.ts`](../packages/cli/src/repo/clone-url.ts) (`parseCloneUrl` — recovers host/owner/name from the clone URL so `resolve-input.ts` didn't need touching), [`packages/cli/src/repo/confirm.ts`](../packages/cli/src/repo/confirm.ts) (pure `parseYesNo` + a thin TTY readline reader), [`packages/cli/src/repo/bootstrap.ts`](../packages/cli/src/repo/bootstrap.ts) (the orchestrator — pure core with injected side-effect deps), [`packages/cli/src/repo/git-runner.ts`](../packages/cli/src/repo/git-runner.ts) (`runGitInit`). `gh-runner.ts` gained `runGhRepoCreate` and now tees `runGhClone`'s stderr (was `inherit`) so the classifier can see it. `main.ts` factors a shared `cloneOrBootstrap` helper used by both the `needs-clone` and `needs-owner-lookup` switch cases.

**Context:** A `fnc_switch_project` call targeting `rhombus-toolkit/ioc` — a repo the user intended to bootstrap, which didn't exist yet — died on `GraphQL: Could not resolve to a Repository`. The session knew the repo was new; fnclaude should have offered to create it rather than failing the clone.

**Why detect-on-failure instead of a pre-check API call:** a pre-check (`gh repo view` before every clone) adds a network round-trip to the common case where the repo exists. Detecting not-found only on the failure path keeps the happy path single-call. The trade-off is reliance on parsing gh's human-readable error text, which can drift; mitigated by matching several known not-found signatures and defaulting to hard-fail on anything not unambiguously not-found — auth errors and network errors still surface as before.

**Why two separate prompts, and private-by-default remote:** the local bootstrap (mkdir + git init + git remote add) is fully reversible. Creating a GitHub remote is outward-facing and hard to undo, so it's gated behind its own explicit second prompt and defaults to `--private`. In a non-TTY context (CI, pipes), the confirm helper returns its default (No) without blocking, so non-interactive runs against a missing repo behave exactly as they did before this change — fnclaude never bootstraps or creates a remote by surprise.

**Revisit when:** gh changes its not-found error wording (update the signatures in [`packages/cli/src/repo/clone-failure.ts`](../packages/cli/src/repo/clone-failure.ts)); or an explicit opt-in (`--new` flag or `+new` suffix) is wanted to skip the first prompt for the known-bootstrap case; or template-based creation (`gh repo create --template`) is wanted instead of a bare empty repo.

---

## 2026-09-05 — DI engine and lifetime model: `@rhombus-std/di` `Builder` + `standardLifetime` + full validation stack

**Decision:** Containers are assembled with `Builder.useAddon(validateUniversalAddresses()).useAddon(validateBuildability()).useAddon(validateScopes()).useAddon(standardLifetime()).withServices(...).build()`. Pure-singleton containers; no scopes; explicit lifetimes on every registration under `Manifest<StandardLifetime>`.

**Context:** fnclaude's only lifetime boundary is process-outlives-one-session, expressed natively by container singletons + disposal. `taggedLifetime` was evaluated and rejected: its sole distinguishing capability (nested request scopes resolving session services) is unused here, its built provider caches nothing (forcing scope machinery just to share instances), and it structurally cannot have a `validateScopes`. The closed vocabulary makes the lifetime argument compile-required, killing the silent-transient class. `validateScopes` rides dormant as free insurance.

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — Four composition roots; every cross-root value is frozen data

**Decision:** `entry/plan.ts` (async, short-lived, emits a frozen ref-free `LaunchPlan` carrying `config` whole + drained `warnings`, then disposes), `entry/install.ts` (`install -y`), `entry/run.ts` (session; emits `SessionOutcome` carrying exit code, handoff argv, ring snapshot, run warnings **before** disposal), `entry/mcp.ts` (subprocess). `main.ts` is a pre-DI dispatcher. The hosting Generic Host is not used: it composes no lifetime model, never disposes its provider, and needs an explicit ordering orchestrator anyway.

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — Both execve tails live outside every container; teardown happens-before re-exec

**Decision:** `replaceProcessImage` (handoff) and `reexecSelf` (cross-CWD) are never registered; `run.ts` invokes them after `await using` disposal completes. The registered `IHandoffDetector` does detection + the kill of claude only and returns the stashed argv. This converts today's teardown-vs-execve soft race into an asserted hard happens-before.

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — Sugar confinement + dialect rules

**Decision:** di.extras sugar appears only in `entry/*`, `*/register.ts`, and `test/composition/*.ctest.ts` (CI grep-enforced). Explicit lifetimes always; function-shaped frozen seams register through `addValue` (the value door); no async construction (async work is a method; `resolveAsync` is the unused escape hatch); optional deps are `T | undefined` unions; tool handlers are multi-registrations aggregated into the dispatcher's `IToolHandler[]` ctor param. Leaf modules keep their deps-object factory signatures untouched; registration factories take typed params and call them.

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — Transform placement: build-to-dist behind `bin/fnc.js`, sentinel-gated

**Decision:** The ttsc lowering runs as a stage (per-file, `@ttsc/unplugin/bun`, `.ttsc-out`) + plugin-free `Bun.build` bundle, `@rhombus-std/*` external. Dev = `ensureFreshDist()`; installed = pre-built `dist/`. The fork keys on `dist/.lowered`, written by the build tool only after a zero-`typefor(` assertion; the dev tsconfig is `noEmit` (emit lives in `tsconfig.build.json`), closing the un-lowered-dist trap. Plain `bun test` stays transform-free (sugar-free unit tier); composition tests ride their own stage+bundle lane (`bun run test:composition`). A runtime preload was rejected: broken in std with an unpinned root cause, never demonstrated out-of-monorepo.

**PR-1 note:** the `bin/fnc.js` fork checks **src presence first** (dev rebuilds), then the sentinel (installed) — an `installed = dist exists` check first would skip dev rebuilds, since a dev checkout has both `src/` and a built `dist/`. The lowering runs a full tsgo typecheck, so it required the pre-existing cli tree to be type-clean; four latent type errors (a dead second arg to `promptBody`/`hasPromptBody`, and `BootFields` lacking an index signature — the cli lint was a stub) were corrected type-only. Warm rebuild at the 87-file cli scale measured ~1.2–2.3 s; the cold transform-host compile is a one-time ~30–70 s.

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — Interim `@rhombus-std` consumption: vendored workspace dirs from std `bd2074fa`; three-gate `@next` flip

**Decision:** `bun pm pack --destination` per library (checkout untouched) → extract → patch (`publishConfig` merge for di/di.core/primitives; `sed 's/0extends1/0 extends 1/g'` on di's broken `.d.ts` — a flagged upstream std bug) → re-tar into `vendor/` → `file:` + mirrored overrides + the `@rhombus-toolkit/types@2.0.0` pin, default hoisted linker. `file:`-directory links are forbidden (verified to fork package copies). Flip to `@next` only when (a) all six packages carry the tag, (b) the published surface typechecks against our usage, and (c) di's published `.d.ts` parses; then swap specifiers to the exact resolved versions, delete `vendor/` + the patch steps. Never a partial flip.

**PR-0/PR-1 note:** implemented as unpacked **workspace dirs** under `vendor/<name>/` consumed `workspace:*`, not `file:` tarballs — bun resolves a `file:` override only as an absolute path (non-portable lockfile), while a workspace member dedupes to one copy and keeps the lockfile path-free. Two extra patches were forced by stale std artifacts at `bd2074fa`: `publishConfig` is merged for the extras too (else the consumer typechecks their unlowered source), and the extras' declarations are re-emitted from shipped src into `dtsgen/` (the committed dist declaration predates the current sugar surface, tripping `INLINE_UNRESOLVED_MEMBER`). Both are flagged upstream tasks; the flip drops them at gate (c′). `typescript 7.0.2` is a load-bearing devDependency (its platform-native optional dep is the transform host's compiler).

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — Published artifact: external exact-pinned `@rhombus-std` runtime deps

**Decision:** `di`, `di.core`, `primitives` are exact-pinned runtime dependencies of the published package; `di.extras`, `primitives.extras`, `transforms` are devDependencies (their sugar is lowered away). Identity safety: one hoisted copy each, version excluded from `Type` specifiers, `di.core`'s `stampSingleInstance` guards loudly. Inlining the runtime is the documented contingency only for a publish forced before real `@next` packages exist, behind a hard single-copy publish gate (`primitives` has no self-guard — a silent-fork hazard).

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — Config stays a frozen value through DI; no `addOptions`

**Decision:** `loadConfig` runs before the plan chain; the frozen record is `addValue`'d, rides the plan whole as `plan.config`, and is re-registered in the run root. `addOptions<T>()` is not adopted — it has no runtime form and would fight the no-runtime-validation / per-field-degrade invariant. Warnings bridge roots as data (`plan.warnings` in, `SessionOutcome.warnings` out; flush on plain exit only).

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).

---

## 2026-09-05 — `IFileSystem` is a minimal, deliberate seam

**Decision:** A filesystem port exists but only `config/load.ts` is converted (the one hermetic-test payoff). The other fs-using leaves keep inline `fs` behind real-tmpdir tests — the working status quo. A systematic port is a separately-justified future decision, not part of DI adoption.

**Revisit when:** the migration sequence in [proposals/design.di-architecture.md](proposals/design.di-architecture.md) §9 reaches a step whose falsifier fires, or `@rhombus-std` publishes `@next` for all six packages (§8 flip gates).
