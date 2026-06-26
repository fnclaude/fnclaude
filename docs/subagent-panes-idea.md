# Subagent panes — design notes

> Related but distinct: [`multipane-orchestration-proposal.md`](multipane-orchestration-proposal.md) proposes a single-agent workspace TUI (Ink chrome + Neovim + transcript). This doc is the *multi-agent cockpit*; the two compose (that doc's region 5 could host the per-subagent panes proposed here).

Status: design in progress. Open questions at the end.

## Goal

When the main `claude` session would spawn a subagent, surface it in a sibling pane so the user can both **watch** it work and **steer** it mid-flight (add topics, redirect, cancel). Pane is a cockpit, not a viewer.

Visibility alone is half the win. The bigger half is that research-shaped subagents — Explore, general-purpose investigation — often need a mid-flight nudge ("also look at X", "ignore that, focus on Y") that native `Task` can't accept once dispatched.

## Architecture — replace `Task`, don't observe it

The built-in `Task` tool spawns subagents in-process inside the `claude` binary. There is no clean external surface to render or interact with them in real time. Rather than try to peek at in-process subagents via hooks + JSONL transcript tail, fnclaude **shadows** `Task`:

1. fnclaude injects an MCP server providing `fnc_spawn_subagent` (and companions).
2. fnclaude injects a system-prompt addendum and `settings.json` instructing main claude to use the MCP tool for subagent work.
3. The MCP tool launches a *real* `claude` session as a child process, displayed in a pane.
4. The launched session runs to a release point (autonomous done + grace window, or manual release), and its summarized result is returned to the parent.

Because subagents are now real interactive `claude` sessions, the pane is the session — perfect display fidelity, full interactivity, no rendering pipeline of our own.

### Routing rule (system prompt)

Main claude is instructed to route by *deliverable shape*, not subagent type:

> Use `Task` when the subagent's job is to produce a synthesized answer (read-only spelunking, advisory research, planning).
> Use `fnc_spawn_subagent` when the subagent should do work in an isolated workspace you'll inspect afterward.

This was an earlier carve-out for Explore-shaped tasks (read-only, prose-product). It was wrong: **the original requirement is visibility**, and routing Explore through native `Task` makes it invisible — exactly the case where mid-flight steering pays off most.

**Final routing: everything goes through `fnc_spawn_subagent`.** The result shape carries both prose and pointers; main claude uses whichever field is meaningful for the task it dispatched.

### Enforcement

- **Primary: system-prompt steerage.** Soft routing. If main claude misroutes, the worst case is the subagent runs natively without a pane — graceful degradation.
- **Backstop: permissions-deny via injected `settings.json`.** `permissions.deny: ["Task"]`. Held in reserve; not enabled by default. Flip on if misrouting becomes a practical problem.

### Nested subagents

The injected system prompt and settings.json cascade to spawned subagents via the spawn pipeline, so nested subagent calls follow the same routing rule. Pane growth is bounded by a configurable cap (see open questions).

## MCP tool surface

```
fnc_spawn_subagent(
    prompt:        string,
    system_prompt: string?,   # rendered by main claude from subagent-type semantics
    tools:         string[]?, # tools the subagent is allowed; default: inherit
    model:         string?,   # default: inherit
    isolation:     "worktree" | "none",
    background:    bool = false,
) → {
    session_id:   "uuid",
    summary:      "...",                # always populated; see Result contract
    report_path:  "/tmp/fnc/agent-<id>/report.md" | null,
    worktree:     "/path/..."            | null,
    branch:       "agent-abc"            | null,
    exit_status:  "completed" | "user_intervened" | "errored",
}

fnc_send_to_subagent(session_id, prompt)  → same result shape, after next release
fnc_subagent_status(session_id)           → { state, last_line, ... }
fnc_subagent_kill(session_id)             → terminates the session
```

The MCP tool is **lower-level than `Task`** — main claude renders subagent-type semantics (system prompt, tool subset, model) into args itself rather than us mirroring claude-code's built-in agent-type table. Lower coupling, no upstream-tracking debt.

## Result contract

### Shape

The MCP tool always returns the same blob. Main claude reads whichever fields are meaningful:

- **`summary`** — always populated. The subagent's compact deliverable.
- **`report_path`** — non-null only when the subagent wrote a full report file.
- **`worktree`** + **`branch`** — non-null only when `isolation: "worktree"` was requested.
- **`exit_status`** — `completed` / `user_intervened` / `errored`.

### File-backed reports, threshold-based

The doc `arch-setup/docs/token-economy-handoff.md` (2026-04-23 and 2026-05-02 post-mortems) identifies subagent full-fat reports as a 3–5k-token-per-subagent recurring tax on parent context. The remedy is file-backed reports: subagent writes full findings to disk, returns an abstract.

Applied **with a threshold** — don't impose ceremony on small answers:

> Subagent system prompt: If your findings fit in ~200 words, return them inline as your final assistant message — that's the result. If they'd exceed 200 words, write the full version to `{report_path}` and return a ≤200-word abstract.

- Tiny answer (10 words): `summary` is the answer; `report_path` is null.
- Verbose findings: `summary` is the abstract; `report_path` points to the file.

Parent's injected system prompt: "Lean on `summary` first. Only `Read` `report_path` if the abstract is insufficient AND it's non-null."

### No forced recap for work-producing spawns

For spawns with `isolation: "worktree"`, the parent embeds an instruction in the subagent prompt:

> Your worktree is the deliverable. Don't end with a prose recap of what you did — the diff is the record.

For research spawns, no such instruction. The synthesis *is* the deliverable, just routed through the size-threshold rule above.

### Result-shape symmetry

| Subagent shape | Primary pointer |
|---|---|
| Work-producing | `worktree` + `branch` |
| Research / Explore-like | `summary` (or `report_path` if verbose) |
| Either | `summary` always; everything else conditional |

## Release semantics

The MCP tool blocks until the subagent is **released**. Release is distinct from the subagent's own "I'm done" turn — Tom often wants to add topics mid-flight, so the subagent's done-claim is a *suggestion* the user can override by typing.

### Mechanism

- **Subagent emits its "done" final turn** → pane status flips to `[releasing in Ns]` with a grace window (configurable; default `10s`).
- **User keystroke in the grace window** → release is cancelled; subagent stays alive for the next prompt.
- **Grace elapses with no input** → MCP tool returns current state as the result.
- **`/release` in the pane, or pane close** → immediate release regardless of state.
- **`/cancel` in the pane** → release with `exit_status: "user_intervened"` so the parent knows the conversation didn't end naturally.

### Status surface

The pane title carries the release state: `agent-abc [running]` / `[releasing in 8s]` / `[idle]`. Visible at a glance which subagents are about to drop off and which are still chewing.

### Config

```toml
[subagent]
release_grace_seconds = 10   # 0 = auto-release immediately on "done"
                             # negative = never auto-release (always manual)
```

## User-facing config

```toml
# ~/.config/fnclaude/config.toml
[subagent]
mode      = "hidden"   # window | pane | hidden    (default: hidden — opt-in)
backend   = "auto"     # tmux | ghostty | kitty | wezterm | wt | shell | auto
release_grace_seconds = 10
max_panes = 4          # cap on simultaneous subagent panes; see open questions
```

`mode = hidden` keeps current behavior; opt-in until proven.

### Backend auto-detect

```
$TMUX                                  → tmux
$TERM_PROGRAM == ghostty / $GHOSTTY_…  → ghostty
$KITTY_WINDOW_ID                       → kitty
$TERM_PROGRAM == WezTerm               → wezterm
$WT_SESSION (Windows Terminal)         → wt
else                                   → shell
```

`mode = pane` degrades to `mode = window` when backend is `shell` — can't split a generic emulator from the outside.

## Cross-platform notes

The pane-open layer is where the cross-platform tax sits. File-watching (the old design's pain point) is no longer in the picture: we own the spawn, we don't need to detect it externally.

- **Linux** — tmux / ghostty / kitty / wezterm / `$TERMINAL` / xdg-terminal-emulator
- **macOS** — tmux / ghostty / kitty / wezterm / `open -a Terminal`
- **Windows** — Windows Terminal `wt.exe -w 0 sp` for split, `wt.exe -w -1` for new window; ConPTY for the underlying session

Cross-platform parity is baseline, not a footnote (see `feedback_cross_platform_baseline.md`).

## Implementation slicing (parallel dispatch)

Three slices, same shape as v5.0.0's dispatch:

- **A. MCP server + spawn pipeline** — `fnc_spawn_subagent` and companions, child-process management, system-prompt / settings.json injection, result extraction (tail subagent's JSONL for final state).
- **B. Pane backends** — tmux + ghostty + kitty + wezterm + wt + shell. `auto` resolver. `pane → window` degradation when backend is `shell`. `max_panes` enforcement.
- **C. Release machinery + status surface** — grace window timer, `/release` / `/cancel` in-pane commands, pane title status updates, multi-turn `fnc_send_to_subagent`.

Pre-dispatch contract (must lock before fan-out): the MCP tool signature + result shape (A↔parent), the pane-open args (A↔B), the release state machine (A↔C).

Sonnet candidates: A and C (mechanical-ish). Opus candidate: B (Windows path has design judgment in it).

## Open questions

1. **`max_panes` policy when exceeded.** Tile up to N, then queue? Tile up to N, then overflow into the last pane as tabs? Reject the spawn? Default `4` is a starting guess.
2. **Background subagents (`background: true`).** Force `mode = hidden` regardless of config? Or show pane but don't block parent? Probably the first — visibility-without-blocking is conceptually closer to `Task`'s background mode.
3. **Nested-subagent pane explosion.** Three levels deep × max-panes = unbounded. Should nested spawns share parent's pane, or get their own? Likely "their own up to `max_panes`, then queue."
4. **Cost / billing.** Spawned `claude` sessions are separate billed instances vs in-process Task subagents in the parent's session. Worth understanding before defaulting `mode` to anything other than `hidden`.
5. **First-release scope.** Does v5.1 ship only `tmux` + `shell` backends, with ghostty/kitty/wezterm/wt as follow-ups? Or all six day one? `tmux` is the highest-leverage single backend.

---

## UI idea — focus + detail layout (captured, not yet reconciled)

**Status: captured for later; how this composes with subagent panes is an open question.**

### Layout

- **Left two-thirds**: main claude session transcript, similar in appearance to the native CLI.
- **Right one-third**: split horizontally into two stacked boxes.
  - **Top right**: input of the selected tool usage.
  - **Bottom right**: output of the selected tool usage.

### Interaction

- A focus indicator lives in the transcript on the left side.
- Keybind (e.g. `Ctrl-Up` / `Ctrl-Down`) moves the indicator between tool-usage events.
- Selecting a tool usage (e.g. a `Bash` call) populates the right-side boxes with that call's input and output.

### Why it's useful

The main transcript stays clean — verbosity rules hide bash outputs, large diffs, etc. — but any individual tool call can be inspected without scrolling. Right-side detail pane is the inspector; left-side transcript is the navigable index. Toggle-and-repaint hides content in the transcript; this layout exposes it on demand without unhiding everything globally.

### Open question

How this coexists with subagent panes (also right-side, also detail-shaped) is unresolved. Possible directions: tab the detail pane between "selected-tool inspector" and "subagent panes"; or move subagent panes to a separate workspace / layout; or have the focus model encompass both. Not solving now — capturing the idea.

## Provenance

- Original design instinct (PreToolUse hook + JSONL tail) abandoned in favor of MCP-replacement after Tom proposed it directly. The MCP path is simpler, perfectly faithful to the "watch it work" requirement, and uniquely enables mid-flight steering.
- File-backed-report threshold rule sourced from `arch-setup/docs/token-economy-handoff.md`. That doc's #1 recommendation in its 2026-05-02 post-mortem was "write a memory pointer so the lessons surface at session start" — should write that memory before this design lands.
