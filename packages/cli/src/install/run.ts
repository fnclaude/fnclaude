/**
 * Running `fnc install`.
 *
 * Two entry points, one plan builder:
 *
 *   {@link runInstallNonInteractive} — `-y --flags`. Feeds the flags straight
 *   into the same {@link OobeState} the interview drives, then applies. No
 *   claude, no session, no prompts; this is the dotfiles path.
 *
 *   {@link planWizardLaunch} — bare `fnc install`. Produces the launch plan
 *   for the wizard session; `main.ts` spawns it exactly as it spawns any other
 *   claude session, so the PTY, MCP socket, and env composition are unchanged.
 *
 * The MCP handlers for the wizard bind to the same state object, so the two
 * paths differ only in who supplies the answers.
 */

import { mkdirSync } from 'node:fs';

import { defaultNoopDir, promptOverridesDir, sharedConfigDir, type XdgEnv } from '../config/paths';
import { writeFncConfig } from '../config/write';
import { ensureOverridesDir } from '../prompts/overrides';
import {
  type ApplyAction,
  buildApplyPlan,
  describeApplyPlan,
  runApplyPlan,
} from '../oobe/apply';
import { runClaudeMdScan } from '../oobe/claude-md-scan';
import { detectSpawnCandidates, detectTools, type ToolPresence } from '../oobe/detect';
import { closingNote, type QuestionId } from '../oobe/questions';
import { OobeState } from '../oobe/state';
import { type InstallFlags, flagsToAnswers } from './subcommand';
import { join } from 'node:path';

export interface RunInstallArgs {
  env: XdgEnv;
  flags: InstallFlags;
  /** Config keys already set on disk, as dotted paths. */
  configured: ReadonlySet<string>;
  /** Detected tools. Injected in tests; defaults to real detection. */
  tools?: ToolPresence;
  /** Where the packaged prompts live, for the override README. */
  packagedPromptsDir: string | null;
  /** Output sink. Defaults to stdout. */
  print?: (line: string) => void;
  /** Command runner for the install steps. Defaults to a real spawn. */
  run?: (command: readonly string[]) => Promise<{ ok: boolean; stderr: string }>;
  /** Read seam for the `~/.claude/CLAUDE.md` scan. */
  readClaudeMd?: (path: string) => string | null;
  /** Config write seam. Defaults to the real writer. */
  writeConfig?: (path: string, patch: Record<string, unknown>) => void;
  /** Directory-creation seam. Defaults to a real recursive mkdir. */
  mkdirp?: (path: string) => void;
  /** Prompt-override seeding seam. Defaults to `ensureOverridesDir`. */
  seedPrompts?: (path: string) => void;
}

export interface InstallOutcome {
  /** 0 on success, 1 when any action failed. */
  exitCode: number;
  /** The actions that were planned, for a caller that wants to show them. */
  actions: ApplyAction[];
}

function defaultRun(command: readonly string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn([...command], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return Promise.all([new Response(proc.stderr).text(), proc.exited]).then(([stderr, code]) => ({
    ok: code === 0,
    stderr: stderr.trim(),
  }));
}

/**
 * `fnc install -y [--flags]`.
 *
 * Every flag becomes an answer, the answers go through the same state object
 * the interview uses (so config writes and coercions are identical), and the
 * plan is applied. Questions with no flag are simply unanswered — a `-y` run
 * configures what it was told to and leaves the rest alone, rather than
 * silently choosing defaults the user never saw.
 */
export async function runInstallNonInteractive(args: RunInstallArgs): Promise<InstallOutcome> {
  const print = args.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const tools = args.tools ?? detectTools();
  const state = new OobeState({
    env: args.env,
    tools,
    spawnCandidates: detectSpawnCandidates(),
    configured: args.configured,
    ...(args.writeConfig !== undefined ? { writeFnc: args.writeConfig } : {}),
  });

  const answers = flagsToAnswers(args.flags);
  for (const [id, value] of answers) {
    const result = state.answer(id, value);
    if (!result.ok) {
      print(`fnc install: ${result.error ?? `could not record ${id}`}`);
      return { exitCode: 1, actions: [] };
    }
  }

  const actions = buildApplyPlan({
    env: args.env,
    answers: answers as ReadonlyMap<QuestionId, string | string[]>,
    shared: state.sharedAnswers(),
    hasFngit: tools.fngit,
    hasPlugin: tools.plugin,
  });

  print('fnc install will:');
  print(describeApplyPlan(actions));

  const outcome = await applyAndReport({ ...args, actions, print, state });
  return { exitCode: outcome.failed.length > 0 ? 1 : 0, actions };
}

/**
 * Run the plan, print the closing note, and report anything that failed.
 * Shared by the interactive and non-interactive paths so the two produce the
 * same output for the same plan.
 */
export async function applyAndReport(args: {
  env: XdgEnv;
  actions: readonly ApplyAction[];
  print: (line: string) => void;
  state: OobeState;
  packagedPromptsDir: string | null;
  run?: RunInstallArgs['run'];
  readClaudeMd?: RunInstallArgs['readClaudeMd'];
  writeConfig?: RunInstallArgs['writeConfig'];
  mkdirp?: RunInstallArgs['mkdirp'];
  seedPrompts?: RunInstallArgs['seedPrompts'];
}): Promise<{ failed: { action: string; reason: string }[] }> {
  const outcome = await runApplyPlan(args.actions, {
    mkdirp: args.mkdirp ?? ((path: string) => mkdirSync(path, { recursive: true })),
    seedPrompts:
      args.seedPrompts ??
      ((path: string) => {
        ensureOverridesDir({ dir: path, packagedDir: args.packagedPromptsDir });
      }),
    run: args.run ?? defaultRun,
    writeConfig: args.writeConfig ?? writeFncConfig,
  });

  for (const line of outcome.done) args.print(`  ✓ ${line}`);
  for (const f of outcome.failed) args.print(`  ✗ ${f.action}\n      ${f.reason}`);

  args.print('');
  args.print(
    closingNote(join(sharedConfigDir(args.env), 'config.json'), promptOverridesDir(args.env)),
  );

  const scan = runClaudeMdScan({
    path: join(args.env.home, '.claude', 'CLAUDE.md'),
    ...(args.readClaudeMd !== undefined ? { read: args.readClaudeMd } : {}),
  });
  if (scan !== null) {
    args.print('');
    args.print(scan);
  }

  return { failed: outcome.failed };
}

export interface WizardLaunchPlan {
  /** The directory to launch in: the shell cwd, unchanged. */
  cwd: string;
  /** Env additions for the wizard session. */
  env: Record<string, string>;
  /** True — a wizard launch never resolves a repo reference. */
  skipRefResolution: true;
}

/**
 * The launch plan for a bare `fnc install`.
 *
 * The cwd is the SHELL cwd, deliberately: Claude Code's trust dialog is
 * per-directory, so a scratch directory would prompt for trust every single
 * run, and the directory the user is standing in is the one most likely to be
 * trusted already. It is also what they expect.
 *
 * `FNC_OOBE=1` is what registers the three `fnc_oobe_*` tools; they stay out
 * of the tool list in every other session.
 */
export function planWizardLaunch(shellCwd: string): WizardLaunchPlan {
  return {
    cwd: shellCwd,
    env: { FNC_OOBE: '1' },
    skipRefResolution: true,
  };
}

/** The default starting directory, for a caller that needs it before answers. */
export function defaultStartingDir(env: XdgEnv): string {
  return defaultNoopDir(env);
}
