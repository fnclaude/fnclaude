/**
 * §8.3 — unit tests for `cleanEnvForSpawn`.
 *
 * Ports Go canonical's TestCleanEnvForSpawn_DropsSessionScopedVars from
 * `fnclaude@fnrhombus/src/spawn_test.go`. The TS shape uses a record
 * (object) instead of `KEY=VALUE` slices, but the semantics are
 * identical: drop FNC_SOCKET / FNCLAUDE_HANDOFF / CLAUDE_CODE_SESSION_ID,
 * preserve everything else.
 */

import { describe, expect, test } from 'bun:test';

import { cleanEnvForSpawn } from '../../src/handoff/clean-env.ts';

describe('cleanEnvForSpawn', () => {
  test('drops FNC_SOCKET, FNCLAUDE_HANDOFF, CLAUDE_CODE_SESSION_ID', () => {
    const out = cleanEnvForSpawn({
      PATH: '/bin',
      FNC_SOCKET: '/tmp/x.sock',
      FNCLAUDE_HANDOFF: '5',
      CLAUDE_CODE_SESSION_ID: '01ABC',
      OTHER: 'keep',
    });
    expect(out.FNC_SOCKET).toBeUndefined();
    expect(out.FNCLAUDE_HANDOFF).toBeUndefined();
    expect(out.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  test('preserves unrelated keys', () => {
    const out = cleanEnvForSpawn({
      PATH: '/bin:/usr/bin',
      HOME: '/home/user',
      XDG_RUNTIME_DIR: '/run/user/1000',
      OTHER: 'keep',
    });
    expect(out.PATH).toBe('/bin:/usr/bin');
    expect(out.HOME).toBe('/home/user');
    expect(out.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(out.OTHER).toBe('keep');
  });

  test('drops undefined slots (NodeJS.ProcessEnv has optional values)', () => {
    const out = cleanEnvForSpawn({
      PATH: '/bin',
      // process.env exposes string|undefined; undefined slots must
      // not produce undefined entries on the cleaned record.
      MAYBE: undefined,
      KEEP: 'yes',
    });
    expect(out.PATH).toBe('/bin');
    expect(out.KEEP).toBe('yes');
    expect('MAYBE' in out).toBe(false);
  });

  test('returns a fresh object, not the input reference', () => {
    const input = { PATH: '/bin', FNC_SOCKET: '/x' };
    const out = cleanEnvForSpawn(input);
    expect(out).not.toBe(input);
    // Mutating the input doesn't bleed into the cleaned result.
    input.PATH = '/other';
    expect(out.PATH).toBe('/bin');
  });

  test('empty env → empty record', () => {
    const out = cleanEnvForSpawn({});
    expect(Object.keys(out)).toHaveLength(0);
  });
});
