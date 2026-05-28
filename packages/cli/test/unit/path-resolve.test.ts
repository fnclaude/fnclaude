import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { expandTilde, noopDir, resolveCwd } from '../../src/path/resolve.ts';

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

describe('noopDir', () => {
  test('uses XDG_CONFIG_HOME when present', () => {
    expect(noopDir({ xdgConfigHome: '/custom/xdg', home: '/home/tom' })).toBe(
      '/custom/xdg/fnclaude/noop',
    );
  });

  test('falls back to $HOME/.config when XDG not set', () => {
    expect(noopDir({ xdgConfigHome: undefined, home: '/home/tom' })).toBe(
      '/home/tom/.config/fnclaude/noop',
    );
  });

  test('empty XDG_CONFIG_HOME also falls back', () => {
    // Some shells set XDG_CONFIG_HOME='' to mean "unset"; align with
    // XDG spec which treats empty as "use default".
    expect(noopDir({ xdgConfigHome: '', home: '/home/tom' })).toBe(
      '/home/tom/.config/fnclaude/noop',
    );
  });
});

describe('resolveCwd — noop fallback', () => {
  const ENV = { home: '/home/tom', xdgConfigHome: '/home/tom/.config', shellCwd: '/current' };

  test('null firstPath → noop fallback', () => {
    expect(resolveCwd(null, ENV)).toEqual({
      launchCwd: '/home/tom/.config/fnclaude/noop',
      usedNoopFallback: true,
    });
  });

  test('empty string firstPath → noop fallback (defensive)', () => {
    expect(resolveCwd('', ENV)).toEqual({
      launchCwd: '/home/tom/.config/fnclaude/noop',
      usedNoopFallback: true,
    });
  });
});

describe('resolveCwd — tilde expansion', () => {
  const ENV = { home: '/home/tom', xdgConfigHome: '/home/tom/.config', shellCwd: '/current' };

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
  const ENV = { home: '/home/tom', xdgConfigHome: '/home/tom/.config', shellCwd: '/current' };

  test('absolute path: passes through unchanged', () => {
    expect(resolveCwd('/abs/path', ENV)).toEqual({
      launchCwd: '/abs/path',
      usedNoopFallback: false,
    });
  });
});

describe('resolveCwd — relative paths', () => {
  const ENV = { home: '/home/tom', xdgConfigHome: '/home/tom/.config', shellCwd: '/current' };

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
      xdgConfigHome: '/home/tom/.config',
      shellCwd: '/somewhere/else',
    });
    expect(r.launchCwd).toBe('/home/tom/src/proj');
  });

  test('mid-token tilde (not at start) is treated as a relative path', () => {
    // '/foo/~bar' is technically absolute already (leading slash), so it
    // passes through. Verify.
    const r = resolveCwd('/foo/~bar', {
      home: '/home/tom',
      xdgConfigHome: '/home/tom/.config',
      shellCwd: '/current',
    });
    expect(r.launchCwd).toBe('/foo/~bar');
  });
});
