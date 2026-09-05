import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { expandTilde, resolveCwd } from '../../src/path/resolve';

/** The caller resolves `noopDir` (config or default) and passes it in. */
const NOOP = '/home/tom/.config/rhombus.rocks/fnclaude/noop';

describe('expandTilde', () => {
  const home = '/home/tom';

  test('bare ~ becomes home', () => {
    expect(expandTilde('~', home)).toBe(home);
  });

  test('~/ prefix becomes home/...', () => {
    expect(expandTilde('~/src/proj', home)).toBe('/home/tom/src/proj');
    expect(expandTilde('~/foo', home)).toBe('/home/tom/foo');
  });

  test('mid-token ~ is left literal (matches shell behavior)', () => {
    expect(expandTilde('/foo/~bar', home)).toBe('/foo/~bar');
    expect(expandTilde('~user/foo', home)).toBe('~user/foo');
  });

  test('absolute path: unchanged', () => {
    expect(expandTilde('/abs/path', home)).toBe('/abs/path');
    expect(expandTilde('/', home)).toBe('/');
  });

  test('relative path: unchanged (no tilde)', () => {
    expect(expandTilde('./relative', home)).toBe('./relative');
    expect(expandTilde('bare-name', home)).toBe('bare-name');
  });

  test('empty string: unchanged', () => {
    expect(expandTilde('', home)).toBe('');
  });
});

describe('resolveCwd — noop fallback', () => {
  const ENV = { home: '/home/tom', noopDir: NOOP, shellCwd: '/current' };

  test('null firstPath → noop fallback', () => {
    expect(resolveCwd(null, ENV)).toEqual({
      launchCwd: NOOP,
      usedNoopFallback: true,
    });
  });

  test('empty string firstPath → noop fallback (defensive)', () => {
    expect(resolveCwd('', ENV)).toEqual({
      launchCwd: NOOP,
      usedNoopFallback: true,
    });
  });
});

describe('resolveCwd — tilde expansion', () => {
  const ENV = { home: '/home/tom', noopDir: NOOP, shellCwd: '/current' };

  test('~ alone → home', () => {
    expect(resolveCwd('~', ENV)).toEqual({
      launchCwd: '/home/tom',
      usedNoopFallback: false,
    });
  });

  test('~/src/proj → home/src/proj', () => {
    expect(resolveCwd('~/src/proj', ENV)).toEqual({
      launchCwd: '/home/tom/src/proj',
      usedNoopFallback: false,
    });
  });
});

describe('resolveCwd — absolute paths', () => {
  const ENV = { home: '/home/tom', noopDir: NOOP, shellCwd: '/current' };

  test('absolute path: passes through unchanged', () => {
    expect(resolveCwd('/abs/path', ENV)).toEqual({
      launchCwd: '/abs/path',
      usedNoopFallback: false,
    });
  });
});

describe('resolveCwd — relative paths', () => {
  const ENV = { home: '/home/tom', noopDir: NOOP, shellCwd: '/current' };

  test('./relative → shellCwd-joined', () => {
    expect(resolveCwd('./relative', ENV)).toEqual({
      launchCwd: '/current/relative',
      usedNoopFallback: false,
    });
  });

  test('bare-name → shellCwd-joined', () => {
    expect(resolveCwd('subproject', ENV)).toEqual({
      launchCwd: '/current/subproject',
      usedNoopFallback: false,
    });
  });

  test('../sibling → resolved relative to shellCwd', () => {
    expect(resolveCwd('../sibling', { ...ENV, shellCwd: '/work/proj' })).toEqual({
      launchCwd: '/work/sibling',
      usedNoopFallback: false,
    });
  });
});

describe('resolveCwd — combined tilde + abs/rel rules', () => {
  test('tilde-expanded path is always absolute, no shellCwd join', () => {
    const r = resolveCwd('~/src/proj', {
      home: '/home/tom',
      noopDir: NOOP,
      shellCwd: '/somewhere/else',
    });
    expect(r.launchCwd).toBe('/home/tom/src/proj');
  });

  test('mid-token tilde (not at start) is treated as a relative path', () => {
    // '/foo/~bar' is technically absolute already (leading slash), so it
    // passes through. Verify.
    const r = resolveCwd('/foo/~bar', {
      home: '/home/tom',
      noopDir: NOOP,
      shellCwd: '/current',
    });
    expect(r.launchCwd).toBe('/foo/~bar');
  });
});
