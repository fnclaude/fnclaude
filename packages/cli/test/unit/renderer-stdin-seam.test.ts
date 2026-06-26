/**
 * Seam regression: fnc's production SpawnProc must hand the renderer a stdin
 * that is a real WHATWG WritableStream, because the renderer's
 * `subscribeToClaude` immediately calls `proc.stdin.getWriter()`.
 *
 * `Bun.spawn(..., { stdin: 'pipe' })` returns a FileSink (`.write()`/`.end()`,
 * NO `getWriter`). The original `makeProdSpawnProc` cast that FileSink straight
 * across the `stdin: WritableStream<Uint8Array>` contract, so mounting combined
 * mode (`FNC_RENDERER=1`) crashed on mount with
 * `proc.stdin.getWriter is not a function`.
 *
 * Why it slipped: the renderer's OWN unit tests feed `subscribeToClaude` a
 * WritableStream-shaped mock, so they never exercised fnc's FileSink-backed
 * stdin. This test drives the REAL cli→renderer seam end to end: fnc's
 * `makeProdSpawnProc` (with Bun.spawn stubbed to return a FileSink-shaped
 * stdin) → `makeFncSpawn` → the renderer's actual `subscribeToClaude`.
 */
import { describe, expect, test } from 'bun:test';

import { subscribeToClaude } from '../../../renderer/src/claude-process';
import {
  type LowLevelSpawn,
  makeFncSpawn,
  makeProdSpawnProc,
} from '../../src/launch/renderer-mount';

/**
 * A Bun.spawn stub whose stdin is a FileSink (write/end, NO getWriter) — the
 * exact shape Bun returns and the exact shape that crashed combined mode.
 */
function makeFileSinkSpawn(): { spawn: LowLevelSpawn; written: () => string } {
  const chunks: Uint8Array[] = [];
  const spawn: LowLevelSpawn = () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    // The crux: a FileSink, NOT a WritableStream. No getWriter on this object.
    stdin: {
      write(chunk: Uint8Array) {
        chunks.push(chunk);
        return chunk.byteLength;
      },
      end() {
        return 0;
      },
    },
    exited: Promise.resolve(0),
    kill() {},
  });
  return {
    spawn,
    written: () => chunks.map((c) => new TextDecoder().decode(c)).join(''),
  };
}

describe('cli→renderer stdin seam', () => {
  test('fnc prod spawn feeds subscribeToClaude a WritableStream stdin (getWriter works)', async () => {
    const { spawn, written } = makeFileSinkSpawn();
    const spawnProc = makeProdSpawnProc(() => {}, spawn);
    const spawnFn = makeFncSpawn({ claudeBin: '/resolved/claude', childEnv: {}, spawnProc });

    // Before the fix this throws synchronously at construction:
    // subscribeToClaude calls proc.stdin.getWriter(), which a FileSink lacks.
    const sub = subscribeToClaude({ spawnFn });
    sub.sendUserTurn('hello world');
    // close() flushes queued writes through the WritableStream then ends the sink.
    await sub.close();

    const out = written();
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out.trim()) as {
      type: string;
      message: { role: string; content: { type: string; text: string }[] };
    };
    expect(parsed.type).toBe('user');
    expect(parsed.message.content[0]?.text).toBe('hello world');
  });
});
