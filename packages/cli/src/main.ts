// `fnc`: launch `claude` in the resolved cwd (or the noop fallback when
// no positional was given). Bun-only (top-level await, Bun.spawn).
//
// This file is the launcher entry. Argv parsing, path resolution, and
// feature transforms live in their own modules under src/; main composes
// them in order.

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { readArgv } from './argv/intake';
import { expandAliases } from './argv/expand';
import { parseArgs } from './argv/parse';
import { expandShortFlags } from './argv/short-flags';
import { loadConfig } from './config/load';
import {
  defaultNoopDir,
  fncConfigDir,
  promptOverridesDir,
} from './config/paths';
import { initLogging } from './log/init';
import { bootFields } from './log/boot';
import { reexecSelf, startHandoffAwaiter } from './handoff/awaiter';
import { decidePostExitTeardown } from './handoff/post-exit-teardown';
import { handoffTrigger } from './handoff/trigger';
import { getVersion, helpText, wantsHelp, wantsVersion } from './help-version';
import { composeEnv } from './launch/compose-env';
import { decideCrossCwdRelaunch } from './launch/cross-cwd-relaunch';
import { findClaude } from './launch/find-claude';
import { readLivePermissionMode, sessionJSONLPath } from './launch/live-permission-reader';
import { RingBuffer } from './launch/ring-buffer';
import { isMcpSubcommand, parseMcpFlags, runMcpServer } from './mcp/dispatch';
import { runInstallNonInteractive } from './install/run';
import {
  buildWizardArgs,
  isInstallSubcommand,
  parseInstallFlags,
  shouldRunOobe,
  WIZARD_SESSION_NAME,
} from './install/subcommand';
import { configuredPaths } from './config/configured';
import {
  createOobeAnswerHandler,
  createOobeNextHandler,
  createOobeReaskHandler,
} from './mcp/handlers/oobe';
import { buildApplyPlan, describeApplyPlan } from './oobe/apply';
import { detectSpawnCandidates, detectTools } from './oobe/detect';
import { OobeState } from './oobe/state';
import { handleCopyToClipboard } from './mcp/handlers/clipboard';
import { createGetUsageHandler } from './mcp/handlers/get-usage';
import { createPtyWriterHolder } from './mcp/handlers/inject-slash';
import { createControlSeamHolder, createPtyControlSeam } from './mcp/handlers/send-control';
import { createRestartHandler } from './mcp/handlers/restart';
import {
  createRequestCompactHandler,
  createRunSlashCommandHandler,
  createSetEffortHandler,
  createSetModelHandler,
} from './mcp/handlers/slash-tools';
import { createSpawnHandler } from './mcp/handlers/spawn';
import { createSwitchHandler } from './mcp/handlers/switch';
import { injectMcpConfig } from './mcp/inject-config';
import { startMcpListener } from './mcp/listener';
import { createParentDispatcher, stubParentHandlers } from './mcp/parent-dispatch';
import { computeSocketPath } from './mcp/socket-path';
import { autoName, shouldAutoName } from './name/auto-name';
import { AUTO_NAME_MODEL, AUTO_NAME_SYSTEM_PROMPT } from './name/llm-prompt';
import { sanitizeForPath } from './name/sanitize';
import { sdkLlmCall } from './name/sdk-llm';
import { findPromptSentinel, insertFlagsBeforeSentinel, promptBody } from './argv/sentinel';
import { makeSessionJsonlReady, seedUltracodePrompt } from './launch/seed-prompt';
import { seedNoopDir } from './noop/seed';
import { resolveTemplateSourcePath } from './noop/template-source';
import { ensureCwd } from './path/ensure-cwd';
import { expandTilde } from './path/resolve';
import { resolvePromptsDir } from './prompts/dir';
import { injectFragments, loadFragments } from './prompts/load';
import { isInteractiveSession, selectFragments } from './prompts/select';
import { findFngit, makeFngitRunner } from './repo/fngit';
import { resolveInput } from './repo/resolve-input';
import { deriveAutoCompactThreshold } from './usage/autocompact-threshold';
import { resolveContextNoticeLadder, startContextMonitor } from './usage/context-monitor';
import { planOwnSession } from './usage/own-session';
import { makeOwnSessionFileResolver } from './usage/proc-session-id';
import { createWarningBuffer } from './warnings/buffer';
import { shouldInjectTmux } from './worktree/auto-tmux';
import { listWorktrees } from './worktree/git-list';
import { applyWorktreeIntercept } from './worktree/intercept';

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

// Load fnc's config from $XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.*
// (specs/rhombus-rocks-config.md). Nothing reads Claude Code's settings.json
// any more: repo templates, source directories and host aliases all live in
// the shared rhombus.rocks config, which fngit — not fnc — reads.
const HOME = homedir();
const shellCwd = process.cwd();
const xdgEnv = {
  home: HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgStateHome: process.env.XDG_STATE_HOME,
};
const config = await loadConfig({ env: xdgEnv });

// fnc's starting directory: `noopDir` when set, else the default under the
// brand directory. `~` is expanded here so everything downstream sees an
// absolute path.
const noopDirPath =
  config.noopDir !== undefined && config.noopDir !== ''
    ? expandTilde(config.noopDir, HOME)
    : defaultNoopDir(xdgEnv);

// `fnc install` — the first-run setup. `-y` applies a plan straight from
// flags; bare `fnc install` launches a wizard session (below) that interviews
// the user. Handled here, after the config load, because both shapes need to
// know what is already configured in order to skip questions.
const installTail = isInstallSubcommand(argv) ? argv.slice(1) : null;
if (installTail !== null) {
  const parsedInstall = parseInstallFlags(installTail);
  if (!parsedInstall.ok || parsedInstall.flags === undefined) {
    process.stderr.write(`fnclaude: ${parsedInstall.error ?? 'could not parse `fnc install` flags'}\n`);
    process.exit(2);
  }
  if (parsedInstall.flags.yes) {
    const binForPrompts = process.argv[1] ?? '';
    const exeDirForPrompts =
      binForPrompts !== '' ? dirname(realpathSync(binForPrompts)) : process.cwd();
    const packaged = resolvePromptsDir({
      envOverride: process.env.FNC_PROMPTS_DIR,
      exeDir: exeDirForPrompts,
    });
    const result = await runInstallNonInteractive({
      env: xdgEnv,
      flags: parsedInstall.flags,
      configured: await configuredPaths(xdgEnv),
      packagedPromptsDir: packaged.dir,
    });
    process.exit(result.exitCode);
  }
  // Bare `fnc install`: fall through to the normal launch path with the
  // wizard flags set. Ref resolution is skipped entirely — there is no repo
  // argument, and `fnc install` run inside a directory that shares a name
  // with a repo must not start cloning.
}
const isOobeLaunch = installTail !== null;

// Resolve the first positional to a launch cwd. fnc owns three cases: no
// argument (the starting directory), an explicit path form, and stripping a
// `+workspace` suffix. Everything else is a repo reference and goes to the
// fngit CLI, which resolves and clones it and prints the path
// (specs/rhombus-rocks-config.md § "fngit CLI contract").
//
// fngit is optional. Without it on PATH the resolver accepts only real paths
// and errors on a repo reference with a message naming `fnc install`.
const fngitBin = findFngit();
const resolved = isOobeLaunch
  ? // A wizard launch resolves nothing: it runs in the shell cwd. Claude
    // Code's trust dialog is per-directory, so a scratch directory would
    // prompt for trust every run, and the directory the user is standing in
    // is the one most likely to be trusted already.
    ({ kind: 'launch', launchCwd: shellCwd, usedNoopFallback: false, workspace: '' } as const)
  : await resolveInput({
  input: parsed.firstPath,
  shellCwd,
  home: HOME,
  noopDir: noopDirPath,
  fngit: fngitBin === null ? null : makeFngitRunner(fngitBin),
  onProgress: (line) => process.stderr.write(`${line}\n`),
});

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

// `ultracode` effort: claude's --effort flag rejects the value, so it rides
// as the `/effort ultracode` initial-prompt slash command (runs on boot —
// verified: `claude -- "/effort ultracode"`). The user's actual prompt (if
// any) can't share that single prompt slot, so we capture it here as the
// seed to submit as a follow-up after claude is ready (useTerminal branch
// only). expandAliases already suppressed --effort for ultracode and the
// parser implied --model opus, same as any bare effort.
const isUltracode = parsedWithIntercept.effort === 'ultracode';
const ultracodeSeedPrompt = isUltracode
  ? promptBody(parsedWithIntercept.passthrough).join(' ').trim()
  : '';

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
  const body = promptBody(parsedWithIntercept.passthrough).join(' ').trim();
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

// Own-session pin: the context-size monitor must read THIS session's own
// JSONL, not guess the oldest post-baseline `*.jsonl` (which mis-pins a
// sibling's file when two sessions share a cwd — the second session then
// reports the first's token curve and is blind to its own growth). Since fnc
// spawns claude, it can KNOW the id: for a fresh interactive session it mints
// a UUID and injects `--session-id <uuid>`; for a resume / user-supplied id it
// parses the id; for --continue/fork/print it declines (monitor falls back to
// the legacy heuristic). The resolved id is threaded into the monitor below.
// See usage/own-session.ts for the full decision table.
//
// FNC_INTERNAL_DISABLE_SESSION_ID=1 is an internal test escape (mirrors
// FNC_INTERNAL_DISABLE_AUTONAME) — when set, no id is minted/injected so e2e
// arg-shape assertions don't see a random `--session-id <uuid>` pollute them.
const ownSessionPlan =
  process.env.FNC_INTERNAL_DISABLE_SESSION_ID === '1'
    ? { sessionId: null, inject: [] as readonly string[] }
    : planOwnSession(claudeArgs, () => randomUUID());
if (ownSessionPlan.inject.length === 2) {
  claudeArgs = insertFlagsBeforeSentinel(
    claudeArgs,
    ownSessionPlan.inject[0]!,
    ownSessionPlan.inject[1]!,
  );
}
const ownSessionId = ownSessionPlan.sessionId;

// Inject prompt fragments via --append-system-prompt. Selection depends on
// noop fallback + interactive (non-print) state of the session.
const fragmentNames = selectFragments({
  usedNoopFallback,
  passthrough: claudeArgs,
  oobe: isOobeLaunch,
});
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
    // A file in the user's override directory replaces the packaged fragment
    // of the same name (specs/rhombus-rocks-config.md § fnc prompt overrides).
    // Passed unconditionally: `resolveFragmentPath` treats a missing directory
    // as "nothing overridden", so there is nothing to check first.
    const loaded = loadFragments(fragmentNames, promptsDir.dir, promptOverridesDir(xdgEnv));
    for (const w of loaded.warnings) warnings.add(w);
    claudeArgs = injectFragments(claudeArgs, loaded.content);
  } else if (promptsDir.warning !== undefined) {
    warnings.add(promptsDir.warning);
  }
}

// Wizard-session lockdown. `oobe.md` asks the model to touch nothing in the
// cwd; these flags make that true whether or not it complies. Every write the
// setup performs happens inside fnc, after Apply.
//
// `--no-session-persistence` keeps the cwd's resume picker and history clean —
// there is nothing in a setup session worth resuming.
let oobeState: OobeState | null = null;
let oobeHandlerArgs: Parameters<typeof createOobeNextHandler>[0] | null = null;
if (isOobeLaunch) {
  claudeArgs = insertFlagsBeforeSentinel(
    claudeArgs,
    ...buildWizardArgs('').filter((t) => t !== '--append-system-prompt' && t !== ''),
    '--name',
    WIZARD_SESSION_NAME,
  );

  const tools = detectTools();
  const spawnCandidates = detectSpawnCandidates();
  oobeState = new OobeState({
    env: xdgEnv,
    tools,
    spawnCandidates,
    configured: await configuredPaths(xdgEnv),
  });

  const binForPrompts = process.argv[1] ?? '';
  const exeDirForPrompts =
    binForPrompts !== '' ? dirname(realpathSync(binForPrompts)) : process.cwd();
  const packagedPrompts = resolvePromptsDir({
    envOverride: process.env.FNC_PROMPTS_DIR,
    exeDir: exeDirForPrompts,
  });

  const state = oobeState;
  oobeHandlerArgs = {
    state,
    onApply: async () => {
      const { applyAndReport } = await import('./install/run');
      const lines: string[] = [];
      const actions = buildApplyPlan({
        env: xdgEnv,
        answers: state.answersSnapshot(),
        shared: state.sharedAnswers(),
        hasFngit: tools.fngit,
        hasPlugin: tools.plugin,
      });
      lines.push('Applying:');
      lines.push(describeApplyPlan(actions));
      await applyAndReport({
        env: xdgEnv,
        actions,
        print: (line) => lines.push(line),
        state,
        packagedPromptsDir: packagedPrompts.dir,
      });
      // Setup is done; hand the session back to the user's original intent by
      // re-execing fnc with the ORIGINAL argv, through the same trigger
      // `fnc_restart` uses. The re-exec resolves and clones normally.
      handoffTrigger.stashArgv(argv.filter((a) => a !== 'install'));
      handoffTrigger.fire();
      return { summary: lines.join('\n') };
    },
  };
}

// `claude.defaultArgs` from config — flags Claude Code has no persistent
// setting for, so fnc supplies them on every launch. Inserted before the `--`
// sentinel so a prompt body stays last, and BEFORE ultracode's rewrite so a
// default flag can't survive into the `/effort ultracode` slot. Explicit argv
// still wins: claude's own parser takes the last occurrence of a flag, and
// these are inserted ahead of nothing the user typed after them.
if (config.claudeDefaultArgs !== undefined && config.claudeDefaultArgs.length > 0) {
  claudeArgs = insertFlagsBeforeSentinel(claudeArgs, ...config.claudeDefaultArgs);
}

// Ultracode: rewrite the prompt positional so claude's single prompt slot is
// exactly `/effort ultracode`. Drop any user-prompt tokens that followed `--`
// (they're delivered as a follow-up via the seed-prompt step after spawn).
// Done after fragment injection (which keys off the prompt body) and before
// MCP injection, so `--mcp-config` still lands BEFORE this `--`.
if (isUltracode) {
  const sentIdx = findPromptSentinel(claudeArgs);
  const head = sentIdx < 0 ? claudeArgs : claudeArgs.slice(0, sentIdx);
  claudeArgs = [...head, '--', '/effort ultracode'];
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

// FNC_OOBE gates the three `fnc_oobe_*` tools in the MCP subprocess. It is set
// ONLY here, on the wizard session, so those tools stay out of the tool list
// everywhere else — a model that can see `fnc_oobe_next` in a normal session
// has no interview to advance and no reason to be tempted.
if (isOobeLaunch) childEnv.FNC_OOBE = '1';

// #332: percentage context-notice tiers ("94%") resolve against the derived
// Claude Code auto-compact threshold (100% = the auto-compact point), computed
// per active model + the child's env (surface/window overrides). We read the
// SAME env claude sees (childEnv), so setting CLAUDE_CODE_AUTO_COMPACT_WINDOW
// et al. moves claude's real behavior and this derivation in lockstep. The
// active model is supplied per tick by the context monitor's session reader.
const deriveNoticeThreshold = (model: string): number =>
  deriveAutoCompactThreshold({ model, env: childEnv });

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
  // The wizard gate, so an e2e test can assert the OOBE tools are registered
  // for `fnc install` and for nothing else.
  if ('FNC_OOBE' in childEnv) dumpEnv.FNC_OOBE = childEnv.FNC_OOBE!;
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

// Deferred-binding tagged control-injection seam (#299) for control traffic
// (context notices, /compact, follow-up handoffs). Built BEFORE the terminal
// exists; the /compact handler takes `controlSeam.sendControl` now and the
// real PTY seam binds once the terminal spawns. Control messages sent before
// bind are queued, not dropped.
const controlSeam = createControlSeamHolder();

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
        compact: createRequestCompactHandler({ sendControl: controlSeam.sendControl }),
        set_effort: createSetEffortHandler({ write: slashWriter.write }),
        set_model: createSetModelHandler({ write: slashWriter.write }),
        run_slash: createRunSlashCommandHandler({ write: slashWriter.write }),
        // get_usage returns structured budget data read from the session
        // JSONL; launchCWD is the encoded-cwd half of that path.
        get_usage: createGetUsageHandler({ launchCWD: cwd }),
        // The interview's three tools, bound to ONE state object for the
        // whole session. They are only reachable in a wizard launch: the
        // subprocess gates them on FNC_OOBE=1, which only this path sets.
        ...(oobeState !== null
          ? {
              oobe_next: createOobeNextHandler(oobeHandlerArgs!),
              oobe_answer: createOobeAnswerHandler(oobeHandlerArgs!),
              oobe_reask: createOobeReaskHandler(oobeHandlerArgs!),
            }
          : {}),
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
// overrides. design: specs/decisions.md.
const { logger } = initLogging({
  env: process.env,
  platform: process.platform,
  home: HOME,
});
logger.info('boot', bootFields(argv, cwd, process.ppid));

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

    // Tagged control seam (#299): control traffic (context notices, /compact,
    // follow-up handoffs) routes through this rather than the raw keystroke
    // injector, so it carries the structural marker AND — crucially — defers
    // around any line the user is mid-typing instead of splicing into it. The
    // stdin forwarder below feeds `noteUserInput` so the seam knows when a draft
    // is in flight.
    const ptyControl = createPtyControlSeam({
      write: (payload: string) => {
        term.write(payload);
      },
    });
    controlSeam.bind(ptyControl.sendControl);

    // Ultracode seed: claude booted under the `/effort ultracode` initial
    // prompt, which consumed its single prompt slot. If the user ALSO typed a
    // prompt, submit it as a follow-up once claude is ready — detected by its
    // session JSONL appearing under ~/.claude/projects/<cwd>/ (no fixed
    // delay; capped by a fallback so it always fires). Fire-and-forget side
    // promise — never blocks the main flow.
    if (isUltracode && ultracodeSeedPrompt !== '') {
      void seedUltracodePrompt({
        seedPrompt: ultracodeSeedPrompt,
        write: (payload) => {
          term.write(payload);
        },
        waitForReady: makeSessionJsonlReady({ launchCWD: cwd }),
      });
    }

    // Forward user stdin → PTY. Raw mode so the shell line discipline
    // doesn't eat control sequences (Ctrl-C, arrow keys, etc.) before
    // claude sees them. bun#25779 (control bytes not delivering signals
    // through Bun.Terminal.write) was fixed before 1.3.14 — verified
    // empirically on this version; no byte-interception workaround
    // needed.
    process.stdin.setRawMode(true);
    process.stdin.on('data', (chunk: Buffer) => {
      // Track draft state so a control message can't splice into a line the
      // user is mid-typing (#299), then forward the keystrokes to claude.
      ptyControl.noteUserInput(chunk.toString());
      term.write(chunk);
    });

    // SIGWINCH no longer reaches claude directly (the PTY is owned by the
    // launcher), so plumb terminal resizes through manually.
    process.stdout.on('resize', () => {
      term.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    });

    // §9.0 / #170 part 2: tiered context-size monitor. Polls the live
    // session JSONL's latest-turn context size and, each time it crosses a
    // new rung of the escalation ladder (consider → plan → now → urgent),
    // emits ONE notice through the tagged control seam (#299) — suggesting the
    // model call request_compact. Routing through the seam (not raw term.write)
    // means the notice carries the structural marker and never splices into a
    // line the user is mid-typing. A watermark suppresses re-fires on mere
    // growth and re-arms after a compaction drop. The ladder defaults to a
    // percentage ladder (76/82/88/94% + 2.5% repeat) that resolves against the
    // derived auto-compact point per active model/surface (#332), overridable
    // via [[context.notice_tiers]] / [context.notice_repeat] in config.toml
    // (each `at`/`every` a bare token count OR a "NN%" percentage), the legacy
    // [context] notice_threshold, or the FNC_CONTEXT_NOTICE_THRESHOLD env var
    // (precedence in resolveContextNoticeLadder).
    contextMonitorStop = startContextMonitor({
      launchCWD: cwd,
      ladder: resolveContextNoticeLadder({
        configLadder: config.contextNoticeLadder,
        configThreshold: config.contextNoticeThreshold,
      }),
      deriveThreshold: deriveNoticeThreshold,
      sendControl: ptyControl.sendControl,
      // Pin the monitor to THIS session's own JSONL by id (no oldest-mtime
      // guess). When the id is known up front, use it directly; when it isn't
      // (`fnc resume` bare/--continue/--fork/picker), resolve the REAL id from
      // the fnc MCP child's /proc environ (keyed on claude's pid) so the
      // identity path is still taken instead of guessing a sibling's file.
      ownSessionFile: makeOwnSessionFileResolver({
        upfrontId: ownSessionId,
        claudePid: proc.pid,
      }),
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
