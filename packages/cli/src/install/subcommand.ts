/**
 * `fnc install` — the first-run setup, in two shapes.
 *
 *   `fnc install`               launches a wizard session and interviews you
 *   `fnc install -y [--flags]`  applies the same plan with no questions
 *
 * Both go through the SAME plan builder. That is the point of the split: the
 * dotfiles path and the interactive path can't drift, because there is only
 * one description of what setup means.
 *
 * The wizard session is a real `claude` session, launched with `oobe.md`
 * injected INSTEAD of `noop-router.md`, and locked down:
 *
 *   - `--no-session-persistence`, so it leaves no resume entry and no history
 *     in the directory it runs in;
 *   - `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash` and
 *     `--permission-mode default`, so the model MECHANICALLY cannot dirty the
 *     cwd even if it ignores the prompt. Every write happens in fnc, after
 *     Apply. The prompt says so; this makes it true.
 *   - no `--resume`, `--continue`, or `-w`: this is a fresh, one-off session.
 *
 * It runs in the SHELL CWD, not a scratch directory. Claude Code's trust
 * dialog is per-directory (`~/.claude.json`), so a temp dir would prompt for
 * trust on every run; the directory the user is standing in is the one most
 * likely to be trusted already, and it is the behaviour they expect. The cost
 * is that the cwd project's CLAUDE.md and hooks load into the wizard, which
 * the tool lockdown above contains.
 *
 * Ref resolution is skipped entirely in this mode — there is no repo argument
 * to resolve, and `fnc install` in a directory that happens to share a name
 * with a repo must not go cloning. After Apply, fnc re-execs with the ORIGINAL
 * argv through the same trigger `fnc_restart` uses, so the re-exec resolves
 * and clones normally.
 */

import { type QuestionId } from '../oobe/questions';

/** Long-form flags `fnc install -y` accepts, one per interview question. */
export interface InstallFlags {
  /** Non-interactive. Without it, `fnc install` launches the wizard. */
  yes: boolean;
  fngit?: boolean;
  plugin?: boolean;
  gitShim?: boolean;
  cloneTemplate?: string;
  worktreeTemplate?: string;
  branchTemplate?: string;
  additionalSrcDirs?: string;
  noopDir?: string;
  spawnCommand?: string;
  tmux?: string;
  handoff?: string;
  claudeArgs?: string;
}

export interface ParseInstallFlagsResult {
  ok: boolean;
  flags?: InstallFlags;
  error?: string;
}

/** Is this argv an `fnc install` invocation? */
export function isInstallSubcommand(args: readonly string[]): boolean {
  return args[0] === 'install';
}

const VALUE_FLAGS = new Map<string, keyof InstallFlags>([
  ['--clone-template', 'cloneTemplate'],
  ['--worktree-template', 'worktreeTemplate'],
  ['--branch-template', 'branchTemplate'],
  ['--additional-src-dirs', 'additionalSrcDirs'],
  ['--noop-dir', 'noopDir'],
  ['--spawn-command', 'spawnCommand'],
  ['--tmux', 'tmux'],
  ['--handoff', 'handoff'],
  ['--claude-args', 'claudeArgs'],
]);

const BOOL_FLAGS = new Map<string, { key: keyof InstallFlags; value: boolean }>([
  ['--fngit', { key: 'fngit', value: true }],
  ['--no-fngit', { key: 'fngit', value: false }],
  ['--plugin', { key: 'plugin', value: true }],
  ['--no-plugin', { key: 'plugin', value: false }],
  ['--git-shim', { key: 'gitShim', value: true }],
  ['--no-git-shim', { key: 'gitShim', value: false }],
]);

/**
 * Parse the tail after `install`. Unknown flags are an error rather than being
 * ignored: this command writes config and installs software, and a silently
 * dropped `--clone-template` would be discovered much later, by which time
 * repos are in the wrong place.
 */
export function parseInstallFlags(tail: readonly string[]): ParseInstallFlagsResult {
  const flags: InstallFlags = { yes: false };
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i]!;
    if (tok === '-y' || tok === '--yes') {
      flags.yes = true;
      continue;
    }
    const bool = BOOL_FLAGS.get(tok);
    if (bool !== undefined) {
      (flags as unknown as Record<string, unknown>)[bool.key] = bool.value;
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const valueKey = VALUE_FLAGS.get(name);
    if (valueKey !== undefined) {
      const value = eq > 0 ? tok.slice(eq + 1) : tail[++i];
      if (value === undefined) {
        return { ok: false, error: `${name} needs a value` };
      }
      (flags as unknown as Record<string, unknown>)[valueKey] = value;
      continue;
    }
    return { ok: false, error: `unknown flag for \`fnc install\`: ${tok}` };
  }
  return { ok: true, flags };
}

/**
 * Turn parsed flags into the same answer map the interview produces, so the
 * non-interactive path feeds the identical plan builder.
 *
 * Only flags actually given become answers. An absent flag is NOT a "no": it
 * means the question was not answered, so a `-y` run configures exactly what
 * was asked for and leaves the rest alone.
 */
export function flagsToAnswers(flags: InstallFlags): Map<QuestionId, string | string[]> {
  const answers = new Map<QuestionId, string | string[]>();
  const yn = (v: boolean): string => (v ? 'yes' : 'no');
  if (flags.fngit !== undefined) answers.set('install-fngit', yn(flags.fngit));
  if (flags.plugin !== undefined) answers.set('install-plugin', yn(flags.plugin));
  if (flags.gitShim !== undefined) answers.set('git-shim', yn(flags.gitShim));
  if (flags.cloneTemplate !== undefined) answers.set('clone-template', flags.cloneTemplate);
  if (flags.worktreeTemplate !== undefined) answers.set('worktree-template', flags.worktreeTemplate);
  if (flags.branchTemplate !== undefined) answers.set('branch-template', flags.branchTemplate);
  if (flags.additionalSrcDirs !== undefined) {
    answers.set('additional-src-dirs', flags.additionalSrcDirs);
  }
  if (flags.noopDir !== undefined) answers.set('noop-dir', flags.noopDir);
  if (flags.spawnCommand !== undefined) answers.set('spawn-command', flags.spawnCommand);
  if (flags.tmux !== undefined) answers.set('auto-tmux', flags.tmux);
  if (flags.handoff !== undefined) answers.set('auto-handoff', flags.handoff);
  if (flags.claudeArgs !== undefined) answers.set('claude-flags', flags.claudeArgs);
  return answers;
}

/**
 * The claude arguments for the wizard session.
 *
 * `promptPath` is the resolved `oobe.md`; it rides as `--append-system-prompt`
 * content exactly as the other fragments do. The tool lockdown is the half
 * that matters most: the prompt asks the model not to touch the directory, and
 * these flags make it so whether or not the model complies.
 */
export function buildWizardArgs(promptContent: string, mcpConfig?: string): string[] {
  const args = [
    '--append-system-prompt',
    promptContent,
    '--no-session-persistence',
    '--disallowedTools',
    'Write,Edit,MultiEdit,NotebookEdit,Bash',
    '--permission-mode',
    'default',
  ];
  if (mcpConfig !== undefined && mcpConfig !== '') {
    args.push('--mcp-config', mcpConfig);
  }
  return args;
}

/** The name the wizard session carries, so it is recognisable in a picker. */
export const WIZARD_SESSION_NAME = 'fnc-setup';

/**
 * Should the interview run on a normal launch?
 *
 * Falsy or absent `noOobe` means yes — but only for an interactive session.
 * A `-p` run, a stream-json run, or a cloud session has nobody to answer, and
 * a wizard that fires there would hang or corrupt the output.
 */
export function shouldRunOobe(args: {
  noOobe: boolean;
  interactive: boolean;
}): boolean {
  if (args.noOobe) return false;
  return args.interactive;
}
