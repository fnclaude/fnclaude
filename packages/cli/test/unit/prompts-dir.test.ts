import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolvePromptsDir } from '../../src/prompts/dir.ts';

let tmpRoot: string;
let exeDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-prompts-dir-'));
  exeDir = join(tmpRoot, 'bin');
  mkdirSync(exeDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolvePromptsDir — precedence order', () => {
  test('env override wins if directory exists', () => {
    const envDir = join(tmpRoot, 'env-prompts');
    mkdirSync(envDir);
    const r = resolvePromptsDir({ envOverride: envDir, exeDir });
    expect(r.dir).toBe(envDir);
  });

  test('env override missing → fall through to <exe-dir>/prompts', () => {
    const envDir = join(tmpRoot, 'env-doesnt-exist');
    const devDir = join(exeDir, 'prompts');
    mkdirSync(devDir);
    const r = resolvePromptsDir({ envOverride: envDir, exeDir });
    expect(r.dir).toBe(devDir);
  });

  test('env unset, <exe-dir>/prompts exists → uses dev dir', () => {
    const devDir = join(exeDir, 'prompts');
    mkdirSync(devDir);
    const r = resolvePromptsDir({ envOverride: undefined, exeDir });
    expect(r.dir).toBe(devDir);
  });

  test('falls through to <exe-dir>/../prompts (npm/monorepo layout)', () => {
    const npmDir = join(tmpRoot, 'prompts');
    mkdirSync(npmDir);
    const r = resolvePromptsDir({ envOverride: undefined, exeDir });
    expect(r.dir).toBe(npmDir);
  });

  test('falls through to FHS share dir if nothing else exists', () => {
    const shareDir = join(tmpRoot, 'share', 'fnclaude', 'prompts');
    mkdirSync(shareDir, { recursive: true });
    const r = resolvePromptsDir({ envOverride: undefined, exeDir });
    expect(r.dir).toBe(shareDir);
  });

  test('none exist → null + warning', () => {
    const r = resolvePromptsDir({ envOverride: undefined, exeDir });
    expect(r.dir).toBe(null);
    expect(r.warning).toBeDefined();
    expect(r.warning).toContain('prompts');
  });
});

describe('resolvePromptsDir — non-directory at path', () => {
  test('env override path is a file (not dir) → falls through', () => {
    const filePath = join(tmpRoot, 'file');
    writeFileSync(filePath, 'a');
    const devDir = join(exeDir, 'prompts');
    mkdirSync(devDir);
    const r = resolvePromptsDir({ envOverride: filePath, exeDir });
    expect(r.dir).toBe(devDir);
  });

  test('empty env string treated as unset', () => {
    const devDir = join(exeDir, 'prompts');
    mkdirSync(devDir);
    const r = resolvePromptsDir({ envOverride: '', exeDir });
    expect(r.dir).toBe(devDir);
  });
});
