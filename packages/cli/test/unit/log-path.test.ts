import { describe, expect, test } from 'bun:test';

import { computeLogDir, computeLogFilePath, logFileName } from '../../src/log/log-path';

describe('computeLogDir', () => {
  test('linux: honors XDG_STATE_HOME', () => {
    expect(
      computeLogDir({
        env: { XDG_STATE_HOME: '/xdg/state' },
        platform: 'linux',
        home: '/home/u',
      }),
    ).toBe('/xdg/state/fnclaude/logs');
  });

  test('linux: falls back to ~/.local/state when XDG_STATE_HOME unset', () => {
    expect(computeLogDir({ env: {}, platform: 'linux', home: '/home/u' })).toBe(
      '/home/u/.local/state/fnclaude/logs',
    );
  });

  test('linux: treats empty-string XDG_STATE_HOME as unset', () => {
    expect(
      computeLogDir({ env: { XDG_STATE_HOME: '' }, platform: 'linux', home: '/home/u' }),
    ).toBe('/home/u/.local/state/fnclaude/logs');
  });

  test('darwin: uses ~/Library/Logs/fnclaude', () => {
    expect(computeLogDir({ env: {}, platform: 'darwin', home: '/Users/u' })).toBe(
      '/Users/u/Library/Logs/fnclaude',
    );
  });

  test('win32: honors LOCALAPPDATA', () => {
    expect(
      computeLogDir({
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        platform: 'win32',
        home: 'C:\\Users\\u',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Local\\fnclaude\\logs');
  });

  test('win32: falls back to home AppData\\Local when LOCALAPPDATA unset', () => {
    expect(computeLogDir({ env: {}, platform: 'win32', home: 'C:\\Users\\u' })).toBe(
      'C:\\Users\\u\\AppData\\Local\\fnclaude\\logs',
    );
  });

  test('win32: treats empty-string LOCALAPPDATA as unset', () => {
    expect(
      computeLogDir({ env: { LOCALAPPDATA: '' }, platform: 'win32', home: 'C:\\Users\\u' }),
    ).toBe('C:\\Users\\u\\AppData\\Local\\fnclaude\\logs');
  });
});

describe('logFileName', () => {
  test('encodes epoch-ms and pid, no colons', () => {
    const name = logFileName({ pid: 4242, timestampMs: 1780000000000 });
    expect(name).toBe('fnclaude-1780000000000-4242.jsonl');
    expect(name).not.toContain(':');
  });
});

describe('computeLogFilePath', () => {
  test('joins dir + filename', () => {
    expect(
      computeLogFilePath({ dir: '/var/log/fnclaude', pid: 7, timestampMs: 1780000000000 }),
    ).toBe('/var/log/fnclaude/fnclaude-1780000000000-7.jsonl');
  });
});
