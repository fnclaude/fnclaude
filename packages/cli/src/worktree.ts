// Port of the worktree-intercept block of src/main.go (Go reference, lines
// 623–743). Mirrors gitRunner / worktreeInfo / listWorktrees / findWorktree /
// applyWorktreeIntercept.
//
// Design notes:
//   - The Go reference uses a package-level mutable `gitRunner` var that
//     tests swap out. TS port uses explicit dependency injection — callers
//     pass a GitRunner in, with `defaultGitRunner` exported for production
//     use. Both shapes give tests deterministic control without an env or
//     module-state assumption.
//   - applyWorktreeIntercept is a pure stage transition: takes a
//     `ResolvedArgs`, returns an `InterceptedArgs` that carries the new
//     `worktreeMatched` invariant. The cwd / passthrough overrides flow
//     through `withIntercepted`; nothing is mutated in place.

import { isAbsolute, join } from 'node:path';
import {
  withIntercepted,
  type InterceptedArgs,
  type ResolvedArgs,
} from './args.js';
import { nameInPassthrough } from './passthrough.js';

/**
 * GitRunner is a thin wrapper around `git -C <dir> <args...>`. Returns the
 * raw stdout string on success; throws on any git error. The thrown-error
 * path is treated identically to "no match possible" by callers — they
 * never inspect the error itself, so any thrown value is fine.
 */
export type GitRunner = (dir: string, ...args: string[]) => string;

/**
 * Production GitRunner. Spawns git synchronously via Bun.spawnSync — same
 * mechanism the rest of the codebase uses for its child-process work
 * (autoname, resolver, clipboard, spawn). Node's `execFileSync` here was
 * the lone holdout; switching unifies the spawn layer.
 *
 * Behaviour preserved from the prior `execFileSync` version:
 *   - On a successful run (exit 0), returns the UTF-8-decoded stdout.
 *   - On non-zero exit, throws an Error with the git stderr verbatim —
 *     callers (listWorktrees) catch any thrown value and treat it as
 *     "no match possible", so the exact shape of the error doesn't matter
 *     beyond being throwable.
 *   - If `git` isn't on PATH, Bun.spawnSync throws ENOENT itself (same
 *     posture as execFileSync did).
 */
export const defaultGitRunner: GitRunner = (dir, ...args) => {
  const proc = Bun.spawnSync(['git', '-C', dir, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr?.toString('utf8') ?? '';
    throw new Error(`git -C ${dir} ${args.join(' ')} exited ${proc.exitCode}: ${stderr.trim()}`);
  }
  return proc.stdout?.toString('utf8') ?? '';
};

/**
 * WorktreeInfo is one entry from `git worktree list --porcelain`.
 */
export interface WorktreeInfo {
  /** Absolute filesystem path of the worktree. */
  path: string;
  /**
   * Bare branch name (e.g. "feat-x" or "worktree-feat-x"); undefined if the
   * worktree is detached.
   */
  branch: string | undefined;
}

/**
 * listWorktrees runs `git worktree list --porcelain` in dir and parses each
 * blank-line-separated block into a WorktreeInfo. Returns [] on any git
 * error (not-a-repo, git unavailable, etc.) — callers treat [] as "no
 * match possible".
 */
export function listWorktrees(dir: string, runner: GitRunner = defaultGitRunner): WorktreeInfo[] {
  let out: string;
  try {
    out = runner(dir, 'worktree', 'list', '--porcelain');
  } catch {
    return [];
  }

  const result: WorktreeInfo[] = [];
  for (const block of out.split('\n\n')) {
    let path = '';
    let branch: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length).trim();
      }
    }
    if (path !== '') {
      result.push({ path, branch });
    }
  }
  return result;
}

/**
 * findWorktree picks the WorktreeInfo matching `query`, trying three
 * strategies in order. Branch name is checked first since the branch is
 * the semantically stable identifier — its path can be anywhere the
 * creator chose, but its branch is the same string the user typed at
 * creation time.
 *
 *   1. Branch name             == query  (any worktree, any convention)
 *   2. Branch with `worktree-` prefix stripped == query  (matches Claude's
 *      default `worktree-<name>` branches)
 *   3. Basename of the path    == query  (last-resort fallback for worktrees
 *      whose branch was renamed or whose creator skipped the convention)
 *
 * Returns undefined when no entry matches. Undefined `query` short-circuits
 * to undefined so that detached worktrees (branch=undefined) can't be
 * matched by accident.
 */
export function findWorktree(
  worktrees: readonly WorktreeInfo[],
  query: string | undefined,
): WorktreeInfo | undefined {
  if (query === undefined) return undefined;

  for (const wt of worktrees) {
    if (wt.branch === query) return wt;
  }
  for (const wt of worktrees) {
    if (wt.branch !== undefined && stripWorktreePrefix(wt.branch) === query) return wt;
  }
  for (const wt of worktrees) {
    if (basename(wt.path) === query) return wt;
  }
  return undefined;
}

function stripWorktreePrefix(branch: string): string {
  return branch.startsWith('worktree-') ? branch.slice('worktree-'.length) : branch;
}

function basename(p: string): string {
  // `path.basename` collapses trailing slashes the way we want here; the
  // Go reference uses filepath.Base which has the same shape.
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * applyWorktreeIntercept applies the -w / --worktree intercept logic.
 *
 * Pure function: takes a `ResolvedArgs`, returns a new `InterceptedArgs`.
 * No input is mutated. The four cases:
 *
 *   1. worktreeSet=false → carry through with worktreeMatched=false.
 *   2. Bare -w (worktreeArg=undefined) → append --worktree to passthrough,
 *      worktreeMatched=false.
 *   3. Existing worktree matched → swap cwd to the worktree path, set
 *      worktreeMatched=true, suppress --worktree.
 *   4. Otherwise → append --worktree <name>, plus --name <name> when
 *      --name isn't already set; worktreeMatched=false.
 *
 * `shellCWD` is the process working directory at fnclaude startup, used
 * to resolve a relative `cwd` to an absolute path before querying git.
 */
export function applyWorktreeIntercept(
  a: ResolvedArgs,
  shellCWD: string,
  runner: GitRunner = defaultGitRunner,
): InterceptedArgs {
  if (!a.worktreeSet) {
    return withIntercepted(a, { worktreeMatched: false });
  }

  // Bare -w with no name: push --worktree back through unchanged.
  if (a.worktreeArg === undefined) {
    return withIntercepted(a, {
      passthrough: [...a.passthrough, '--worktree'],
      worktreeMatched: false,
    });
  }

  // Resolve absolute cwd for git queries.
  const dir = isAbsolute(a.cwd) ? a.cwd : join(shellCWD, a.cwd);

  // List worktrees in the project repo, then match the user's query against
  // branch / stripped-branch / basename.
  const hit = findWorktree(listWorktrees(dir, runner), a.worktreeArg);
  if (hit) {
    // Existing worktree matched: swap cwd, suppress -w.
    return withIntercepted(a, { cwd: hit.path, worktreeMatched: true });
  }

  // No match (or not a repo): pass --worktree through and attach --name.
  const withWt = [...a.passthrough, '--worktree', a.worktreeArg];
  const passthrough = nameInPassthrough(withWt)
    ? withWt
    : [...withWt, '--name', a.worktreeArg];
  return withIntercepted(a, { passthrough, worktreeMatched: false });
}
