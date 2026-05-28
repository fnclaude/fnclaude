import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTemplateSourcePath } from '../../src/noop/template-source.ts';

let tmpRoot: string;
let exeDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-noop-tmpl-src-'));
  exeDir = join(tmpRoot, 'bin');
  mkdirSync(exeDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveTemplateSourcePath — precedence order', () => {
  test('env override wins if file exists', () => {
    const envPath = join(tmpRoot, 'env.md');
    writeFileSync(envPath, 'env template');
    const r = resolveTemplateSourcePath({ envOverride: envPath, exeDir });
    expect(r.path).toBe(envPath);
  });

  test('env override missing → falls through to <exe-dir>/templates/handoff.template.md', () => {
    const envPath = join(tmpRoot, 'missing.md');
    const devPath = join(exeDir, 'templates', 'handoff.template.md');
    mkdirSync(join(exeDir, 'templates'), { recursive: true });
    writeFileSync(devPath, 'dev template');
    const r = resolveTemplateSourcePath({ envOverride: envPath, exeDir });
    expect(r.path).toBe(devPath);
  });

  test('env unset, <exe-dir>/templates/handoff.template.md exists → uses dev path', () => {
    const devPath = join(exeDir, 'templates', 'handoff.template.md');
    mkdirSync(join(exeDir, 'templates'), { recursive: true });
    writeFileSync(devPath, 'dev template');
    const r = resolveTemplateSourcePath({ envOverride: undefined, exeDir });
    expect(r.path).toBe(devPath);
  });

  test('falls through to <exe-dir>/../templates/handoff.template.md (npm/monorepo layout)', () => {
    const npmPath = join(tmpRoot, 'templates', 'handoff.template.md');
    mkdirSync(join(tmpRoot, 'templates'), { recursive: true });
    writeFileSync(npmPath, 'npm template');
    const r = resolveTemplateSourcePath({ envOverride: undefined, exeDir });
    expect(r.path).toBe(npmPath);
  });

  test('falls through to FHS share path if nothing else exists', () => {
    const sharePath = join(tmpRoot, 'share', 'fnclaude', 'templates', 'handoff.template.md');
    mkdirSync(join(tmpRoot, 'share', 'fnclaude', 'templates'), { recursive: true });
    writeFileSync(sharePath, 'share template');
    const r = resolveTemplateSourcePath({ envOverride: undefined, exeDir });
    expect(r.path).toBe(sharePath);
  });

  test('none exist → null + tried list populated', () => {
    const r = resolveTemplateSourcePath({ envOverride: undefined, exeDir });
    expect(r.path).toBe(null);
    expect(r.tried.length).toBeGreaterThan(0);
    expect(r.tried.some((c) => c.includes('handoff.template.md'))).toBe(true);
  });
});

describe('resolveTemplateSourcePath — non-file at path', () => {
  test('env override path is a directory (not file) → falls through', () => {
    const dirPath = join(tmpRoot, 'a-dir');
    mkdirSync(dirPath);
    const devPath = join(exeDir, 'templates', 'handoff.template.md');
    mkdirSync(join(exeDir, 'templates'), { recursive: true });
    writeFileSync(devPath, 'dev template');
    const r = resolveTemplateSourcePath({ envOverride: dirPath, exeDir });
    expect(r.path).toBe(devPath);
  });

  test('empty env string treated as unset', () => {
    const devPath = join(exeDir, 'templates', 'handoff.template.md');
    mkdirSync(join(exeDir, 'templates'), { recursive: true });
    writeFileSync(devPath, 'dev template');
    const r = resolveTemplateSourcePath({ envOverride: '', exeDir });
    expect(r.path).toBe(devPath);
  });
});
