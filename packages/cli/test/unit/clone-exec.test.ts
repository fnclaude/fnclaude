import { describe, expect, test } from 'bun:test';

import { cloneRepo, type GhCloneCall, type GhCloneResult } from '../../src/repo/clone-exec.ts';

function makeGhClone(result: GhCloneResult, capture?: { url?: string; dest?: string }): GhCloneCall {
  return async (url: string, dest: string) => {
    if (capture !== undefined) {
      capture.url = url;
      capture.dest = dest;
    }
    return result;
  };
}

describe('cloneRepo', () => {
  test('forwards url + destination to ghClone, succeeds on ok', async () => {
    const cap: { url?: string; dest?: string } = {};
    const ghClone = makeGhClone({ ok: true }, cap);
    const r = await cloneRepo({
      url: 'https://github.com/anthropics/cool.git',
      destination: '/home/u/src/cool@anthropics',
      ghClone,
      mkdirp: async () => {},
    });
    expect(r.ok).toBe(true);
    expect(cap.url).toBe('https://github.com/anthropics/cool.git');
    expect(cap.dest).toBe('/home/u/src/cool@anthropics');
  });

  test('mkdirp called with parent directory before clone', async () => {
    let parentCreated = '';
    const r = await cloneRepo({
      url: 'https://github.com/x/y.git',
      destination: '/home/u/deep/nested/y@x',
      ghClone: makeGhClone({ ok: true }),
      mkdirp: async (path: string) => {
        parentCreated = path;
      },
    });
    expect(r.ok).toBe(true);
    expect(parentCreated).toBe('/home/u/deep/nested');
  });

  test('ghClone failure → result.ok false with error', async () => {
    const r = await cloneRepo({
      url: 'https://github.com/x/y.git',
      destination: '/tmp/y@x',
      ghClone: makeGhClone({ ok: false, error: 'auth required', stderr: 'gh auth login' }),
      mkdirp: async () => {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('auth required');
      expect(r.stderr).toContain('gh auth login');
    }
  });

  test('mkdirp failure surfaces as result.ok false (clone not attempted)', async () => {
    let cloneCalled = false;
    const r = await cloneRepo({
      url: 'https://github.com/x/y.git',
      destination: '/tmp/y@x',
      ghClone: async () => {
        cloneCalled = true;
        return { ok: true };
      },
      mkdirp: async () => {
        throw new Error('permission denied');
      },
    });
    expect(r.ok).toBe(false);
    expect(cloneCalled).toBe(false);
    if (!r.ok) expect(r.error).toContain('permission denied');
  });
});
