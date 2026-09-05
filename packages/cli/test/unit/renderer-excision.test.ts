/**
 * Regression: the renderer is gone and must stay gone.
 *
 * `@fnclaude/renderer` was an OPTIONAL dependency, and `renderer-mount.ts`
 * imported it behind a try/catch that degraded silently to the normal PTY
 * launch. That shape means a half-reverted excise is invisible at runtime:
 * a reintroduced import or a stale `optionalDependencies` entry produces no
 * error, no warning, and no failing test — it just quietly resurrects a code
 * path that has no package behind it any more (and, in the umbrella's case,
 * ships a `workspace:*` range npm cannot resolve).
 *
 * So assert it structurally: nothing under src/ names the package, and the
 * manifest declares no dependency on it in any dependency field.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { resolve } from 'node:path';

const CLI_ROOT = resolve(__dirname, '..', '..');

describe('renderer excision', () => {
  test('no source file references @fnclaude/renderer', async () => {
    const offenders: string[] = [];
    for await (const rel of new Glob('**/*.ts').scan({ cwd: resolve(CLI_ROOT, 'src') })) {
      const body = readFileSync(resolve(CLI_ROOT, 'src', rel), 'utf8');
      if (body.includes('@fnclaude/renderer')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('the cli manifest declares no renderer dependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(CLI_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      expect(pkg[field]?.['@fnclaude/renderer']).toBeUndefined();
    }
  });
});
