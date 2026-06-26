import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureCwd } from '../../src/path/ensure-cwd';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-ensure-cwd-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureCwd — happy paths', () => {
  test('existing directory → no-op, no created paths', () => {
    const r = ensureCwd(tmpRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toEqual([]);
  });

  test('single missing leaf level → one created entry', () => {
    const leaf = join(tmpRoot, 'leaf');
    const r = ensureCwd(leaf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toEqual([leaf]);
    expect(existsSync(leaf)).toBe(true);
  });

  test('multiple missing levels → deepest-last order', () => {
    const a = join(tmpRoot, 'a');
    const b = join(a, 'b');
    const c = join(b, 'c');
    const r = ensureCwd(c);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toEqual([a, b, c]);
    expect(existsSync(c)).toBe(true);
  });

  test('partial — only deepest level missing', () => {
    const a = join(tmpRoot, 'a');
    mkdirSync(a);
    const b = join(a, 'b');
    const r = ensureCwd(b);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toEqual([b]);
  });
});

describe('ensureCwd — error cases', () => {
  test('path exists but is a file → error', () => {
    const file = join(tmpRoot, 'a-file');
    writeFileSync(file, 'x');
    const r = ensureCwd(file);
    expect(r.ok).toBe(false);
  });

  test('parent exists as a file, child requested → error (cannot mkdir under file)', () => {
    const file = join(tmpRoot, 'a-file');
    writeFileSync(file, 'x');
    const childOfFile = join(file, 'child');
    const r = ensureCwd(childOfFile);
    expect(r.ok).toBe(false);
  });
});

describe('ensureCwd — cleanup callback', () => {
  test('cleanup removes all created levels (deepest-first)', () => {
    const a = join(tmpRoot, 'a');
    const b = join(a, 'b');
    const c = join(b, 'c');
    const r = ensureCwd(c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(existsSync(c)).toBe(true);
    r.cleanup();
    expect(existsSync(c)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(a)).toBe(false);
  });

  test('cleanup is no-op when nothing was created', () => {
    const r = ensureCwd(tmpRoot);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    r.cleanup();
    expect(existsSync(tmpRoot)).toBe(true);
  });

  test('cleanup tolerates a created dir that became non-empty', () => {
    const a = join(tmpRoot, 'a');
    const b = join(a, 'b');
    const r = ensureCwd(b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Drop a file into the created dir — cleanup should NOT throw
    writeFileSync(join(b, 'evidence'), 'x');
    r.cleanup(); // should not crash
    // The non-empty dir + parent still exist; that's expected (rmdir refused)
    expect(existsSync(b)).toBe(true);
  });

  test('cleanup is idempotent (calling twice is fine)', () => {
    const a = join(tmpRoot, 'a');
    const b = join(a, 'b');
    const r = ensureCwd(b);
    if (!r.ok) throw new Error('test setup');
    r.cleanup();
    r.cleanup(); // shouldn't throw
    expect(existsSync(a)).toBe(false);
  });
});

describe('ensureCwd — mode of created dirs', () => {
  test('created dirs are normal directories (no permission weirdness)', () => {
    const leaf = join(tmpRoot, 'leaf');
    const r = ensureCwd(leaf);
    expect(r.ok).toBe(true);
    expect(statSync(leaf).isDirectory()).toBe(true);
  });
});
