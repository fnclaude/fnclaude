# How Claude Code renders and steers the subagent UI

A reverse-engineering reference for the subagent list, transcript view, steering delivery, agent teams, and workflow progress tree. Written against **v2.1.149** of the Bun-compiled ELF at `~/.local/share/mise/installs/npm-anthropic-ai-claude-code/2.1.149/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`; official-docs and GitHub-issue findings reflect behavior through ~v2.1.186.

> Minified symbol names (`QJ8`, `B$4`, `WX5`, `AO`, `SM`, …) are build-specific. Byte offsets likewise. **Anchor on string literals, not names.** See the sibling doc [`claude-code-binary-internals.md`](claude-code-binary-internals.md) for the `grep -aboF` + `dd`-window grep technique — this doc cites offsets but does not restate the method.

## Why this exists

fnclaude wraps the `claude` CLI and wants to surface a subagent cockpit: a list of running agents with their activity, a way to view transcripts, and a way to steer. Before building that, we need to know exactly how Claude Code's native version works — what state it projects, where the delivery seam actually is, and what the timing constraints are. This is that reference.

Cross-references (do not duplicate):

- [`docs/subagent-panes-idea.md`](../subagent-panes-idea.md) — the MCP-shadow per-subagent-pane cockpit design. This doc is the **evidence base** for its core premise: native in-process subagents expose no external steering seam, which is precisely why that doc replaces `Task` with an MCP tool.
- [`docs/multipane-orchestration-proposal.md`](../multipane-orchestration-proposal.md) — the tmux-hosted single-agent workspace layout. Region 5 (transcript pane) is the natural host for a recreated agent-panel or transcript view.

---

## The four surfaces (disambiguate first — they get conflated)

| # | Surface | How to reach it | What it shows |
|---|---|---|---|
| 1 | **Subagents panel** | `/agents` inside a session | Running + Library tabs; Task-tool subagents for the current session |
| 2 | **Agent view** | `claude agents` CLI command | Full-screen background-session dispatcher; richest row model |
| 3 | **Agent panel** | Bottom of the prompt input when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | Selectable list of running teammates; arrow+Enter to open transcript; type to steer. **This is the surface matching the "bottom-of-window list" description.** |
| 4 | **Dynamic workflows** | `/workflows` progress tree; triggered by the `ultrawork` keyword | Phase-grouped multi-agent tree with per-phase rollup; the "fancier" display |

---

## (a) The agent panel — bottom-of-window running-agent list

**Confidence: high — bundle-grep + official docs**

Official name: **"agent panel"**. Rendered below the prompt input in "in-process" display mode when agent teams are active. Reference: `code.claude.com/docs/en/agent-teams`.

### App-state projection

The list is a pure projection of an Ink app-state `tasks` map. Rendered only when the panel is expanded AND `hasRunningTeammates`.

Bundle internals (v2.1.149):

- **List container component:** minified `QJ8` (~byte 230,053,350). Props: `{selectedIndex, isInSelectionMode, allIdle, leaderVerb, leaderIdleText, leaderTokenCount}`. Renders a `team-lead` header row then `tasks.map(...)` of per-teammate rows.
- **Per-teammate row component:** minified `B$4` (~byte 230,050,152).
- **Tree glyphs:** `┌─` / `├─` / `└─` for standard rows; `╒═` / `╞═` / `╘═` for the selected/foregrounded row. Selection cursor from a `pointer` glyph.

### Per-row teammate object shape

Verbatim from bundle — this is the state model to mirror:

```
{
  id,
  identity: { agentName, color },
  spinnerVerb,
  pastTenseVerb,
  isIdle,
  startTime,
  totalPausedMs,
  shutdownRequested,
  awaitingPlanApproval,
  progress: {
    toolUseCount,
    tokenCount,
    recentActivities[],
    lastActivity: { activityDescription }
  },
  messages[]
}
```

What a row renders: cursor · tree glyph · `@agentName` (in `identity.color`) · live activity text (from `progress.recentActivities` / `lastActivity.activityDescription`, else `spinnerVerb`) · `· N tool uses · M tokens` · elapsed/frozen duration · `⟨enter⟩ to view` chord hint when selected but not foregrounded.

Status sub-renderer mapping:

| Condition | Displayed text |
|---|---|
| `shutdownRequested` | `[stopping]` |
| `awaitingPlanApproval` | `…` (waiting indicator) |
| `isIdle && elapsed < threshold` | `Idle` |
| `isIdle && elapsed >= threshold` | `Worked for <duration>` |

**Idle auto-hide (v2.1.181+):** an idle teammate's row auto-hides after 30 s and reappears on its next turn. The teammate stays running and addressable while hidden.

### Keybindings (official docs)

| Key | Action |
|---|---|
| Up / Down | Select a teammate |
| Enter | Open the teammate's transcript + enable messaging |
| Esc | Interrupt the selected teammate's current turn |
| `x` | Stop the selected teammate |
| Ctrl+T | Toggle the shared task-list panel |

### Agent view row model — richer reference

The `claude agents` full-screen dispatcher (`code.claude.com/docs/en/agent-view`) uses a richer row model that is a good design target for a fnclaude recreation:

**Groups:** Pinned / Ready-for-review / Needs-input / Working / Completed.

**Row fields:** state icon · name · one-line activity summary · "last changed N m/h ago" · optional `PR #N`.

**Icon encoding** (two independent axes):

| Axis | Values |
|---|---|
| **Color encodes state** | Working=animated, Needs-input=yellow, Idle=dimmed, Completed=green, Failed=red, Stopped=grey |
| **Shape encodes process liveness** | `✻`/animated `✽` = alive; `∙` = exited but resumable; `✢` = `/loop` sleeping with countdown |

**One-line summary:** generated by a Haiku-class model, refreshed at most once per 15 s and once per turn-end. A `done/total` count (e.g. `2/5`) prefixes it when parallel work items are in flight (v2.1.161+).

**Keybindings** (agent view):

| Key | Action |
|---|---|
| ↑ / ↓ | Move selection |
| Space | Peek panel (recent output / blocked question; reply inline) |
| Enter / → | Attach |
| ← | Detach |
| Ctrl+T | Pin |
| Ctrl+X | Stop (×2 to delete) |
| Ctrl+S | Regroup by directory |

`claude agents --json` emits structured rows with `state` (`working` / `blocked` / `done` / `failed` / `stopped`) and `waitingFor` — a clean data-model reference for any external integration.

---

## (b) Viewing a subagent transcript ("foregrounding")

**Confidence: high — bundle-grep**

### Selection state

App-state has a tri-state `viewSelectionMode`:

| Value | Meaning |
|---|---|
| `"none"` | Normal operation; no agent selected |
| `"selecting-agent"` | Cursor is on the agent panel; not yet foregrounded |
| `"viewing-agent"` | A specific agent's transcript is open |

Relevant state keys: `viewingAgentTaskId`, `viewSelectionMode`, `selectedIPAgentIndex`, `showTeammateMessagePreview`.

> **Open gap:** the exact keybinding that enters `"selecting-agent"` mode is not confirmed in the v2.1.149 bundle. Official docs document select→view once already selecting; the keybind that first activates selection mode was not found. Flag this for anyone reimplementing — it may be document-only or gated behind another UI state.

### Enter — `iv(taskId, setState)` (~byte 233,069,700)

Sets `viewingAgentTaskId`, transitions `viewSelectionMode` → `"viewing-agent"`, and flips the task `retain: true, evictAfter: undefined` so the transcript is not evicted while being viewed. Emits telemetry `tengu_transcript_view_enter`.

### Exit — `rv(setState)` 

Clears `viewingAgentTaskId`, transitions `viewSelectionMode` → `"none"`, re-arms eviction. Emits `tengu_transcript_view_exit`.

Guard hook `uK9` (~byte 234,862,343) auto-exits if the viewed task vanishes or its status reaches `killed` / `failed` / `errored`.

### Transcript persistence

Transcripts are **persisted to disk and lazily loaded** (tracked by a `diskLoaded` flag on the task). The full child-session history is recoverable for the view, not just the in-memory tail. Child/subagent messages carry **`isSidechain: true`**, used to separate sub-agent streams from the main thread in transcript filtering.

---

## (c) Steering / message-injection delivery timing — the crux

**Confidence: high — bundle-grep + official issues**

This is the "never consumed until too late" mechanism. The timing is precise and the consequences are significant for any reimplementation.

### The command queue

One **global module-level priority command queue**. Factory `WX5` (~byte 225,873,498) builds a singleton exposed as **`AO`**, with bound free functions:

- **`SM`** — enqueue a command
- **`mA`** — enqueue a pending notification

A command object shape: `{ mode, value, priority?, agentId?, uuid?, isMeta? }`. Default priority: `"next"`.

Priority values and `getCommandsByMaxPriority("next")` behavior:

| Priority | Integer rank | Included by `getCommandsByMaxPriority("next")` |
|---|---|---|
| `"now"` | 0 | Yes |
| `"next"` | 1 | Yes |
| `"later"` | 2 | **No** |

### The single drain point

~Byte 231,766,102, inside the main agentic-loop generator. Runs **once per loop iteration**, after the assistant message has fully streamed AND all tool calls in that turn have executed (`query_tool_execution_end`) AND PostToolBatch hooks have run.

Targeting: the main thread consumes commands where `agentId === undefined`; a subagent consumes only `mode === "task-notification" && agentId === <self>`. Drained commands are turned into user messages, appended to the message array for the **next** model call, then removed from the queue (`command_lifecycle: started`).

### Timing consequences — read carefully

| Scenario | What happens to a queued steer |
|---|---|
| Steer typed during a streaming assistant message | Queued, not read until the stream completes AND all tool calls in that turn finish |
| Steer typed during a long tool call (e.g. a slow `bash`) | Queued, not read until that tool call returns — one slow tool call wedges steering indefinitely |
| Turn produces **no tool calls** (model responds with text only) | The in-loop drain is inside the tool-handling branch and is **skipped**; the steer waits for the OUTER repl loop to pick it up as the next prompt |
| Command enqueued with `priority: "later"` | Never taken by the in-turn drain; only eligible after the current turn fully completes and the outer loop restarts |
| Command enqueued with `priority: "now"` | Still only consumed at the next tool-batch boundary — does **not** preempt the current turn. The only mid-stream levers are enqueue-as-now (marginal gain) or hard abort |

**Hard abort (Esc):** triggers `abortController` with `reason: "interrupt"`. This cancels the current turn rather than injecting into it — destructive, not additive.

There is **no mid-stream injection seam**. This is the documented design, not a defect.

### Producer call sites

All via `SM({ mode, value, priority })`:

| Producer | mode | priority |
|---|---|---|
| Teammate → teammate `SendMessage` | `"prompt"` | `"next"` (default) |
| Background-review reply | `"prompt"` | `"next"` |
| MCP-channel prompt | `"prompt"` | `"next"` (`isMeta: true, origin: { kind: "channel" }`) |
| `/loop` default fire | `"prompt"` | `"later"` (`isMeta: true`) |
| Slash command | `"prompt"` | `"next"` |

### Corroborating official issues

These confirm the timing behavior is observable and user-reported, not just inferred from the bundle:

- **`anthropics/claude-code#64624`** — "messages are queued, not injected"; Esc is the only non-queue option and it is destructive.
- **`anthropics/claude-code#30492`** — messages "remain queued through the entire execution turn," delivered at the next turn boundary "by which point Claude may have completed significant work in the wrong direction."
- **`zed-industries/zed#57761`** — a long-running tool call stalls the queued message until it returns; a single slow tool call wedges steering indefinitely.
- **`anthropics/claude-code#61718`** — "Cowork queue": message IS dequeued ~13 s after the turn, but **no follow-up assistant turn spawns** to process it. The "should I start turn 2 after dequeue?" decision is a separate, fragile orchestrator state; hypothesized `rate_limit_event` race. The dequeue-without-follow-up failure mode is a distinct hazard from the delivery-timing one.
- **`anthropics/claude-code#49373`**, **`#50246`** — community-requested fix: deliver at tool-call boundaries (what PostToolUse hooks already get). Not yet implemented.

### Separate task-notification channel

A per-session ring buffer `PX6` (capacity 1000) pushes `{ type: "system", subtype: "task_notification", task_id, tool_use_id, status, output_file, summary, usage }`. This is the channel that produces the `<task-notification>` system-reminder blocks in the context. The drain filters for `mode: "task-notification"` addressed to the receiving agent.

---

## (c-teams) Agent teams — routing and communication

**Confidence: high mechanism / med routing — bundle-grep + docs**

### Delivery timing

A teammate's `SendMessage` content is delivered by enqueuing `{ mode: "prompt", value: <content> }` onto the **same global queue** described in §c. Consumed at the recipient's next tool-batch boundary — identical timing to external steering. Shutdown is likewise a queued prompt. This corroborates fnclaude's existing memory note: `SendMessage` delivers at the next turn boundary, not on completion.

### Message types (official docs)

| Type | Direction | Notes |
|---|---|---|
| `message` | peer → peer | Direct delivery to a named agent |
| `broadcast` | one → all | The only all-targeting mechanism |
| `shutdown_request` | any | Queued, arrives at next tool-batch boundary |
| `shutdown_response` | recipient | Acknowledgment |
| `plan_approval_response` | orchestrator | Responds to `awaitingPlanApproval` state |

Coordination tools (`SendMessage`, task tools) are always available to a teammate even if its `tools` allowlist restricts everything else.

Communication backbone: a **Mailbox** component (official docs term).

### Display modes

| Mode | When used | Notes |
|---|---|---|
| `"in-process"` | Default | The agent-panel UI rendered inside the session |
| `"split-panes"` | tmux or iTerm2 with `it2` | Each teammate gets its own pane |
| `"auto"` | | Picks split-panes inside tmux/iTerm2; falls back to in-process |

Split-panes is unsupported in VS Code integrated terminal, Windows Terminal, and Ghostty. Configured via `teammateMode` or the `--teammate-mode` flag.

---

## (d) Workflows / `ultrawork` — the fancier progress tree

**Confidence: high on feature / med on renderer internals — bundle-grep + official docs**

### Naming note — important

The user's description said "ultracode"; the v2.1.149 bundle keyword is **`ultrawork`** (also `ultraplan` / `ultrareview` for cloud-only flows). "ultracode" is the name the **fnclaude harness** uses for the same Workflow-tool fan-out — these are the same underlying mechanism. Anthropic's own docs describe it under "dynamic workflows"; before v2.1.160 the keyword was `workflow`.

### How it triggers

The keyword `ultrawork` injects `{ type: "ultrawork_request" }` plus an immediate status event (`ultrawork-active`, "Multi-agent workflow requested for this turn"), with prompt text instructing the model to use the first-class **Workflow tool**. The Workflow tool then orchestrates a JavaScript orchestration script.

Telemetry confirms a phased model: `workflow_agent`, `workflow_phase`, `tengu_workflow_completed`, `tengu_workflow_phase_completed`, `workflow_log`. Agent row states: `running` / `completed` / `skipped by user` / `error`.

The progress tree reuses the same teammate-row primitives (`QJ8` / `B$4`) driven by `tasks`, grouped by `workflow_phase`.

### What a workflow is (official docs)

A workflow is a JavaScript orchestration script Claude writes. A runtime executes it in the background, isolated from the conversation, while the session stays responsive. **Intermediate results live in script variables, not the model context** — only the final answer returns. That out-of-context result store is the structural difference vs agent teams.

Reference workflow: `/deep-research`.

### `/workflows` progress view keybindings

| Key | Action |
|---|---|
| ↑ / ↓ | Select run or phase |
| Enter / → | Drill in (phase → agent → detail) |
| Esc | Go back |
| j / k | Scroll detail |
| `f` | Filter by status (v2.1.186+) |
| `p` | Pause / resume |
| `x` | Stop agent or run |
| `r` | Restart a running agent |
| `s` | Save run's script as a `/command` |

The view shows each phase with its **agent count, token total, and elapsed time** — the per-phase rollup the flat agent panel lacks. Drill phase → agent to read that agent's prompt, recent tool calls, and result (two-level drill-down). A one-line summary also appears in the task panel below the input.

### Limits

- ≤16 concurrent agents (fewer on low-CPU hosts)
- 1000 agents per run total
- **No mid-run user steering** — only permission prompts can pause. Workflows deliberately have no steering channel; re-run stages instead of steering.
- Subagents in a workflow run with `acceptEdits`.
- Resumable within the same session (completed agents return cached results); a fresh CLI session restarts from scratch.

`ultraplan` / `ultrareview` are remote/cloud multi-agent flows whose results stream back via the task-notification channel (§c) rather than a live local tree.

---

## On-disk state layout

**Confidence: high — official docs**

### Agent teams

| Path | Contents |
|---|---|
| `~/.claude/teams/{team-name}/config.json` | `members[]`: name / agentId / agentType + session IDs + tmux pane IDs (removed on exit; runtime-only state) |
| `~/.claude/tasks/{team-name}/` | Task list (persists, never uploaded) |

`team-name` = `"session-"` + first 8 characters of the session ID.

Conceptual components: Team lead / Teammates / Task list / Mailbox.

### Workflows

Workflow scripts live in the session directory under `~/.claude/projects/`. Claude receives the path at launch — askable, diffable, editable, and relaunchable.

### Agent view (background sessions)

| Path | Contents |
|---|---|
| `~/.claude/jobs/<id>/state.json` | Per-session state |
| `~/.claude/daemon/roster.json` | Supervisor's agent roster |
| `~/.claude/daemon.log` | Supervisor log |
| `$CLAUDE_JOB_DIR=~/.claude/jobs/<id>/tmp/` | Per-session scratch space |

Background sessions run under a per-user supervisor process that keeps a pre-warmed worker, survives terminal close, and watches the on-disk binary — restarting automatically into new versions.

Transcripts are local and resumable via `claude --resume` / `claude attach`. (Transcript format is widely assumed to be JSONL per-turn — **med confidence**; official confirmation not obtained this pass.)

---

## Rendering pipeline

**Confidence: med — community reverse-engineering, NOT Anthropic-confirmed. Build-independent codenames.**

React + Ink, custom React host via `createReconciler`, Yoga flexbox layout, output-builder → screen-buffer → diff-engine → ANSI pipeline.

Community codenames (from BrightCoding / xugj520 / PromptLayer RE writeups — mark as community-RE, not Anthropic-confirmed):

| Codename | Role |
|---|---|
| `nO` | Main agent loop — single-threaded async-generator master loop |
| `h2A` | Async input queue — dual-buffer RingBuffer between keyboard and agent loop. Reportedly supports pause/resume + mid-stream injection at the plumbing level; the gap is that interactive user messages are not wired into that path, consistent with §c's findings |
| `I2A` | Subagent runner — privilege-isolated; returns final result as a `tool_result` to the parent context |

The `h2A` plumbing gap is notable: the infrastructure would support mid-stream delivery, but the interactive steering path does not use it. The official issues in §c are a direct consequence of this wiring choice.

---

## Recreating this in fnclaude — load-bearing takeaways

**1. The "consumed too late" behavior is the documented design.**
One global priority queue, drained once per turn after the full tool batch + post-tool hooks. Nothing at all if the turn is wedged in a long tool call. To beat it, fnclaude would need an additional mid-stream injection seam that Claude Code deliberately does not have. Its only mid-stream lever is hard abort. If pursuing mid-stream injection, treat the "spawn a follow-up turn after dequeue" decision as an explicit, testable orchestrator state — `#61718` is the cautionary tale for what happens when that decision is fragile.

**2. Subagent UI = projection of a `tasks` map.**
Rows expose `progress.{ toolUseCount, tokenCount, recentActivities }` + spinner verb + elapsed duration. View selection is tri-state (`none` → `selecting-agent` → `viewing-agent`); Enter foregrounds via `viewingAgentTaskId` and loads the disk-persisted transcript. Mirror agent view's **color=state / shape=process-liveness** icon split and the **Haiku-generated one-liner** for the richest possible row.

**3. Targeting is by `agentId`.**
Main thread consumes `agentId === undefined`; a subagent consumes `mode: "task-notification" && agentId === <self>`. This is the addressing model to replicate in any external queue.

**4. The "fancier tree" = phase-grouped rollup.**
Agent count + token total + elapsed per phase, with phase → agent → detail drill-down, fed by a runtime that holds results **outside the model context**. Structurally different from agent-teams, which keep results in the conversation.

**5. Relation to fnclaude's existing designs.**
`subagent-panes-idea.md` proposes MCP-shadowing of `Task` precisely because this doc establishes that native in-process subagents expose no external steering seam. The `"consumed too late"` findings are the concrete evidence for that no-external-seam premise. `multipane-orchestration-proposal.md`'s region 5 (transcript pane) is the natural host for a recreated agent-panel list and the transcript viewer it drills into.

---

## Sources

| Source | Confidence | Notes |
|---|---|---|
| Direct bundle grep: v2.1.149 ELF | High | Symbols `WX5`/`AO`/`SM`/`QJ8`/`B$4`/`iv`/`rv`/`uK9`/`PX6`; offsets listed inline; all version-specific |
| `code.claude.com/docs/en/agents` | High | Subagents panel |
| `code.claude.com/docs/en/agent-view` | High | Agent view (`claude agents`) |
| `code.claude.com/docs/en/agent-teams` | High | Agent panel + teams |
| `code.claude.com/docs/en/workflows` | High | Workflows / `ultrawork` |
| `code.claude.com/docs/en/sub-agents` | High | General subagent model |
| `anthropics/claude-code#64624` | High | Queue-not-inject confirmation |
| `anthropics/claude-code#30492` | High | "entire execution turn" delivery timing |
| `anthropics/claude-code#61718` | High | Dequeue-without-follow-up race |
| `zed-industries/zed#57761` | High | Single slow tool call wedges queue |
| `anthropics/claude-code#49373`, `#50246` | Med | Community-requested tool-boundary delivery (not yet shipped) |
| BrightCoding, xugj520.cn, blog.promptlayer.com | Med/Low | Community RE of rendering pipeline; not Anthropic-confirmed |
