// Tests for clipboard.ts — mirrors clipboard_test.go from the Go reference.
//
// Real clipboard binaries are never exec'd; spawn is injected via the
// ClipboardSpawnFn seam.

import { describe, expect, test } from 'bun:test';
import {
  copyToClipboard,
  pickClipboardTool,
  type ClipboardSpawnFn,
} from '../src/clipboard.js';

// ── pickClipboardTool ─────────────────────────────────────────────────────────

describe('pickClipboardTool', () => {
  const env =
    (vars: Record<string, string>) =>
    (k: string): string | undefined =>
      vars[k];

  describe('linux', () => {
    test('WAYLAND_DISPLAY set → wl-copy', () => {
      const tool = pickClipboardTool('linux', env({ WAYLAND_DISPLAY: ':0' }));
      expect(tool).toEqual({ name: 'wl-copy', args: [] });
    });

    test('DISPLAY set (no Wayland) → xclip', () => {
      const tool = pickClipboardTool('linux', env({ DISPLAY: ':0' }));
      expect(tool).toEqual({ name: 'xclip', args: ['-selection', 'clipboard'] });
    });

    test('both WAYLAND_DISPLAY and DISPLAY → wl-copy (Wayland wins)', () => {
      const tool = pickClipboardTool(
        'linux',
        env({ WAYLAND_DISPLAY: ':0', DISPLAY: ':0' }),
      );
      expect(tool).toEqual({ name: 'wl-copy', args: [] });
    });

    test('headless (neither env var set) → null', () => {
      const tool = pickClipboardTool('linux', env({}));
      expect(tool).toBeNull();
    });

    test('WAYLAND_DISPLAY empty string → falls through to DISPLAY', () => {
      const tool = pickClipboardTool(
        'linux',
        env({ WAYLAND_DISPLAY: '', DISPLAY: ':1' }),
      );
      expect(tool).toEqual({ name: 'xclip', args: ['-selection', 'clipboard'] });
    });
  });

  describe('darwin', () => {
    test('→ pbcopy (no env needed)', () => {
      const tool = pickClipboardTool('darwin', env({}));
      expect(tool).toEqual({ name: 'pbcopy', args: [] });
    });
  });

  describe('win32', () => {
    test('→ clip (no env needed)', () => {
      const tool = pickClipboardTool('win32', env({}));
      expect(tool).toEqual({ name: 'clip', args: [] });
    });
  });

  describe('unsupported platform', () => {
    test('freebsd → null', () => {
      const tool = pickClipboardTool('freebsd' as NodeJS.Platform, env({}));
      expect(tool).toBeNull();
    });
  });
});

// ── copyToClipboard ───────────────────────────────────────────────────────────

/** Build an env function that returns the given vars. */
const makeEnv =
  (vars: Record<string, string>) =>
  (k: string): string | undefined =>
    vars[k];

/** A spawn that succeeds and records calls. */
function makeRecordingSpawn(): {
  calls: Array<{ name: string; args: string[]; text: string }>;
  fn: ClipboardSpawnFn;
} {
  const calls: Array<{ name: string; args: string[]; text: string }> = [];
  const fn: ClipboardSpawnFn = async (name, args, text) => {
    calls.push({ name, args, text });
  };
  return { calls, fn };
}

/** A spawn that throws on first call matching toolName, succeeds otherwise. */
function makeFailingSpawn(failName: string): ClipboardSpawnFn {
  return async (name) => {
    if (name === failName) throw new Error(`${name}: command not found`);
  };
}

describe('copyToClipboard', () => {
  test('linux/wayland → calls wl-copy with text', async () => {
    const { calls, fn } = makeRecordingSpawn();
    const result = await copyToClipboard(
      'hello',
      fn,
      'linux',
      makeEnv({ WAYLAND_DISPLAY: ':0' }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'wl-copy', args: [], text: 'hello' });
  });

  test('linux/X11 → calls xclip with correct args', async () => {
    const { calls, fn } = makeRecordingSpawn();
    const result = await copyToClipboard(
      'world',
      fn,
      'linux',
      makeEnv({ DISPLAY: ':0' }),
    );
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({
      name: 'xclip',
      args: ['-selection', 'clipboard'],
      text: 'world',
    });
  });

  test('darwin → calls pbcopy', async () => {
    const { calls, fn } = makeRecordingSpawn();
    const result = await copyToClipboard('mac text', fn, 'darwin', makeEnv({}));
    expect(result.ok).toBe(true);
    expect(calls[0]?.name).toBe('pbcopy');
    expect(calls[0]?.text).toBe('mac text');
  });

  test('win32 → calls clip', async () => {
    const { calls, fn } = makeRecordingSpawn();
    const result = await copyToClipboard('win text', fn, 'win32', makeEnv({}));
    expect(result.ok).toBe(true);
    expect(calls[0]?.name).toBe('clip');
  });

  test('unsupported platform → ok:false + error', async () => {
    const { fn } = makeRecordingSpawn();
    const result = await copyToClipboard(
      'text',
      fn,
      'freebsd' as NodeJS.Platform,
      makeEnv({}),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('freebsd');
  });

  test('headless linux → ok:false + error', async () => {
    const { fn } = makeRecordingSpawn();
    const result = await copyToClipboard('text', fn, 'linux', makeEnv({}));
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('linux');
  });

  test('xclip failure → falls back to xsel', async () => {
    const calls: Array<{ name: string }> = [];
    const fn: ClipboardSpawnFn = async (name, _args, _text) => {
      calls.push({ name });
      if (name === 'xclip') throw new Error('xclip not found');
      // xsel succeeds
    };
    const result = await copyToClipboard(
      'text',
      fn,
      'linux',
      makeEnv({ DISPLAY: ':0' }),
    );
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['xclip', 'xsel']);
  });

  test('xclip and xsel both fail → ok:false with both messages', async () => {
    const fn = makeFailingSpawn('xclip'); // xsel also fails since we reuse this
    // Override: both tools fail
    const bothFail: ClipboardSpawnFn = async (name) => {
      throw new Error(`${name}: not found`);
    };
    const result = await copyToClipboard(
      'text',
      bothFail,
      'linux',
      makeEnv({ DISPLAY: ':0' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('xclip');
    expect(result.error?.message).toContain('xsel');
  });

  test('non-xclip tool failure → ok:false directly', async () => {
    const fn: ClipboardSpawnFn = async () => {
      throw new Error('wl-copy failed');
    };
    const result = await copyToClipboard(
      'text',
      fn,
      'linux',
      makeEnv({ WAYLAND_DISPLAY: ':0' }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('wl-copy');
  });

  test('text is passed verbatim including newlines', async () => {
    const { calls, fn } = makeRecordingSpawn();
    const multiline = 'line1\nline2\nline3';
    await copyToClipboard(multiline, fn, 'darwin', makeEnv({}));
    expect(calls[0]?.text).toBe(multiline);
  });
});
