import { describe, expect, test } from 'bun:test';

import { parseGitWorktreeListPorcelain } from '../../src/worktree/git-list';

describe('parseGitWorktreeListPorcelain', () => {
  test('empty output → empty list', () => {
    expect(parseGitWorktreeListPorcelain('')).toEqual([]);
  });

  test('single worktree on main branch', () => {
    const out = [
      'worktree /home/u/src/proj',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');
    expect(parseGitWorktreeListPorcelain(out)).toEqual([
      { path: '/home/u/src/proj', branch: 'main' },
    ]);
  });

  test('multiple worktrees', () => {
    const out = [
      'worktree /home/u/src/proj',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/u/src/proj@feat-x',
      'HEAD def456',
      'branch refs/heads/feat-x',
      '',
      'worktree /home/u/src/proj@bug-fix',
      'HEAD 789aaa',
      'branch refs/heads/bug-fix',
      '',
    ].join('\n');
    expect(parseGitWorktreeListPorcelain(out)).toEqual([
      { path: '/home/u/src/proj', branch: 'main' },
      { path: '/home/u/src/proj@feat-x', branch: 'feat-x' },
      { path: '/home/u/src/proj@bug-fix', branch: 'bug-fix' },
    ]);
  });

  test('detached worktree gets branch=""', () => {
    const out = [
      'worktree /home/u/src/proj',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/u/src/proj@review',
      'HEAD 999',
      'detached',
      '',
    ].join('\n');
    expect(parseGitWorktreeListPorcelain(out)).toEqual([
      { path: '/home/u/src/proj', branch: 'main' },
      { path: '/home/u/src/proj@review', branch: '' },
    ]);
  });

  test('branch without refs/heads/ prefix is taken verbatim', () => {
    const out = [
      'worktree /x',
      'HEAD a',
      'branch some-weird-thing',
      '',
    ].join('\n');
    expect(parseGitWorktreeListPorcelain(out)).toEqual([
      { path: '/x', branch: 'some-weird-thing' },
    ]);
  });

  test('trailing blank line tolerated', () => {
    const out = [
      'worktree /a',
      'HEAD a',
      'branch refs/heads/main',
      '',
      '',
    ].join('\n');
    expect(parseGitWorktreeListPorcelain(out)).toEqual([
      { path: '/a', branch: 'main' },
    ]);
  });

  test('missing trailing blank line tolerated', () => {
    const out = [
      'worktree /a',
      'HEAD a',
      'branch refs/heads/main',
    ].join('\n');
    expect(parseGitWorktreeListPorcelain(out)).toEqual([
      { path: '/a', branch: 'main' },
    ]);
  });

  test('worktree line with no path → entry ignored', () => {
    expect(parseGitWorktreeListPorcelain('HEAD abc\n\n')).toEqual([]);
  });
});
