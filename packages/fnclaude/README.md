# fnclaude

Umbrella package for the fnclaude Claude Code launcher. Wraps `@rhombus.rocks/fnclaude` behind a single install.

## Installation

```bash
npm install fnclaude
bun add fnclaude
```

This installs the full fnclaude CLI. The package exports a shim entrypoint (`fnc` command) that wraps it.

### Install details

fnclaude re-exports `@rhombus.rocks/fnclaude` as a single umbrella package. The dependency is resolved via a workspace reference, so the umbrella and the CLI always ship compatible versions.

## Compatibility

**Runtime requirement:** fnclaude requires **Bun** for session execution. The CLI is distributed as JavaScript, installable via npm or Bun, but at runtime the terminal session manager uses Bun's PTY integration for reliable shell interaction. A working Bun installation (1.1.0 or later) is required to run `fnc` commands.

## What's included

- `@rhombus.rocks/fnclaude` — the fnclaude command-line launcher

## Quick start

After installation, the `fnc` command provides access to all Claude Code functionality:

```bash
fnc --help          # Show available commands
fnc <project-path>  # Start a new session in a project
```

For detailed documentation on CLI features and usage, see the CLI package readme.
