# fnclaude

Umbrella package for Claude Code CLI and renderer. Bundles `@fnclaude/cli` and `@fnclaude/renderer` as a single dependency.

## Installation

```bash
npm install fnclaude
bun add fnclaude
```

This installs the full Claude Code CLI along with the renderer runtime. The package exports a shim entrypoint (`fnc` command) that wraps the CLI.

### Install details

fnclaude bundles `@fnclaude/cli` and `@fnclaude/renderer` as a single umbrella package. Both dependencies are pinned to matching versions to ensure compatibility between the CLI and renderer layers.

## Compatibility

**Runtime requirement:** fnclaude requires **Bun** for session execution. The CLI and renderer are distributed as JavaScript bundles, installable via npm or Bun, but at runtime the terminal session manager uses Bun's PTY integration for reliable shell interaction. A working Bun installation (0.0.250 or later) is required to run `fnc` commands.

## What's included

- `@fnclaude/cli` — Claude Code command-line interface
- `@fnclaude/renderer` — Renderer and WebSocket server for interactive sessions

## Quick start

After installation, the `fnc` command provides access to all Claude Code functionality:

```bash
fnc --help          # Show available commands
fnc <project-path>  # Start a new session in a project
```

For detailed documentation on CLI features and usage, see the individual package readmes.
