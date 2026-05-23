import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { clearWarnings, flushWarnings, pendingWarnings, warn } from '../src/warnings.js';

// Other tests in the suite (e.g. config.test.ts) load config and may
// enqueue warnings into the shared sink via the config → warnings bridge.
// Clear before AND after to keep this file's assertions hermetic.
beforeEach(() => {
  clearWarnings();
});
afterEach(() => {
  clearWarnings();
});

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

describe('warnings', () => {
  test('warn() enqueues and pendingWarnings() inspects without draining', () => {
    warn('first');
    warn('second');
    expect(pendingWarnings()).toEqual(['first', 'second']);
    // pendingWarnings is a snapshot — calling again returns the same data
    expect(pendingWarnings()).toEqual(['first', 'second']);
  });

  test('flushWarnings drains and emits each line with a trailing newline', () => {
    warn('one');
    warn('two');
    const { stream, chunks } = makeBuf();
    const n = flushWarnings(stream as unknown as NodeJS.WriteStream);
    expect(n).toBe(2);
    expect(chunks.join('')).toBe('one\ntwo\n');
    expect(pendingWarnings()).toEqual([]);
  });

  test('flushWarnings on empty queue is a no-op and returns 0', () => {
    const { stream, chunks } = makeBuf();
    expect(flushWarnings(stream as unknown as NodeJS.WriteStream)).toBe(0);
    expect(chunks).toEqual([]);
  });

  test('clearWarnings drops queued warnings without printing', () => {
    warn('discard-me');
    clearWarnings();
    expect(pendingWarnings()).toEqual([]);
  });
});
