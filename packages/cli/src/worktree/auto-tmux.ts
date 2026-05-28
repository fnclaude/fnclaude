/**
 * Auto-tmux gating (§5.4) — when `config.auto.tmux = "worktree"` and the
 * user is creating a new worktree (i.e. `-w <name>` was set and the
 * worktree-intercept layer did NOT find an existing match), inject
 * `--tmux` into passthrough. The injection itself is the caller's job;
 * this module decides whether.
 *
 * Per design.md §1 and prd.launcher.md "Auto-tmux for new worktrees".
 *
 * All five conditions must hold:
 *   1. configAutoTmux === "worktree"
 *   2. worktreeSet === true (user passed -w / 2nd-positional)
 *   3. worktreeMatched === false (a new worktree, not entering an
 *      existing one)
 *   4. noTmux === false (user did not pass --no-tmux escape hatch)
 *   5. passthrough does NOT already contain `--tmux` or `--tmux=…`
 *      (short -T is assumed to have been expanded by §4.5)
 *
 * If any fails: do nothing — explicit user intent always wins.
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
  if (args.configAutoTmux !== 'worktree') return false;
  if (!args.worktreeSet) return false;
  if (args.worktreeMatched) return false;
  if (args.noTmux) return false;
  if (passthroughHasTmux(args.passthrough)) return false;
  return true;
}
