import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeCWDForProjects,
  readLivePermissionMode,
  sessionJSONLPath,
} from '../src/sessionState.js';

let SAVED_HOME: string | undefined;
beforeEach(() => {
  SAVED_HOME = process.env.HOME;
});
afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED_HOME;
});

function writeJSONL(
  claudeHome: string,
  cwd: string,
  sessionID: string,
  body: string,
): string {
  const encoded = encodeCWDForProjects(cwd);
  const dir = join(claudeHome, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionID}.jsonl`);
  writeFileSync(path, body);
  return path;
}

// ── encodeCWDForProjects ─────────────────────────────────────────────────

describe('encodeCWDForProjects', () => {
  test.each<[string, string]>([
    ['/home/tom/src/fnclaude@fnrhombus', '-home-tom-src-fnclaude-fnrhombus'],
    ['/', '-'],
    ['/a', '-a'],
    ['/a/b/c', '-a-b-c'],
  ])('encode %s → %s', (input, expected) => {
    expect(encodeCWDForProjects(input)).toBe(expected);
  });
});

// ── sessionJSONLPath ─────────────────────────────────────────────────────

describe('sessionJSONLPath', () => {
  test('joins encoded cwd + session id under ~/.claude/projects/', () => {
    process.env.HOME = '/home/tester';
    const got = sessionJSONLPath('/home/test/proj', 'abc-123');
    expect(got).toBe(
      '/home/tester/.claude/projects/-home-test-proj/abc-123.jsonl',
    );
  });
});

// ── readLivePermissionMode ───────────────────────────────────────────────

describe('readLivePermissionMode', () => {
  test('missing file → undefined', () => {
    const home = mkdtempSync(join(tmpdir(), 'fnclaude-ss-'));
    process.env.HOME = home;
    expect(
      readLivePermissionMode('/no/such/cwd', '11111111-1111-1111-1111-111111111111'),
    ).toBeUndefined();
  });

  test('no records → undefined', () => {
    const home = mkdtempSync(join(tmpdir(), 'fnclaude-ss-'));
    process.env.HOME = home;
    const cwd = '/home/test/proj';
    const sid = '22222222-2222-2222-2222-222222222222';
    const body =
      '{"type":"user","message":{"role":"user","content":"hi"}}\n' +
      '{"type":"assistant","message":{"role":"assistant","content":"hello"}}\n';
    writeJSONL(home, cwd, sid, body);
    expect(readLivePermissionMode(cwd, sid)).toBeUndefined();
  });

  test('one record returns its value', () => {
    const home = mkdtempSync(join(tmpdir(), 'fnclaude-ss-'));
    process.env.HOME = home;
    const cwd = '/home/test/proj';
    const sid = '33333333-3333-3333-3333-333333333333';
    const body =
      '{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"33333333-3333-3333-3333-333333333333"}\n';
    writeJSONL(home, cwd, sid, body);
    expect(readLivePermissionMode(cwd, sid)).toBe('bypassPermissions');
  });

  test('multiple records → most recent wins', () => {
    const home = mkdtempSync(join(tmpdir(), 'fnclaude-ss-'));
    process.env.HOME = home;
    const cwd = '/home/test/proj';
    const sid = '44444444-4444-4444-4444-444444444444';
    const body =
      '{"type":"permission-mode","permissionMode":"default"}\n' +
      '{"type":"user","message":{"role":"user","content":"hi"}}\n' +
      '{"type":"permission-mode","permissionMode":"acceptEdits"}\n' +
      '{"type":"permission-mode","permissionMode":"plan"}\n';
    writeJSONL(home, cwd, sid, body);
    expect(readLivePermissionMode(cwd, sid)).toBe('plan');
  });

  test('malformed line ignored, scan continues', () => {
    const home = mkdtempSync(join(tmpdir(), 'fnclaude-ss-'));
    process.env.HOME = home;
    const cwd = '/home/test/proj';
    const sid = '55555555-5555-5555-5555-555555555555';
    const body =
      '{"type":"permission-mode","permissionMode":"default"}\n' +
      'not-json-at-all\n' +
      '{"type":"permission-mode","permissionMode":"acceptEdits"}\n';
    writeJSONL(home, cwd, sid, body);
    expect(readLivePermissionMode(cwd, sid)).toBe('acceptEdits');
  });

  test('non permission-mode types with permissionMode field ignored', () => {
    // user/assistant messages may bake in permissionMode, but those are
    // a cached snapshot — only type:"permission-mode" records are
    // authoritative.
    const home = mkdtempSync(join(tmpdir(), 'fnclaude-ss-'));
    process.env.HOME = home;
    const cwd = '/home/test/proj';
    const sid = '66666666-6666-6666-6666-666666666666';
    const body =
      '{"type":"permission-mode","permissionMode":"default"}\n' +
      '{"type":"user","permissionMode":"plan","message":{"role":"user","content":"x"}}\n' +
      '{"type":"assistant","permissionMode":"plan","message":{"role":"assistant","content":"y"}}\n';
    writeJSONL(home, cwd, sid, body);
    expect(readLivePermissionMode(cwd, sid)).toBe('default');
  });
});
