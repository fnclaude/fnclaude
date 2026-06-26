import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seedNoopDir } from '../../src/noop/seed';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-noop-seed-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('seedNoopDir', () => {
  test('fresh dir + valid source → copies file, copied: true', async () => {
    const sourcePath = join(tmpRoot, 'source.md');
    writeFileSync(sourcePath, 'source contents');
    const noopDir = join(tmpRoot, 'noop');

    const result = await seedNoopDir({ noopDir, templateSourcePath: sourcePath });

    expect(result.ok).toBe(true);
    expect(result.copied).toBe(true);
    const dest = join(noopDir, 'handoff.template.md');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('source contents');
  });

  test('existing handoff.template.md → no-op, copied: false', async () => {
    const sourcePath = join(tmpRoot, 'source.md');
    writeFileSync(sourcePath, 'new contents');
    const noopDir = join(tmpRoot, 'noop');
    mkdirSync(noopDir);
    const dest = join(noopDir, 'handoff.template.md');
    writeFileSync(dest, 'pre-existing contents');

    const result = await seedNoopDir({ noopDir, templateSourcePath: sourcePath });

    expect(result.ok).toBe(true);
    expect(result.copied).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('pre-existing contents');
  });

  test('missing source path (null) → graceful no-op', async () => {
    const noopDir = join(tmpRoot, 'noop');

    const result = await seedNoopDir({ noopDir, templateSourcePath: null });

    expect(result.ok).toBe(true);
    expect(result.copied).toBe(false);
    expect(result.reason).toBe('no source template');
    // Should not have created the dest.
    expect(existsSync(join(noopDir, 'handoff.template.md'))).toBe(false);
  });

  test('source path is empty string → graceful no-op', async () => {
    const noopDir = join(tmpRoot, 'noop');

    const result = await seedNoopDir({ noopDir, templateSourcePath: '' });

    expect(result.ok).toBe(true);
    expect(result.copied).toBe(false);
    expect(result.reason).toBe('no source template');
  });

  test('source path does not exist on disk → graceful no-op', async () => {
    const noopDir = join(tmpRoot, 'noop');
    const bogusPath = join(tmpRoot, 'does-not-exist.md');

    const result = await seedNoopDir({ noopDir, templateSourcePath: bogusPath });

    expect(result.ok).toBe(true);
    expect(result.copied).toBe(false);
    expect(result.reason).toBe('no source template');
  });

  test('creates noop dir when missing', async () => {
    const sourcePath = join(tmpRoot, 'source.md');
    writeFileSync(sourcePath, 'x');
    const nested = join(tmpRoot, 'a', 'b', 'noop');
    expect(existsSync(nested)).toBe(false);

    const result = await seedNoopDir({ noopDir: nested, templateSourcePath: sourcePath });

    expect(result.ok).toBe(true);
    expect(result.copied).toBe(true);
    expect(existsSync(join(nested, 'handoff.template.md'))).toBe(true);
  });
});
