/**
 * The config loader's {@link IFileSystem} read seam (design.di-architecture §5,
 * PR-2). These pin what the temp-dir suite in `config-load.test.ts` cannot: that
 * `loadConfig` reads only through the injected filesystem (hermetic, no disk) and
 * degrades to defaults when a read fails rather than throwing.
 */

import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../../src/config/load';
import type { IFileSystem } from '../../src/ports/contracts';

/** In-memory {@link IFileSystem}; a path mapped to `null` exists but rejects on read. */
class InMemoryFileSystem implements IFileSystem {
  #files: Map<string, string | null>;

  constructor(files: Record<string, string | null>) {
    this.#files = new Map(Object.entries(files));
  }

  isFile(path: string): boolean {
    return this.#files.has(path);
  }

  readText(path: string): Promise<string> {
    const body = this.#files.get(path);
    if (body === undefined || body === null) {
      return Promise.reject(new Error(`unreadable: ${path}`));
    }
    return Promise.resolve(body);
  }
}

const env = { home: '/home/u', xdgConfigHome: '/home/u/.config' };
const CONFIG_PATH = '/home/u/.config/rhombus.rocks/fnclaude/config.json';

describe('loadConfig — IFileSystem read seam', () => {
  test('reads config through the injected filesystem, never disk', async () => {
    const fs = new InMemoryFileSystem({
      [CONFIG_PATH]: JSON.stringify({ auto: { tmux: 'worktree' } }),
    });
    const c = await loadConfig({ env, fs });
    expect(c.autoTmux).toBe('worktree');
  });

  test('a read that rejects degrades to defaults, no throw', async () => {
    // isFile() reports the file present, but readText() rejects (permission,
    // vanished-after-stat). The loader must swallow it and return defaults.
    const fs = new InMemoryFileSystem({ [CONFIG_PATH]: null });
    const c = await loadConfig({ env, fs });
    expect(c.autoTmux).toBeUndefined();
    expect(c.noOobe).toBe(false);
  });

  test('no file in the fake filesystem → defaults, nothing written', async () => {
    const writes: string[] = [];
    const fs = new InMemoryFileSystem({});
    const c = await loadConfig({ env, fs, write: (p) => writes.push(p) });
    expect(c.autoTmux).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
