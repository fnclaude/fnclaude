/**
 * Run `git worktree list --porcelain` in a directory and parse the output
 * into Worktree[] for the intercept layer (§5.3).
 *
 * Porcelain block format (per git docs):
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>     OR     detached
 *
 * Blocks separated by blank lines. The branch field's "refs/heads/"
 * prefix is stripped so callers can match against the user-typed name
 * directly. Detached worktrees get branch = "".
 *
 * listWorktrees() returns null if git isn't installed, the directory
 * isn't a git repo, or git errored — the intercept layer treats null as
 * "no worktrees, no match" and forwards `-w` to claude unchanged.
 */

import { spawnSync } from 'node:child_process';

import type { Worktree } from './intercept';

const REFS_HEADS_PREFIX = 'refs/heads/';

export function parseGitWorktreeListPorcelain(out: string): Worktree[] {
  const lines = out.split('\n');
  const worktrees: Worktree[] = [];
  let cur: { path: string | null; branch: string | null } = { path: null, branch: null };

  const flush = (): void => {
    if (cur.path !== null) {
      worktrees.push({ path: cur.path, branch: cur.branch ?? '' });
    }
    cur = { path: null, branch: null };
  };

  for (const line of lines) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      cur.path = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      const v = line.slice('branch '.length);
      cur.branch = v.startsWith(REFS_HEADS_PREFIX) ? v.slice(REFS_HEADS_PREFIX.length) : v;
    } else if (line === 'detached') {
      cur.branch = '';
    }
    // HEAD <sha> and any unknown lines: ignored.
  }
  flush();

  return worktrees;
}

export function listWorktrees(cwd: string): Worktree[] | null {
  let result;
  try {
    result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
  if (result.error !== undefined) return null;
  if (result.status !== 0) return null;
  return parseGitWorktreeListPorcelain(result.stdout);
}
