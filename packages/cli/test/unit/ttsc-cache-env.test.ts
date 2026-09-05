/**
 * The dev build's transform host must cache under the checkout, never under
 * `$HOME`.
 *
 * `ensureFreshDist` (bin/fnc.js) runs the ttsc/Go host on every launch from a
 * checkout, including the HOME-isolated launches the `fnc install` e2e spawns.
 * When the caches defaulted under `homedir()`, each such launch wrote its Go
 * build/module caches into the test's throwaway HOME and paid a cold host
 * compile — hundreds of MB of tmpfs per run. Rooting the defaults in the
 * package keeps one warm, content-keyed cache per checkout and leaves a fake
 * HOME untouched.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ttscEnv } from '../../tools/ttsc-build.ts';

const CLI_ROOT = resolve(__dirname, '..', '..');
const REPO_CACHE = resolve(CLI_ROOT, '.cache', 'ttsc');
const CACHE_VARS = ['GOCACHE', 'GOMODCACHE', 'GOPATH', 'GOTMPDIR', 'TTSC_CACHE_DIR'] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map(Object.keys(overrides).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe('ttscEnv cache directories', () => {
  test('defaults every ttsc/Go cache under the checkout, HOME-independent', () => {
    const cleared = Object.fromEntries(CACHE_VARS.map(name => [name, undefined]));
    const env = withEnv(cleared, ttscEnv);
    for (const name of CACHE_VARS) {
      const dir = env[name];
      expect(dir).toBeDefined();
      expect(dir!).toStartWith(REPO_CACHE);
    }
  });

  test('an explicit cache env value wins over the repo-local default', () => {
    const env = withEnv({ GOCACHE: '/tmp/explicit-gocache' }, ttscEnv);
    expect(env.GOCACHE).toBe('/tmp/explicit-gocache');
  });
});
