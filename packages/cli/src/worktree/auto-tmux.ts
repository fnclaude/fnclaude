/**
 * Auto-tmux gating (§5.4) — Claude Code has no persistent setting for
 * `--tmux`, so fnc supplies the default from `auto.tmux` in its config. The
 * injection itself is the caller's job; this module decides whether.
 *
 * Three settings (specs/oobe-interview.md, Sessions batch):
 *
 *   `never`     — the default. Never inject.
 *   `always`    — inject on every launch.
 *   `worktree`  — inject only when CREATING a new worktree: `-w <name>` was
 *                 set and the worktree-intercept layer found no existing
 *                 match. Entering an existing worktree does not qualify.
 *
 * Explicit user intent always wins, under every setting: `--no-tmux` and an
 * already-present `--tmux` in passthrough both suppress the injection. (Short
 * `-T` is assumed to have been expanded by §4.5.) Any other value — including
 * an unset one — means never.
 *
 * Per design.md §1 and prd.launcher.md "Auto-tmux for new worktrees".
 */

export interface AutoTmuxArgs {
  configAutoTmux: string | undefined;
  worktreeSet: boolean;
  worktreeMatched: boolean;
  noTmux: boolean;
  passthrough: readonly string[];
}

function passthroughHasTmux(passthrough: readonly string[]): boolean {
  for (const tok of passthrough) {
    if (tok === '--tmux') return true;
    if (tok.startsWith('--tmux=')) return true;
  }
  return false;
}

export function shouldInjectTmux(args: AutoTmuxArgs): boolean {
  // The user's explicit choice comes first, so it applies to `always` too —
  // otherwise `auto.tmux = "always"` would make `--no-tmux` unusable.
  if (args.noTmux) return false;
  if (passthroughHasTmux(args.passthrough)) return false;

  if (args.configAutoTmux === 'always') return true;
  if (args.configAutoTmux !== 'worktree') return false;
  if (!args.worktreeSet) return false;
  if (args.worktreeMatched) return false;
  return true;
}
