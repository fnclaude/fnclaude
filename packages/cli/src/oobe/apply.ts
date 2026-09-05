/**
 * Everything that happens after the user says Apply.
 *
 * Up to this point the wizard has only written to its own config file. This is
 * where it touches the system: creating the starting directory, installing
 * tools, seeding the prompt-override directory, and finally setting `noOobe`
 * so the interview doesn't run again.
 *
 * The plan is built as DATA first (`buildApplyPlan`) and executed second
 * (`runApplyPlan`). That split is what lets the Apply screen show "every file
 * that will be written and every command that will be run" and have it be the
 * truth rather than a description maintained alongside the code.
 *
 * fnc subsumes its dependencies' own interviews (owner, 2026-09-04): fngit's
 * questions and the plugin's are asked once, here, and the tools are then
 * driven NON-interactively with the collected answers. `fngit install` remains
 * a standalone wizard for people installing fngit on its own; it must never
 * prompt when fnc drives it, which is what `-y` guarantees.
 */

import { defaultNoopDir, fncConfigWritePath, promptOverridesDir, type XdgEnv } from '../config/paths';
import { expandTilde } from '../path/resolve';
import { type QuestionId } from './questions';

/** One thing the wizard will do, described well enough to preview. */
export type ApplyAction =
  | { kind: 'mkdir'; path: string; why: string }
  | { kind: 'seed-prompts'; path: string; why: string }
  | { kind: 'run'; command: readonly string[]; why: string }
  | { kind: 'write-config'; path: string; patch: Record<string, unknown>; why: string };

export interface BuildApplyPlanArgs {
  env: XdgEnv;
  /** Answers from the interview. */
  answers: ReadonlyMap<QuestionId, string | string[]>;
  /** Shared-config keys collected for `fngit install -y`. */
  shared: Record<string, unknown>;
  /** Already-installed tools, so an install isn't proposed twice. */
  hasFngit: boolean;
  hasPlugin: boolean;
}

/** The plugin's marketplace and name after the move to the rhombus.rocks org. */
export const PLUGIN_MARKETPLACE = 'rhombus-rocks/claude-plugins';
export const PLUGIN_NAME = 'worktree-paths';
export const PLUGIN_QUALIFIED = `${PLUGIN_NAME}@rhombus-rocks-claude-plugins`;
/** The pre-migration install, which `fnc install` swaps out when it finds it. */
export const OLD_PLUGIN_QUALIFIED = 'claude-code-worktree-paths@fnclaude-plugins';

function said(answers: BuildApplyPlanArgs['answers'], id: QuestionId, want: string): boolean {
  const v = answers.get(id);
  return (Array.isArray(v) ? v[0] : v) === want;
}

/**
 * Build the ordered list of actions. Order matters: fngit is installed before
 * `fngit install -y` runs, and `noOobe` is set last so an interruption
 * anywhere earlier leaves the interview still due.
 */
export function buildApplyPlan(args: BuildApplyPlanArgs): ApplyAction[] {
  const actions: ApplyAction[] = [];
  const { answers, env } = args;

  const noopAnswer = answers.get('noop-dir');
  const noopRaw = typeof noopAnswer === 'string' && noopAnswer !== '' ? noopAnswer : null;
  const noopPath = noopRaw === null ? defaultNoopDir(env) : expandTilde(noopRaw, env.home);
  actions.push({
    kind: 'mkdir',
    path: noopPath,
    why: "fnc's starting directory, for `fnc` with no path",
  });

  actions.push({
    kind: 'seed-prompts',
    path: promptOverridesDir(env),
    why: 'where a file overrides the packaged system prompt of the same name (README.txt only)',
  });

  const wantsFngit = said(answers, 'install-fngit', 'yes');
  if (wantsFngit && !args.hasFngit) {
    actions.push({
      kind: 'run',
      command: ['npm', 'install', '-g', '@rhombus.rocks/fngit'],
      why: 'resolves repo names and clones them',
    });
  }

  // Drive fngit's own installer non-interactively with what we already asked.
  // Only worth running when there is something to tell it.
  if ((wantsFngit || args.hasFngit) && Object.keys(args.shared).length > 0) {
    actions.push({
      kind: 'run',
      command: fngitInstallCommand(args.shared, said(answers, 'git-shim', 'yes')),
      why: 'writes the shared repos config and installs the git shim',
    });
  }

  if (said(answers, 'install-plugin', 'yes') && !args.hasPlugin) {
    actions.push({
      kind: 'run',
      command: ['claude', 'plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE],
      why: 'the marketplace the worktree-paths plugin lives in',
    });
    actions.push({
      kind: 'run',
      command: ['claude', 'plugin', 'install', PLUGIN_QUALIFIED],
      why: 'overrides where Claude Code puts worktrees and how it names branches',
    });
  }

  actions.push({
    kind: 'write-config',
    path: fncConfigWritePath(env),
    patch: { noOobe: true },
    why: "so this interview doesn't run again — re-run it with `fnc install`",
  });

  return actions;
}

/**
 * `fngit install -y …` with the answers fnc collected. `-y` is what keeps it
 * silent: fnc owns the interview, so fngit must never prompt when driven here.
 */
export function fngitInstallCommand(
  shared: Record<string, unknown>,
  gitShim: boolean,
): string[] {
  const cmd = ['fngit', 'install', '-y'];
  const clone = shared['repos.cloneTemplate'];
  if (typeof clone === 'string' && clone !== '') cmd.push('--clone-template', clone);
  const worktree = shared['repos.worktreeTemplate'];
  if (typeof worktree === 'string' && worktree !== '') cmd.push('--worktree-template', worktree);
  const dirs = shared['repos.additionalSrcDirs'];
  if (Array.isArray(dirs) && dirs.length > 0) {
    cmd.push('--additional-src-dirs', dirs.join(','));
  }
  // The plugin is installed by fnc directly (above), so fngit is told not to.
  cmd.push('--no-plugin');
  cmd.push(gitShim ? '--shadow-git' : '--no-shadow-git');
  return cmd;
}

/** A human-readable preview of one action, for the Apply screen. */
export function describeAction(a: ApplyAction): string {
  switch (a.kind) {
    case 'mkdir':
      return `create ${a.path} — ${a.why}`;
    case 'seed-prompts':
      return `create ${a.path} with a README.txt — ${a.why}`;
    case 'run':
      return `run \`${a.command.join(' ')}\` — ${a.why}`;
    case 'write-config':
      return `write ${JSON.stringify(a.patch)} to ${a.path} — ${a.why}`;
  }
}

/** The whole preview, as the Apply screen shows it. */
export function describeApplyPlan(actions: readonly ApplyAction[]): string {
  return actions.map((a) => `- ${describeAction(a)}`).join('\n');
}

export interface RunApplyPlanSeams {
  mkdirp: (path: string) => void;
  seedPrompts: (path: string) => void;
  run: (command: readonly string[]) => Promise<{ ok: boolean; stderr: string }>;
  writeConfig: (path: string, patch: Record<string, unknown>) => void;
}

export interface ApplyOutcome {
  /** Actions that completed. */
  done: string[];
  /** Actions that failed, with the reason. */
  failed: { action: string; reason: string }[];
}

/**
 * Execute the plan. A failed step does NOT abort the rest: a user whose
 * `npm install -g` fails for lack of permissions should still get their
 * starting directory, their config, and a clear list of what didn't work —
 * rather than a half-applied system and one error.
 *
 * `noOobe` is the exception in spirit: it is last in the plan, so it is only
 * reached once everything before it has been attempted.
 */
export async function runApplyPlan(
  actions: readonly ApplyAction[],
  seams: RunApplyPlanSeams,
): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { done: [], failed: [] };
  for (const action of actions) {
    const label = describeAction(action);
    try {
      switch (action.kind) {
        case 'mkdir':
          seams.mkdirp(action.path);
          break;
        case 'seed-prompts':
          seams.seedPrompts(action.path);
          break;
        case 'write-config':
          seams.writeConfig(action.path, action.patch);
          break;
        case 'run': {
          const r = await seams.run(action.command);
          if (!r.ok) {
            out.failed.push({ action: label, reason: r.stderr || 'command failed' });
            continue;
          }
          break;
        }
      }
      out.done.push(label);
    } catch (err) {
      out.failed.push({ action: label, reason: (err as Error).message });
    }
  }
  return out;
}
