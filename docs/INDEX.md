# docs/

Navigation index for the docs folder.

## Product Requirements

| File | Description |
|---|---|
| [prd.md](prd.md) | Top-level PRD index pointing to launcher, in-session, design, and spec subdocs |
| [prd.launcher.md](prd.launcher.md) | User-facing requirements for fnclaude invocation: model shortcuts, auto-tmux, targeting |
| [prd.in-session.md](prd.in-session.md) | User-facing requirements for features available inside a running fnclaude session |

## Design

| File | Description |
|---|---|
| [design.md](design.md) | Locked-in technical requirements from the Go reference: wire formats, regexes, contracts |
| [design.mcp.md](design.mcp.md) | OS-level narrative of how fnclaude, claude, and the MCP subprocess wire together |
| [design.renderer.md](design.renderer.md) | Forward-looking design for renderer↔CLI in-process integration (not yet shipped) |
| [design.renderer-images.md](design.renderer-images.md) | Implementation guide for inline images: Kitty protocol, `<Static>` foundation, `<img>`/pasted-image flows, security |

## Proposed Features

| File | Description |
|---|---|
| [multipane-orchestration-proposal.md](multipane-orchestration-proposal.md) | Design exploration for a TUI hosting Ink chrome, Neovim, and transcript side-by-side |
| [subagent-panes-idea.md](subagent-panes-idea.md) | Design for a multi-agent cockpit: per-subagent panes for watching and steering in-flight agents |

## Research

| File | Description |
|---|---|
| [research/bun-pty-spawn.md](research/bun-pty-spawn.md) | Research on spawning interactive TUI children from Bun; recommends Bun.Terminal over node-pty |
| [research/claude-code-agent-ui-internals.md](research/claude-code-agent-ui-internals.md) | Reverse-engineering reference for Claude Code's subagent UI, steering seams, and workflow tree |
| [research/claude-code-binary-internals.md](research/claude-code-binary-internals.md) | Runbook for grepping Claude Code's Bun-compiled binary for embedded JS and prompt strings |
| [research/claude-code-render-modes.md](research/claude-code-render-modes.md) | Reference for Claude Code's three terminal render modes, mode selection logic, and what they mean for fnclaude's subprocess model |
| [research/renderer-graphics-interactivity.md](research/renderer-graphics-interactivity.md) | Feasibility memo for renderer graphics and interactivity: inline images, math, mermaid, mouse events, links, scroll |
| [claude-code-compact-prompts.md](claude-code-compact-prompts.md) | Reverse-engineered compact/summary prompt strings extracted from Claude Code binary |
| [claude-code-prompt-strings.md](claude-code-prompt-strings.md) | Heuristic bulk extraction of all instruction-like strings from Claude Code binary |

## Reference

| File | Description |
|---|---|
| [specs.md](specs.md) | Canonical behavior spec derived from the Go reference source, with README divergences noted |
| [decisions.md](decisions.md) | Dated log of technical decisions made during the rewrite, with rationale |

## Build & Implementation

| File | Description |
|---|---|
| [build-plan.md](build-plan.md) | Dependency-ordered implementation plan with TDD protocol for the CLI rewrite |

## Investigations & Reviews

| File | Description |
|---|---|
| [arch-review-2026-05.md](arch-review-2026-05.md) | Architecture + language-feature review of the Go→TS port, May 2026 |
| [fnc-silent-exit-investigation.md](fnc-silent-exit-investigation.md) | Investigation notes for the silent-exit bug in fnclaude 1.1.1 with node-pty |
