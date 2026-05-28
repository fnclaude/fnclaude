// `fnc`: launch `claude` in the resolved cwd (or the noop fallback when
// no positional was given). Bun-only (top-level await, Bun.spawn).
//
// This file is the launcher entry. Argv parsing, path resolution, and
// feature transforms live in their own modules under src/; main composes
// them in order.

import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readArgv } from './argv/intake.ts';
import { expandAliases } from './argv/expand.ts';
import { parseArgs } from './argv/parse.ts';
import { expandShortFlags } from './argv/short-flags.ts';
import { loadConfig } from './config/load.ts';
import { getVersion, helpText, wantsHelp, wantsVersion } from './help-version.ts';
import { isMcpSubcommand, parseMcpFlags, runMcpServer } from './mcp/dispatch.ts';
import { resolvePromptsDir } from './prompts/dir.ts';
import { injectFragments, loadFragments } from './prompts/load.ts';
import { selectFragments } from './prompts/select.ts';
import { loadHostAliases } from './repo/host-aliases.ts';
import { loadRepoSettings } from './repo/repo-settings.ts';
import { resolveInput } from './repo/resolve-input.ts';
import { shouldInjectTmux } from './worktree/auto-tmux.ts';
import { listWorktrees } from './worktree/git-list.ts';
import { applyWorktreeIntercept } from './worktree/intercept.ts';

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

// Load fnclaude config (auto.tmux + other settings the launcher consults).
const HOME = homedir();
const shellCwd = process.cwd();
const configBase = process.env.XDG_CONFIG_HOME ?? join(HOME, '.config');
const config = await loadConfig({ path: join(configBase, 'fnclaude', 'config.toml') });

// Load settings before resolution. Resolution-time settings only need user +
// managed tiers (project/local require knowing projectRoot, which only matters
// after launch). The managed-settings path is Linux-only for now; macOS &
// Windows resolution to come.
const settings = loadRepoSettings({
  userPath: join(HOME, '.claude', 'settings.json'),
  projectPath: join(shellCwd, '.claude', 'settings.json'),
  localPath: join(shellCwd, '.claude', 'settings.local.json'),
  managedPath: '/etc/claude-code/managed-settings.json',
});
const hostAliases = loadHostAliases({
  systemPath: '/usr/share/fnrhombus/host-aliases.json',
  userPath: join(HOME, '.local', 'share', 'fnrhombus', 'host-aliases.json'),
});

// Resolve the first positional (path or repo ref) to a launch cwd. The
// resolver handles path short-circuit (/, ~, ~/) AND repo-ref refs whose owner
// is already known (URL forms, owner/name, name@owner, gh:owner/name). Bare
// names and clone execution route through the gh-CLI branches below; ambiguous
// matches surface a clean error.
const resolved = resolveInput({
  input: parsed.firstPath,
  shellCwd,
  home: HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  settings: { cloneTemplate: settings.cloneTemplate, hostAliases },
});

let cwd: string;
let usedNoopFallback = false;
switch (resolved.kind) {
  case 'launch':
    cwd = resolved.launchCwd;
    usedNoopFallback = resolved.usedNoopFallback;
    if (usedNoopFallback) await mkdir(cwd, { recursive: true });
    break;
  case 'needs-clone':
    process.stderr.write(
      `fnclaude: ${resolved.destination} doesn't exist on disk. Would clone ${resolved.url} → ${resolved.destination}; clone execution not yet implemented in the TS rewrite.\n`,
    );
    process.exit(2);
  case 'needs-owner-lookup':
    process.stderr.write(
      `fnclaude: bare name ${JSON.stringify(resolved.name)} needs gh CLI to find the owner; not yet implemented in the TS rewrite.\n`,
    );
    process.exit(2);
  case 'ambiguous': {
    const both = resolved.cloneDestination ?? resolved.repoRef ?? '?';
    process.stderr.write(
      `fnclaude: ambiguous reference — could be the local directory ${resolved.path} OR ${both}. Disambiguate by typing './<name>' for the local path.\n`,
    );
    process.exit(2);
  }
  case 'error':
    process.stderr.write(`fnclaude: ${resolved.error}\n`);
    process.exit(2);
}

// Worktree intercept: when -w <name> is set, possibly swap cwd to an
// existing worktree's path. The intercept also pushes `--worktree`/`--name`
// into passthrough as appropriate per spec §10.
const intercept = applyWorktreeIntercept({
  worktreeSet: parsed.worktreeSet,
  worktreeArg: parsed.worktreeArg,
  launchCwd: cwd,
  passthrough: parsed.passthrough,
  listWorktrees,
});
for (const w of intercept.warnings) process.stderr.write(`${w}\n`);
cwd = intercept.launchCwd;
const parsedWithIntercept = { ...parsed, passthrough: intercept.passthrough };

// Build the final claude argv: prepend magic-captured flags (model/effort/
// subcommand), then expand any short-flag clusters in the passthrough.
const withAliases = expandAliases(parsedWithIntercept);
const shortExpanded = expandShortFlags(withAliases);
if (!shortExpanded.ok) {
  process.stderr.write(`${shortExpanded.error}\n`);
  process.exit(2);
}
let claudeArgs = shortExpanded.tokens;

// Auto-tmux: if config has auto.tmux = "worktree" AND this is a brand-new
// worktree (worktreeSet + no match) AND user didn't opt out, inject --tmux.
if (
  shouldInjectTmux({
    configAutoTmux: config.autoTmux,
    worktreeSet: parsed.worktreeSet,
    worktreeMatched: intercept.worktreeMatched,
    noTmux: parsed.noTmux,
    passthrough: claudeArgs,
  })
) {
  claudeArgs = [...claudeArgs, '--tmux'];
}

// Inject prompt fragments via --append-system-prompt. Selection depends on
// noop fallback + interactive (non-print) state of the session.
const fragmentNames = selectFragments({ usedNoopFallback, passthrough: claudeArgs });
if (fragmentNames.length > 0) {
  // process.argv[1] is the BIN script (bin/fnc.js after preflight, or whatever
  // node invoked). Realpath it so symlinked installs (npm's .bin/ → package
  // bin/) resolve to the actual layout. The "prompts" directory candidates
  // (../prompts, ../share/...) are sibling-relative to that resolved bin.
  const binPath = process.argv[1] ?? '';
  const exeDir = binPath !== '' ? dirname(realpathSync(binPath)) : process.cwd();
  const promptsDir = resolvePromptsDir({
    envOverride: process.env.FNC_PROMPTS_DIR,
    exeDir,
  });
  if (promptsDir.dir !== null) {
    const loaded = loadFragments(fragmentNames, promptsDir.dir);
    for (const w of loaded.warnings) process.stderr.write(`${w}\n`);
    claudeArgs = injectFragments(claudeArgs, loaded.content);
  } else if (promptsDir.warning !== undefined) {
    process.stderr.write(`${promptsDir.warning}\n`);
  }
}

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
