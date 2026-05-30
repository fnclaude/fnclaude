import { describe, expect, test } from 'bun:test';

import { createFileSink } from '../../src/log/file-sink.ts';
import type { LogRecord } from '../../src/log/logger.ts';

const rec: LogRecord = { t: 1, pid: 2, ppid: 3, lvl: 'info', ev: 'boot', cwd: '/tmp' };

describe('createFileSink', () => {
  test('serializes one JSON line per record (trailing newline)', () => {
    const writes: Array<{ path: string; line: string }> = [];
    const sink = createFileSink({
      path: '/log/x.jsonl',
      append: (path, line) => writes.push({ path, line }),
    });
    sink(rec);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('/log/x.jsonl');
    expect(writes[0]!.line).toBe(`${JSON.stringify(rec)}\n`);
    expect(JSON.parse(writes[0]!.line.trimEnd())).toEqual(rec);
  });

  test('one call per record', () => {
    let calls = 0;
    const sink = createFileSink({ path: '/log/x.jsonl', append: () => { calls += 1; } });
    sink(rec);
    sink(rec);
    expect(calls).toBe(2);
  });

  test('a throwing append is swallowed — no throw escapes', () => {
    const sink = createFileSink({
      path: '/log/x.jsonl',
      append: () => {
        throw new Error('EACCES');
      },
    });
    expect(() => sink(rec)).not.toThrow();
  });

  test('routes append errors to onError', () => {
    const errors: unknown[] = [];
    const sink = createFileSink({
      path: '/log/x.jsonl',
      append: () => {
        throw new Error('disk full');
      },
      onError: (e) => errors.push(e),
    });
    sink(rec);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('disk full');
  });
});
