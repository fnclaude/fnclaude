import { describe, expect, test } from 'bun:test';

import { createWarningBuffer } from '../../src/warnings/buffer';

/**
 * Minimal in-memory writable stream stand-in. We only need .write to land
 * the bytes somewhere we can assert against — no need to construct a real
 * stream.Writable.
 */
function makeSink(): { written: string[]; stream: NodeJS.WritableStream } {
  const written: string[] = [];
  const stream = {
    write(chunk: unknown): boolean {
      written.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { written, stream };
}

describe('createWarningBuffer', () => {
  test('add → add → flush writes both, in order, newline-terminated', () => {
    const buf = createWarningBuffer();
    const { written, stream } = makeSink();
    buf.add('first warning');
    buf.add('second warning');
    buf.flush(stream);
    expect(written).toEqual(['first warning\n', 'second warning\n']);
  });

  test('messages with trailing newline are not double-terminated', () => {
    const buf = createWarningBuffer();
    const { written, stream } = makeSink();
    buf.add('already-newlined\n');
    buf.flush(stream);
    expect(written).toEqual(['already-newlined\n']);
  });

  test('flush with no adds is a no-op (does not write anything)', () => {
    const buf = createWarningBuffer();
    const { written, stream } = makeSink();
    buf.flush(stream);
    expect(written).toEqual([]);
  });

  test('flush drains: second flush after first writes nothing', () => {
    const buf = createWarningBuffer();
    const { written, stream } = makeSink();
    buf.add('warning A');
    buf.flush(stream);
    expect(written).toEqual(['warning A\n']);
    buf.flush(stream);
    // No second copy — the buffer drained on first flush.
    expect(written).toEqual(['warning A\n']);
  });

  test('add → flush → add → flush emits each warning exactly once', () => {
    const buf = createWarningBuffer();
    const { written, stream } = makeSink();
    buf.add('one');
    buf.flush(stream);
    buf.add('two');
    buf.flush(stream);
    expect(written).toEqual(['one\n', 'two\n']);
  });
});
