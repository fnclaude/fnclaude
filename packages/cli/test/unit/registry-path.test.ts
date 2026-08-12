import { describe, expect, test } from 'bun:test';

import { computeRegistryDir, registryFilePath } from '../../src/registry/registry-path';

describe('computeRegistryDir', () => {
  test('linux: honors XDG_STATE_HOME', () => {
    expect(
      computeRegistryDir({
        env: { XDG_STATE_HOME: '/xdg/state' },
        platform: 'linux',
        home: '/home/u',
      }),
    ).toBe('/xdg/state/fnclaude/registry');
  });

  test('linux: falls back to ~/.local/state when XDG_STATE_HOME unset', () => {
    expect(computeRegistryDir({ env: {}, platform: 'linux', home: '/home/u' })).toBe(
      '/home/u/.local/state/fnclaude/registry',
    );
  });

  test('linux: treats empty-string XDG_STATE_HOME as unset', () => {
    expect(
      computeRegistryDir({ env: { XDG_STATE_HOME: '' }, platform: 'linux', home: '/home/u' }),
    ).toBe('/home/u/.local/state/fnclaude/registry');
  });

  test('darwin: uses ~/Library/Application Support/fnclaude/registry', () => {
    expect(computeRegistryDir({ env: {}, platform: 'darwin', home: '/Users/u' })).toBe(
      '/Users/u/Library/Application Support/fnclaude/registry',
    );
  });

  test('win32: honors LOCALAPPDATA', () => {
    expect(
      computeRegistryDir({
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        platform: 'win32',
        home: 'C:\\Users\\u',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Local\\fnclaude\\registry');
  });

  test('win32: falls back to home AppData\\Local when LOCALAPPDATA unset', () => {
    expect(computeRegistryDir({ env: {}, platform: 'win32', home: 'C:\\Users\\u' })).toBe(
      'C:\\Users\\u\\AppData\\Local\\fnclaude\\registry',
    );
  });
});

describe('registryFilePath', () => {
  test('joins dir and <session-id>.json', () => {
    expect(registryFilePath('/state/fnclaude/registry', 'abc-123')).toBe(
      '/state/fnclaude/registry/abc-123.json',
    );
  });
});
