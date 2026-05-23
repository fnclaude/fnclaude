/**
 * End-to-end test for the cross-cwd resume pipeline.
 *
 * The flow under test (no Claude binary required):
 *
 *   1. Synthetic claude PTY output is fed through a RingBuffer (mirrors
 *      what unix.ts collects in production).
 *   2. detectCrossCwd scans the ring tail for the "cd <dest> && claude
 *      --resume <uuid>" marker, returning the parsed destination and UUID.
 *   3. reconstructArgv takes the ORIGINAL fnclaude argv plus dest/uuid
 *      and produces the argv that silentRelaunch would execve with.
 *
 * The Go reference behavior (preserved magic words, stripped positional
 * paths, kept-everything-from-first-flag-onward) is the contract these
 * tests pin. Failure modes that previously surfaced in the wild:
 *
 *   - Trailing TUI cleanup escapes (\x1b[K\r\x1b[1C\x1b[1B between the
 *     "To resume, run:" line and the "cd … && claude --resume …" line)
 *     break a naively-anchored regex. The crossCwdRe handles this via
 *     [\s\S]*? — covered below as fixture "ansi_cleanup".
 *
 *   - Claude 2.1.143 began emitting more trailing cleanup before exit, so
 *     a 4 KB ring buffer was too small in the wild; RING_BUFFER_SIZE was
 *     bumped to 64 KB. Covered indirectly via the "large_preamble"
 *     fixture which writes more than the old 4 KB cap before the marker.
 */

import { describe, expect, test } from 'bun:test';
import {
  detectCrossCwd,
  reconstructArgv,
  RING_BUFFER_SIZE,
  RingBuffer,
} from '../../src/pty.js';

/** Drive bytes through a ring + run the detector, end-to-end. */
function pipeline(chunks: ReadonlyArray<string | Buffer>): {
  hit: ReturnType<typeof detectCrossCwd>;
  tailLen: number;
} {
  const ring = new RingBuffer(RING_BUFFER_SIZE);
  for (const c of chunks) ring.write(c);
  const tail = ring.bytes();
  const hit = detectCrossCwd(tail);
  return { hit, tailLen: tail.length };
}

describe('cross-cwd e2e — synthetic PTY output → reconstructed next argv', () => {
  test('plain marker → detect + reconstruct preserves first-flag-onward', async () => {
    const dest = '/home/user/src/target-repo';
    const uuid = 'aabbccdd-eeff-1122-3344-556677889900';
    const out = `noise…\nTo resume, run:\ncd ${dest} && claude --resume ${uuid}\n`;

    const { hit } = pipeline([out]);
    expect(hit).not.toBeNull();
    expect(hit!.dest).toBe(dest);
    expect(hit!.uuid).toBe(uuid);

    // Original argv had a magic word + a path + a flag. After cross-cwd
    // reconstruction: magic preserved, path dropped, --resume injected,
    // flag preserved (no denylist on cross-cwd resume).
    const origArgs = ['opus', '/home/user/src/source-repo', '-V'];
    const next = reconstructArgv(origArgs, hit!.dest, hit!.uuid);
    expect(next).toEqual(['opus', dest, '--resume', uuid, '-V']);
  });

  test('TUI cleanup escapes between anchors do not defeat detection', async () => {
    // crossCwdRe uses [\s\S]*? to swallow the TUI goo claude emits between
    // "To resume, run:" and the cd line; observed in the wild:
    //   \x1b[K\r\x1b[1C\x1b[1B
    const dest = '/another/cwd';
    const uuid = '11111111-2222-3333-4444-555555555555';
    const out =
      'something earlier\nTo resume, run:' +
      '\x1b[K\r\x1b[1C\x1b[1B' +
      `cd ${dest} && claude --resume ${uuid}\n` +
      // Trailing TUI cleanup after the cd line too — defensive.
      '\x1b[?1049l\x1b[?25h';

    const { hit } = pipeline([out]);
    expect(hit).not.toBeNull();
    expect(hit!.dest).toBe(dest);
    expect(hit!.uuid).toBe(uuid);
  });

  test('large preamble before marker still detected (RING_BUFFER_SIZE is enough)', async () => {
    // Earlier 4 KB ring buffer was too small; bumped to 64 KB. Verify by
    // writing > 4 KB of preamble before the marker line.
    const filler = 'x'.repeat(5_000);
    const dest = '/dst';
    const uuid = 'cafebabe-1234-5678-9abc-def012345678';
    const out = `${filler}\nTo resume, run:\ncd ${dest} && claude --resume ${uuid}\n`;

    const { hit } = pipeline([out]);
    expect(hit).not.toBeNull();
    expect(hit!.dest).toBe(dest);
    expect(hit!.uuid).toBe(uuid);
  });

  test('marker split across multiple write() chunks still resolves', async () => {
    const dest = '/split/cwd';
    const uuid = 'deadbeef-0000-1111-2222-333333333333';
    // Split the marker boundary across two writes — exercises chunked
    // ring assembly.
    const chunks = [
      'preamble noise\nTo resume, run:\ncd /sp',
      `lit/cwd && claude --resume ${uuid}\ntrailing`,
    ];
    expect(chunks[0]! + chunks[1]!).toContain(`cd ${dest} && claude --resume ${uuid}`);

    const { hit } = pipeline(chunks);
    expect(hit).not.toBeNull();
    expect(hit!.dest).toBe(dest);
    expect(hit!.uuid).toBe(uuid);
  });

  test('LAST marker wins when output contains multiple', async () => {
    // Defensive: should multiple markers ever appear, the most-recent one
    // is the one the user just acted on.
    const out =
      'To resume, run:\ncd /first && claude --resume 11111111-1111-1111-1111-111111111111\n' +
      'more output…\n' +
      'To resume, run:\ncd /second && claude --resume 22222222-2222-2222-2222-222222222222\n';

    const { hit } = pipeline([out]);
    expect(hit).not.toBeNull();
    expect(hit!.dest).toBe('/second');
    expect(hit!.uuid).toBe('22222222-2222-2222-2222-222222222222');
  });

  test('no marker → null', async () => {
    const out = 'just some plain output with no resume marker';
    const { hit } = pipeline([out]);
    expect(hit).toBeNull();
  });

  test('reconstructed argv: bare invocation gets just dest + --resume', async () => {
    // Original argv was empty (bare `fnclaude`) — no magic words, no path,
    // no flags. After cross-cwd resume: just dest + --resume uuid.
    const next = reconstructArgv(
      [],
      '/dst',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(next).toEqual(['/dst', '--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  });

  test('reconstructed argv: magic-only invocation preserves magic', async () => {
    const next = reconstructArgv(
      ['opus', 'max'],
      '/dst',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    expect(next).toEqual(['opus', 'max', '/dst', '--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  });

  test('reconstructed argv: positional paths dropped, flags kept', async () => {
    const next = reconstructArgv(
      ['opus', '/orig/src', '-V', '--allowedTools', 'Bash'],
      '/dst',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    // /orig/src dropped; everything from -V on (the first flag) preserved.
    expect(next).toEqual([
      'opus',
      '/dst',
      '--resume',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '-V',
      '--allowedTools',
      'Bash',
    ]);
  });
});
