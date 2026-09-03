# Teammate execution modes and peer messaging

How Claude Code decides *where* a spawned teammate runs, which of those choices
puts teammate output into the parent's transcript, and the settings governing
`SendMessage` between peer sessions.

Written against **v2.1.240–2.1.241** (2026-08). Anchored on settings keys and
schema description strings, which are public contract; no minified names.

---

## `teammateMode`

A `settings.json` key. Its schema description in the binary:

> How spawned teammates execute (tmux, iterm2, in-process, auto)

Four values:

| Value | Where teammates run | Output in parent transcript? |
|---|---|---|
| `tmux` | tmux panes / sessions | no |
| `iterm2` | iTerm2 panes | no |
| `in-process` | inside the parent session | **yes** — inline |
| `auto` | resolved by environment | depends on what it resolves to |

**`in-process` is the only mode that renders teammate output inline in the
parent's conversation.** With `auto`, that outcome is environment-dependent:
inside a tmux session `auto` has tmux available; on iTerm2 it has iTerm2;
launched from a terminal that is neither — e.g. Ghostty with no tmux server —
`auto` has nothing left to fall back to but `in-process`.

Practical consequence: the *same* `auto` setting produces silent teammates in a
tmux-launched session and inline teammate output in a bare-terminal session.
Config didn't change; the launch environment did.

### `tmux` does not require an existing session

Two pieces of evidence that `tmux` mode creates its own tmux sessions rather
than requiring the user to already be inside one:

- `new-session` occurs 25 times in the binary against 7 for `split-window` and
  4 for `new-window`.
- The tmux failure path is about tmux being **absent from the system**, not
  about the caller being outside a session. The strings are per-platform
  install instructions: `Install tmux with: brew install tmux`,
  `Install tmux with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL)`,
  `tmux is not natively available on Windows. Consider using WSL or Cygwin.`

No string matching "not inside a tmux session" or "requires tmux" exists.

Related telemetry event: `tengu_teammate_mode_changed`.

---

## How delivered messages appear

A message a teammate explicitly sends to the session it reports to arrives as
an `<agent-message from="<name>">` block. In the receiving session's JSONL,
these land as records of type `queue-operation` and `attachment` — not as
ordinary assistant or user turns.

In practice the bulk of this traffic is **agents' final completion reports**
(the "DONE — …", "FILES CHANGED", path-listing shape), which is substantial
content rather than chatter. A single working session was observed carrying 27
such records.

**Unconfirmed:** these appear to render inline in 2.1.241 where 2.1.240 folded
them away. Observed as a behavior change across an auto-update on 2026-08-24;
not traced to a specific gate, and no `showAgentMessages` / `hideAgentMessages`
key exists in the binary. Treat as a lead, not a finding.

Note that `teammateMode` does **not** govern this. It controls where teammates
*execute*; an explicitly-sent message is delivered into the recipient's
conversation regardless of execution mode.

---

## Adjacent peer-messaging settings

Two more `settings.json` keys, with their schema descriptions:

**`isolatePeerMachines`**

> Require explicit approval before SendMessage can reach a peer session on
> another machine via Remote Control

Cross-*machine* only. Same-machine cross-session messaging is unaffected by it.

**`remoteControlAtStartup`**

> Start Remote Control bridge automatically each session

Cross-references [`claude-remote-control.md`](claude-remote-control.md) for the
bridge's transport and auth.

---

## Reusable string seeds

| Seed | Leads to |
|---|---|
| `How spawned teammates execute (tmux` | the `teammateMode` schema description; the vocabulary lives beside it |
| `teammateMode` | the config key, its snapshot capture, and the telemetry event |
| `tengu_teammate_mode_changed` | mode-change telemetry |
| `Install tmux with:` | the tmux-absent failure path and its platform branches |
| `isolatePeerMachines` / `remoteControlAtStartup` | peer-messaging + RC bridge settings, adjacent in the config key list |
| `agent-message` | delivered-message envelope |
