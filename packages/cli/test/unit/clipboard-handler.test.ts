/**
 * Unit tests for §8.4 handler — `handleCopyToClipboard`.
 *
 * The handler never errors: clipboard absence is reported via the
 * `clipboard_ok: false` flag, defensive arg-type failures likewise.
 */

import { describe, expect, test } from 'bun:test';

import { handleCopyToClipboard } from '../../src/mcp/handlers/clipboard';
import type { WhichFn, SpawnFn } from '../../src/mcp/handlers/clipboard-backends';

const whichWlCopy: WhichFn = (name) => (name === 'wl-copy' ? '/usr/bin/wl-copy' : null);
const whichNone: WhichFn = () => null;

const spawnOk: SpawnFn = () => ({
  stdin: { write() {}, end() {} },
  exited: Promise.resolve(0),
  kill() {},
});

const spawnFail: SpawnFn = () => ({
  stdin: { write() {}, end() {} },
  exited: Promise.resolve(2),
  kill() {},
});

describe('handleCopyToClipboard', () => {
  test('valid text + working backend → done, clipboard_ok=true', async () => {
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard', text: 'hello world' },
      { which: whichWlCopy, spawn: spawnOk },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(true);
  });

  test('no backend on PATH → done, clipboard_ok=false', async () => {
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard', text: 'hello' },
      { which: whichNone, spawn: spawnOk },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(false);
  });

  test('backend exits non-zero → done, clipboard_ok=false', async () => {
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard', text: 'hello' },
      { which: whichWlCopy, spawn: spawnFail },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(false);
  });

  test('missing text arg → done, clipboard_ok=false (defensive)', async () => {
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard' },
      { which: whichWlCopy, spawn: spawnOk },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(false);
  });

  test('text arg is wrong type → done, clipboard_ok=false', async () => {
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard', text: 123 as unknown as string },
      { which: whichWlCopy, spawn: spawnOk },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(false);
  });

  test('text arg is null → done, clipboard_ok=false', async () => {
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard', text: null as unknown as string },
      { which: whichWlCopy, spawn: spawnOk },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(false);
  });

  test('empty string text is still copied (length 0 is valid payload)', async () => {
    let writtenLen = -1;
    const spawn: SpawnFn = () => ({
      stdin: {
        write(chunk: string | Uint8Array) {
          writtenLen = typeof chunk === 'string' ? chunk.length : chunk.byteLength;
        },
        end() {},
      },
      exited: Promise.resolve(0),
      kill() {},
    });
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard', text: '' },
      { which: whichWlCopy, spawn },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(true);
    expect(writtenLen).toBe(0);
  });

  test('spawn throwing → done, clipboard_ok=false (no propagation)', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('ENOENT');
    };
    const r = await handleCopyToClipboard(
      { op: 'copy_to_clipboard', text: 'hello' },
      { which: whichWlCopy, spawn },
    );
    expect(r.action).toBe('done');
    expect(r.clipboard_ok).toBe(false);
  });
});
