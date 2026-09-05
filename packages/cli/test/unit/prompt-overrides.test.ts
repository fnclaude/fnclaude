/**
 * Unit tests for user overrides of fnc's packaged system prompts.
 *
 * The mechanism is presence: a file in
 * `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/prompts/` replaces the packaged
 * fragment of the same name. Nothing is copied on install and nothing is
 * merged (owner's call, 2026-09-04). The subtle half is that overriding ONE
 * fragment must not detach the others — a user who replaces `noop-router.md`
 * still gets the packaged `spawn.md`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadFragments } from '../../src/prompts/load';
import {
  PACKAGED_FRAGMENT_NAMES,
  ensureOverridesDir,
  overridesReadme,
  resolveFragmentPath,
} from '../../src/prompts/overrides';

let tmpRoot: string;
let packaged: string;
let overrides: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-overrides-'));
  packaged = join(tmpRoot, 'packaged');
  overrides = join(tmpRoot, 'overrides');
  mkdirSync(packaged, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveFragmentPath', () => {
  test('no override directory → the packaged file', () => {
    writeFileSync(join(packaged, 'a.md'), 'packaged');
    expect(resolveFragmentPath('a.md', packaged, null)).toBe(join(packaged, 'a.md'));
  });

  test('an override directory that does not exist is not an error', () => {
    writeFileSync(join(packaged, 'a.md'), 'packaged');
    expect(resolveFragmentPath('a.md', packaged, overrides)).toBe(join(packaged, 'a.md'));
  });

  test('an override of the same name wins', () => {
    mkdirSync(overrides, { recursive: true });
    writeFileSync(join(packaged, 'a.md'), 'packaged');
    writeFileSync(join(overrides, 'a.md'), 'mine');
    expect(resolveFragmentPath('a.md', packaged, overrides)).toBe(join(overrides, 'a.md'));
  });

  test('an override with no packaged counterpart is still used', () => {
    mkdirSync(overrides, { recursive: true });
    writeFileSync(join(overrides, 'a.md'), 'mine');
    expect(resolveFragmentPath('a.md', packaged, overrides)).toBe(join(overrides, 'a.md'));
  });

  test('neither exists → null', () => {
    mkdirSync(overrides, { recursive: true });
    expect(resolveFragmentPath('a.md', packaged, overrides)).toBeNull();
  });

  test('a DIRECTORY named like a fragment is not a fragment', () => {
    mkdirSync(join(overrides, 'a.md'), { recursive: true });
    writeFileSync(join(packaged, 'a.md'), 'packaged');
    expect(resolveFragmentPath('a.md', packaged, overrides)).toBe(join(packaged, 'a.md'));
  });
});

describe('loadFragments with overrides', () => {
  test('overriding one fragment leaves the others packaged', () => {
    writeFileSync(join(packaged, 'a.md'), 'packaged A');
    writeFileSync(join(packaged, 'b.md'), 'packaged B');
    mkdirSync(overrides, { recursive: true });
    writeFileSync(join(overrides, 'a.md'), 'mine A');

    const r = loadFragments(['a.md', 'b.md'], packaged, overrides);
    expect(r.content).toBe('mine A\n\npackaged B');
    expect(r.warnings).toEqual([]);
  });

  test('with no overrides directory, behaviour is exactly as before', () => {
    writeFileSync(join(packaged, 'a.md'), 'packaged A');
    writeFileSync(join(packaged, 'b.md'), 'packaged B');
    expect(loadFragments(['a.md', 'b.md'], packaged).content).toBe('packaged A\n\npackaged B');
  });

  test('a missing fragment still warns and is skipped, not fatal', () => {
    writeFileSync(join(packaged, 'a.md'), 'packaged A');
    const r = loadFragments(['a.md', 'gone.md'], packaged, overrides);
    expect(r.content).toBe('packaged A');
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('gone.md');
  });
});

describe('ensureOverridesDir', () => {
  test('creates the directory and seeds README.txt', () => {
    expect(ensureOverridesDir({ dir: overrides, packagedDir: packaged })).toBe(true);
    const readme = readFileSync(join(overrides, 'README.txt'), 'utf8');
    expect(readme).toContain('SYSTEM PROMPT');
    expect(readme).toContain(packaged);
  });

  test('it is README.txt, not README.md — this is a file people meet in `ls`', () => {
    ensureOverridesDir({ dir: overrides, packagedDir: packaged });
    expect(() => readFileSync(join(overrides, 'README.md'), 'utf8')).toThrow();
  });

  test('the README lists every packaged fragment name', () => {
    ensureOverridesDir({ dir: overrides, packagedDir: packaged });
    const readme = readFileSync(join(overrides, 'README.txt'), 'utf8');
    for (const name of PACKAGED_FRAGMENT_NAMES) {
      expect(readme).toContain(name);
    }
  });

  test('an existing README is never clobbered — a user may have annotated it', () => {
    mkdirSync(overrides, { recursive: true });
    writeFileSync(join(overrides, 'README.txt'), 'my notes');
    expect(ensureOverridesDir({ dir: overrides, packagedDir: packaged })).toBe(false);
    expect(readFileSync(join(overrides, 'README.txt'), 'utf8')).toBe('my notes');
  });

  test('re-running is a no-op', () => {
    ensureOverridesDir({ dir: overrides, packagedDir: packaged });
    const first = readFileSync(join(overrides, 'README.txt'), 'utf8');
    expect(ensureOverridesDir({ dir: overrides, packagedDir: packaged })).toBe(false);
    expect(readFileSync(join(overrides, 'README.txt'), 'utf8')).toBe(first);
  });

  test('an unknown packaged directory still produces a usable README', () => {
    const text = overridesReadme(null);
    expect(text).toContain('SYSTEM PROMPT');
    expect(text).toContain('noop-router.md');
  });
});

describe('the packaged fragment list matches what the package ships', () => {
  test('every name in PACKAGED_FRAGMENT_NAMES except oobe.md exists in prompts/', async () => {
    // oobe.md lands with the `fnc install` wizard; the rest ship today. The
    // list is what the README promises a user they can override, so a name in
    // it that resolves to nothing would be a lie in user-facing text.
    const { readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const shipped = new Set(readdirSync(resolve(__dirname, '..', '..', 'prompts')));
    for (const name of PACKAGED_FRAGMENT_NAMES) {
      if (name === 'oobe.md') continue;
      expect(shipped.has(name)).toBe(true);
    }
  });
});
