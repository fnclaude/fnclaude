// `fnc`: the pre-DI dispatcher. It reads argv, short-circuits help/version and the
// internal dump hooks without building a container, forks to the MCP subprocess and
// `fnc install -y` roles, builds the frozen LaunchPlan (the plan root), and hands it
// to the run root (entry/run.ts) which owns the claude session and both execve tails.

import { homedir } from 'node:os';

import { readArgv } from './argv/intake';
import { buildLaunchPlan } from './entry/plan';
import { runInstall } from './entry/install';
import { runMcpServer } from './entry/mcp';
import { runSession } from './entry/run';
import { LaunchAbort, type LaunchInputs, type LaunchPlan } from './launch/contracts';

import { getVersion, helpText, wantsHelp, wantsVersion } from './help-version';
import { isInstallSubcommand, parseInstallFlags } from './install/subcommand';
import { isMcpSubcommand } from './mcp/dispatch';

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

// MCP subprocess role: dispatch to the MCP entry. No launch container is built for it.
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

// Run root: owns the claude session and both execve tails (entry/run.ts).
process.exit(await runSession(plan, argv));
