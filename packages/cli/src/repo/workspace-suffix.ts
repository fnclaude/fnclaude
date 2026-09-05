/**
 * The `+workspace` suffix is fnc's, not fngit's.
 *
 * `fnc fnclaude+my-feature` means "the fnclaude repo, in a worktree called
 * my-feature". fngit knows nothing about it: fnc strips the suffix before
 * calling `fngit clone`, then hands the name to claude as `--worktree <ws>`
 * exactly as it always has (specs/rhombus-rocks-config.md § "fngit CLI
 * contract", last paragraph).
 *
 * The split is on the FIRST `+`, matching the old `parseRepoRef` behaviour, so
 * a worktree name may itself contain `+`. A trailing `+` with nothing after it
 * yields an empty workspace, which the caller treats as "no worktree" rather
 * than an error — `fnc repo+` is a typo, not a request for a worktree named
 * empty-string, and erroring on it would be a worse experience than launching
 * the repo.
 */

export interface WorkspaceSplit {
  /** The reference with the suffix removed. */
  body: string;
  /** The worktree name, or `''` when there was no suffix. */
  workspace: string;
}

export function splitWorkspaceSuffix(input: string): WorkspaceSplit {
  const idx = input.indexOf('+');
  if (idx < 0) return { body: input, workspace: '' };
  return { body: input.slice(0, idx), workspace: input.slice(idx + 1) };
}
