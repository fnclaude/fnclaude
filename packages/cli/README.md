# @fnclaude/cli

The Claude Code command-line interface. Provides the `fnc` command for managing Claude Code sessions, projects, tasks, and remote triggers.

## Installation

```bash
npm install @fnclaude/cli
bun add @fnclaude/cli
```

## Requirements

This package requires the **Bun runtime** for terminal session management. The underlying PTY layer uses node-pty with Bun's native adapter, which provides efficient cross-platform support for interactive shell sessions. Node.js as the JavaScript runtime is supported for package management and installation, but session execution runs via Bun.

## Quick Start

```bash
# Launch Claude Code with default settings
fnc

# Specify a model and effort level
fnc opus max ~/my-project

# Open Claude in a specific worktree
fnc ~/my-project my-feature-branch

# Resume your most recent session
fnc continue
```

## Usage

```bash
fnc --help
```

For more details on available commands and features, run `fnc help` or see the main fnclaude documentation.

## Key Features

- **Model selection**: Pass `opus`, `sonnet`, or `haiku` as the first argument to pick a model alias
- **Effort levels**: Set effort with `low`, `medium`, `high`, `xhigh`, or `max` as the second argument
- **Worktree switching**: Automatically swap to a named worktree with `-w <name>` or as a positional argument
- **Session resume**: Resume previous sessions with `fnc continue` or pick one interactively with `fnc resume`
- **MCP integration**: Built-in Model Context Protocol server for seamless Claude integration

## Status

The CLI is actively maintained. Current release is published to npm under `@latest` and `@next` dist-tags. See the main fnclaude repository for release notes and version history.
