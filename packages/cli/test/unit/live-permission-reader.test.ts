/**
 * Unit tests for `live-permission-reader` — the TS port of Go canonical's
 * `session_state.go` (encoding, path-build, JSONL-scan with last-wins).
 *
 * Tests three exports:
 *   - `encodeCWDForProjects(cwd)` — pure string transform with [A-Za-z0-9-]
 *     allowlist; everything else collapses to '-'.
 *   - `sessionJSONLPath(launchCWD, sessionID)` — joins
 *     `<HOME>/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
 *   - `readLivePermissionMode(launchCWD, sessionID)` — opens the JSONL,
 *     last-wins scan for `{type:"permission-mode", permissionMode:<value>}`,
 *     returns `null` on miss/error.
 *
 * HOME is overridden via `process.env.HOME` per test (restored in `afterEach`)
 * to keep the on-disk fixtures hermetic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeCWDForProjects,
  readLivePermissionMode,
  sessionJSONLPath,
} from '../../src/launch/live-permission-reader';

const cleanupPaths: string[] = [];
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  for (const p of cleanupPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-live-perm-home-'));
  cleanupPaths.push(dir);
  process.env.HOME = dir;
  return dir;
}

function seedJSONL(
  home: string,
  encodedCwd: string,
  sessionID: string,
  lines: string[],
): string {
  const projDir = join(home, '.claude', 'projects', encodedCwd);
  mkdirSync(projDir, { recursive: true });
  const filePath = join(projDir, `${sessionID}.jsonl`);
  writeFileSync(filePath, lines.join('\n'), { mode: 0o600 });
  return filePath;
}

const SID = '01234567-89ab-cdef-0123-456789abcdef';

// ─────────────────────────────────────────────────────────────────────────────
// encodeCWDForProjects
// ─────────────────────────────────────────────────────────────────────────────

describe('encodeCWDForProjects', () => {
  test('canonical absolute path → leading dash + slashes → dashes', () => {
    expect(encodeCWDForProjects('/home/tom/src/fnclaude@fnclaude')).toBe(
      '-home-tom-src-fnclaude-fnclaude',
    );
  });

  test('preserves mixed-case letters', () => {
    expect(encodeCWDForProjects('/Users/Tom/Repo')).toBe('-Users-Tom-Repo');
  });

  test('preserves digits', () => {
    expect(encodeCWDForProjects('/a/b1/c23')).toBe('-a-b1-c23');
  });

  test('preserves existing dashes', () => {
    expect(encodeCWDForProjects('/a-b/c-d')).toBe('-a-b-c-d');
  });

  test('underscores become dashes', () => {
    expect(encodeCWDForProjects('a_b_c')).toBe('a-b-c');
  });

  test('dots become dashes', () => {
    expect(encodeCWDForProjects('a.b.c')).toBe('a-b-c');
  });

  test('@ becomes dash', () => {
    expect(encodeCWDForProjects('fnclaude@fnclaude')).toBe('fnclaude-fnclaude');
  });

  test('+ becomes dash', () => {
    expect(encodeCWDForProjects('repo+workspace')).toBe('repo-workspace');
  });

  test('slash becomes dash', () => {
    expect(encodeCWDForProjects('a/b')).toBe('a-b');
  });

  test('empty string maps to empty string', () => {
    expect(encodeCWDForProjects('')).toBe('');
  });

  test('mixed metacharacters all collapse to dashes', () => {
    expect(encodeCWDForProjects('/p/a_b.c@d+e/f')).toBe('-p-a-b-c-d-e-f');
  });

  test('non-ASCII characters become dashes (one dash per char)', () => {
    expect(encodeCWDForProjects('café')).toBe('caf-');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sessionJSONLPath
// ─────────────────────────────────────────────────────────────────────────────

describe('sessionJSONLPath', () => {
  test('joins HOME + .claude/projects + encoded-cwd + sid.jsonl', () => {
    const home = makeHome();
    const path = sessionJSONLPath('/home/tom/src/fnclaude@fnclaude', SID);
    expect(path).toBe(
      join(home, '.claude', 'projects', '-home-tom-src-fnclaude-fnclaude', `${SID}.jsonl`),
    );
  });

  test('reflects different launchCWDs in the encoded segment', () => {
    const home = makeHome();
    const path = sessionJSONLPath('/var/log', SID);
    expect(path).toBe(
      join(home, '.claude', 'projects', '-var-log', `${SID}.jsonl`),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readLivePermissionMode
// ─────────────────────────────────────────────────────────────────────────────

describe('readLivePermissionMode', () => {
  test('missing file → null', () => {
    makeHome(); // sets HOME but writes nothing
    expect(readLivePermissionMode('/home/tom/missing', SID)).toBeNull();
  });

  test('empty file → null', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, []);
    expect(readLivePermissionMode('/cwd', SID)).toBeNull();
  });

  test('single permission-mode record → that value', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
    ]);
    expect(readLivePermissionMode('/cwd', SID)).toBe('plan');
  });

  test('multiple permission-mode records → last value wins', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'acceptEdits' }),
    ]);
    expect(readLivePermissionMode('/cwd', SID)).toBe('acceptEdits');
  });

  test('intermixed non-permission-mode records are ignored', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      JSON.stringify({ type: 'user', message: 'hi' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
      JSON.stringify({ type: 'assistant', message: 'hey' }),
    ]);
    expect(readLivePermissionMode('/cwd', SID)).toBe('plan');
  });

  test('malformed JSON lines are skipped (not thrown)', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      'not-json-at-all',
      '{"type":"permission-mode","permissionMode":"plan"}',
      '{broken',
    ]);
    expect(readLivePermissionMode('/cwd', SID)).toBe('plan');
  });

  test('permission-mode record with empty permissionMode is ignored', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
      JSON.stringify({ type: 'permission-mode', permissionMode: '' }),
    ]);
    // The empty-string record must NOT clobber the earlier 'plan'.
    expect(readLivePermissionMode('/cwd', SID)).toBe('plan');
  });

  test('non-"permission-mode" type carrying a permissionMode field is ignored', () => {
    // Per Go canonical: assistant/user/system records may serialize
    // `permissionMode` as a cached snapshot — only `type: "permission-mode"`
    // is authoritative.
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      JSON.stringify({ type: 'user', permissionMode: 'auto' }),
      JSON.stringify({ type: 'assistant', permissionMode: 'bypassPermissions' }),
    ]);
    expect(readLivePermissionMode('/cwd', SID)).toBeNull();
  });

  test('blank lines in the file are skipped without affecting last-wins', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      '',
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
      '',
      '',
    ]);
    expect(readLivePermissionMode('/cwd', SID)).toBe('plan');
  });

  test('no matching record at all → null', () => {
    const home = makeHome();
    seedJSONL(home, '-cwd', SID, [
      JSON.stringify({ type: 'user', message: 'hi' }),
      JSON.stringify({ type: 'assistant', message: 'hey' }),
    ]);
    expect(readLivePermissionMode('/cwd', SID)).toBeNull();
  });

  test('honors encoded-cwd path lookup (different cwd → different file)', () => {
    const home = makeHome();
    // Seed under one encoded cwd; lookup for a *different* one should miss.
    seedJSONL(home, '-cwd-a', SID, [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }),
    ]);
    expect(readLivePermissionMode('/cwd/a', SID)).toBe('plan');
    expect(readLivePermissionMode('/cwd/b', SID)).toBeNull();
  });
});
