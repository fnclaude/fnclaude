---
title: The noop landing zone
description: What happens when you run fnc with no argument, and why the noop directory routes instead of working.
---

Run `fnc` with no repository argument and it launches in the **noop** directory:
`$XDG_CONFIG_HOME/fnclaude/noop/`, typically `~/.config/fnclaude/noop/`. fnclaude
seeds the directory on first launch and it holds no project state.

The point is that you often know what you want before you know where it belongs.
Instead of guessing a repository and being wrong, you start nowhere and let the
session route you.

## It is a router, not a workspace

The noop session runs with a router prompt in its system prompt, served from a
read-only file that ships alongside the installed binary. That prompt classifies
every request you make into one of three shapes:

- **General.** Conceptual or how-to questions with no specific repository in scope.
  Answered on the spot, no project tool calls.
- **Read-shaped.** Answering it well needs reading code or files in a specific
  repository. Answered here too, with reads kept tight.
- **Action.** It needs to *modify* a repository, or run its build, tests, deploy, or
  git commands. This is the one that gets handed off.

:::note
noop deliberately holds no code. Ask it to modify a repository and it writes a
continuity summary and moves you there, rather than editing from the wrong context.
:::

## Customising the router

The base router prompt regenerates from the install image on every launch, so editing
it does not stick. Customisations go in an overlay instead: a `CLAUDE.md` inside the
noop directory itself, which Claude Code loads alongside the system prompt. Rules
there extend or override the base.

If you keep your dotfiles under a manager such as chezmoi, edit the source of truth
there and sync, the same as any other file under `~/.config/`.
