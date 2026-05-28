// `fnc`: launch `claude` in the resolved cwd (or the noop fallback when
// no positional was given). Bun-only (top-level await, Bun.spawn).
//
// This file is the launcher entry. Argv parsing, path resolution, and
// feature transforms live in their own modules under src/; main composes
// them in order.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { readArgv } from './argv/intake.ts';
import { expandAliases } from './argv/expand.ts';
import { parseArgs } from './argv/parse.ts';
import { expandShortFlags } from './argv/short-flags.ts';
import { getVersion, helpText, wantsHelp, wantsVersion } from './help-version.ts';
import { isMcpSubcommand, parseMcpFlags, runMcpServer } from './mcp/dispatch.ts';
import { expandTilde, noopDir } from './path/resolve.ts';

const argv = readArgv();

// Internal test hook: dump raw argv before any other work. Lets e2e tests
// verify the preflight + intake chain preserves `--` without spawning anything.
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

// Parse argv into structured launcher inputs. Magic positionals, fnclaude-eaten
// flags, subcommands, and the passthrough split happen here.
const parsed = parseArgs(argv);
if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n`);
  process.exit(2);
}

// Compute launch cwd. For now: no positional → noop; positional → tilde-expand
// + make absolute relative to shell cwd. The full resolver (repo refs, gh CLI
// lookup, clone) lands in a follow-up slice.
let cwd: string;
let usedNoopFallback = false;
const HOME = homedir();
if (parsed.firstPath === null) {
  cwd = noopDir({ xdgConfigHome: process.env.XDG_CONFIG_HOME, home: HOME });
  usedNoopFallback = true;
  await mkdir(cwd, { recursive: true });
} else {
  const expanded = expandTilde(parsed.firstPath, HOME);
  cwd = isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
}

// Build the final claude argv: prepend magic-captured flags (model/effort/
// subcommand), then expand any short-flag clusters in the passthrough.
const withAliases = expandAliases(parsed);
const shortExpanded = expandShortFlags(withAliases);
if (!shortExpanded.ok) {
  process.stderr.write(`${shortExpanded.error}\n`);
  process.exit(2);
}
const claudeArgs = shortExpanded.tokens;

// Internal test hook: dump the launch plan as JSON and exit 0 BEFORE spawning
// claude. Lets e2e tests verify the full pipeline composition (cwd + final
// claude args) without needing a real claude on PATH or a fake-claude harness.
if (process.env.FNC_INTERNAL_DUMP_PLAN === '1') {
  process.stdout.write(
    `${JSON.stringify({ cwd, claudeArgs, usedNoopFallback })}\n`,
  );
  process.exit(0);
}

const proc = Bun.spawn(['claude', ...claudeArgs], {
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
