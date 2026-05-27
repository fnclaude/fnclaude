import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the package's completions directory relative to this test file.
// __dirname-equivalent under ESM: dirname(fileURLToPath(import.meta.url))
const here = dirname(fileURLToPath(import.meta.url));
const completionsDir = join(here, '..', 'completions');

describe('shipped shell completions', () => {
  test('completions/ exists at packages/cli/completions', () => {
    expect(existsSync(completionsDir)).toBe(true);
    expect(statSync(completionsDir).isDirectory()).toBe(true);
  });

  test.each([
    '_fnc', // zsh: convention is _<command-name>
    'fnc.bash',
    'fnc.fish',
    'README.md',
  ])('completions/%s is present and non-empty', (name) => {
    const p = join(completionsDir, name);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  });

  test('fnc.bash parses as bash (bash -n)', () => {
    // Skip if bash isn't on PATH (CI runners have it; some dev shells don't).
    try {
      execFileSync('bash', ['-n', join(completionsDir, 'fnc.bash')], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      // If bash itself is missing, treat as a soft pass — we can't validate
      // syntax without an interpreter, but the file existing was already
      // covered above.
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return;
      throw err;
    }
  });
});
