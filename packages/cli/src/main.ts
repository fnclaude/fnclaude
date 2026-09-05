// `fnc`: the pre-DI dispatcher. It reads argv, short-circuits help/version and the
// internal dump hooks without building a container, forks to the MCP subprocess and
// `fnc install -y` roles, and otherwise builds the frozen LaunchPlan (the plan root)
// and hands it to the run code path.
//
// The plan pipeline (config load through the argv-rewriting phases) lives in the
// Planner and its phase services (src/launch/*, src/entry/plan.ts). The run code
// path below is still hand-wired against the LaunchPlan until PR-4 lands the run root.

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { readArgv } from './argv/intake';
import { buildLaunchPlan } from './entry/plan';
import { runInstall } from './entry/install';
import { runMcpServer } from './entry/mcp';
import { LaunchAbort, type LaunchInputs, type LaunchPlan } from './launch/contracts';

import { configuredPaths } from './config/configured';
import { getVersion, helpText, wantsHelp, wantsVersion } from './help-version';
import { reexecSelf, startHandoffAwaiter } from './handoff/awaiter';
import { decidePostExitTeardown } from './handoff/post-exit-teardown';
import { handoffTrigger } from './handoff/trigger';
import { bootFields } from './log/boot';
import { initLogging } from './log/init';
import { decideCrossCwdRelaunch } from './launch/cross-cwd-relaunch';
import { readLivePermissionMode, sessionJSONLPath } from './launch/live-permission-reader';
import { RingBuffer } from './launch/ring-buffer';
import { makeSessionJsonlReady, seedUltracodePrompt } from './launch/seed-prompt';
import { isInstallSubcommand, parseInstallFlags } from './install/subcommand';
import { isMcpSubcommand } from './mcp/dispatch';
import { handleCopyToClipboard } from './mcp/handlers/clipboard';
import { createGetUsageHandler } from './mcp/handlers/get-usage';
import { createPtyWriterHolder } from './mcp/handlers/inject-slash';
import {
  createOobeAnswerHandler,
  createOobeNextHandler,
  createOobeReaskHandler,
} from './mcp/handlers/oobe';
import { createRestartHandler } from './mcp/handlers/restart';
import { createControlSeamHolder, createPtyControlSeam } from './mcp/handlers/send-control';
import {
  createRequestCompactHandler,
  createRunSlashCommandHandler,
  createSetEffortHandler,
  createSetModelHandler,
} from './mcp/handlers/slash-tools';
import { createSpawnHandler } from './mcp/handlers/spawn';
import { createSwitchHandler } from './mcp/handlers/switch';
import { startMcpListener } from './mcp/listener';
import { createParentDispatcher, stubParentHandlers } from './mcp/parent-dispatch';
import { buildApplyPlan, describeApplyPlan } from './oobe/apply';
import { detectSpawnCandidates, detectTools } from './oobe/detect';
import { OobeState } from './oobe/state';
import { resolvePromptsDir } from './prompts/dir';
import { deriveAutoCompactThreshold } from './usage/autocompact-threshold';
import { resolveContextNoticeLadder, startContextMonitor } from './usage/context-monitor';
import { makeOwnSessionFileResolver } from './usage/proc-session-id';
import { createWarningBuffer } from './warnings/buffer';

const argv = readArgv();

// Internal test hook: dump raw argv before any other work. Lets e2e tests
// verify the preflight + intake chain preserves `--` without spawning anything.
if (process.env.FNC_INTERNAL_DUMP_ARGV === '1') {
  process.stdout.write(`${JSON.stringify(argv)}\n`);
  process.exit(0);
}

// help/version never build a container.
if (wantsHelp(argv)) {
  process.stdout.write(helpText);
  process.exit(0);
}
if (wantsVersion(argv)) {
  const version = await getVersion();
  process.stdout.write(`fnc ${version}\n`);
  process.exit(0);
}

// MCP subprocess role: dispatch to the (PR-5-pending) MCP entry, which runs today's
// code path unchanged. No launch container is built for it.
if (isMcpSubcommand(argv)) {
  process.exit(await runMcpServer(argv.slice(1)));
}

// The frozen argv/env product every launch phase composes against.
const xdgEnv = {
  home: homedir(),
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  xdgStateHome: process.env.XDG_STATE_HOME,
};
const inputs: LaunchInputs = {
  argv,
  shellCwd: process.cwd(),
  home: homedir(),
  xdg: xdgEnv,
  env: process.env,
  platform: process.platform,
  pid: process.pid,
  execPath: process.execPath,
  binPath: process.argv[1] ?? '',
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
};

// `fnc install -y` role: the install mini-root. Bare `fnc install` (no `-y`) is a
// wizard launch and falls through to the plan with the OOBE overlay.
if (isInstallSubcommand(argv)) {
  const parsedInstall = parseInstallFlags(argv.slice(1));
  if (!parsedInstall.ok || parsedInstall.flags === undefined) {
    process.stderr.write(
      `fnclaude: ${parsedInstall.error ?? 'could not parse `fnc install` flags'}\n`,
    );
    process.exit(2);
  }
  if (parsedInstall.flags.yes) {
    process.exit(
      await runInstall({
        flags: parsedInstall.flags,
        xdg: xdgEnv,
        binPath: inputs.binPath,
        shellCwd: inputs.shellCwd,
      }),
    );
  }
}

// Kernel routes Ctrl-C to the whole foreground pgrp; claude handles its own SIGINT.
// Swallow both here so fnc survives to read claude's exit code. These no-ops live in
// the dispatcher and are never installed by a DI primitive (doctrine 6).
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

// Build the launch plan (the plan root). A terminal plan error is a preformatted
// stderr line plus an exit code, surfaced here rather than from inside a container.
let plan: LaunchPlan;
try {
  plan = await buildLaunchPlan(inputs);
} catch (err) {
  if (err instanceof LaunchAbort) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.code);
  }
  throw err;
}

// Internal test hook: dump the launch plan as JSON and exit 0 BEFORE spawning claude.
// Only env values fnclaude actively manages are dumped, to keep snapshots predictable.
if (process.env.FNC_INTERNAL_DUMP_PLAN === '1') {
  const childEnv = plan.env;
  const dumpEnv: Record<string, string> = {};
  if (plan.config.execEnv !== undefined) {
    for (const k of Object.keys(plan.config.execEnv)) {
      if (k in childEnv) dumpEnv[k] = childEnv[k]!;
    }
  }
  if ('FNCLAUDE_HANDOFF' in childEnv) dumpEnv.FNCLAUDE_HANDOFF = childEnv.FNCLAUDE_HANDOFF!;
  if ('FNC_SOCKET' in childEnv) dumpEnv.FNC_SOCKET = childEnv.FNC_SOCKET!;
  if ('FNC_OOBE' in childEnv) dumpEnv.FNC_OOBE = childEnv.FNC_OOBE!;
  process.stdout.write(
    `${JSON.stringify({
      cwd: plan.launchCWD,
      claudeArgs: plan.claudeArgv,
      usedNoopFallback: plan.usedNoopFallback,
      env: dumpEnv,
    })}\n`,
  );
  process.exit(0);
}

// ── run code path (hand-wired against the plan until PR-4) ────────────────────────

const cwd = plan.launchCWD;
const claudeArgs = plan.claudeArgv;
const childEnv = plan.env;
const config = plan.config;
const useTerminal = plan.useTerminal;
const mcpSocketPath = plan.socketPath;
const ownSessionId = plan.sessionID;

// Non-fatal warnings deferred from the plan phases flush after claude exits, so the
// user sees them at their shell rather than scrolled off by claude's TUI (§27).
const warnings = createWarningBuffer();
for (const w of plan.warnings) warnings.add(w);

// The claude binary was located during planning; a missing binary aborts here (after
// the dump-plan escape) so the dump never requires claude on PATH.
if (!plan.claudeBin.ok) {
  process.stderr.write(`${plan.claudeBin.error}\n`);
  process.exit(127);
}
const claudeBinPath = plan.claudeBin.path;

// #332: percentage context tiers resolve against the derived auto-compact point,
// computed per active model + the SAME child env claude sees.
const deriveNoticeThreshold = (model: string): number =>
  deriveAutoCompactThreshold({ model, env: childEnv });

// Wizard session state + handlers (built from frozen plan data). Only reachable in a
// bare `fnc install` launch; the subprocess gates the three OOBE tools on FNC_OOBE=1.
let oobeState: OobeState | null = null;
let oobeHandlerArgs: Parameters<typeof createOobeNextHandler>[0] | null = null;
if (plan.isOobeLaunch) {
  const tools = detectTools();
  const spawnCandidates = detectSpawnCandidates();
  oobeState = new OobeState({
    env: plan.xdg,
    tools,
    spawnCandidates,
    configured: await configuredPaths(plan.xdg),
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
        env: plan.xdg,
        answers: state.answersSnapshot(),
        shared: state.sharedAnswers(),
        hasFngit: tools.fngit,
        hasPlugin: tools.plugin,
      });
      lines.push('Applying:');
      lines.push(describeApplyPlan(actions));
      await applyAndReport({
        env: plan.xdg,
        actions,
        print: (line) => lines.push(line),
        state,
        packagedPromptsDir: packagedPrompts.dir,
      });
      // Setup done: hand the session back to the user's original intent by re-execing
      // fnc with the ORIGINAL argv, through the same trigger `fnc_restart` uses.
      handoffTrigger.stashArgv(argv.filter((a) => a !== 'install'));
      handoffTrigger.fire();
      return { summary: lines.join('\n') };
    },
  };
}

// Deferred-binding PTY writer for the slash-injection MCP tools (C0–C4). Bound to the
// live terminal after spawn; a write before bind is a no-op.
const slashWriter = createPtyWriterHolder();

// Deferred-binding tagged control seam (#299). Control messages sent before bind are
// queued, not dropped.
const controlSeam = createControlSeamHolder();

// Bind the MCP listener (Unix only). Must happen BEFORE the spawn so the subprocess
// claude launches per --mcp-config can dial back over $FNC_SOCKET. Bind failure is
// fatal (design.mcp.md §2.1).
let mcpListenerStop: (() => Promise<void>) | undefined;
if (mcpSocketPath !== undefined) {
  try {
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
        compact: createRequestCompactHandler({ sendControl: controlSeam.sendControl }),
        set_effort: createSetEffortHandler({ write: slashWriter.write }),
        set_model: createSetModelHandler({ write: slashWriter.write }),
        run_slash: createRunSlashCommandHandler({ write: slashWriter.write }),
        get_usage: createGetUsageHandler({ launchCWD: cwd }),
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

// Structured file logging. Best-effort, file-ONLY; initLogging never throws.
const { logger } = initLogging({
  env: process.env,
  platform: process.platform,
  home: homedir(),
});
logger.info('boot', bootFields(argv, cwd, process.ppid));

// §9.1: capture the tail of PTY output for §9.2's cross-cwd detection. Only meaningful
// on the useTerminal branch; under stdio inherit the buffer stays empty.
const ringBuffer = new RingBuffer();

let exitCode: number;
// Captured so the post-exit handoff branch can await it (keeps the parent alive +
// foreground until the re-exec'd child exits).
let handoffAwaiter: Promise<void> | undefined;
// Stops the context-size monitor's poll timer on teardown. Only set on the useTerminal
// branch; left undefined under stdio inherit.
let contextMonitorStop: (() => void) | undefined;
try {
  let proc: Bun.Subprocess;
  if (useTerminal) {
    const term = new Bun.Terminal({
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      data: (_t, chunk) => {
        process.stdout.write(chunk);
        ringBuffer.push(chunk);
      },
    });

    proc = Bun.spawn([claudeBinPath, ...claudeArgs], {
      cwd,
      env: childEnv,
      terminal: term,
    });
    logger.info('claude.spawn', { claudePid: proc.pid, cwd });

    slashWriter.bind((payload: string) => {
      term.write(payload);
    });

    const ptyControl = createPtyControlSeam({
      write: (payload: string) => {
        term.write(payload);
      },
    });
    controlSeam.bind(ptyControl.sendControl);

    if (plan.isUltracode && plan.ultracodeSeedPrompt !== '') {
      void seedUltracodePrompt({
        seedPrompt: plan.ultracodeSeedPrompt,
        write: (payload) => {
          term.write(payload);
        },
        waitForReady: makeSessionJsonlReady({ launchCWD: cwd }),
      });
    }

    process.stdin.setRawMode(true);
    process.stdin.on('data', (chunk: Buffer) => {
      ptyControl.noteUserInput(chunk.toString());
      term.write(chunk);
    });

    process.stdout.on('resize', () => {
      term.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    });

    contextMonitorStop = startContextMonitor({
      launchCWD: cwd,
      ladder: resolveContextNoticeLadder({
        configLadder: config.contextNoticeLadder,
        configThreshold: config.contextNoticeThreshold,
      }),
      deriveThreshold: deriveNoticeThreshold,
      sendControl: ptyControl.sendControl,
      ownSessionFile: makeOwnSessionFileResolver({
        upfrontId: ownSessionId,
        claudePid: proc.pid,
      }),
    }).stop;
  } else {
    proc = Bun.spawn([claudeBinPath, ...claudeArgs], {
      cwd,
      env: childEnv,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    logger.info('claude.spawn', { claudePid: proc.pid, cwd });
  }

  // §8.5: arm the kill-and-exec awaiter as a side-promise. If an MCP tool dispatches a
  // handoff during the session, the awaiter SIGTERMs claude, waits for proc.exited, then
  // re-execs fnclaude with the stashed argv. Captured so the handoff branch can await it.
  handoffAwaiter = startHandoffAwaiter({
    trigger: handoffTrigger,
    proc,
  });

  exitCode = await proc.exited;
  logger.info('claude.exit', { code: exitCode, signal: proc.signalCode ?? null });
} finally {
  // Stop the MCP listener + unlink the socket even if spawn or proc.exited throws.
  if (mcpListenerStop !== undefined) {
    await mcpListenerStop();
  }
  // Stop the context-size monitor's poll timer (idempotent).
  if (contextMonitorStop !== undefined) {
    contextMonitorStop();
  }
}

// §8.5: decide who owns shutdown. When an MCP handoff has stashed argv, the awaiter owns
// the relaunch and the parent must not run its own teardown+exit tail.
const teardown = decidePostExitTeardown({
  handoffStashed: handoffTrigger.getStashedArgv() !== null,
  useTerminal,
});

if (teardown.kind === 'defer-to-handoff') {
  logger.info('relaunch.handoff', {});
  if (teardown.releaseStdin) {
    process.stdin.pause();
  }
  await handoffAwaiter;
  process.exit(exitCode);
}

if (teardown.restoreRawMode) {
  process.stdin.setRawMode(false);
}
if (teardown.releaseStdin) {
  process.stdin.pause();
}

// §9.3: cross-cwd silent relaunch. After a clean exit, scan the ring buffer for claude's
// resume hint and silently re-exec fnclaude in the new cwd.
const crossCwdDecision = decideCrossCwdRelaunch({
  exitCode,
  alreadyStashed: handoffTrigger.getStashedArgv() !== null,
  ringSnapshot: ringBuffer.snapshot(),
  origArgs: argv,
  sessionExists: (probeCwd, uuid) => existsSync(sessionJSONLPath(probeCwd, uuid)),
});
if (crossCwdDecision.relaunch) {
  handoffTrigger.stashArgv(crossCwdDecision.argv);
  logger.info('relaunch.cross_cwd', { argv: crossCwdDecision.argv });
  await reexecSelf({ argv: crossCwdDecision.argv });
  // Unreachable: reexecSelf calls process.exit.
} else if ('reason' in crossCwdDecision && crossCwdDecision.reason === 'unresolvable') {
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

// Flush accumulated warnings now that claude has exited and the user is back at their
// shell. Silent-relaunch paths above skip this by returning via execve.
warnings.flush(process.stderr);

process.exit(exitCode);
