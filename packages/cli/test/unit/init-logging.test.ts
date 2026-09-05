import { describe, expect, test } from 'bun:test';

import { initLogging } from '../../src/log/init';
import type { LogRecord } from '../../src/log/logger';

const base = {
  platform: 'linux' as NodeJS.Platform,
  home: '/home/u',
  pid: 7,
  ppid: 8,
  now: () => 1780000000000,
};

function spies() {
  const appended: Array<{ path: string; line: string }> = [];
  const mkdirCalls: string[] = [];
  return {
    appended,
    mkdirCalls,
    mkdir: (dir: string) => {
      mkdirCalls.push(dir);
    },
    append: (path: string, line: string) => {
      appended.push({ path, line });
    },
    // prune seams: empty dir, no-op
    readdir: () => [],
    stat: () => ({ mtimeMs: 0 }),
    unlink: () => {},
  };
}

describe('initLogging level precedence', () => {
  test('FNC_LOG overrides configLevel and default', () => {
    const s = spies();
    const { logger, logPath } = initLogging({
      ...base,
      env: { FNC_LOG: 'debug', XDG_STATE_HOME: '/state' },
      configLevel: 'error',
      mkdir: s.mkdir,
      append: s.append,
      readdir: s.readdir,
      stat: s.stat,
      unlink: s.unlink,
    });
    expect(logPath).toBe('/state/rhombus.rocks/fnclaude/fnclaude-1780000000000-7.jsonl');
    logger.debug('d');
    expect(s.appended).toHaveLength(1); // debug passes at level debug
  });

  test('configLevel used when FNC_LOG unset/unrecognized', () => {
    const s = spies();
    const { logger } = initLogging({
      ...base,
      env: { FNC_LOG: 'bogus', XDG_STATE_HOME: '/state' },
      configLevel: 'error',
      mkdir: s.mkdir,
      append: s.append,
      readdir: s.readdir,
      stat: s.stat,
      unlink: s.unlink,
    });
    logger.warn('w'); // below error → dropped
    logger.error('e');
    expect(s.appended.map((a) => JSON.parse(a.line.trimEnd()).ev)).toEqual(['e']);
  });

  test('defaults to info when neither source resolves', () => {
    const s = spies();
    const { logger } = initLogging({
      ...base,
      env: { XDG_STATE_HOME: '/state' },
      mkdir: s.mkdir,
      append: s.append,
      readdir: s.readdir,
      stat: s.stat,
      unlink: s.unlink,
    });
    logger.debug('d'); // dropped at info
    logger.info('i');
    expect(s.appended.map((a) => JSON.parse(a.line.trimEnd()).ev)).toEqual(['i']);
  });
});

describe('initLogging silent', () => {
  test("FNC_LOG=silent → NOOP logger + null path, no mkdir", () => {
    const s = spies();
    const { logger, logPath } = initLogging({
      ...base,
      env: { FNC_LOG: 'silent', XDG_STATE_HOME: '/state' },
      mkdir: s.mkdir,
      append: s.append,
      readdir: s.readdir,
      stat: s.stat,
      unlink: s.unlink,
    });
    expect(logPath).toBeNull();
    logger.error('e');
    expect(s.appended).toHaveLength(0);
    expect(s.mkdirCalls).toHaveLength(0);
  });

  test("FNC_LOG=off → NOOP + null", () => {
    const s = spies();
    const { logPath } = initLogging({
      ...base,
      env: { FNC_LOG: 'off' },
      mkdir: s.mkdir,
      append: s.append,
      readdir: s.readdir,
      stat: s.stat,
      unlink: s.unlink,
    });
    expect(logPath).toBeNull();
  });
});

describe('initLogging mkdir failure', () => {
  test('degrades to NOOP + null path, never throws', () => {
    const s = spies();
    let result!: ReturnType<typeof initLogging>;
    expect(() => {
      result = initLogging({
        ...base,
        env: { XDG_STATE_HOME: '/state' },
        mkdir: () => {
          throw new Error('EACCES');
        },
        append: s.append,
        readdir: s.readdir,
        stat: s.stat,
        unlink: s.unlink,
      });
    }).not.toThrow();
    expect(result.logPath).toBeNull();
    result.logger.error('e');
    expect(s.appended).toHaveLength(0);
  });
});

describe('initLogging happy path', () => {
  test('records reach the file sink', () => {
    const s = spies();
    const { logger, logPath } = initLogging({
      ...base,
      env: { XDG_STATE_HOME: '/state' },
      mkdir: s.mkdir,
      append: s.append,
      readdir: s.readdir,
      stat: s.stat,
      unlink: s.unlink,
    });
    expect(s.mkdirCalls).toEqual(['/state/rhombus.rocks/fnclaude']);
    logger.info('boot', { cwd: '/work' });
    expect(s.appended).toHaveLength(1);
    const rec: LogRecord = JSON.parse(s.appended[0]!.line.trimEnd());
    expect(rec.ev).toBe('boot');
    expect(rec.pid).toBe(7);
    expect(rec.ppid).toBe(8);
    expect(rec.t).toBe(1780000000000);
    expect(rec.cwd).toBe('/work');
    expect(s.appended[0]!.path).toBe(logPath);
  });

  test('runs prune against the resolved dir', () => {
    const s = spies();
    const seen: string[] = [];
    initLogging({
      ...base,
      env: { XDG_STATE_HOME: '/state' },
      keep: 3,
      mkdir: s.mkdir,
      append: s.append,
      readdir: (dir: string) => {
        seen.push(dir);
        return [];
      },
      stat: s.stat,
      unlink: s.unlink,
    });
    expect(seen).toEqual(['/state/rhombus.rocks/fnclaude']);
  });
});
