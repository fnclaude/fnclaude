# @fnclaude/cli

The Claude Code command-line interface. Provides the `fnc` command for managing Claude Code sessions, projects, tasks, and remote triggers.

## Installation

```bash
npm install @fnclaude/cli
bun add @fnclaude/cli
```

## Requirements

This package requires the **Bun runtime** for terminal session management. The underlying PTY layer uses node-pty with Bun's native adapter, which provides efficient cross-platform support for interactive shell sessions. Node.js as the JavaScript runtime is supported for package management and installation, but session execution runs via Bun.

## Usage

```bash
fnc --help
```

For more details on available commands and features, run `fnc help` or see the main fnclaude documentation.

## Status

The CLI is actively maintained. Current release is published to npm under `@latest` and `@next` dist-tags. See the main fnclaude repository for release notes and version history.
