import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { flushWarnings } from '../src/warnings.js';

// Tiny in-memory stderr substitute that satisfies the WriteStream
// duck-typing used by flushWarnings (only .write is called).
function makeBuf() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      cb();
    },
  });
  return { stream, chunks };
}

describe('flushWarnings', () => {
  test('writes each warning to the stream with a trailing newline and returns count', () => {
    const { stream, chunks } = makeBuf();
    const n = flushWarnings(['one', 'two'], stream as unknown as NodeJS.WriteStream);
    expect(n).toBe(2);
    expect(chunks.join('')).toBe('one\ntwo\n');
  });

  test('empty input is a no-op and returns 0', () => {
    const { stream, chunks } = makeBuf();
    expect(flushWarnings([], stream as unknown as NodeJS.WriteStream)).toBe(0);
    expect(chunks).toEqual([]);
  });

  test('preserves order', () => {
    const { stream, chunks } = makeBuf();
    flushWarnings(['c', 'a', 'b'], stream as unknown as NodeJS.WriteStream);
    expect(chunks.join('')).toBe('c\na\nb\n');
  });
});
