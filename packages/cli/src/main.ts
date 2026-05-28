// `fnc`: launch `claude` in the resolved cwd (or the noop fallback when
// no positional was given). Bun-only (top-level await, Bun.spawn).
//
// This file is the launcher entry. Argv parsing, path resolution, and
// feature transforms live in their own modules under src/; main composes
// them in order. The minimum viable launch (noop fallback + claude
// spawn) is preserved as the no-arg path until the full pipeline lands.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';

import { readArgv } from './argv/intake.ts';
import { getVersion, helpText, wantsHelp, wantsVersion } from './help-version.ts';
import { isMcpSubcommand, parseMcpFlags, runMcpServer } from './mcp/dispatch.ts';
import { noopDir } from './path/resolve.ts';

const argv = readArgv();

// Internal test hook: when set, dump the parsed argv as JSON to stdout and
// exit 0 BEFORE we touch the noop dir or spawn claude. Lets e2e tests
// verify the preflight + intake chain preserves `--` end-to-end without
// needing a fake-claude harness. Not user-facing.
if (process.env.FNC_INTERNAL_DUMP_ARGV === '1') {
  process.stdout.write(`${JSON.stringify(argv)}\n`);
  process.exit(0);
}

if (wantsHelp(argv)) {
  process.stdout.write(helpText);
  process.exit(0);
}

if (wantsVersion(argv)) {
  const version = await getVersion();
  process.stdout.write(`fnc ${version}\n`);
  process.exit(0);
}

if (isMcpSubcommand(argv)) {
  const exitCode = await runMcpServer(parseMcpFlags(argv.slice(1)));
  process.exit(exitCode);
}

const cwd = noopDir({
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  home: homedir(),
});
await mkdir(cwd, { recursive: true });

const proc = Bun.spawn(['claude'], {
  cwd,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

// Kernel routes Ctrl-C to the whole foreground pgrp; claude handles its
// own SIGINT. Swallow it here so fnc survives to read claude's exit code.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

process.exit(await proc.exited);
