import { describe, expect, test } from 'bun:test';

import {
  createLogger,
  NOOP_LOGGER,
  parseLevel,
  type LogRecord,
} from '../../src/log/logger.ts';

function collect(): { sink: (r: LogRecord) => void; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { sink: (r) => records.push(r), records };
}

describe('createLogger record shape', () => {
  test('emits t/pid/ppid/lvl/ev plus merged fields with injected seams', () => {
    const { sink, records } = collect();
    const logger = createLogger({
      sink,
      level: 'debug',
      now: () => 1780000000000,
      pid: 111,
      ppid: 222,
    });
    logger.info('boot', { argv: ['a', 'b'], cwd: '/tmp' });
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      t: 1780000000000,
      pid: 111,
      ppid: 222,
      lvl: 'info',
      ev: 'boot',
      argv: ['a', 'b'],
      cwd: '/tmp',
    });
  });

  test('merges base fields into every record', () => {
    const { sink, records } = collect();
    const logger = createLogger({
      sink,
      level: 'debug',
      now: () => 1,
      pid: 1,
      ppid: 0,
      base: { session: 'abc' },
    });
    logger.warn('x');
    logger.error('y', { extra: true });
    expect(records[0]!.session).toBe('abc');
    expect(records[1]!.session).toBe('abc');
    expect(records[1]!.extra).toBe(true);
  });

  test('fields can override base fields', () => {
    const { sink, records } = collect();
    const logger = createLogger({
      sink,
      level: 'debug',
      now: () => 1,
      pid: 1,
      ppid: 0,
      base: { k: 'base' },
    });
    logger.info('e', { k: 'call' });
    expect(records[0]!.k).toBe('call');
  });
});

describe('level gating', () => {
  test("level 'info' drops debug, keeps info/warn/error", () => {
    const { sink, records } = collect();
    const logger = createLogger({ sink, level: 'info', now: () => 1, pid: 1, ppid: 0 });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(records.map((r) => r.ev)).toEqual(['i', 'w', 'e']);
  });

  test("level 'error' keeps only error", () => {
    const { sink, records } = collect();
    const logger = createLogger({ sink, level: 'error', now: () => 1, pid: 1, ppid: 0 });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(records.map((r) => r.ev)).toEqual(['e']);
  });

  test("level 'debug' keeps everything", () => {
    const { sink, records } = collect();
    const logger = createLogger({ sink, level: 'debug', now: () => 1, pid: 1, ppid: 0 });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(records.map((r) => r.ev)).toEqual(['d', 'i', 'w', 'e']);
  });
});

describe('NOOP_LOGGER', () => {
  test('writes nothing and never throws', () => {
    expect(() => {
      NOOP_LOGGER.debug('a');
      NOOP_LOGGER.info('b', { x: 1 });
      NOOP_LOGGER.warn('c');
      NOOP_LOGGER.error('d');
    }).not.toThrow();
  });
});

describe('parseLevel', () => {
  test('parses each level (case-insensitive)', () => {
    expect(parseLevel('debug')).toBe('debug');
    expect(parseLevel('INFO')).toBe('info');
    expect(parseLevel('Warn')).toBe('warn');
    expect(parseLevel('ERROR')).toBe('error');
  });

  test('silent aliases map to silent', () => {
    expect(parseLevel('silent')).toBe('silent');
    expect(parseLevel('off')).toBe('silent');
    expect(parseLevel('none')).toBe('silent');
    expect(parseLevel('OFF')).toBe('silent');
  });

  test('unknown and undefined map to undefined', () => {
    expect(parseLevel('verbose')).toBeUndefined();
    expect(parseLevel('')).toBeUndefined();
    expect(parseLevel(undefined)).toBeUndefined();
  });
});
