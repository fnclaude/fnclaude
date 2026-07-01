/**
 * Unit tests for the shared restart core (`restartInPlace` / `buildRestartArgv`).
 *
 * These are the TDD target for the framework's restart handoff: the built argv
 * must splice `--resume <sessionId>` immediately after the launch cwd, preserve
 * the user's magic prefix + flags (minus stale session-reference flags), apply
 * overrides, and stash+fire the trigger. The MCP `createRestartHandler` and the
 * `//restart` slash command both go through this core, so a regression here
 * would break BOTH callers — which the restart-handler + slash-registry suites
 * would then also catch.
 */

import { describe, expect, test } from 'bun:test';

import { createHandoffTrigger } from '../../src/handoff/trigger';
import { buildRestartArgv, restartInPlace } from '../../src/restart/restart-core';

const VALID_SID = '01234567-89ab-cdef-0123-456789abcdef';

describe('restartInPlace — validation', () => {
  test('empty session id → missing-session-id, nothing stashed', () => {
    const trigger = createHandoffTrigger();
    const r = restartInPlace({ sessionId: '', launchCWD: '/cwd', origArgs: [], trigger });
    expect(r).toEqual({ ok: false, reason: 'missing-session-id' });
    expect(trigger.getStashedArgv()).toBeNull();
  });

  test('malformed session id → invalid-session-id, nothing stashed', () => {
    const trigger = createHandoffTrigger();
    const r = restartInPlace({ sessionId: 'not-a-uuid', launchCWD: '/cwd', origArgs: [], trigger });
    expect(r).toEqual({ ok: false, reason: 'invalid-session-id' });
    expect(trigger.getStashedArgv()).toBeNull();
  });
});

describe('restartInPlace — argv build + trigger', () => {
  test('splices --resume <sid> immediately after the launch cwd', () => {
    const trigger = createHandoffTrigger();
    const r = restartInPlace({
      sessionId: VALID_SID,
      launchCWD: '/launch/cwd',
      origArgs: ['opus', 'max', '/some/cwd', '--ide', '-W', 'Bash'],
      trigger,
    });
    expect(r.ok).toBe(true);
    expect(trigger.getStashedArgv()).toEqual([
      'opus',
      'max',
      '/launch/cwd',
      '--resume',
      VALID_SID,
      '--ide',
      '-W',
      'Bash',
    ]);
  });

  test('empty origArgs → [cwd, --resume, sid]', () => {
    const trigger = createHandoffTrigger();
    restartInPlace({ sessionId: VALID_SID, launchCWD: '/launch/cwd', origArgs: [], trigger });
    expect(trigger.getStashedArgv()).toEqual(['/launch/cwd', '--resume', VALID_SID]);
  });

  test('fires the trigger', async () => {
    const trigger = createHandoffTrigger();
    let fired = false;
    void trigger.awaitTrigger().then(() => {
      fired = true;
    });
    restartInPlace({ sessionId: VALID_SID, launchCWD: '/cwd', origArgs: [], trigger });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toBe(true);
  });

  test('stale --resume from origArgs is not duplicated (#205)', () => {
    const trigger = createHandoffTrigger();
    const oldSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    restartInPlace({
      sessionId: VALID_SID,
      launchCWD: '/launch/cwd',
      origArgs: ['/launch/cwd', '--resume', oldSid, '--ide'],
      trigger,
    });
    const got = trigger.getStashedArgv()!;
    expect(got.filter((t) => t === '--resume').length).toBe(1);
    expect(got[got.indexOf('--resume') + 1]).toBe(VALID_SID);
    expect(got).not.toContain(oldSid);
  });
});

describe('buildRestartArgv — overrides + live capture (pure)', () => {
  test('model override strips bare magic and appends --model', () => {
    const argv = buildRestartArgv({
      sessionId: VALID_SID,
      launchCWD: '/launch/cwd',
      origArgs: ['opus', 'max', '/some/cwd', '--ide'],
      overrides: { model: 'sonnet' },
    });
    expect(argv).toEqual([
      'max',
      '/launch/cwd',
      '--resume',
      VALID_SID,
      '--ide',
      '--model',
      'sonnet',
    ]);
  });

  test('live permission-mode captured when none supplied/preserved', () => {
    let seen = '';
    const argv = buildRestartArgv({
      sessionId: VALID_SID,
      launchCWD: '/launch/cwd',
      origArgs: [],
      livePermissionModeReader: (sid) => {
        seen = sid;
        return 'plan';
      },
    });
    expect(seen).toBe(VALID_SID);
    expect(argv).toContain('--permission-mode');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  test('explicit permission-mode override wins; reader not invoked', () => {
    let called = false;
    const argv = buildRestartArgv({
      sessionId: VALID_SID,
      launchCWD: '/launch/cwd',
      origArgs: [],
      overrides: { permissionMode: 'bypassPermissions' },
      livePermissionModeReader: () => {
        called = true;
        return 'plan';
      },
    });
    expect(called).toBe(false);
    expect(argv.filter((t) => t === '--permission-mode').length).toBe(1);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  });
});
