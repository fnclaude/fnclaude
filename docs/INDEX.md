# docs/

Navigation index for the fnclaude documentation.

## Product Requirements

- [prd.launcher.md](prd.launcher.md) — User-facing requirements for fnclaude invocation: model shortcuts, auto-tmux, targeting — created 2026-05-27
- [prd.in-session.md](prd.in-session.md) — User-facing requirements for features available inside a running fnclaude session — created 2026-05-27

## Design

- [design.md](design.md) — Locked-in technical requirements from the Go reference: wire formats, regexes, contracts — created 2026-05-27
- [design.mcp.md](design.mcp.md) — OS-level narrative of how fnclaude, claude, and the MCP subprocess wire together — created 2026-05-27

## Proposals

- [proposals/design.renderer.md](proposals/design.renderer.md) — Forward-looking design for renderer↔CLI in-process integration (not yet shipped) — created 2026-05-30
- [proposals/design.renderer-images.md](proposals/design.renderer-images.md) — Implementation guide for inline images: Kitty graphics protocol, `<Static>` foundation, `<img>`/pasted-image flows, security — created 2026-06-26
- [proposals/multipane-orchestration-proposal.md](proposals/multipane-orchestration-proposal.md) — Design exploration for a TUI hosting Ink chrome, Neovim, and transcript side-by-side — created 2026-06-26
- [proposals/subagent-panes-idea.md](proposals/subagent-panes-idea.md) — Design for a multi-agent cockpit: per-subagent panes for watching and steering in-flight agents — created 2026-06-18, updated 2026-06-26

## Reference

- [decisions.md](decisions.md) — Dated log of technical decisions made during the rewrite, with rationale — created 2026-05-27, updated 2026-06-26
- [renderer-component-hierarchy.md](renderer-component-hierarchy.md) — React/Ink component composition tree and event→renderer dispatch map (Mermaid) — created 2026-06-30

## Research

- [bun-pty-spawn.md](bun-pty-spawn.md) — Research on spawning interactive TUI children from Bun; recommends Bun.Terminal over node-pty — created 2026-05-27
- [research/renderer-graphics-interactivity.md](research/renderer-graphics-interactivity.md) — Feasibility memo on inline images, math, Mermaid, mouse/link interactivity, and scrolling architecture for the renderer — created 2026-06-26

## Reverse Engineering

- [reverse-engineering/claude-code-agent-ui-internals.md](reverse-engineering/claude-code-agent-ui-internals.md) — Reverse-engineering reference for Claude Code's subagent UI, steering seams, and workflow tree — created 2026-06-26
- [reverse-engineering/claude-code-binary-internals.md](reverse-engineering/claude-code-binary-internals.md) — Runbook for grepping Claude Code's Bun-compiled binary for embedded JS and prompt strings — created 2026-06-17
- [reverse-engineering/claude-code-compact-prompts.md](reverse-engineering/claude-code-compact-prompts.md) — Reverse-engineered compact/summary prompt strings extracted from Claude Code binary — created 2026-06-18
- [reverse-engineering/claude-code-control-protocol.md](reverse-engineering/claude-code-control-protocol.md) — Reference for the stream-json `control_request`/`control_response` protocol: frame shape, full subtype vocabulary, CLI-side receiver, and the renderer-mode-only handle for live model/effort/permission-mode switching — created 2026-07-03
- [reverse-engineering/claude-code-prompt-strings.md](reverse-engineering/claude-code-prompt-strings.md) — Heuristic bulk extraction of all instruction-like strings from Claude Code binary — created 2026-06-18
- [reverse-engineering/claude-code-render-modes.md](reverse-engineering/claude-code-render-modes.md) — Reference for Claude Code's three terminal render modes, escape-sequence mechanics, and implications for fnclaude — created 2026-06-26
- [reverse-engineering/claude-code-terminal-tricks.md](reverse-engineering/claude-code-terminal-tricks.md) — Behavior-level reference for CC's terminal/TUI mechanisms: theme detection, OSC hyperlinks, image protocols, clipboard, keyboard handling, and capability detection — created 2026-06-29
- [reverse-engineering/claude-remote-control.md](reverse-engineering/claude-remote-control.md) — Transport, auth, entry surfaces, and print/stream-json gate for Claude Code's Remote Control feature; renderer-mode implications for fnc — created 2026-06-30
- [reverse-engineering/extract-claude-code-prompts.sh](reverse-engineering/extract-claude-code-prompts.sh) — Shell script used to extract prompt strings from the Claude Code binary

## Archive

- [archive/arch-review-2026-05.md](archive/arch-review-2026-05.md) — Architecture + language-feature review of the Go→TS port, May 2026 — created 2026-05-25
- [archive/build-plan.md](archive/build-plan.md) — Dependency-ordered implementation plan with TDD protocol for the CLI rewrite (all phases ✅) — created 2026-05-27, updated 2026-05-28
- [archive/fnc-silent-exit-investigation.md](archive/fnc-silent-exit-investigation.md) — Investigation notes for the silent-exit bug in fnclaude 1.1.1 with node-pty (closed) — created 2026-05-27
- [archive/specs.md](archive/specs.md) — Canonical behavior spec derived from the Go reference source, with README divergences noted — created 2026-05-27
