# fnclaude — in-session features

Everything users experience while inside a fnclaude-launched claude session. You ask claude to do these things; claude coordinates with fnclaude behind the scenes.

---

## Project switching

In any session launched by fnclaude, you can ask claude to switch you to a different project:

> "Switch me to ~/src/other-proj and work on the login bug."

Claude handles the transfer: it decides what context from the current conversation is relevant to the destination project — what you asked for, decisions made, files touched, work in flight, open questions — and compresses that into a focused summary. It ends the current session and opens a fresh one in the new project, pre-loaded with that summary as starting context. Your cursor appears in the new session, already in context. Irrelevant parts of the current conversation are left behind; claude makes the call about what to carry.

Model and permission settings from your current session carry over automatically. Override them in the same request if you want something different:

> "Switch me to ~/src/other-proj with opus and no permission prompts."

Project switching is always available in any fnclaude-launched session, regardless of your `auto.handoff` config setting. That setting controls only the noop router's behavior (described below).

---

## Noop session routing

When you launch `fnclaude` with no directory, claude acts as a smart router. Ask a general question and it answers directly. Describe project work and it figures out which project you mean and proposes switching you there.

How the switch happens depends on your `auto.handoff` config setting:

- **`ask`** (default): claude asks "Want me to switch you over now?" before doing anything. Say yes and you're there; say no and it puts the command on your clipboard instead.
- **`never`**: claude renders the switch command and puts it on your clipboard. You run it yourself.
- **`5`** (a number): claude announces it's switching in 5 seconds and does it automatically. Press Ctrl-C during the countdown to cancel (you'll get the command on your clipboard instead). Use `0` for an instant switch with no countdown.

Whichever mode is active, the summary of your original request travels to the new session as context, loaded automatically when the new session opens.

To personalize the no-op session — add standing instructions, preferred project aliases, notes about your workflow — drop a `CLAUDE.md` file in `~/.config/fnclaude/noop/`. Claude loads it as project context every time you open the no-op session. fnclaude never touches that file.

---

## Restarting the current session

Ask claude to restart the session when you want to reset the conversation without losing your startup configuration:

> "Restart this session."

Claude ends the current session and reopens it in the same directory with the same model, flags, and permissions. The session ID travels with it so `--resume` points at the right conversation. All context is preserved by default — the restart picks up exactly where it left off; if you want a clean slate, say so explicitly and claude will restart without resuming.

If you changed your permission mode during the session (via a `/permission-mode` slash command inside claude), the restart picks up the current mode automatically, not the one you launched with.

---

## Spawning a sibling session

Ask claude to open work in a new window while keeping your current session running:

> "Open a new window for ~/src/other-proj and start working on the API refactor."

Claude makes a judgment call about what context to carry to the sibling — same selective-summarize logic as project switching, but scoped to what the sibling needs to do its job cold. The current session keeps running; nothing is interrupted.

For this to work automatically, fnclaude needs to know how to open a new window. It detects tmux automatically. For other terminals, set a template in your config:

```toml
[auto]
spawn_command = "kitty @ launch --type=os-window {bin} {dest} --name {name} @{summary}"
```

If no window launcher is configured or detected, claude puts the spawn command on your clipboard and you run it yourself in a new window.

---

## Clipboard handoff

In sessions where the primary handoff tools — project switching and spawning — are disabled by config or unavailable in your terminal, claude can copy the relaunch command to your clipboard as a fallback:

> "Copy this JSON snippet to my clipboard."

Claude writes directly to the clipboard — no confirmation prompt. On Linux, this works with both Wayland (`wl-copy`) and X11 (`xclip` or `xsel`); on macOS via `pbcopy`; on Windows via `clip`. On headless Linux with no display server, the copy fails gracefully and claude lets you know.

---

## System prompts — preserved verbatim

fnclaude injects five carefully-crafted system prompt fragments into each session that govern how claude handles the above features. These fragments are canonical artifacts:

- `agent-pitfall.md` — guards against a known pitfall with agent/worktree isolation
- `noop-router.md` — the router behavior for no-op sessions
- `project-switch.md` — how claude executes a project switch
- `spawn.md` — how claude handles spawning a sibling session
- `restart.md` — how claude handles session restart

The rewrite must preserve these fragments verbatim. They encode specific UX contracts — trigger phrases, confirmation flows, paste-flow handling — that users depend on. Do not paraphrase, regenerate, or summarize them.
