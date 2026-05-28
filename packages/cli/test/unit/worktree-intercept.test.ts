import { describe, expect, test } from 'bun:test';

import {
  applyWorktreeIntercept,
  type InterceptArgs,
  type Worktree,
} from '../../src/worktree/intercept.ts';

function args(overrides: Partial<InterceptArgs> = {}): InterceptArgs {
  return {
    worktreeSet: false,
    worktreeArg: '',
    launchCwd: '/home/u/src/proj',
    passthrough: [],
    listWorktrees: () => [],
    ...overrides,
  };
}

describe('applyWorktreeIntercept — no -w', () => {
  test('worktreeSet=false → no-op, identity passthrough', () => {
    const r = applyWorktreeIntercept(args({ passthrough: ['--verbose'] }));
    expect(r.launchCwd).toBe('/home/u/src/proj');
    expect(r.passthrough).toEqual(['--verbose']);
    expect(r.worktreeMatched).toBe(false);
  });

  test('worktreeSet=false → does NOT call listWorktrees', () => {
    let called = false;
    applyWorktreeIntercept(
      args({
        listWorktrees: () => {
          called = true;
          return [];
        },
      }),
    );
    expect(called).toBe(false);
  });
});

describe('applyWorktreeIntercept — bare -w (no value)', () => {
  test('passes --worktree alone, no --name', () => {
    const r = applyWorktreeIntercept(args({ worktreeSet: true, worktreeArg: '' }));
    expect(r.passthrough).toEqual(['--worktree']);
    expect(r.worktreeMatched).toBe(false);
    expect(r.launchCwd).toBe('/home/u/src/proj');
  });
});

describe('applyWorktreeIntercept — -w <name> with NO match', () => {
  test('listWorktrees returns [] → push --worktree foo + --name foo', () => {
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => [] }),
    );
    expect(r.passthrough).toEqual(['--worktree', 'foo', '--name', 'foo']);
    expect(r.worktreeMatched).toBe(false);
    expect(r.launchCwd).toBe('/home/u/src/proj');
  });

  test('listWorktrees returns null (not a git repo) → no-match path', () => {
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => null }),
    );
    expect(r.passthrough).toEqual(['--worktree', 'foo', '--name', 'foo']);
  });

  test('--name already in passthrough → do NOT add another', () => {
    const r = applyWorktreeIntercept(
      args({
        worktreeSet: true,
        worktreeArg: 'foo',
        passthrough: ['--name', 'explicit'],
        listWorktrees: () => [],
      }),
    );
    expect(r.passthrough).toEqual(['--name', 'explicit', '--worktree', 'foo']);
  });

  test('-n already in passthrough → do NOT add --name', () => {
    const r = applyWorktreeIntercept(
      args({
        worktreeSet: true,
        worktreeArg: 'foo',
        passthrough: ['-n', 'explicit'],
        listWorktrees: () => [],
      }),
    );
    expect(r.passthrough).toEqual(['-n', 'explicit', '--worktree', 'foo']);
  });

  test('--name=val already in passthrough → do NOT add --name', () => {
    const r = applyWorktreeIntercept(
      args({
        worktreeSet: true,
        worktreeArg: 'foo',
        passthrough: ['--name=explicit'],
        listWorktrees: () => [],
      }),
    );
    expect(r.passthrough).toEqual(['--name=explicit', '--worktree', 'foo']);
  });
});

describe('applyWorktreeIntercept — match priority ladder', () => {
  test('priority 1: branch === name → match', () => {
    const wts: Worktree[] = [
      { path: '/x/other', branch: 'other' },
      { path: '/x/foo', branch: 'foo' },
    ];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => wts }),
    );
    expect(r.launchCwd).toBe('/x/foo');
    expect(r.worktreeMatched).toBe(true);
    expect(r.passthrough).toEqual(['--name', 'foo']);
  });

  test('priority 2: branch == worktree-<name> → match', () => {
    const wts: Worktree[] = [
      { path: '/x/wt-foo', branch: 'worktree-foo' },
    ];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => wts }),
    );
    expect(r.launchCwd).toBe('/x/wt-foo');
    expect(r.worktreeMatched).toBe(true);
    expect(r.passthrough).toEqual(['--name', 'foo']);
  });

  test('priority 3: basename(path) === name → match', () => {
    const wts: Worktree[] = [
      { path: '/x/other', branch: 'other' },
      { path: '/x/foo', branch: 'some-other-name' },
    ];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => wts }),
    );
    expect(r.launchCwd).toBe('/x/foo');
    expect(r.worktreeMatched).toBe(true);
  });

  test('priority 1 wins over priority 2 (even if priority 2 listed first)', () => {
    const wts: Worktree[] = [
      { path: '/x/p2', branch: 'worktree-foo' },
      { path: '/x/p1', branch: 'foo' },
    ];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => wts }),
    );
    expect(r.launchCwd).toBe('/x/p1');
  });

  test('priority 2 wins over priority 3', () => {
    const wts: Worktree[] = [
      { path: '/x/foo', branch: 'some-branch' },
      { path: '/x/wt-foo', branch: 'worktree-foo' },
    ];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => wts }),
    );
    expect(r.launchCwd).toBe('/x/wt-foo');
  });
});

describe('applyWorktreeIntercept — match swaps cwd, NOT --worktree forwarded', () => {
  test('on match, --worktree is NOT pushed to passthrough', () => {
    const wts: Worktree[] = [{ path: '/x/foo', branch: 'foo' }];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => wts }),
    );
    expect(r.passthrough).not.toContain('--worktree');
  });

  test('on match, --name still added unless explicit', () => {
    const wts: Worktree[] = [{ path: '/x/foo', branch: 'foo' }];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo', listWorktrees: () => wts }),
    );
    expect(r.passthrough).toEqual(['--name', 'foo']);
  });

  test('on match, --name NOT added when --name already set', () => {
    const wts: Worktree[] = [{ path: '/x/foo', branch: 'foo' }];
    const r = applyWorktreeIntercept(
      args({
        worktreeSet: true,
        worktreeArg: 'foo',
        passthrough: ['--name', 'explicit'],
        listWorktrees: () => wts,
      }),
    );
    expect(r.passthrough).toEqual(['--name', 'explicit']);
  });
});

describe('applyWorktreeIntercept — sanitization', () => {
  test('name with bad chars sanitized; warning emitted; sanitized version used for match', () => {
    const wts: Worktree[] = [{ path: '/x/foo-bar', branch: 'foo-bar' }];
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'foo bar!', listWorktrees: () => wts }),
    );
    expect(r.launchCwd).toBe('/x/foo-bar');
    expect(r.worktreeMatched).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toContain('foo bar!');
    expect(r.warnings[0]).toContain('foo-bar');
  });

  test('name that sanitizes to invalid → original used + warning', () => {
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: '/etc/passwd', listWorktrees: () => [] }),
    );
    // Invalid → use original; no match; push --worktree <original> --name <original>
    expect(r.passthrough).toEqual(['--worktree', '/etc/passwd', '--name', '/etc/passwd']);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('clean name → no warning', () => {
    const r = applyWorktreeIntercept(
      args({ worktreeSet: true, worktreeArg: 'feat-foo', listWorktrees: () => [] }),
    );
    expect(r.warnings.length).toBe(0);
  });
});
