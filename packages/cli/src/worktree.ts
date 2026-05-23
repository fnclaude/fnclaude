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
//   - applyWorktreeIntercept mutates Args in place to match the Go signature
//     `*Args`. This keeps the call site in run() simple: `applyWorktreeIntercept(args, cwd)`
//     reads naturally, and Args is a single-owner container at that point in
//     the lifecycle — no aliasing concerns.

import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import type { Args } from './args.js';

/**
 * GitRunner is a thin wrapper around `git -C <dir> <args...>`. Returns the
 * raw stdout string on success; throws on any git error. The thrown-error
 * path is treated identically to "no match possible" by callers — they
 * never inspect the error itself, so any thrown value is fine.
 */
export type GitRunner = (dir: string, ...args: string[]) => string;

/**
 * Production GitRunner. Spawns git synchronously (same shape as Go's
 * `exec.Command(...).Output()` posture in the reference).
 */
export const defaultGitRunner: GitRunner = (dir, ...args) => {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

/**
 * WorktreeInfo is one entry from `git worktree list --porcelain`.
 */
export interface WorktreeInfo {
  /** Absolute filesystem path of the worktree. */
  path: string;
  /**
   * Bare branch name (e.g. "feat-x" or "worktree-feat-x"); "" if the
   * worktree is detached.
   */
  branch: string;
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
    let branch = '';
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
 * Returns null when no entry matches. Empty `query` short-circuits to null
 * so that detached worktrees (branch="") can't be matched by accident.
 */
export function findWorktree(
  worktrees: readonly WorktreeInfo[],
  query: string,
): WorktreeInfo | null {
  if (query === '') return null;

  for (const wt of worktrees) {
    if (wt.branch === query) return wt;
  }
  for (const wt of worktrees) {
    if (wt.branch !== '' && stripWorktreePrefix(wt.branch) === query) return wt;
  }
  for (const wt of worktrees) {
    if (basename(wt.path) === query) return wt;
  }
  return null;
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
 * applyWorktreeIntercept applies the -w / --worktree intercept logic to a.
 * It may modify a.cwd, a.passthrough, and a.worktreeMatched in place.
 *
 *   1. worktreeSet=false → no-op.
 *   2. Bare -w (worktreeArg="") → push --worktree through unchanged.
 *   3. Existing worktree matched → swap a.cwd to the worktree, set
 *      worktreeMatched=true, suppress --worktree.
 *   4. Otherwise → push --worktree <name> through, plus --name <name>
 *      (when --name isn't already set).
 *
 * `shellCWD` is the process working directory at fnclaude startup, used
 * to resolve a relative a.cwd to an absolute path before querying git.
 */
export function applyWorktreeIntercept(
  a: Args,
  shellCWD: string,
  runner: GitRunner = defaultGitRunner,
): void {
  if (!a.worktreeSet) return;

  // Bare -w with no name: push --worktree back through unchanged.
  if (a.worktreeArg === '') {
    a.passthrough.push('--worktree');
    return;
  }

  // Resolve absolute cwd for git queries.
  const dir = isAbsolute(a.cwd) ? a.cwd : join(shellCWD, a.cwd);

  // List worktrees in the project repo, then match the user's query against
  // branch / stripped-branch / basename.
  const hit = findWorktree(listWorktrees(dir, runner), a.worktreeArg);
  if (hit) {
    // Existing worktree matched: swap cwd, suppress -w.
    a.cwd = hit.path;
    a.worktreeMatched = true;
    return;
  }

  // No match (or not a repo): pass --worktree through and attach --name.
  a.passthrough.push('--worktree', a.worktreeArg);
  if (!nameInPassthrough(a.passthrough)) {
    a.passthrough.push('--name', a.worktreeArg);
  }
}

/**
 * nameInPassthrough — local copy of the helper in argParser.ts. Replicated
 * to avoid an import cycle (argParser → buildArgv → worktree → argParser).
 * Both copies must agree; the shared contract is "--name or -n, bare or
 * =value, anywhere in the slice."
 */
function nameInPassthrough(passthrough: readonly string[]): boolean {
  return passthrough.some(
    (t) => t === '--name' || t === '-n' || t.startsWith('--name=') || t.startsWith('-n='),
  );
}
