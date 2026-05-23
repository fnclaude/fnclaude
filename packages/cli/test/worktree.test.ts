// Mirrors the worktree intercept tests in src/main_test.go from the Go reference.
//
// Coverage:
//   - findWorktree: branch-first, stripped-branch, basename fallback,
//     no-match nil, detached empty-query nil.
//   - applyWorktreeIntercept: not set short-circuit, bare -w passthrough,
//     matched-existing cwd-swap, relative-cwd resolution, unmatched
//     passthrough+name injection, name-already-set no-dup, not-a-repo
//     fallback, and the two convention-flavoured integration cases
//     (custom <repo>+<wt> on-disk, default .claude/worktrees/<wt>).
//
// Git is stubbed by dependency injection — applyWorktreeIntercept and
// listWorktrees both accept an explicit gitRunner so tests don't have to
// mock at module level or spawn real git processes.

import { describe, expect, test } from 'bun:test';
import type { Args } from '../src/args.js';
import {
  applyWorktreeIntercept,
  findWorktree,
  listWorktrees,
  type GitRunner,
  type WorktreeInfo,
} from '../src/worktree.js';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * fakeGitRunner returns a GitRunner that yields `out` on every call. An empty
 * `out` simulates a git failure (not-a-repo / git unavailable). Mirrors the
 * Go helper of the same name.
 */
function fakeGitRunner(out: string): GitRunner {
  return (_dir, ..._args) => {
    if (out === '') throw new Error('not a git repo');
    return out;
  };
}

/**
 * worktreeListOutput builds a fake `git worktree list --porcelain` payload
 * for a set of absolute paths. Branch for entry i comes from branches[i] when
 * provided; otherwise defaults to "main" for the first entry and "wt-<i>"
 * for the rest. Mirrors the Go helper.
 */
function worktreeListOutput(paths: string[], ...branches: string[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const branch = i < branches.length ? branches[i] : i === 0 ? 'main' : `wt-${i}`;
    blocks.push(`worktree ${paths[i]}\nHEAD abc123\nbranch refs/heads/${branch}`);
  }
  return blocks.join('\n\n') + '\n';
}

/**
 * baseArgs supplies the boilerplate Args fields each test would otherwise
 * have to spell out. Tests override the fields they care about.
 */
function baseArgs(overrides: Partial<Args> = {}): Args {
  return {
    cwd: '/p/main',
    extraDirs: [],
    passthrough: [],
    noTmux: false,
    worktreeSet: false,
    worktreeArg: '',
    usedNoopFallback: false,
    worktreeMatched: false,
    ...overrides,
  };
}

// ── findWorktree ───────────────────────────────────────────────────────────

describe('findWorktree', () => {
  test('matches by basename', () => {
    const wts: WorktreeInfo[] = [
      { path: '/repo/main', branch: 'main' },
      { path: '/repo/feat-x', branch: 'feat-x' },
    ];
    const hit = findWorktree(wts, 'feat-x');
    expect(hit?.path).toBe('/repo/feat-x');
  });

  test('matches by branch (custom convention <repo>+<wtname>)', () => {
    const wts: WorktreeInfo[] = [
      { path: '/home/tom/src/proj@user', branch: 'main' },
      { path: '/home/tom/src/proj@user+feat-x', branch: 'feat-x' },
    ];
    const hit = findWorktree(wts, 'feat-x');
    expect(hit?.path).toBe('/home/tom/src/proj@user+feat-x');
  });

  test('matches by branch with worktree- prefix stripped (default convention)', () => {
    const wts: WorktreeInfo[] = [
      { path: '/repo/.claude/worktrees/feat-x', branch: 'worktree-feat-x' },
    ];
    const hit = findWorktree(wts, 'feat-x');
    expect(hit?.path).toBe('/repo/.claude/worktrees/feat-x');
  });

  test('branch wins over basename when both could match different entries', () => {
    const wts: WorktreeInfo[] = [
      { path: '/repo/feat-x', branch: 'other' }, // basename matches "feat-x"
      { path: '/repo/main', branch: 'feat-x' }, // branch matches "feat-x"
    ];
    const hit = findWorktree(wts, 'feat-x');
    expect(hit?.path).toBe('/repo/main');
  });

  test('no match → null', () => {
    const wts: WorktreeInfo[] = [{ path: '/repo/main', branch: 'main' }];
    expect(findWorktree(wts, 'nope')).toBeNull();
  });

  test('detached worktree (branch="") not matched by empty query', () => {
    const wts: WorktreeInfo[] = [{ path: '/repo/wt1', branch: '' }];
    expect(findWorktree(wts, '')).toBeNull();
  });
});

// ── listWorktrees ──────────────────────────────────────────────────────────

describe('listWorktrees', () => {
  test('parses the standard porcelain output shape', () => {
    const runner = fakeGitRunner(
      worktreeListOutput(['/repo/main', '/repo/feat'], 'main', 'feat'),
    );
    const wts = listWorktrees('/repo/main', runner);
    expect(wts).toEqual([
      { path: '/repo/main', branch: 'main' },
      { path: '/repo/feat', branch: 'feat' },
    ]);
  });

  test('detached worktree leaves branch empty', () => {
    // The Go reference only strips `branch refs/heads/...`; anything else
    // (detached HEAD entries that emit "detached" instead) leaves branch="".
    const out =
      'worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /repo/detached\nHEAD def456\ndetached\n';
    const wts = listWorktrees('/repo/main', fakeGitRunner(out));
    expect(wts).toEqual([
      { path: '/repo/main', branch: 'main' },
      { path: '/repo/detached', branch: '' },
    ]);
  });

  test('git failure returns empty array (not-a-repo posture)', () => {
    expect(listWorktrees('/somewhere', fakeGitRunner(''))).toEqual([]);
  });

  test('passes the dir argument through to gitRunner', () => {
    let captured = '';
    const runner: GitRunner = (dir, ..._args) => {
      captured = dir;
      return '';
    };
    listWorktrees('/given/dir', runner);
    expect(captured).toBe('/given/dir');
  });

  test('invokes git with `worktree list --porcelain`', () => {
    let cmd: string[] = [];
    const runner: GitRunner = (_dir, ...args) => {
      cmd = [...args];
      return '';
    };
    listWorktrees('/r', runner);
    expect(cmd).toEqual(['worktree', 'list', '--porcelain']);
  });
});

// ── applyWorktreeIntercept ─────────────────────────────────────────────────

describe('applyWorktreeIntercept', () => {
  test('worktreeSet=false short-circuits — no git, no mutation', () => {
    let called = false;
    const runner: GitRunner = (_dir, ..._args) => {
      called = true;
      return '';
    };
    const a = baseArgs({ cwd: '/p/main' });
    applyWorktreeIntercept(a, '/shell', runner);
    expect(a.cwd).toBe('/p/main');
    expect(a.passthrough).toEqual([]);
    expect(called).toBe(false);
  });

  test('bare -w (worktreeArg="") pushes --worktree through unchanged', () => {
    let called = false;
    const runner: GitRunner = (_dir, ..._args) => {
      called = true;
      return '';
    };
    const a = baseArgs({ cwd: '/p/main', worktreeSet: true, worktreeArg: '' });
    applyWorktreeIntercept(a, '/shell', runner);
    expect(a.worktreeMatched).toBe(false);
    expect(a.passthrough).toContain('--worktree');
    expect(called).toBe(false);
  });

  test('matched existing worktree → cwd swapped, --worktree NOT pushed', () => {
    const runner = fakeGitRunner(worktreeListOutput(['/repo/main', '/repo/feat']));
    const a = baseArgs({ cwd: '/repo/main', worktreeSet: true, worktreeArg: 'feat' });
    applyWorktreeIntercept(a, '/shell', runner);
    expect(a.cwd).toBe('/repo/feat');
    expect(a.worktreeMatched).toBe(true);
    expect(a.passthrough).not.toContain('--worktree');
    expect(a.passthrough).not.toContain('-w');
  });

  test('relative cwd resolves against shellCWD before querying git', () => {
    let gotDir = '';
    const runner: GitRunner = (dir, ..._args) => {
      gotDir = dir;
      return worktreeListOutput(['/repo/main', '/repo/feat']);
    };
    const a = baseArgs({
      cwd: 'relative/sub',
      worktreeSet: true,
      worktreeArg: 'feat',
    });
    applyWorktreeIntercept(a, '/shell/here', runner);
    expect(gotDir).toBe('/shell/here/relative/sub');
  });

  test('unmatched name → passthrough --worktree + --name <name>', () => {
    const runner = fakeGitRunner(worktreeListOutput(['/repo/main']));
    const a = baseArgs({
      cwd: '/repo/main',
      worktreeSet: true,
      worktreeArg: 'newfeature',
    });
    applyWorktreeIntercept(a, '/shell', runner);
    expect(a.worktreeMatched).toBe(false);
    expect(a.passthrough).toContain('--worktree');
    expect(a.passthrough).toContain('newfeature');
    expect(a.passthrough).toContain('--name');
  });

  test('unmatched but --name already in passthrough → no duplicate --name', () => {
    const runner = fakeGitRunner(worktreeListOutput(['/repo/main']));
    const a = baseArgs({
      cwd: '/repo/main',
      worktreeSet: true,
      worktreeArg: 'newfeature',
      passthrough: ['--name', 'myname'],
    });
    applyWorktreeIntercept(a, '/shell', runner);
    const nameCount = a.passthrough.filter((t) => t === '--name').length;
    expect(nameCount).toBe(1);
  });

  test('not-a-repo (git fails) → passthrough --worktree + --name <name>', () => {
    const a = baseArgs({
      cwd: '/p/main',
      worktreeSet: true,
      worktreeArg: 'newfeature',
    });
    applyWorktreeIntercept(a, '/shell', fakeGitRunner(''));
    expect(a.worktreeMatched).toBe(false);
    expect(a.passthrough).toContain('--worktree');
    expect(a.passthrough).toContain('--name');
  });

  test('matches by branch (custom convention <repo>+<wtname>)', () => {
    // Path basename includes `+`, so basename match fails; branch match wins.
    const runner = fakeGitRunner(
      worktreeListOutput(
        ['/home/tom/src/proj@user', '/home/tom/src/proj@user+feat-x'],
        'main',
        'feat-x',
      ),
    );
    const a = baseArgs({
      cwd: '/home/tom/src/proj@user',
      worktreeSet: true,
      worktreeArg: 'feat-x',
    });
    applyWorktreeIntercept(a, '/shell', runner);
    expect(a.cwd).toBe('/home/tom/src/proj@user+feat-x');
    expect(a.worktreeMatched).toBe(true);
  });

  test('matches by stripped branch (default .claude/worktrees convention)', () => {
    const runner = fakeGitRunner(
      worktreeListOutput(
        ['/repo/main', '/repo/.claude/worktrees/feat-x'],
        'main',
        'worktree-feat-x',
      ),
    );
    const a = baseArgs({
      cwd: '/repo/main',
      worktreeSet: true,
      worktreeArg: 'feat-x',
    });
    applyWorktreeIntercept(a, '/shell', runner);
    expect(a.cwd).toBe('/repo/.claude/worktrees/feat-x');
    expect(a.worktreeMatched).toBe(true);
  });
});
