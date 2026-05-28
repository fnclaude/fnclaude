// Minimal `fnc`: launch `claude` in the noop dir, inherit stdio, exit
// with the child's code. Bun-only (top-level await, Bun.spawn).
//
// The noop dir is $XDG_CONFIG_HOME/fnclaude/noop, falling back to
// ~/.config/fnclaude/noop. Created on demand so a fresh install
// doesn't fail on first run.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readArgv } from './argv/intake.ts';

const argv = readArgv();

// Internal test hook: when set, dump the parsed argv as JSON to stdout and
// exit 0 BEFORE we touch the noop dir or spawn claude. Lets e2e tests
// verify the preflight + intake chain preserves `--` end-to-end without
// needing a fake-claude harness. Not user-facing.
if (process.env.FNC_INTERNAL_DUMP_ARGV === '1') {
  process.stdout.write(`${JSON.stringify(argv)}\n`);
  process.exit(0);
}

const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
const noopDir = join(xdgConfig, 'fnclaude', 'noop');
await mkdir(noopDir, { recursive: true });

const proc = Bun.spawn(['claude'], {
  cwd: noopDir,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

// Kernel routes Ctrl-C to the whole foreground pgrp; claude handles its
// own SIGINT. Swallow it here so fnc survives to read claude's exit code.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

process.exit(await proc.exited);
