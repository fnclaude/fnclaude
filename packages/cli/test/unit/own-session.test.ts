/**
 * Unit tests for {@link planOwnSession} — deciding how the context monitor
 * learns THIS session's own JSONL so it never mis-pins a sibling's file.
 *
 * The planner is pure over (claudeArgs, mintUuid). A fixed fake `mintUuid`
 * makes the fresh-session injection deterministic.
 */

import { describe, expect, test } from 'bun:test';

import { planOwnSession } from '../../src/usage/own-session';

const FAKE_UUID = '11111111-2222-4333-8444-555555555555';
const REAL_UUID = 'abcdef01-2345-4678-9abc-def012345678';
const mint = (): string => FAKE_UUID;

describe('planOwnSession — fresh interactive session', () => {
  test('mints a UUID and injects --session-id', () => {
    const plan = planOwnSession(['--tmux'], mint);
    expect(plan.sessionId).toBe(FAKE_UUID);
    expect(plan.inject).toEqual(['--session-id', FAKE_UUID]);
  });

  test('bare invocation (no flags) is still fresh', () => {
    const plan = planOwnSession([], mint);
    expect(plan.sessionId).toBe(FAKE_UUID);
    expect(plan.inject).toEqual(['--session-id', FAKE_UUID]);
  });

  test('coexists with a typed prompt (tokens after --)', () => {
    const plan = planOwnSession(['--name', 'foo', '--', 'do a thing'], mint);
    expect(plan.sessionId).toBe(FAKE_UUID);
    expect(plan.inject).toEqual(['--session-id', FAKE_UUID]);
  });
});

describe('planOwnSession — id already known, inject nothing', () => {
  test('--resume <uuid> reuses that id', () => {
    const plan = planOwnSession(['--resume', REAL_UUID], mint);
    expect(plan.sessionId).toBe(REAL_UUID);
    expect(plan.inject).toEqual([]);
  });

  test('-r <uuid> short form reuses that id', () => {
    const plan = planOwnSession(['-r', REAL_UUID], mint);
    expect(plan.sessionId).toBe(REAL_UUID);
    expect(plan.inject).toEqual([]);
  });

  test('user-supplied --session-id <uuid> is honoured', () => {
    const plan = planOwnSession(['--session-id', REAL_UUID], mint);
    expect(plan.sessionId).toBe(REAL_UUID);
    expect(plan.inject).toEqual([]);
  });

  // `--flag=value` form: claude accepts it and fnc passes long flags through
  // verbatim, so the planner must recognise it — otherwise a resume is misread
  // as fresh and gets a conflicting injected --session-id (claude rejects it).
  test('--resume=<uuid> equals-form reuses that id, injects nothing', () => {
    const plan = planOwnSession([`--resume=${REAL_UUID}`], mint);
    expect(plan.sessionId).toBe(REAL_UUID);
    expect(plan.inject).toEqual([]);
  });

  test('-r=<uuid> equals-form reuses that id, injects nothing', () => {
    const plan = planOwnSession([`-r=${REAL_UUID}`], mint);
    expect(plan.sessionId).toBe(REAL_UUID);
    expect(plan.inject).toEqual([]);
  });

  test('--session-id=<uuid> equals-form is honoured, injects nothing', () => {
    const plan = planOwnSession([`--session-id=${REAL_UUID}`], mint);
    expect(plan.sessionId).toBe(REAL_UUID);
    expect(plan.inject).toEqual([]);
  });
});

describe('planOwnSession — id not knowable up front → null, inject nothing', () => {
  test('--continue', () => {
    const plan = planOwnSession(['--continue'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });

  test('-c short form', () => {
    const plan = planOwnSession(['-c'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });

  test('--resume <uuid> --fork-session mints a NEW id we cannot know', () => {
    const plan = planOwnSession(['--resume', REAL_UUID, '--fork-session'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });

  test('--resume with no uuid (picker) is unknowable', () => {
    const plan = planOwnSession(['--resume'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });

  test('--session-id present but malformed → decline, do not inject a second', () => {
    const plan = planOwnSession(['--session-id', 'not-a-uuid'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });
});

describe('planOwnSession — print / non-interactive never tracks', () => {
  test('--print', () => {
    const plan = planOwnSession(['--print', '--', 'q'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });

  test('-p short form', () => {
    const plan = planOwnSession(['-p', '--', 'q'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });

  test('print takes precedence even if it would otherwise look fresh', () => {
    const plan = planOwnSession(['-p'], mint);
    expect(plan.sessionId).toBeNull();
    expect(plan.inject).toEqual([]);
  });
});
