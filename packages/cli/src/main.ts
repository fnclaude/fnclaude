// `fnc`: launch `claude` in the resolved cwd (or the noop fallback when
// no positional was given). Bun-only (top-level await, Bun.spawn).
//
// This file is the launcher entry. Argv parsing, path resolution, and
// feature transforms live in their own modules under src/; main composes
// them in order.

import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readArgv } from './argv/intake.ts';
import { expandAliases } from './argv/expand.ts';
import { parseArgs } from './argv/parse.ts';
import { expandShortFlags } from './argv/short-flags.ts';
import { loadConfig } from './config/load.ts';
import { initLogging } from './log/init.ts';
import { reexecSelf, startHandoffAwaiter } from './handoff/awaiter.ts';
import { decidePostExitTeardown } from './handoff/post-exit-teardown.ts';
import { handoffTrigger } from './handoff/trigger.ts';
import { getVersion, helpText, wantsHelp, wantsVersion } from './help-version.ts';
import { composeEnv } from './launch/compose-env.ts';
import { decideCrossCwdRelaunch } from './launch/cross-cwd-relaunch.ts';
import { findClaude } from './launch/find-claude.ts';
import { readLivePermissionMode, sessionJSONLPath } from './launch/live-permission-reader.ts';
import { RingBuffer } from './launch/ring-buffer.ts';
import { isMcpSubcommand, parseMcpFlags, runMcpServer } from './mcp/dispatch.ts';
import { handleCopyToClipboard } from './mcp/handlers/clipboard.ts';
import { createGetUsageHandler } from './mcp/handlers/get-usage.ts';
import { createPtyWriterHolder } from './mcp/handlers/inject-slash.ts';
import { createRestartHandler } from './mcp/handlers/restart.ts';
import {
  createRequestCompactHandler,
  createRunSlashCommandHandler,
  createSetEffortHandler,
  createSetModelHandler,
} from './mcp/handlers/slash-tools.ts';
import { createSpawnHandler } from './mcp/handlers/spawn.ts';
import { createSwitchHandler } from './mcp/handlers/switch.ts';
import { injectMcpConfig } from './mcp/inject-config.ts';
import { startMcpListener } from './mcp/listener.ts';
import { createParentDispatcher, stubParentHandlers } from './mcp/parent-dispatch.ts';
import { computeSocketPath } from './mcp/socket-path.ts';
import { autoName, shouldAutoName } from './name/auto-name.ts';
import { AUTO_NAME_MODEL, AUTO_NAME_SYSTEM_PROMPT } from './name/llm-prompt.ts';
import { sanitizeForPath } from './name/sanitize.ts';
import { sdkLlmCall } from './name/sdk-llm.ts';
import { findPromptSentinel, insertFlagsBeforeSentinel, promptBody } from './argv/sentinel.ts';
import { seedNoopDir } from './noop/seed.ts';
import { resolveTemplateSourcePath } from './noop/template-source.ts';
import { ensureCwd } from './path/ensure-cwd.ts';
import { resolvePromptsDir } from './prompts/dir.ts';
import { injectFragments, loadFragments } from './prompts/load.ts';
import { isInteractiveSession, selectFragments } from './prompts/select.ts';
import { buildCloneUrl, computeCloneDestination } from './repo/clone.ts';
import { cloneRepo } from './repo/clone-exec.ts';
import { isRepoNotFoundError } from './repo/clone-failure.ts';
import { parseCloneUrl } from './repo/clone-url.ts';
import { bootstrapRepo } from './repo/bootstrap.ts';
import { confirm } from './repo/confirm.ts';
import { runGitInit } from './repo/git-runner.ts';
import { runGhApi, runGhClone, runGhRepoCreate } from './repo/gh-runner.ts';
import { loadHostAliases } from './repo/host-aliases.ts';
import { findOwner, formatOwnerLookupError } from './repo/owner-lookup.ts';
import { loadRepoSettings } from './repo/repo-settings.ts';
import { resolveInput } from './repo/resolve-input.ts';
import { resolveContextNoticeThreshold, startContextMonitor } from './usage/context-monitor.ts';
import { createWarningBuffer } from './warnings/buffer.ts';
import { shouldInjectTmux } from './worktree/auto-tmux.ts';
import { listWorktrees } from './worktree/git-list.ts';
import { applyWorktreeIntercept } from './worktree/intercept.ts';

const argv = readArgv();

// Non-fatal warnings accumulate here; we flush after claude exits so the
// user actually sees them. Terminal errors (the `exit(2)` / `exit(127)`
// paths below) bypass the buffer and write straight to stderr — they're
// the reason we're not launching, not background noise. Design: §27.
const warnings = createWarningBuffer();

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

// Clone the ref into `destination`; if the clone fails *because the repo
// doesn't exist*, offer to bootstrap a fresh local repo (and optionally the
// private GitHub remote) instead of hard-failing. Returns the cwd to launch
// in, or null when the caller should abort (already printed + must exit 2).
// Shared by both `needs-clone` and `needs-owner-lookup`.
async function cloneOrBootstrap(url: string, destination: string): Promise<string | null> {
  process.stderr.write(`fnclaude: cloning ${url} → ${destination}\n`);
  const cloneR = await cloneRepo({
    url,
    destination,
    ghClone: runGhClone,
    mkdirp: async (path) => {
      await mkdir(path, { recursive: true });
    },
  });
  if (cloneR.ok) return destination;

  // Only the repo-not-found failure is recoverable; auth/network/etc still
  // hard-fail as before.
  if (!isRepoNotFoundError(cloneR.stderr)) {
    process.stderr.write(`fnclaude: ${cloneR.error}\n`);
    return null;
  }

  const parts = parseCloneUrl(url);
  if (parts === null) {
    process.stderr.write(`fnclaude: ${cloneR.error}\n`);
    return null;
  }

  const boot = await bootstrapRepo({
    owner: parts.owner,
    name: parts.name,
    host: parts.host,
    destination,
    url,
    deps: {
      confirm,
      mkdirp: async (path) => {
        await mkdir(path, { recursive: true });
      },
      gitInit: runGitInit,
      ghRepoCreate: runGhRepoCreate,
      log: (msg) => process.stderr.write(`${msg}\n`),
    },
  });
  if (boot.kind === 'launched') return boot.cwd;
  if (boot.kind === 'error') {
    process.stderr.write(`fnclaude: ${boot.error}\n`);
    return null;
  }
  // declined → restore today's behavior: print the original clone error.
  process.stderr.write(`fnclaude: ${cloneR.error}\n`);
  return null;
}

let cwd: string;
let usedNoopFallback = false;
let workspaceFromRef = '';
switch (resolved.kind) {
  case 'launch':
    cwd = resolved.launchCwd;
    usedNoopFallback = resolved.usedNoopFallback;
    workspaceFromRef = resolved.workspace;
    if (usedNoopFallback) {
      await mkdir(cwd, { recursive: true });
      // Seed handoff.template.md on first noop-fallback launches (design.md
      // §19). Resolves the template source from <exe-dir> sibling layouts
      // and only copies if dest is missing — never clobbers an existing
      // hand-edited template. Failures here don't block the launch.
      const binPathForSeed = process.argv[1] ?? '';
      const exeDirForSeed = binPathForSeed !== '' ? dirname(realpathSync(binPathForSeed)) : process.cwd();
      const tmplSource = resolveTemplateSourcePath({
        envOverride: process.env.FNC_NOOP_TEMPLATE_PATH,
        exeDir: exeDirForSeed,
      });
      await seedNoopDir({ noopDir: cwd, templateSourcePath: tmplSource.path });
    }
    break;
  case 'needs-clone': {
    // Repo ref resolved cleanly but the destination doesn't exist on disk.
    // Clone it (or bootstrap, if it doesn't exist), then launch there.
    const launchCwd = await cloneOrBootstrap(resolved.url, resolved.destination);
    if (launchCwd === null) process.exit(2);
    cwd = launchCwd;
    workspaceFromRef = resolved.workspace;
    break;
  }
  case 'needs-owner-lookup': {
    // Bare-name ref — ask gh which org owns a repo by this name, then
    // re-route through the resolver as if owner had been on the input.
    const ownerR = await findOwner({ name: resolved.name, ghApi: runGhApi });
    if (!ownerR.ok) {
      process.stderr.write(`${formatOwnerLookupError(ownerR, resolved.name)}\n`);
      process.exit(2);
    }
    // Build a synthetic ref for the resolved owner and recompute destination.
    const syntheticRef = {
      host: '',
      owner: ownerR.owner,
      name: resolved.name,
      workspace: resolved.workspace,
      original: resolved.name,
    };
    if (settings.cloneTemplate === '') {
      process.stderr.write(
        `fnclaude: cloneTemplate is not configured in repoSettings; cannot resolve bare-name refs.\n`,
      );
      process.exit(2);
    }
    const destR = computeCloneDestination({
      ref: syntheticRef,
      template: settings.cloneTemplate,
      hostAliases,
      home: HOME,
    });
    if (!destR.ok) {
      process.stderr.write(`fnclaude: ${destR.error}\n`);
      process.exit(2);
    }
    // If the destination already exists, just launch there. Otherwise clone.
    const { existsSync } = await import('node:fs');
    if (existsSync(destR.path)) {
      cwd = destR.path;
      workspaceFromRef = resolved.workspace;
      break;
    }
    const url = buildCloneUrl(syntheticRef);
    const launchCwd = await cloneOrBootstrap(url, destR.path);
    if (launchCwd === null) process.exit(2);
    cwd = launchCwd;
    workspaceFromRef = resolved.workspace;
    break;
  }
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
for (const w of intercept.warnings) warnings.add(w);
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
  claudeArgs = insertFlagsBeforeSentinel(claudeArgs, '--tmux');
}

// Auto-name: when the user has typed a prompt body via `--` and hasn't given
// --name / -n (and the session isn't print/resume/continue/from-pr), generate
// a session name. Spec defaults: 15s timeout, heuristic fallback on error/
// timeout. When ANTHROPIC_API_KEY is set we hit the API via the SDK directly
// (saves a claude cold-start); otherwise we shell out to `claude -p`.
//
// FNC_INTERNAL_DISABLE_AUTONAME=1 is an internal test escape — when set,
// autoName is skipped entirely so e2e tests don't have to wait on a real
// claude -p call (and don't see --name pollute their assertion shapes).
if (process.env.FNC_INTERNAL_DISABLE_AUTONAME !== '1' && shouldAutoName(parsedWithIntercept)) {
  const sentinelIdx = findPromptSentinel(parsedWithIntercept.passthrough);
  const body = promptBody(parsedWithIntercept.passthrough, sentinelIdx).join(' ').trim();
  const claudePLlmCall = async (prompt: string): Promise<string> => {
    const proc = Bun.spawn(
      ['claude', '-p', '--model', AUTO_NAME_MODEL, `${AUTO_NAME_SYSTEM_PROMPT}\n\nUser request: ${prompt}`],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const out = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`claude -p exited ${exit}`);
    return out;
  };
  const llmCall = process.env.ANTHROPIC_API_KEY !== undefined ? sdkLlmCall : claudePLlmCall;
  const generated = await autoName({ prompt: body, llmCall, timeoutMs: 15_000 });
  const san = sanitizeForPath(generated);
  const final = san.kind === 'invalid' ? generated : san.value;
  claudeArgs = insertFlagsBeforeSentinel(claudeArgs, '--name', final);
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
    for (const w of loaded.warnings) warnings.add(w);
    claudeArgs = injectFragments(claudeArgs, loaded.content);
  } else if (promptsDir.warning !== undefined) {
    warnings.add(promptsDir.warning);
  }
}

// Compute the MCP socket path. On Unix this also feeds FNC_SOCKET into
// the child env so the MCP subprocess (which claude spawns per the
// injected --mcp-config) knows where to dial. On win32, AF_UNIX over
// Bun.listen({ unix }) isn't supported yet — skip the socket entirely
// so the launcher still works without self-MCP.
let mcpSocketPath: string | undefined;
let mcpListenerStop: (() => Promise<void>) | undefined;
if (process.platform !== 'win32') {
  mcpSocketPath = computeSocketPath({
    env: process.env,
    pid: process.pid,
    platform: process.platform,
  });
}

// Compose the child env: process.env → [exec.env] from config → FNCLAUDE_HANDOFF
// → FNC_SOCKET. Later entries win against same-name earlier entries per
// design.md §5.
const childEnv = composeEnv({
  processEnv: process.env,
  execEnv: config.execEnv,
  handoff: config.autoHandoff,
  socket: mcpSocketPath,
});

// Self-MCP --mcp-config injection (§7.4). Skipped when there's no socket
// to dial back to (win32 — no listener), and gated to interactive
// sessions per design.md §29. The fnc bin is realpath'd so symlinked
// installs (npm's .bin/) resolve to the actual layout; process.execPath
// is the bun runtime that will exec the subprocess script. Decision: bun
// + script-path is a two-element shape because fnc.js is a bun script,
// not a self-contained binary — see decisions.md 2026-05-27 entry.
if (mcpSocketPath !== undefined) {
  const binPathForMcp = process.argv[1] ?? '';
  const fncBin = binPathForMcp !== '' ? realpathSync(binPathForMcp) : '';
  claudeArgs = injectMcpConfig({
    claudeArgs,
    bunExec: process.execPath,
    fncBin,
    noop: usedNoopFallback,
    interactive: isInteractiveSession(claudeArgs),
  });
}

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

// Deferred-binding PTY writer for the slash-injection MCP tools (C0–C4).
// The dispatcher is wired below BEFORE the terminal exists; the keystone
// handlers take `slashWriter.write` now and we bind it to the real
// `term.write` once the terminal spawns (further down). Until bound, a
// write is a no-op (fire-and-forget) — but the terminal binds long before
// any tool call can arrive.
const slashWriter = createPtyWriterHolder();

// Bind the MCP listener (Unix only). Must happen BEFORE Bun.spawn so the
// subprocess claude launches per --mcp-config can dial back over
// $FNC_SOCKET. Bind failure is fatal per Go canonical — we can't run
// without it once tools are wired (§8). design.mcp.md §2.1.
if (mcpSocketPath !== undefined) {
  try {
    // §7.7 + §8.x: wire per-tool dispatch onto each accepted socket.
    // §8.1 (restart), §8.2 (switch), §8.3 (spawn) and §8.4 (clipboard)
    // replace their stubs; nothing remains stubbed in §8.
    //
    // Live permission-mode reader binds `cwd` (the launch cwd) at
    // construction so both handlers consume the same
    // `(sessionId) => string | null` shape. Reads claude's
    // `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` for the latest
    // `{type:"permission-mode",...}` record — last-wins, null on miss.
    const livePermissionModeReader = (sessionId: string): string | null =>
      readLivePermissionMode(cwd, sessionId);
    const restartHandler = createRestartHandler({
      origArgs: argv,
      launchCWD: cwd,
      trigger: handoffTrigger,
      livePermissionModeReader,
    });
    const switchHandler = createSwitchHandler({
      origArgs: argv,
      trigger: handoffTrigger,
      livePermissionModeReader,
    });
    const binPathForListener = process.argv[1] ?? '';
    const fncBinAbs = binPathForListener !== '' ? realpathSync(binPathForListener) : '';
    const spawnHandler = createSpawnHandler({
      config: { autoSpawnCommand: config.autoSpawnCommand },
      processEnv: process.env,
      fncBinPath: fncBinAbs,
      handleCopyToClipboard,
    });
    const dispatcher = createParentDispatcher({
      handlers: {
        ...stubParentHandlers,
        restart: restartHandler,
        switch: switchHandler,
        spawn: spawnHandler,
        copy_to_clipboard: handleCopyToClipboard,
        // Batch-2 slash-injection tools — thin wrappers over the C0
        // keystone, all sharing the deferred-bound PTY writer.
        compact: createRequestCompactHandler({ write: slashWriter.write }),
        set_effort: createSetEffortHandler({ write: slashWriter.write }),
        set_model: createSetModelHandler({ write: slashWriter.write }),
        run_slash: createRunSlashCommandHandler({ write: slashWriter.write }),
        // get_usage returns structured budget data read from the session
        // JSONL; launchCWD is the encoded-cwd half of that path.
        get_usage: createGetUsageHandler({ launchCWD: cwd }),
      },
    });
    const listener = await startMcpListener({
      socketPath: mcpSocketPath,
      onConnection: dispatcher,
    });
    mcpListenerStop = listener.stop;
  } catch (err) {
    process.stderr.write(`fnclaude: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

// Structured file logging. Best-effort, file-ONLY (the session-time
// controlling terminal is claude's TUI, so a stdout/stderr sink would corrupt
// its render). Built here — cwd is resolved, but before ensureCwd — so the
// resume/cross-cwd transition into a removed dir is observable at the exact
// boundary where terminal logging is unusable. initLogging never throws; on
// any fs failure it returns a no-op logger. Default level INFO, FNC_LOG
// overrides. design: docs/decisions.md.
const { logger } = initLogging({
  env: process.env,
  platform: process.platform,
  home: HOME,
});
logger.info('boot', { argv: process.argv.slice(2), cwd, ppid: process.ppid });

// Fabricate the cwd tree if missing — Bun.spawn would otherwise return ENOENT
// blaming the claude binary. The cleanup() unlinks any fabricated dirs right
// after spawn, since the kernel holds the cwd by inode reference once the
// child has chdir'd (which posix_spawn does before returning to us).
const ensured = ensureCwd(cwd);
if (!ensured.ok) {
  logger.error('ensure_cwd.failed', { cwd, error: ensured.error });
  process.stderr.write(`fnclaude: ${ensured.error}\n`);
  process.exit(2);
}
logger.info('ensure_cwd.ok', { cwd, created: ensured.created });

// §9.0: spawn claude via Bun.Terminal on POSIX so the launcher can tee PTY
// output through a ring buffer for cross-cwd resume detection (§9.1+). On
// Windows we fall back to stdio inherit until Bun.Terminal lands on win32.
// Non-TTY contexts (piped stdin, FNC_INTERNAL_DUMP_PLAN tests) also use the
// inherit shape — raw-mode forwarding requires a real terminal anyway.
const useTerminal =
  process.platform !== 'win32' &&
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true;

// Kernel routes Ctrl-C to the whole foreground pgrp; claude handles its
// own SIGINT. Swallow it here so fnc survives to read claude's exit code.
// Under Bun.Terminal the parent isn't in the same pgrp as the child, so
// these handlers mostly cover the inherit branch — harmless either way.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

// §9.1: capture the tail of PTY output for §9.2's cross-cwd detection.
// Hoisted here so it stays reachable after `proc.exited` resolves below.
// Only meaningful on the useTerminal branch; under stdio inherit the
// buffer stays empty and post-exit consumers will simply see no match.
const ringBuffer = new RingBuffer();

let exitCode: number;
// Captured so the post-exit handoff branch can await it (keeps the
// parent alive + foreground until the re-exec'd child exits).
let handoffAwaiter: Promise<void> | undefined;
// Stops the context-size monitor's poll timer on teardown. Only set on
// the useTerminal branch; left undefined under stdio inherit.
let contextMonitorStop: (() => void) | undefined;
try {
  let proc: Bun.Subprocess;
  if (useTerminal) {
    // Tee PTY output → process.stdout AND the ring buffer. §9.3 consumes
    // the buffer after exit to scan for claude's cross-cwd resume hint.
    const term = new Bun.Terminal({
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      data: (_t, chunk) => {
        process.stdout.write(chunk);
        ringBuffer.push(chunk);
      },
    });

    proc = Bun.spawn([claudeBin.path, ...claudeArgs], {
      cwd,
      env: childEnv,
      terminal: term,
    });
    logger.info('claude.spawn', { claudePid: proc.pid, cwd });

    // Bind the slash-injection writer to the live PTY input — the same
    // path user keystrokes take below. The MCP tool handlers wired before
    // spawn now route into this terminal.
    slashWriter.bind((payload: string) => {
      term.write(payload);
    });

    // Forward user stdin → PTY. Raw mode so the shell line discipline
    // doesn't eat control sequences (Ctrl-C, arrow keys, etc.) before
    // claude sees them. bun#25779 (control bytes not delivering signals
    // through Bun.Terminal.write) was fixed before 1.3.14 — verified
    // empirically on this version; no byte-interception workaround
    // needed.
    process.stdin.setRawMode(true);
    process.stdin.on('data', (chunk: Buffer) => {
      term.write(chunk);
    });

    // SIGWINCH no longer reaches claude directly (the PTY is owned by the
    // launcher), so plumb terminal resizes through manually.
    process.stdout.on('resize', () => {
      term.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    });

    // §9.0 / #170 part 2: context-size monitor. Polls the live session
    // JSONL's latest-turn context size and, the FIRST time it crosses the
    // threshold, injects ONE plain-text notice line into the PTY via the
    // same raw `term.write` seam user keystrokes go through — suggesting
    // the model call request_compact at a clean stopping point. Latches
    // off after firing. Threshold defaults to 200k, overridable via
    // [context] notice_threshold in config.toml or the
    // FNC_CONTEXT_NOTICE_THRESHOLD env var.
    contextMonitorStop = startContextMonitor({
      launchCWD: cwd,
      threshold: resolveContextNoticeThreshold({ configThreshold: config.contextNoticeThreshold }),
      write: (payload) => {
        term.write(payload);
      },
    }).stop;
  } else {
    proc = Bun.spawn([claudeBin.path, ...claudeArgs], {
      cwd,
      env: childEnv,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    logger.info('claude.spawn', { claudePid: proc.pid, cwd });
  }

  ensured.cleanup();
  logger.info('ensure_cwd.cleanup', { removed: ensured.created });

  // §8.5: arm the kill-and-exec awaiter as a side-promise. If an MCP
  // tool dispatches a handoff during the session, the awaiter wakes,
  // SIGTERMs claude (escalating to SIGKILL after 200 ms if needed),
  // waits for proc.exited, then re-execs fnclaude with the stashed
  // argv via Bun.spawn (no native execve binding — see decisions.md).
  // If no handoff fires, this promise sits idle until process exit
  // and gets GC'd; the orphaned-promise pattern matches Go canonical's
  // background goroutine. design.mcp.md §6.
  //
  // Captured (not voided): the handoff teardown branch below awaits it
  // so the parent stays alive + in the controlling tty's foreground
  // process group until the re-exec'd child exits. Without that, the
  // main flow's `process.exit` races the re-exec and, if it wins,
  // orphans the child → its setRawMode(true) hits EIO. See the
  // post-exit teardown decision below.
  handoffAwaiter = startHandoffAwaiter({
    trigger: handoffTrigger,
    proc,
  });

  exitCode = await proc.exited;
  logger.info('claude.exit', { code: exitCode, signal: proc.signalCode ?? null });
} finally {
  // Stop the MCP listener + unlink the socket file even if spawn or
  // proc.exited throws. design.mcp.md §7 — socket file cleanup is the
  // parent's job.
  if (mcpListenerStop !== undefined) {
    await mcpListenerStop();
  }
  // Stop the context-size monitor's poll timer (idempotent; no-op if it
  // already latched off after firing).
  if (contextMonitorStop !== undefined) {
    contextMonitorStop();
  }
}

// §8.5: decide who owns shutdown. When an MCP handoff (restart / project
// transfer) has stashed argv, the awaiter side-promise owns the relaunch
// and the parent must NOT run its own teardown+exit tail — doing so races
// the spawn-based re-exec and, if the self-exit wins, orphans the child
// out of the tty's foreground process group → its setRawMode(true) hits
// EIO (errno 5). In that case we hand the tty over: release the parent's
// stdin reader (so the child reads the tty alone) and leave termios to the
// child, then await the awaiter (which keeps the parent alive + foreground
// until the child exits, then process.exits with its code).
const teardown = decidePostExitTeardown({
  handoffStashed: handoffTrigger.getStashedArgv() !== null,
  useTerminal,
});

if (teardown.kind === 'defer-to-handoff') {
  logger.info('relaunch.handoff', {});
  if (teardown.releaseStdin) {
    // Stop forwarding our stdin → PTY so the re-exec'd child owns the
    // tty input fd exclusively. We deliberately do NOT setRawMode(false):
    // the child re-enters raw mode, and flipping cooked here then having
    // the child flip raw races the window where the child isn't yet
    // foreground. Leave termios as the child expects to find it.
    process.stdin.pause();
  }
  // Wait for the awaiter to SIGTERM claude (already done by now), reexec
  // the child, and process.exit with the child's code. handoffAwaiter is
  // always set here — it's armed unconditionally after spawn, before the
  // trigger could ever fire.
  await handoffAwaiter;
  // Unreachable: reexecSelf inside the awaiter calls process.exit. Guard
  // against a never-resolving await (e.g. a bug in the awaiter path)
  // hanging the parent on a dead tty.
  process.exit(exitCode);
}

if (teardown.restoreRawMode) {
  // Restore the terminal so the user's shell prompt comes back in cooked
  // mode. setRawMode is a no-op when stdin isn't a TTY; we only entered
  // raw mode in the useTerminal branch, so this is safe to call.
  process.stdin.setRawMode(false);
}
if (teardown.releaseStdin) {
  // Stop reading stdin so process.exit doesn't block on an open listener.
  process.stdin.pause();
}

// §9.3: cross-cwd silent relaunch. After a clean exit, scan the ring
// buffer for claude's "To resume, run: cd X && claude --resume UUID"
// hint and silently re-exec fnclaude in the new cwd. Gated to skip
// when an MCP handoff has already stashed argv (that path owns the
// relaunch) and when claude exited non-zero (don't relaunch on a
// crash). On Windows the ring buffer stays empty (inherit branch), so
// the decision always returns false there — keeps the call shape
// platform-uniform without a separate guard.
const crossCwdDecision = decideCrossCwdRelaunch({
  exitCode,
  alreadyStashed: handoffTrigger.getStashedArgv() !== null,
  ringSnapshot: ringBuffer.snapshot(),
  origArgs: argv,
  // Loop guard: claude resolves `--resume <uuid>` only from the cwd whose
  // project-dir encoding hosts `<uuid>.jsonl`. Orphaned worktree sessions
  // (recorded cwd encodes to a different dir than the jsonl is filed under,
  // e.g. a worktree that's since been removed) would relaunch into a cwd
  // where claude can't find the session → it bounces to the picker → the
  // user re-picks → claude re-emits the hint → infinite loop. Probe the
  // filesystem so the decision can refuse the futile relaunch.
  sessionExists: (cwd, uuid) => existsSync(sessionJSONLPath(cwd, uuid)),
});
if (crossCwdDecision.relaunch) {
  // Stash so future getStashedArgv() callers see this relaunch as
  // owned. The cross-cwd path is "silent" — we skip the warnings
  // flush below; the new fnclaude process re-evaluates and re-queues
  // anything still applicable.
  handoffTrigger.stashArgv(crossCwdDecision.argv);
  logger.info('relaunch.cross_cwd', { argv: crossCwdDecision.argv });
  await reexecSelf({ argv: crossCwdDecision.argv });
  // Unreachable: reexecSelf calls process.exit. Typed as Promise<never>.
} else if (
  'reason' in crossCwdDecision &&
  crossCwdDecision.reason === 'unresolvable'
) {
  // Break the picker loop: claude pointed us at a cwd that doesn't host
  // the session (typically an orphaned worktree session). Relaunching
  // there would just bounce back to the picker. Tell the user plainly
  // and stop instead of spinning.
  logger.warn('relaunch.unresolvable', {
    cwd: crossCwdDecision.cwd,
    uuid: crossCwdDecision.uuid,
  });
  process.stderr.write(
    `fnclaude: cannot resume session ${crossCwdDecision.uuid} — its recorded ` +
      `directory (${crossCwdDecision.cwd}) no longer hosts the session log. ` +
      `This usually means the session ran in a worktree that has since been ` +
      `removed. Resume it from the directory where it was created, or start ` +
      `a fresh session.\n`,
  );
}

// Flush accumulated warnings to stderr now that claude has exited and the
// user is back at their shell prompt where they have time to read them.
// Silent-relaunch paths (cross-cwd resume above; MCP handoff via the
// awaiter side-promise) skip this flush — the new fnclaude process
// re-evaluates and re-queues any still-applicable warnings.
warnings.flush(process.stderr);

process.exit(exitCode);
