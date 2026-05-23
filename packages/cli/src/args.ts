/**
 * Args holds the result of parsing fnclaude's own argv.
 *
 * Mirrors the Go `Args` struct in src/main.go from the upstream Go
 * implementation. Property docstrings keep that mapping explicit; the parser
 * in argParser.ts is the only producer of values here.
 */
export interface Args {
  /**
   * CWD is the directory claude will be launched in (first positional, or
   * the noop fallback when no positionals are given).
   */
  cwd: string;

  /**
   * ExtraDirs collects all -A / --also values in order. Positional 2 is the
   * worktree slot; -A is the only way to supply extra dirs.
   */
  extraDirs: string[];

  /**
   * Passthrough is everything else, preserved in order, to be forwarded to
   * claude verbatim. Short flags are already translated to their long
   * forms.
   */
  passthrough: string[];

  /**
   * NoTmux is true when the user passed --no-tmux (eaten by fnclaude; not
   * forwarded to claude).
   */
  noTmux: boolean;

  /**
   * WorktreeSet is true when the user passed -w / --worktree, OR supplied
   * a 2nd positional after magic + subcommand consumption.
   */
  worktreeSet: boolean;

  /**
   * WorktreeArg is the name/value given with -w / --worktree (or the 2nd
   * positional), or "" if the flag was bare.
   */
  worktreeArg: string;

  /**
   * UsedNoopFallback is true when CWD was filled by the noop fallback (no
   * positional path given). Caller uses this to gate seed-noop behavior —
   * explicit paths don't get auto-seeded.
   */
  usedNoopFallback: boolean;

  /**
   * WorktreeMatched is set by applyWorktreeIntercept when -w / --worktree
   * was resolved against an existing worktree of the project repo (cwd was
   * swapped to that worktree). Downstream consumers (buildArgv's auto-tmux
   * gate, primarily) treat matched=true as "no new worktree being created
   * this run" and avoid injecting flags that only make sense when claude
   * is about to spin up a fresh worktree.
   */
  worktreeMatched: boolean;
}
