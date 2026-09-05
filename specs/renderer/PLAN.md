# Renderer: claude-parity + complete-plan — overnight 2026-06-18 (ultracode)

**RESUME POINTER (read on every resume):** Autonomous overnight build, Tom asleep.
Engine = sequential Workflows; each completion re-invokes me, so I chain phases
without a user turn. On resume: read THIS file + `docs/design.renderer.md` +
memory `project-renderer-wiring-shipped` + the `/tmp/renderer-parity/*.md`
findings. Update the checklist below as phases land. Default posture: **do the
MOST CORRECT thing, not the easiest/fastest** (Tom's standing instruction).

## Tom's plan (his words / intent)
1. Push a tag of the current version (bare renderer wiring).
2. Claude parity: "wire in the json streaming." No fancy fnc features. Slash
   commands forwarded to claude like any other prompt.
3. Push a tag of the claude-parity version.
4. Complete the renderer plan (`docs/design.renderer.md`).
Process: most-correct > easy/fast; ask only if still unsure after that.
Closeout: doc updates incl. `CLAUDE.md`.

## My interpretations (most-correct; Tom may redirect)
- **Step 2 = "wire in the json streaming IO"** (Tom clarified 2026-06-18: if
  "claude parity" diverges from "just json streaming," the JSON STREAMING IO is
  what he wants). So step 2 = render claude's stream-json faithfully (full event
  coverage + token-level streaming via `--include-partial-messages`) + forward
  input incl. slashes RAW (`sendUserTurn`, no fnc interception). NOT full
  agentic parity — arg-threading, permissions, spawn-ownership are STEP 4.
- **Step 4 = "complete it" = go as ABSOLUTELY FAR as possible WITHOUT STOPPING**
  (Tom 2026-06-18). Max autonomy, non-stop, to the end of design.renderer.md.
- **Maximize DEVELOPMENT parallelism** (Tom 2026-06-18): decompose every impl
  phase into concurrent, file-disjoint tracks (parallel worktrees/agents/PRs).
- **Step 4 (complete plan)** = full combined-mode per design.renderer.md: §7
  `mountRenderer` streams-injection; fnc owns spawn (FNC_SOCKET + MCP config +
  stderr PIPED + `--resume`); slash-tools via `sendUserTurn` (per spike);
  capability negotiation; React error boundary; restart in/out; lifecycle.
- **Releases**: normal gated auto-merge+publish per PR (feature behind
  `FNC_RENDERER`, off by default → live `fnc` unchanged). Multiple incremental
  releases overnight is fine.
- **Tags**: annotated `checkpoint/renderer-bare-wiring` (step 1, done) and
  `checkpoint/renderer-claude-parity` (step 3).
- **Compact**: rely on harness auto-summarization + Workflow separate-context
  agents (a blocking manual `/compact` would strand the autonomous run).

## Open empirical unknowns → WF1 spikes
- Do `/effort`, `/model` (others) work over `claude --print` stream-json?
  (only `/compact` + `/usage` proven; `/help` rejected.)
- How does `claude --print` handle tool permissions (control protocol?
  permission-mode? deadlock?).
- partial-message event shape (`--include-partial-messages`).
- spawn-arg taxonomy (claude-native vs fnc-only).

## Phase checklist
- [x] **Step 1 tag** — `checkpoint/renderer-bare-wiring` (pristine current ae50d47).
- [ ] **WF1 Understand** — parity-gap + slash-spike + permission-spike +
      spawn-args + streaming → `/tmp/renderer-parity/*.md`. [LAUNCHED]
- [ ] **Synthesize** — finalize parity + complete-plan design; update this file
      + design.renderer.md.
- [ ] **WF2 Implement parity** — spawn-ownership(args)+stderr-pipe, streaming,
      full event coverage, permissions, raw input. PRs + adversarial review.
- [ ] **Verify parity** — headless smoke + note Tom-visual.
- [ ] **Step 3 tag** — `checkpoint/renderer-claude-parity`.
- [ ] **WF3 Complete plan** — mountRenderer streams-injection, FNC_SOCKET/MCP
      threading, slash-tools via sendUserTurn, capability negotiation, error
      boundary, restart in/out. PRs + review.
- [ ] **Docs** — design.renderer.md (mark implemented), decisions.md, project
      CLAUDE.md (fix stale "live fnc = source" note + new conventions),
      document FNC_RENDERER.
- [ ] **Closeout** — commit ffnc alias (1a, dots), /getitdone, final report.

## Standing carried TODOs
- dots `dot_zsh_aliases`: commit ONLY the `ffnc` hunk (1a), leave Tom's `md()` WIP.
- project `CLAUDE.md` "step zero: live fnc = source" is STALE → fix in docs phase.
- bug #214 (env-isolation test) — optional; surface, don't auto-fix unless time.

---

## SYNTHESIS (post-WF1, 2026-06-18) — findings + execution plan

Findings live in `/tmp/renderer-parity/{parity-gap,slash-spike,permission-spike,spawn-args,streaming}.md`.

### Key resolved facts
- **STREAMING**: `--include-partial-messages` → additive top-level `stream_event`.
  claude emits BOTH per-block deltas AND a consolidated `assistant` event per
  block (assistant = TRUTH, deltas = preview). Design: transient "live block"
  keyed by (message.id, index), rendered below committed transcript with glow
  DISABLED, DROPPED when its `assistant` event lands (finalize-on-truth). Parser
  unchanged. Low risk.
- **SLASH (corrects prior)**: over `claude --print` stream-json only
  `/compact`,`/clear`,`/usage` honored; `/effort`,`/model`,`/help` return
  synthetic "isn't available" (TUI-only; absent from `system:init.slash_commands`).
  Rejection invisible on `is_error`. ⇒ step-4: `/compact` via sendUserTurn;
  `/effort`,`/model` out-of-band (spawn `--model`/`--effort`, respawn, or
  fnc_set_* MCP); pre-filter forwarded slashes vs the live registry.
- **PERMISSIONS**: no control_request/can_use_tool in `--print`; default mode
  AUTO-DENIES tools (unusable; doesn't hang). Denials → tool_result is_error +
  `result.permission_denials[]`. ⇒ step-4 renderer spawn sets `--permission-mode`
  EXPLICITLY (default `bypassPermissions`); add `permission_denials?` to ResultEvent.
- **SPAWN (Q1 opt c)**: fnc owns spawn; inject SpawnFn (claudeBin swap + childEnv
  + stderr PIPED) → mountRenderer → App → subscribeToClaude. Thread claude-native
  args (--model/--effort/--resume/--append-system-prompt/cwd/--permission-mode),
  KEEP self-MCP --mcp-config + FNC_SOCKET, STRIP --tmux + FNC_ARGS_JSON,
  initialPrompt as first sendUserTurn. Self-MCP inject is interactive-gated today
  → needs renderer-mode override.

### PINNED mountRenderer contract (renderer + cli both build to this)
```
mountRenderer(opts?: MountOptions, renderFn?): RendererHandle
MountOptions  = { cwd?: string; extraArgs?: string[]; spawnFn?: SpawnFn; initialPrompt?: string }
RendererHandle = { waitUntilExit(): Promise<void>; unmount(): void; sendUserTurn(text): void; close(): Promise<number> }
```
App gains `subscription?: ClaudeSubscription` (created by mountRenderer, not App);
gate inverts (subscription===undefined → static/test); close() owned by handle/fnc.
Backward-compat: `mountRenderer()` no-opts = today's bare session.

### Execution tracks (renderer pkg = serialization spine; cli ∥ renderer)
- [ ] **R — step 2 json streaming IO** [wt feat-renderer-json-streaming]: streaming
      + P0 duplicate-answer fix + wire SystemInit + system/status + rate_limit_event
      + UNKNOWN-event/tool fallback (dim raw — covers exotic types) + parser surface
      malformed. Renderer pkg. → merge → TAG checkpoint/renderer-claude-parity.
- [ ] **C — step 4 cli spawn-ownership** [wt feat-cli-renderer-spawn-ownership,
      PARALLEL w/ R]: fnc owns spawn per spawn-args.md vs pinned contract; tests
      mock mountRenderer; defensive (degrades if old mountRenderer). cli pkg.
- [ ] **R2 — faithfulness completeness** [after R]: styled renderers for
      image/document/redacted_thinking + top-level error + compact_boundary +
      result metadata (upgrade from raw). renderer pkg.
- [ ] **B1 — renderer mountRenderer refactor** [after R/R2]: §7 streams-injection
      to pinned contract + React error boundary + close-ownership. renderer pkg.
- [ ] **B3 — slash-tools combined mode** [after C+B1]: /compact via sendUserTurn;
      /effort,/model out-of-band; capability negotiation. cli pkg.
- [ ] **D — docs**: design.renderer.md (impl status), decisions.md, project
      CLAUDE.md (fix stale live-fnc note + FNC_RENDERER + --permission-mode),
      event-spec.md (stream_event). 
- [ ] **Closeout**: ffnc commit (1a), /getitdone.

### Progress log (overnight 2026-06-18)
- ✅ R #231 (renderer faithful streaming) MERGED. ✅ C #230 (cli spawn-ownership) MERGED → cli 2.12.0.
- ✅ TAGGED `checkpoint/renderer-claude-parity`. Old worktrees/branches cleaned.
- 🔄 B1 `feat-renderer-mount-refactor` LAUNCHED (mountRenderer owns subscription + handle + error boundary — makes #230 functional E2E). Monitor armed.
- NEXT after B1 merges: ff main → end-to-end verify (combined mode) → launch R2 (renderer completeness renderers) ∥ B3 (cli slash-tools combined: /compact via sendUserTurn, /effort,/model out-of-band, capability negotiation) → docs (design.renderer.md/decisions.md/CLAUDE.md/event-spec.md) → closeout (ffnc commit, live-fnc bump to latest, /getitdone).
