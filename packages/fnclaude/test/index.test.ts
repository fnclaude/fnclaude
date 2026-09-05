import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, '..', 'package.json'), 'utf8'),
) as {
  name: string;
  dependencies: Record<string, string>;
  bin: Record<string, string>;
};

describe('fnclaude (umbrella)', () => {
  test('declares the expected name and bin', () => {
    expect(pkg.name).toBe('fnclaude');
    expect(pkg.bin).toEqual({ fnc: './bin/fnc.js' });
  });

  test('depends on the cli package via workspace protocol', () => {
    // Bun does NOT auto-link bare "*" — it tries the registry (Bun issue
    // #25177). Use "workspace:*" instead. `bun publish` and release-please's
    // node-workspace plugin both rewrite this to a concrete version on publish.
    expect(pkg.dependencies['@rhombus.rocks/fnclaude']).toBe('workspace:*');
  });

  // The renderer package was excised from the monorepo; the umbrella must not
  // reintroduce a dependency on it (a stale entry would make every `npm
  // install fnclaude` fail on an unpublishable workspace ref).
  test('does not depend on the excised renderer package', () => {
    expect(pkg.dependencies['@fnclaude/renderer']).toBeUndefined();
  });
});
