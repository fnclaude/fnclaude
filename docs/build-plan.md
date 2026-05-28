# fnclaude — implementation plan

Dependency-ordered build of the CLI rewrite. Each item is a discrete feature with a TDD entry point. Sequential execution is the default until Tom explicitly flips to parallel; the plan annotates parallelism opportunities up front so the structure is already in place when that happens.

**Conventions:**
- ⏱ **Sequential**: must be completed before any later items in this group or downstream groups.
- 🌿 **Parallel-safe**: items in the same braced group `{…}` can be developed concurrently once their dependencies are met.
- ✅ marks items already done.
- Every code-shipping feature follows the TDD protocol in §0 below.

---

## §0 — TDD protocol (read before writing any feature)

Every code-shipping feature follows this loop:

1. **Read** the PRD entry ([`prd.launcher.md`](prd.launcher.md) / [`prd.in-session.md`](prd.in-session.md)) and the corresponding [`design.md`](design.md) section.
2. **Write a failing test.** Pick the tier:
   - **Unit test** (`packages/cli/test/unit/<feature>.test.ts`) — for pure functions, parsers, predicates, and any module that exposes a clean injectable seam. Mocks/fakes/dependency-injection are fine here (see "Mocks/fakes — what's allowed where" below).
   - **e2e test** (`packages/cli/test/e2e/<feature>.test.ts`) — for the user-visible launch behavior. The test invokes the **real** `claude` binary against the **real** `fnc` symlink — no mocks, no fakes, no shell-script stand-ins for claude. Use the user's actual `~/.local/bin/fnc` (which symlinks to `packages/cli/bin/fnc.js`) OR invoke `bun packages/cli/bin/fnc.js` directly; either way, the binary that runs is the dev source.
   - In practice, most features get **both**: a unit test for the pure logic and an e2e test that confirms the wiring through `main.ts`. The `FNC_INTERNAL_DUMP_PLAN` hook lets the e2e tier verify launch composition without spawning claude.
3. **Run the test.** Confirm it fails AND that the failure message points at the feature, not at unrelated assertions.
4. **Implement** the feature in `packages/cli/src/`.
5. **Run the test again.** Confirm green.
6. **Sanity-check** by reverting the implementation diff (`git stash --keep-index -- packages/cli/src/<file>`), rerunning the test (must FAIL), restoring (`git stash pop`), rerunning (must PASS). If both states pass, the test isn't catching what you fixed — rewrite it.
7. **End-to-end manual verification** in a real terminal: do the user-visible action the feature enables. The TDD test catches regressions; the manual verification catches "is this actually shippable to a human."
8. **Commit + push.** Conventional commits (`feat(cli): …` for new features, `fix(cli): …` for bug fixes). Same commit includes any [`decisions.md`](decisions.md) entry that the feature embodies. Direct to `main` (no PR).
9. **Move to the next feature.**

**Test runner setup** (do this once before the first feature):
- Unstub `packages/cli/package.json`'s `test` script to `"bun test"`.
- Verify `claude` is on PATH (`command -v claude` returns a path) — tests will hard-fail otherwise.
- e2e tests are slow (real PTY, real claude); that's the cost. Don't bypass with mocks.

**Mocks/fakes — what's allowed where:**

| Tier | Mocks/fakes? | Why |
|---|---|---|
| **Unit tests** (`test/unit/`) | ✅ allowed | Unit tests cover pure functions and small modules; injecting fakes for `gh`, `claude -p`, `git worktree list`, the LLM callback, etc. is fine — these are the boundaries the modules already expose for testability. |
| **Integration tests** (if/when added) | 🤔 case-by-case | Argument exists either way. Default to real fixtures unless a specific dependency makes the test flaky, slow, or non-hermetic. Document the call. |
| **e2e tests** (`test/e2e/`) | ❌ **never** | e2e tests invoke the **real** `claude` binary against the **real** `fnc` symlink (or `bun packages/cli/bin/fnc.js` directly). No shell-script `fake-claude` that records argv to a file — the Go-canonical tests did this and it masked the SIGHUP bug that motivated the rewrite. Trap-vs-real-signal divergence is exactly the class of bug that fake binaries hide. |

DO use real fixtures at every tier: temp dirs for cwd, real env vars, real config files in temp `$HOME` if needed for hermeticity. Dependency injection at module boundaries (passing a `listWorktrees` or `llmCall` function as a parameter) is **not** the same as a fake binary and is the right pattern for unit-testable seams.

---

## §1 — Foundation (Phase 0, ✅ done)

✅ `packages/cli/bin/fnc.js` — single-line bun-shebang shim.
✅ `packages/cli/src/main.ts` — `Bun.spawn(['claude'])` in noop dir, stdio inherit, SIGINT/SIGTERM swallowed.
✅ Live system symlink at `~/.local/bin/fnc`.
✅ CI workflows disabled (renamed to `.yml.disabled`).
✅ Merge-queue rule disabled.
✅ Tag `cli-pre-rewrite` pushed.
✅ Spec docs landed: `prd.*`, `design.*`, `specs.md`, `decisions.md`.

---

## §2 — Argv parsing core (Phase 1, ⏱ sequential within)

This is the bottleneck for everything else. Build it first, all of it, before reaching for magic words or short flags.

✅ **§2.1 ⏱ argv intake** — `argv = process.argv.slice(2)`. **Revised during implementation:** Bun 1.3.14 *does* strip `--` from script argv (empirically confirmed) — restored the Node-shebang preflight + `FNC_ARGS_JSON` env-var indirection. Verify empirically that `fnc -- "say hi"` preserves `--` in `process.argv`.

✅ **§2.2 ⏱ Token classification** — given a token, is it: flag-shaped (starts with `-`), magic word (model/effort/subcommand), or positional? Pure function. PRD: [`prd.launcher.md` "Model and effort shortcuts" + "Session-mode words"].

✅ **§2.3 ⏱ Magic positional state machine** — position 1: model alias OR effort level (effort-only → opus implied). Position 2: effort level if position 1 was model. Subcommand-style positionals (`resume`/`res`/`continue`/`con`/`fork`/`fk`) at any positional slot, max one. PRD: [`prd.launcher.md` "Model and effort shortcuts" + "Session-mode words"]. Design: [`design.md` §1].

✅ **§2.4 ⏱ Positional path collection** — after magic, first non-flag positional is cwd; second is worktree-name slot; third+ is an error. Design: [`design.md` §1].

✅ **§2.5 ⏱ Stop-at-`--`** — anything after a literal `--` is the prompt to claude, passed through verbatim.

✅ **§2.6 ⏱ `--help` / `--version` short-circuits** — print and exit 0 before any parsing.

✅ **§2.7 ⏱ `mcp` subcommand dispatch** — if `argv[0] === "mcp"`, hand off to the MCP server entry point (stub today; exits 2 with a pointer at §7).

End of §2. Argv is parsed into `{cwd, extraDirs (empty/onIce), passthrough, noTmux, worktreeSet, worktreeArg, usedNoopFallback, subcommand}`.

---

## §3 — Path resolution + cwd targeting (Phase 2)

Depends on §2. Three slots that can run in parallel once §2 is done:

✅ 🌿 **§3.1** **Tilde expansion** — `~/foo` → `<HOME>/foo`. Pure string fn.
✅ 🌿 **§3.2** **Absolute path passthrough** — `/abs/path` → unchanged.
✅ 🌿 **§3.3** **Noop fallback** — no positional → `$XDG_CONFIG_HOME/fnclaude/noop`.

✅ **§3.4** **Repo-reference resolver** — depends on §3.1–§3.3. `parseRepoRef` covers every form (bare-name / `name@owner` / `owner/name` / `gh:owner/name` / HTTPS / SSH / scp-style); host-aliases + four-tier repoSettings loaders ship; `resolveInput` orchestrator returns a discriminated union (`launch` / `needs-clone` / `needs-owner-lookup` / `ambiguous` / `error`) with full dual-lookup logic. gh-CLI side effects are wired: `findOwner` does `gh api user` + `gh api /user/orgs` for bare-name owner resolution, and `cloneRepo` does `gh repo clone` to materialize needs-clone targets. Design: [`design.md` §15–17, §22–23].

✅ ⏱ **§3.5** **+workspace suffix** — `name@owner+workspace`. Parsed by `parseRepoRef`, propagated through every `resolveInput` result variant, and wired into `applyWorktreeIntercept` as a fallback `-w` value when the user didn't pass `-w` explicitly. Explicit `-w` always wins.

End of §3. `launchCWD` is an absolute path.

---

## §4 — Short flags + magic expansion (Phase 3, fully parallel-safe)

Depends on §2 complete. Items 🌿 here are independent — same dispatch boundary.

✅ 🌿 **§4.1** **Model alias expansion** — `opus`/`sonnet`/`haiku` → `--model <alias>` prepended to passthrough.
✅ 🌿 **§4.2** **Effort level expansion** — `low`/`medium`/`high`/`xhigh`/`max`/`auto` → `--effort <level>` prepended.
✅ 🌿 **§4.3** **Effort-without-model → opus** — when only effort appears at position 1, inject `--model opus` alongside `--effort <level>`. PRD item #2.
✅ 🌿 **§4.4** **Subcommand expansion** — `resume`/`res` → `--resume`; `continue`/`con` → `--continue`; `fork`/`fk` → `--resume --fork-session`. Design: [`design.md` §1].
✅ 🌿 **§4.5** **Short-flag translation** — capital-letter shorts → long forms. Cluster mechanics: `-BVC` splits into three; last in cluster may consume next token as value (`-BVCM plan` → `-B -V -C -M plan`). Sentinel-aware: tokens after `--` pass through verbatim. Design: [`design.md` §2]. PRD item #9.

End of §4. Passthrough has all expansions applied.

---

## §5 — Per-invocation features (Phase 4)

Depends on §2–§4. Mixed parallel/sequential within.

✅ 🌿 **§5.1** **Name sanitization** — exact regex per [`design.md` §3]: replace AND collapse runs of `[^A-Za-z0-9._/-]` to a single `-`, collapse dash runs, collapse slash runs, trim leading `[-.]`, trim trailing `[-/]`, reject `..` containment. PRD item #7.

✅ 🌿 **§5.2** **Auto-name from prompt** — `shouldAutoName` gate (`--` + body + no `--name`/`-p`/`-r`/`-c`/`--from-pr`) + heuristic fallback + LLM-output slug sanitizer + `autoName` orchestrator with 15s timeout. Two LLM paths: `ANTHROPIC_API_KEY` set → Anthropic SDK (`claude-haiku-4-5`); unset → `claude -p` subprocess. Both share the same system prompt + model via `name/llm-prompt.ts`. Design: [`design.md` §18]. PRD: [`prd.launcher.md` "Auto-naming"].

✅ ⏱ **§5.3** **Worktree intercept** — `-w <name>` OR 2nd-positional. Match priority ladder (branch / `worktree-<name>` stripped / basename). Match → swap cwd + set `--name`; no match → pass `--worktree <name>` + `--name <name>`. Wired with a `git worktree list --porcelain` parser + spawner.

✅ 🌿 **§5.4** **Auto-tmux gating** — config `auto.tmux = "worktree"` AND user passed `-w` for a new worktree AND no `--no-tmux` AND no `--tmux` already present → inject `--tmux`. Config loader uses Bun's native `import(path, { with: { type: "toml" } })` — no third-party TOML dependency.

✅ 🌿 **§5.5** **Prompt-fragment composition** — `selectFragments` + `loadFragments` + `injectFragments` + `resolvePromptsDir` (with `$FNC_PROMPTS_DIR` override → `<exe-dir>/prompts` → `<exe-dir>/../prompts` for npm/monorepo → FHS share). `exeDir` is `realpathSync(process.argv[1])` so symlinked installs resolve correctly. Append-aware (merges into existing `--append-system-prompt` if present).

🌿 **§5.6** **Multi-dir injection** — 🧊 **ON ICE**. Per PRD item #6, deferred. Don't implement now.

End of §5. Argv is complete except for self-MCP injection (handled in §7).

---

## §6 — Launch + env wiring (Phase 5, ⏱ sequential)

Depends on §2–§5.

⏱ **§6.1** **Env composition** — `process.env` + `[exec.env]` from config + handoff vars (`FNC_SOCKET`, `FNCLAUDE_HANDOFF`). Today main.ts inherits `process.env` only. Design: [`design.md` §5].

✅ ⏱ **§6.2** **PATH check for claude** — `findClaude({pathEnv})` walks PATH left-to-right, errors with a clean "claude not found" pointer (exit 127). Spawn uses the resolved absolute path.

✅ ⏱ **§6.3** **ensureCWD** — `ensureCwd(path)` walks up, mkdirs missing levels, returns a `cleanup()` callback. main.ts runs ensure → spawn → cleanup so the kernel's inode reference keeps the child's pwd alive after we unlink the phantom dirs.

✅ ⏱ **§6.4** **PTY spawn** — `Bun.spawn` + stdio inherit. Sufficient until §9 needs output capture; when that lands, switch to `Bun.Terminal`.

✅ ⏱ **§6.5** **Signal handling** — SIGINT/SIGTERM swallowed (kernel routes to child via foreground pgrp). SIGWINCH passes through inherit. Will need revisit when `Bun.Terminal` lands.

End of §6. claude is running.

---

## §7 — MCP server scaffolding (Phase 7, ⏱ sequential within)

Depends on §6. This is the big chunk before any in-session feature can work.

✅ **§7.1 ⏱ Socket path computation** — `<base>/fnclaude-mcp-<pid>.sock` where `<base>` is `$XDG_RUNTIME_DIR` or OS temp dir. Design: [`design.md` §14], [`design.mcp.md` §1–2]. Implemented in `packages/cli/src/mcp/socket-path.ts` as the pure `computeSocketPath({ env, pid, platform })` function; Unix-only (throws on win32, see §7 follow-up).

✅ **§7.2** **AF_UNIX listener startup** — `startMcpListener({ socketPath, onConnection })` in `packages/cli/src/mcp/listener.ts` binds via `Bun.listen({ unix })`, best-effort-unlinks any stale socket file before bind, and exposes a `stop()` that closes the listener + unlinks the socket (idempotent). main.ts starts it AFTER the DUMP_PLAN early-exit but BEFORE `Bun.spawn`, and wraps spawn + `proc.exited` in try/finally so cleanup runs even on uncaught errors. Bind failure rejects the promise → main.ts treats as fatal (exit 2). FNC_SOCKET is now plumbed into the child env via composeEnv. Skipped on win32 (named-pipes follow-up).

✅ **§7.3** **JSON-RPC 2.0 server scaffold** — `initialize`, `tools/list`, `tools/call`, notification handling. MCP transport over stdio (subprocess invoked by claude per `--mcp-config`). Design: [`design.mcp.md` §3]. Implemented in `packages/cli/src/mcp/jsonrpc-server.ts` as `createJsonRpcServer({tools, initializeResponse})` — pure handler that takes one newline-delimited message and returns the response line (or null for notifications). Routes by method, injects tools via `Record<string, {description, inputSchema, handler}>`. Standard JSON-RPC error codes (-32700/-32600/-32601/-32603). Tool results wrapped in MCP's `{ content: [{ type: "text", text: <json> }] }` shape.

⏱ **§7.4** **Self-MCP `--mcp-config` injection** — inline JSON: `{"mcpServers":{"fnclaude":{"command":"<self-path>","args":["mcp"]}}}` (add `--noop` for noop sessions). Design: [`design.md` §29], [`design.mcp.md` §2.1].

✅ **§7.5** **MCP subprocess entry point** — `fnclaude mcp [--noop]` dispatch (the `mcp` subcommand from §2.7). `runMcpServer` reads `$FNC_SOCKET` (fatal exit 2 if absent), constructs four tool handlers via `buildTools`, and pumps stdin → JSON-RPC handler → stdout. Each handler builds a `WireRequest` with the matching `op` (`restart` / `switch` / `spawn` / `copy_to_clipboard`) and forwards through `dialAndCall`. Full JSON-RPC scaffolding (initialize, tools/list) still pending in §7.3. Design: [`design.mcp.md` §2.2–2.3].

✅ **§7.6** **Request/Response wire format** — `packages/cli/src/mcp/wire.ts` ships `dialAndCall({socketPath, request, dialTimeoutMs=10000, callTimeoutMs=10000})` with newline-delimited JSON over `Bun.connect({ unix })`. One request/response per connection; rejects on dial timeout, call timeout, malformed JSON, or any socket error. Design: [`design.mcp.md` §3].

⏱ **§7.7** **Per-tool dispatch on parent side** — accept connection, read request, route by `op`, write response, close. Each connection in its own concurrency unit. Design: [`design.mcp.md` §2.3].

End of §7. The four tools can now be implemented in parallel.

---

## §8 — MCP tools + handoff (Phase 8, 🌿 fully parallel-safe)

Depends on §7 complete. All four tools are independent:

🌿 **§8.1** **`fnc_restart`** — UUID validation, preserveArgs (nil deny), applyOverrides, build relaunch argv (`[magic] launchCWD --resume <uuid> [rest]`), stash + trigger. Design: [`design.md` §12–13], [`design.mcp.md` §4.1, §5].

🌿 **§8.2** **`fnc_switch_project`** — summary file write (`<base>/fnclaude-handoff-content-<16hex>.md`, mode 0600), preserveArgs (transfer denylist), applyOverrides, live permission-mode capture, build relaunch argv (`[magic] dest [rest] --name <name> @<summary>`), stash + trigger. Also: `never` mode → paste-flow response with clipboard write. Design: [`design.md` §12–13], [`design.mcp.md` §4.2].

🌿 **§8.3** **`fnc_spawn_session`** — `applyOverrides(nil, req)` (no preservation), summary file write, spawn launcher: config `auto.spawnCommand` → tmux auto-detect → paste-flow fallback. `cleanEnvForSpawn` strips `FNC_SOCKET`/`FNCLAUDE_HANDOFF`/`CLAUDE_CODE_SESSION_ID`. Design: [`design.md` §20], [`design.mcp.md` §4.3].

✅ **§8.4** **`fnc_copy_to_clipboard`** — backend detection: `wl-copy` → `xclip` → `xsel` → `pbcopy` → `clip.exe`. Returns `done` with `clipboard_ok` flag. Pure handler module (`packages/cli/src/mcp/handlers/clipboard.ts` + `clipboard-backends.ts`); wiring into §7.7's parent dispatcher is Wave 2. Design: [`design.md` §25], [`design.mcp.md` §4.4].

🌿 **§8.5** **Handoff trigger + kill sequence + re-execution** — `Triggered` mechanism (channel/promise), SIGTERM → 200ms → SIGKILL on Unix; `TerminateProcess` equivalent on Windows. After claude exits, process image replacement: `execve` on Unix, new child + wait on Windows. Design: [`design.mcp.md` §6].

Note: §8.5 is technically a prerequisite for §8.1–§8.3 firing end-to-end, but can be developed in parallel with the tool implementations themselves (they just won't trigger anything until §8.5 lands). Group them at the same dispatch boundary.

---

## §9 — Cross-cwd resume + post-launch (Phase 6, 🌿 mostly parallel)

Depends on §6 (and on switching the launcher to `Bun.Terminal` for output capture).

✅ ⏱ **§9.0** **Switch launcher to Bun.Terminal** — replace stdio inherit with `Bun.Terminal` so the parent can capture output. Document in `decisions.md`. [bun#25779](https://github.com/oven-sh/bun/issues/25779) verified fixed in 1.3.14 — no Ctrl-C byte-interception workaround needed; Windows + non-TTY contexts fall back to stdio inherit.

🌿 **§9.1** **Ring buffer** — 64 KB fixed-capacity circular byte buffer. Tee PTY output to stdout + ring. Design: [`design.md` §4].

🌿 **§9.2** **Cross-cwd detection regex** — `/To resume, run:[\s\S]*?cd (\S+) && claude --resume ([0-9a-fA-F-]{36})/g`. Run against ring contents after claude exits. Validate destination per security rules (`isSafeDest`).

🌿 **§9.3** **Cross-cwd silent relaunch** — reconstructArgv (preserveArgs with nil deny → splitLeadingMagic → magic + dest + `--resume <uuid>` + rest). Process image replacement on Unix; equivalent on Windows.

End of §9. Cross-cwd resume works on Linux + Windows + macOS (per PRD item #12).

---

## §10 — Polish + completions (🌿 fully parallel-safe)

Depends on the relevant features. Each item is independent.

🌿 **§10.1** **Shell completions** — three sub-items, fully parallel:
   ✅ zsh `_fnclaude` (in `packages/cli/completions/`)
   ✅ bash `fnclaude.bash`
   ✅ fish `fnclaude.fish`
   Each includes `-w`/`--worktree` completion that calls `git worktree list`.

✅ 🌿 **§10.2** **Help text** — `--help` / `-h` output covers every magic positional, fnclaude-owned flag, capital-letter short, env var (ANTHROPIC_API_KEY, XDG_CONFIG_HOME, FNC_PROMPTS_DIR, FNC_NOOP_TEMPLATE_PATH), config.toml section ([name]/[auto]/[exec.env]), and a worked Examples block. Mirrors Go canonical's `helpText` structure; new env-vars block surfaces the SDK fast-path and template-source override.

✅ **§10.3** **Warnings deferred-flush** — accumulate warnings during the run; flush to stderr AFTER claude exits and the user is back at their shell. Skip on silent-relaunch paths. Design: [`design.md` §27].

✅ 🌿 **§10.4** **`[exec.env]` config injection** — already shipped via §6.1's `composeEnv` (see [`launch/compose-env.ts`](../packages/cli/src/launch/compose-env.ts)). `config.execEnv` is layered between `process.env` and the handoff/socket vars; the `launch-plan.test.ts` "env composition" block exercises the wiring end-to-end. No additional work — marking done as the §10.2 polish pass crossed it off.

✅ 🌿 **§10.5** **`--no-tmux` escape hatch** — verified at the parser (`packages/cli/src/argv/parse.ts:139–143` eats `--no-tmux` into `parsed.noTmux`, never pushing it to passthrough); §5.4's `shouldInjectTmux` already honors it. Regression coverage added: unit test asserts `--no-tmux` is absent from `parsed.passthrough`; e2e test asserts `--no-tmux` is absent from `plan.claudeArgs`.

🌿 **§10.6** **Repo `CLAUDE.md` for noop dir personalization** — already free via claude's own project context loading; just document it in PRD (which it already is). No code needed.

✅ 🌿 **§10.7** **Noop seeding** — seed `handoff.template.md` into noop dir on noop-fallback launches (NOT `CLAUDE.md` — that was the README divergence). `seedNoopDir` + `resolveTemplateSourcePath` walk `<exe-dir>/templates/` → `<exe-dir>/../templates/` → `<exe-dir>/../share/fnclaude/templates/` candidates (mirrors the prompts-dir resolver). Source ships at `packages/cli/share/fnclaude/templates/handoff.template.md`. Existing dest is never clobbered; missing source is a graceful no-op. Design: [`design.md` §19].

---

## Sequential execution order (default, what we do until Tom flips parallel)

When executing sequentially, walk the plan top-to-bottom:
- All of §2 (argv core), in order.
- All of §3 (path resolution), in numbered order (§3.1, §3.2, §3.3, §3.4, §3.5).
- All of §4 (magic + short flags), in numbered order even though parallel-safe.
- All of §5 (per-invocation features), in numbered order.
- All of §6 (launch + env).
- All of §7 (MCP scaffolding).
- All of §8 (tools + handoff).
- §9 (cross-cwd resume), starting with §9.0 switching the launcher.
- §10 (polish + completions), in numbered order.

---

## Parallel execution order (when Tom authorizes)

The natural dispatch boundaries:

**Wave 1 (sequential):** §2 (argv core, ~7 features one after the other).

**Wave 2:** §3.1, §3.2, §3.3 in parallel (3 dispatches). Then §3.4 (depends on the three). Then §3.5.

**Wave 3:** §4.1–§4.5 all in parallel (5 dispatches).

**Wave 4:** §5.1, §5.2, §5.4, §5.5 in parallel (4 dispatches). Then §5.3 (depends on §5.1).

**Wave 5 (sequential):** §6.1 → §6.2 → §6.3 → §6.4 → §6.5. Could pipeline §6.1 with §6.3 if we accept the integration risk.

**Wave 6 (sequential):** §7.1 → §7.2 → §7.3 → §7.4 → §7.5 → §7.6 → §7.7.

**Wave 7:** §8.1, §8.2, §8.3, §8.4, §8.5 all in parallel (5 dispatches).

**Wave 8:** §9.0 sequential, then §9.1, §9.2, §9.3 in parallel (3 dispatches).

**Wave 9:** all of §10 in parallel (7 dispatches).

Total dispatches if maximally parallel: ~32. Total waves: 9. Most parallelism is in waves 3, 4, 7, 8, 9.

---

## What's NOT in scope for the rewrite

- Anything `--also`/multi-dir related (ON ICE per PRD item #6).
- AUR / `yay` install path. Direct npm + dev symlink only for now.
- Cross-platform PTY testing on macOS (Mac is the secondary target; we accept manual testing only).
- Migration helpers from the old cli-v1.1.1 install (users `npm uninstall` and `npm install` cleanly).
