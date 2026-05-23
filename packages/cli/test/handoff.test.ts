import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handoffBaseDir,
  handoffContentPath,
  handoffEnv,
  handoffSocketPath,
} from '../src/handoff.js';

let SAVED_XDG: string | undefined;

beforeEach(() => {
  SAVED_XDG = process.env.XDG_RUNTIME_DIR;
});
afterEach(() => {
  if (SAVED_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = SAVED_XDG;
});

// ── handoffBaseDir ────────────────────────────────────────────────────────

describe('handoffBaseDir', () => {
  test('XDG_RUNTIME_DIR set → uses it', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    expect(handoffBaseDir()).toBe('/run/user/1000');
  });

  test('XDG unset → os tmpdir', () => {
    delete process.env.XDG_RUNTIME_DIR;
    expect(handoffBaseDir()).toBe(tmpdir());
  });

  test('XDG empty string → falls through to os tmpdir', () => {
    process.env.XDG_RUNTIME_DIR = '';
    expect(handoffBaseDir()).toBe(tmpdir());
  });
});

// ── handoffSocketPath ─────────────────────────────────────────────────────

describe('handoffSocketPath', () => {
  test('XDG set', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    expect(handoffSocketPath(42)).toBe('/run/user/1000/fnclaude-mcp-42.sock');
  });

  test('XDG unset → tmpdir', () => {
    delete process.env.XDG_RUNTIME_DIR;
    expect(handoffSocketPath(7)).toBe(join(tmpdir(), 'fnclaude-mcp-7.sock'));
  });
});

// ── handoffEnv ────────────────────────────────────────────────────────────

function envSliceToMap(env: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const e of env) {
    const i = e.indexOf('=');
    if (i < 0) continue;
    m[e.slice(0, i)] = e.slice(i + 1);
  }
  return m;
}

describe('handoffEnv', () => {
  test('returns FNCLAUDE_HANDOFF + FNC_SOCKET', () => {
    const got = handoffEnv('ask', '/tmp/fnclaude-mcp-42.sock');
    expect(got.length).toBe(2);
    const m = envSliceToMap(got);
    expect(m.FNCLAUDE_HANDOFF).toBe('ask');
    expect(m.FNC_SOCKET).toBe('/tmp/fnclaude-mcp-42.sock');
  });

  test('numeric mode', () => {
    const m = envSliceToMap(handoffEnv('5', '/tmp/x.sock'));
    expect(m.FNCLAUDE_HANDOFF).toBe('5');
  });

  test('never mode is allowed (listener still wants socket)', () => {
    const m = envSliceToMap(handoffEnv('never', '/tmp/x.sock'));
    expect(m.FNCLAUDE_HANDOFF).toBe('never');
    expect(m.FNC_SOCKET).toBe('/tmp/x.sock');
  });

  test('no legacy v4 vars exported (regression guard)', () => {
    const m = envSliceToMap(handoffEnv('ask', '/tmp/x.sock'));
    expect(m.FNC_PID).toBeUndefined();
    expect(m.FNC_HANDOFF_PATH).toBeUndefined();
    expect(m.FNC_HANDOFF_CONTENT_PATH).toBeUndefined();
  });
});

// ── handoffContentPath ────────────────────────────────────────────────────

describe('handoffContentPath', () => {
  test('XDG set: prefix + .md suffix', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const got = handoffContentPath();
    expect(got.startsWith('/run/user/1000/fnclaude-handoff-content-')).toBe(true);
    expect(got.endsWith('.md')).toBe(true);
  });

  test('XDG unset → tmpdir prefix', () => {
    delete process.env.XDG_RUNTIME_DIR;
    const want = join(tmpdir(), 'fnclaude-handoff-content-');
    expect(handoffContentPath().startsWith(want)).toBe(true);
  });

  test('unique across calls', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const a = handoffContentPath();
    const b = handoffContentPath();
    expect(a).not.toBe(b);
  });

  test('random token is hex with at least 8 chars', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const got = handoffContentPath();
    const core = got
      .replace('/run/user/1000/fnclaude-handoff-content-', '')
      .replace(/\.md$/, '');
    expect(core.length).toBeGreaterThanOrEqual(8);
    expect(/^[0-9a-f]+$/.test(core)).toBe(true);
  });
});
