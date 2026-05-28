import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findClaude } from '../../src/launch/find-claude.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-find-claude-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeExec(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho hi\n');
  chmodSync(path, 0o755);
  return path;
}

describe('findClaude', () => {
  test('claude on PATH → ok with absolute path', () => {
    const binDir = join(tmpRoot, 'bin');
    const claudePath = makeExec(binDir, 'claude');
    const r = findClaude({ pathEnv: binDir });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(claudePath);
  });

  test('claude not on PATH → not ok with helpful error', () => {
    const binDir = join(tmpRoot, 'bin');
    mkdirSync(binDir);
    const r = findClaude({ pathEnv: binDir });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('claude');
      expect(r.error.toLowerCase()).toMatch(/path|not found|install/);
    }
  });

  test('first match in PATH wins (left-to-right precedence)', () => {
    const a = join(tmpRoot, 'a');
    const b = join(tmpRoot, 'b');
    const first = makeExec(a, 'claude');
    makeExec(b, 'claude');
    const r = findClaude({ pathEnv: `${a}:${b}` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(first);
  });

  test('empty PATH → not ok', () => {
    const r = findClaude({ pathEnv: '' });
    expect(r.ok).toBe(false);
  });

  test('PATH with non-existent dirs is skipped gracefully', () => {
    const binDir = join(tmpRoot, 'bin');
    makeExec(binDir, 'claude');
    const r = findClaude({ pathEnv: `/totally/missing:${binDir}` });
    expect(r.ok).toBe(true);
  });
});
