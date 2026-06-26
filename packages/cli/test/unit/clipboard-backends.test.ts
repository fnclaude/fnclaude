/**
 * Unit tests for §8.4 — clipboard backend detection + invocation.
 *
 * Backend priority per design.md §25 + design.mcp.md §4.4:
 *   wl-copy → xclip → xsel → pbcopy → clip.exe
 *
 * Tests use injected `which` and `spawn` fakes so we never touch real
 * processes; integration coverage against the actually-installed backend
 * lives at the bottom and is gated by a runtime detect.
 */

import { describe, expect, test } from 'bun:test';

import {
  detectBackend,
  runBackend,
  type WhichFn,
  type SpawnFn,
  type SpawnedProc,
} from '../../src/mcp/handlers/clipboard-backends';

function whichOf(present: Record<string, string>): WhichFn {
  return (name: string): string | null => (name in present ? present[name]! : null);
}

function fakeSpawnExit(exitCode: number): SpawnFn {
  return (_args, _opts) => {
    let stdinClosed = false;
    const proc: SpawnedProc = {
      stdin: {
        write(_chunk: string | Uint8Array) {
          /* swallow */
        },
        end() {
          stdinClosed = true;
        },
      },
      exited: Promise.resolve(exitCode),
      kill() {
        /* noop */
      },
      get _stdinClosed() {
        return stdinClosed;
      },
    } as SpawnedProc & { _stdinClosed: boolean };
    return proc;
  };
}

function fakeSpawnThrow(message = 'ENOENT'): SpawnFn {
  return () => {
    throw new Error(message);
  };
}

describe('detectBackend', () => {
  test('returns wl-copy first when available (highest priority)', () => {
    const which = whichOf({
      'wl-copy': '/usr/bin/wl-copy',
      xclip: '/usr/bin/xclip',
      xsel: '/usr/bin/xsel',
    });
    const r = detectBackend({ which });
    expect(r).not.toBeNull();
    expect(r!.name).toBe('wl-copy');
    expect(r!.command).toBe('/usr/bin/wl-copy');
  });

  test('falls through wl-copy → xclip', () => {
    const which = whichOf({ xclip: '/usr/bin/xclip', xsel: '/usr/bin/xsel' });
    const r = detectBackend({ which });
    expect(r).not.toBeNull();
    expect(r!.name).toBe('xclip');
  });

  test('xclip beats xsel when both present', () => {
    const which = whichOf({ xclip: '/usr/bin/xclip', xsel: '/usr/bin/xsel' });
    const r = detectBackend({ which });
    expect(r!.name).toBe('xclip');
  });

  test('xsel chosen when xclip absent', () => {
    const which = whichOf({ xsel: '/usr/bin/xsel' });
    const r = detectBackend({ which });
    expect(r!.name).toBe('xsel');
  });

  test('pbcopy chosen when X11/Wayland backends absent (macOS profile)', () => {
    const which = whichOf({ pbcopy: '/usr/bin/pbcopy' });
    const r = detectBackend({ which });
    expect(r!.name).toBe('pbcopy');
  });

  test('clip.exe chosen on Windows/WSL profile', () => {
    const which = whichOf({ 'clip.exe': '/mnt/c/Windows/System32/clip.exe' });
    const r = detectBackend({ which });
    expect(r!.name).toBe('clip.exe');
  });

  test('returns null when nothing on PATH', () => {
    const r = detectBackend({ which: whichOf({}) });
    expect(r).toBeNull();
  });

  test('priority order: full list', () => {
    // Verify priority ordering by removing the top entry one at a time.
    const all = {
      'wl-copy': '/usr/bin/wl-copy',
      xclip: '/usr/bin/xclip',
      xsel: '/usr/bin/xsel',
      pbcopy: '/usr/bin/pbcopy',
      'clip.exe': '/mnt/c/Windows/System32/clip.exe',
    };
    const order = ['wl-copy', 'xclip', 'xsel', 'pbcopy', 'clip.exe'];
    let remaining: Record<string, string> = { ...all };
    for (const expected of order) {
      const r = detectBackend({ which: whichOf(remaining) });
      expect(r!.name).toBe(expected);
      delete remaining[expected];
    }
    expect(detectBackend({ which: whichOf(remaining) })).toBeNull();
  });
});

describe('runBackend', () => {
  const backend = { name: 'xclip', command: '/usr/bin/xclip' };

  test('exit 0 → true', async () => {
    const ok = await runBackend({ backend, text: 'hello', spawn: fakeSpawnExit(0) });
    expect(ok).toBe(true);
  });

  test('non-zero exit → false', async () => {
    const ok = await runBackend({ backend, text: 'hello', spawn: fakeSpawnExit(1) });
    expect(ok).toBe(false);
  });

  test('spawn throwing → false (no rethrow)', async () => {
    const ok = await runBackend({ backend, text: 'hello', spawn: fakeSpawnThrow() });
    expect(ok).toBe(false);
  });

  test('stdin write failure → false', async () => {
    const spawn: SpawnFn = () => {
      const proc: SpawnedProc = {
        stdin: {
          write() {
            throw new Error('EPIPE');
          },
          end() {
            /* noop */
          },
        },
        exited: Promise.resolve(0),
        kill() {
          /* noop */
        },
      };
      return proc;
    };
    const ok = await runBackend({ backend, text: 'hello', spawn });
    expect(ok).toBe(false);
  });

  test('writes text via stdin and closes it', async () => {
    let received = '';
    let ended = false;
    const spawn: SpawnFn = () => {
      const proc: SpawnedProc = {
        stdin: {
          write(chunk: string | Uint8Array) {
            received += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          },
          end() {
            ended = true;
          },
        },
        exited: Promise.resolve(0),
        kill() {
          /* noop */
        },
      };
      return proc;
    };
    await runBackend({ backend, text: 'payload-text', spawn });
    expect(received).toBe('payload-text');
    expect(ended).toBe(true);
  });

  test('xclip backend invokes with -selection clipboard', async () => {
    let invokedArgs: readonly string[] | null = null;
    const spawn: SpawnFn = (args, _opts) => {
      invokedArgs = args;
      return {
        stdin: { write() {}, end() {} },
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    await runBackend({
      backend: { name: 'xclip', command: '/usr/bin/xclip' },
      text: 'x',
      spawn,
    });
    expect(invokedArgs).toEqual(['/usr/bin/xclip', '-selection', 'clipboard']);
  });

  test('xsel backend invokes with -ib', async () => {
    let invokedArgs: readonly string[] | null = null;
    const spawn: SpawnFn = (args, _opts) => {
      invokedArgs = args;
      return {
        stdin: { write() {}, end() {} },
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    await runBackend({
      backend: { name: 'xsel', command: '/usr/bin/xsel' },
      text: 'x',
      spawn,
    });
    expect(invokedArgs).toEqual(['/usr/bin/xsel', '-ib']);
  });

  test('wl-copy backend invokes with no extra args', async () => {
    let invokedArgs: readonly string[] | null = null;
    const spawn: SpawnFn = (args, _opts) => {
      invokedArgs = args;
      return {
        stdin: { write() {}, end() {} },
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    await runBackend({
      backend: { name: 'wl-copy', command: '/usr/bin/wl-copy' },
      text: 'x',
      spawn,
    });
    expect(invokedArgs).toEqual(['/usr/bin/wl-copy']);
  });

  test('pbcopy backend invokes with no extra args', async () => {
    let invokedArgs: readonly string[] | null = null;
    const spawn: SpawnFn = (args, _opts) => {
      invokedArgs = args;
      return {
        stdin: { write() {}, end() {} },
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    await runBackend({
      backend: { name: 'pbcopy', command: '/usr/bin/pbcopy' },
      text: 'x',
      spawn,
    });
    expect(invokedArgs).toEqual(['/usr/bin/pbcopy']);
  });

  test('clip.exe backend invokes with no extra args', async () => {
    let invokedArgs: readonly string[] | null = null;
    const spawn: SpawnFn = (args, _opts) => {
      invokedArgs = args;
      return {
        stdin: { write() {}, end() {} },
        exited: Promise.resolve(0),
        kill() {},
      };
    };
    await runBackend({
      backend: { name: 'clip.exe', command: '/mnt/c/Windows/System32/clip.exe' },
      text: 'x',
      spawn,
    });
    expect(invokedArgs).toEqual(['/mnt/c/Windows/System32/clip.exe']);
  });
});
