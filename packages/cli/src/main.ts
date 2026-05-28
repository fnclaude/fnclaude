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
import { composeEnv } from './launch/compose-env.ts';
import { findClaude } from './launch/find-claude.ts';
import { isMcpSubcommand, parseMcpFlags, runMcpServer } from './mcp/dispatch.ts';
import { autoName, shouldAutoName } from './name/auto-name.ts';
import { sanitizeForPath } from './name/sanitize.ts';
import { findPromptSentinel, promptBody } from './argv/sentinel.ts';
import { ensureCwd } from './path/ensure-cwd.ts';
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
let workspaceFromRef = '';
switch (resolved.kind) {
  case 'launch':
    cwd = resolved.launchCwd;
    usedNoopFallback = resolved.usedNoopFallback;
    workspaceFromRef = resolved.workspace;
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
//
// `+workspace` suffix on a repo ref (parsed by resolveInput) feeds into here
// as if the user had typed `-w <workspace>` — but explicit `-w` always wins.
const effectiveWorktreeSet = parsed.worktreeSet || workspaceFromRef !== '';
const effectiveWorktreeArg = parsed.worktreeSet ? parsed.worktreeArg : workspaceFromRef;
const intercept = applyWorktreeIntercept({
  worktreeSet: effectiveWorktreeSet,
  worktreeArg: effectiveWorktreeArg,
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

// Auto-name: when the user has typed a prompt body via `--` and hasn't given
// --name / -n (and the session isn't print/resume/continue/from-pr), generate
// a session name. Spec defaults: LLM-via-claude-p with 15s timeout, heuristic
// fallback on error/timeout. ANTHROPIC_API_KEY → SDK fast-path is a follow-up.
//
// FNC_INTERNAL_DISABLE_AUTONAME=1 is an internal test escape — when set,
// autoName is skipped entirely so e2e tests don't have to wait on a real
// claude -p call (and don't see --name pollute their assertion shapes).
if (process.env.FNC_INTERNAL_DISABLE_AUTONAME !== '1' && shouldAutoName(parsedWithIntercept)) {
  const sentinelIdx = findPromptSentinel(parsedWithIntercept.passthrough);
  const body = promptBody(parsedWithIntercept.passthrough, sentinelIdx).join(' ').trim();
  const llmCall = process.env.ANTHROPIC_API_KEY !== undefined
    ? undefined // TODO: Anthropic SDK fast-path
    : async (prompt: string): Promise<string> => {
        const system = "Generate a 1-3 word lowercase hyphen-separated label for this user's request. Output ONLY the label — no punctuation, no quotes, no explanation, no leading 'Label:'. Examples: 'fix-login-bug', 'add-dark-mode', 'refactor-auth'.";
        const proc = Bun.spawn(
          ['claude', '-p', '--model', 'claude-haiku-4-5', `${system}\n\nUser request: ${prompt}`],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        );
        const out = await new Response(proc.stdout).text();
        const exit = await proc.exited;
        if (exit !== 0) throw new Error(`claude -p exited ${exit}`);
        return out;
      };
  const generated = await autoName({ prompt: body, llmCall, timeoutMs: 15_000 });
  const san = sanitizeForPath(generated);
  const final = san.kind === 'invalid' ? generated : san.value;
  claudeArgs = [...claudeArgs, '--name', final];
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

// Compose the child env: process.env → [exec.env] from config → FNCLAUDE_HANDOFF
// (and FNC_SOCKET once §7 lands). Later entries win against same-name earlier
// entries per design.md §5.
const childEnv = composeEnv({
  processEnv: process.env,
  execEnv: config.execEnv,
  handoff: config.autoHandoff,
  socket: undefined, // §7 will populate this with the AF_UNIX socket path
});

// Internal test hook: dump the launch plan as JSON and exit 0 BEFORE spawning
// claude. Lets e2e tests verify the full pipeline composition (cwd + final
// claude args) without needing a real claude on PATH or a fake-claude harness.
if (process.env.FNC_INTERNAL_DUMP_PLAN === '1') {
  // Dump only env values fnclaude actively manages (handoff/socket + execEnv
  // keys) to keep the dump small and predictable in tests. The full process
  // env would leak shell state into snapshots.
  const dumpEnv: Record<string, string> = {};
  if (config.execEnv !== undefined) {
    for (const k of Object.keys(config.execEnv)) {
      if (k in childEnv) dumpEnv[k] = childEnv[k]!;
    }
  }
  if ('FNCLAUDE_HANDOFF' in childEnv) dumpEnv.FNCLAUDE_HANDOFF = childEnv.FNCLAUDE_HANDOFF!;
  if ('FNC_SOCKET' in childEnv) dumpEnv.FNC_SOCKET = childEnv.FNC_SOCKET!;
  process.stdout.write(
    `${JSON.stringify({ cwd, claudeArgs, usedNoopFallback, env: dumpEnv })}\n`,
  );
  process.exit(0);
}

// Verify claude is on PATH before doing any spawn-time setup. Failing here
// gives a far better error than Bun.spawn's bare ENOENT.
const claudeBin = findClaude({ pathEnv: process.env.PATH ?? '' });
if (!claudeBin.ok) {
  process.stderr.write(`${claudeBin.error}\n`);
  process.exit(127);
}

// Fabricate the cwd tree if missing — Bun.spawn would otherwise return ENOENT
// blaming the claude binary. The cleanup() unlinks any fabricated dirs right
// after spawn, since the kernel holds the cwd by inode reference once the
// child has chdir'd (which posix_spawn does before returning to us).
const ensured = ensureCwd(cwd);
if (!ensured.ok) {
  process.stderr.write(`fnclaude: ${ensured.error}\n`);
  process.exit(2);
}

const proc = Bun.spawn([claudeBin.path, ...claudeArgs], {
  cwd,
  env: childEnv,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

ensured.cleanup();

// Kernel routes Ctrl-C to the whole foreground pgrp; claude handles its
// own SIGINT. Swallow it here so fnc survives to read claude's exit code.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

process.exit(await proc.exited);
