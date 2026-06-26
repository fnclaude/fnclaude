/**
 * Unit tests for §8.1 handler — `createRestartHandler`.
 *
 * Ports relevant cases from the Go canonical
 * `fnclaude@fnrhombus/src/socket_listener_overrides_test.go`:
 *
 *   - origArgs preserved (magic at front, launchCWD in middle, post-magic flags at end)
 *   - bare origArgs (no magic, no flags)
 *   - model override strips bare-magic AND appends --model <override>
 *   - effort override strips bare "max" AND appends --effort <override>
 *   - explicit permission_mode wins over live capture
 *   - missing permission_mode AND no --permission-mode flag → live capture invoked
 *
 * Plus the validation / wire-shape cases (missing session_id, bad UUID).
 */

import { describe, expect, test } from 'bun:test';

import { createHandoffTrigger } from '../../src/handoff/trigger';
import { createRestartHandler } from '../../src/mcp/handlers/restart';

const VALID_SID = '01234567-89ab-cdef-0123-456789abcdef';

describe('createRestartHandler — validation', () => {
  test('missing session_id → error response', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/cwd',
      trigger,
    });
    const r = await handler({ op: 'restart' });
    expect(r.action).toBe('error');
    expect(typeof r.error).toBe('string');
    expect(r.error).toContain('session_id');
    expect(trigger.getStashedArgv()).toBeNull();
  });

  test('session_id of wrong type → error', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/cwd',
      trigger,
    });
    const r = await handler({ op: 'restart', session_id: 42 as unknown as string });
    expect(r.action).toBe('error');
    expect(trigger.getStashedArgv()).toBeNull();
  });

  test('invalid UUID → error response', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/cwd',
      trigger,
    });
    const r = await handler({ op: 'restart', session_id: 'not-a-uuid' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('UUID');
    expect(trigger.getStashedArgv()).toBeNull();
  });
});

describe('createRestartHandler — preserveArgs + argv build', () => {
  test('rich origArgs: magic preserved at front, cwd + --resume in middle, flags at end', async () => {
    const trigger = createHandoffTrigger();
    const origArgs = ['opus', 'max', '/some/cwd', '--ide', '--brief', '-W', 'Bash'];
    const handler = createRestartHandler({
      origArgs,
      launchCWD: '/launch/cwd',
      trigger,
    });
    const r = await handler({ op: 'restart', session_id: VALID_SID });
    expect(r.action).toBe('done');
    expect(trigger.getStashedArgv()).toEqual([
      'opus',
      'max',
      '/launch/cwd',
      '--resume',
      VALID_SID,
      '--ide',
      '--brief',
      '-W',
      'Bash',
    ]);
  });

  test('empty origArgs: argv is just [cwd, --resume, sid]', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/launch/cwd',
      trigger,
    });
    const r = await handler({ op: 'restart', session_id: VALID_SID });
    expect(r.action).toBe('done');
    expect(trigger.getStashedArgv()).toEqual(['/launch/cwd', '--resume', VALID_SID]);
  });

  test('handler fires the trigger', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/cwd',
      trigger,
    });

    let triggered = false;
    void trigger.awaitTrigger().then(() => {
      triggered = true;
    });
    expect(triggered).toBe(false);

    await handler({ op: 'restart', session_id: VALID_SID });
    // Yield microtasks so the await chain settles.
    await new Promise((r) => setTimeout(r, 0));
    expect(triggered).toBe(true);
  });

  test('first stash wins — second restart call is a no-op for argv', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/cwd',
      trigger,
    });
    await handler({ op: 'restart', session_id: VALID_SID });
    const firstStash = trigger.getStashedArgv();
    await handler({
      op: 'restart',
      session_id: '11111111-2222-3333-4444-555555555555',
    });
    expect(trigger.getStashedArgv()).toEqual(firstStash!);
  });
});

describe('createRestartHandler — #205 symptom 2: --resume not duplicated', () => {
  // Each in-session fnc_restart rebuilds the argv from the running
  // process's origArgs (FNC_ARGS_JSON, stamped by the previous relaunch).
  // After the first restart the origArgs already carry `--resume <sid>`;
  // the handler must NOT preserve that stale flag and then prepend a fresh
  // one — that accumulates one extra `--resume` per generation (#205).
  test('origArgs already carrying --resume <sid> → exactly one --resume out', async () => {
    const trigger = createHandoffTrigger();
    const oldSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // This is what generation-2's origArgs look like: the gen-1 relaunch
    // stamped `[cwd, '--resume', <oldSid>, ...flags]` into FNC_ARGS_JSON.
    const origArgs = ['/launch/cwd', '--resume', oldSid, '--ide', '--effort', 'high'];
    const handler = createRestartHandler({
      origArgs,
      launchCWD: '/launch/cwd',
      trigger,
    });
    await handler({ op: 'restart', session_id: VALID_SID });
    const got = trigger.getStashedArgv()!;
    const resumeCount = got.filter((t) => t === '--resume').length;
    expect(resumeCount).toBe(1);
    // The single --resume carries the CURRENT session id, not the stale one.
    expect(got[got.indexOf('--resume') + 1]).toBe(VALID_SID);
    expect(got).not.toContain(oldSid);
  });

  test('origArgs with --resume=<sid> equals-form → exactly one --resume out', async () => {
    const trigger = createHandoffTrigger();
    const oldSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const origArgs = ['/launch/cwd', `--resume=${oldSid}`, '--ide'];
    const handler = createRestartHandler({
      origArgs,
      launchCWD: '/launch/cwd',
      trigger,
    });
    await handler({ op: 'restart', session_id: VALID_SID });
    const got = trigger.getStashedArgv()!;
    const resumeCount =
      got.filter((t) => t === '--resume').length +
      got.filter((t) => t.startsWith('--resume=')).length;
    expect(resumeCount).toBe(1);
    expect(got).not.toContain(`--resume=${oldSid}`);
    expect(got[got.indexOf('--resume') + 1]).toBe(VALID_SID);
  });

  test('two consecutive restart generations stay at one --resume', async () => {
    // Simulate the generation chain: gen-1 origArgs → gen-1 stashed argv
    // becomes gen-2's origArgs → gen-2 stashed argv. Without the fix the
    // count climbs 1 → 2 across generations.
    const sid1 = '11111111-1111-1111-1111-111111111111';
    const sid2 = '22222222-2222-2222-2222-222222222222';

    const t1 = createHandoffTrigger();
    const h1 = createRestartHandler({
      origArgs: ['/launch/cwd', '--ide'],
      launchCWD: '/launch/cwd',
      trigger: t1,
    });
    await h1({ op: 'restart', session_id: sid1 });
    const gen1 = t1.getStashedArgv()!;
    expect(gen1.filter((t) => t === '--resume').length).toBe(1);

    const t2 = createHandoffTrigger();
    const h2 = createRestartHandler({
      // gen-2 sees gen-1's relaunch argv as its origArgs.
      origArgs: gen1,
      launchCWD: '/launch/cwd',
      trigger: t2,
    });
    await h2({ op: 'restart', session_id: sid2 });
    const gen2 = t2.getStashedArgv()!;
    expect(gen2.filter((t) => t === '--resume').length).toBe(1);
    expect(gen2[gen2.indexOf('--resume') + 1]).toBe(sid2);
    expect(gen2).not.toContain(sid1);
  });
});

describe('createRestartHandler — overrides', () => {
  test('model override strips bare-magic AND appends --model', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: ['opus', 'max', '/some/cwd', '--ide'],
      launchCWD: '/launch/cwd',
      trigger,
    });
    await handler({ op: 'restart', session_id: VALID_SID, model: 'sonnet' });
    // "opus" stripped (model override); "max" kept as leading magic.
    expect(trigger.getStashedArgv()).toEqual([
      'max',
      '/launch/cwd',
      '--resume',
      VALID_SID,
      '--ide',
      '--model',
      'sonnet',
    ]);
  });

  test('effort override strips bare "max" AND appends --effort', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: ['opus', 'max', '/some/cwd'],
      launchCWD: '/launch/cwd',
      trigger,
    });
    await handler({ op: 'restart', session_id: VALID_SID, effort: 'low' });
    expect(trigger.getStashedArgv()).toEqual([
      'opus',
      '/launch/cwd',
      '--resume',
      VALID_SID,
      '--effort',
      'low',
    ]);
  });

  test('boolean overrides flow through (verbose/ide/brief/chrome)', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: ['/some/cwd', '--ide'],
      launchCWD: '/launch/cwd',
      trigger,
    });
    await handler({
      op: 'restart',
      session_id: VALID_SID,
      ide: false,
      verbose: true,
    });
    const got = trigger.getStashedArgv()!;
    expect(got).not.toContain('--ide'); // stripped
    expect(got).toContain('--verbose'); // appended
  });

  test('allowed_tools override → --allowedTools <value>', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/launch/cwd',
      trigger,
    });
    await handler({
      op: 'restart',
      session_id: VALID_SID,
      allowed_tools: 'Bash,Read',
    });
    expect(trigger.getStashedArgv()).toEqual([
      '/launch/cwd',
      '--resume',
      VALID_SID,
      '--allowedTools',
      'Bash,Read',
    ]);
  });

  test('agent override → --agent <value>', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/launch/cwd',
      trigger,
    });
    await handler({
      op: 'restart',
      session_id: VALID_SID,
      agent: 'researcher',
    });
    const got = trigger.getStashedArgv()!;
    expect(got).toContain('--agent');
    expect(got[got.indexOf('--agent') + 1]).toBe('researcher');
  });
});

describe('createRestartHandler — live permission-mode capture', () => {
  test('explicit permission_mode wins; live reader NOT invoked', async () => {
    const trigger = createHandoffTrigger();
    let readerCalled = false;
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/launch/cwd',
      trigger,
      livePermissionModeReader: (_sid) => {
        readerCalled = true;
        return 'plan';
      },
    });
    await handler({
      op: 'restart',
      session_id: VALID_SID,
      permission_mode: 'bypassPermissions',
    });
    expect(readerCalled).toBe(false);
    const got = trigger.getStashedArgv()!;
    expect(got).toContain('--permission-mode');
    expect(got[got.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    // Exactly ONE --permission-mode token in the result.
    const count = got.filter((t) => t === '--permission-mode').length;
    expect(count).toBe(1);
  });

  test('no permission_mode + no preserved --permission-mode → live reader invoked', async () => {
    const trigger = createHandoffTrigger();
    let seenSid = '';
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/launch/cwd',
      trigger,
      livePermissionModeReader: (sid) => {
        seenSid = sid;
        return 'plan';
      },
    });
    await handler({ op: 'restart', session_id: VALID_SID });
    expect(seenSid).toBe(VALID_SID);
    const got = trigger.getStashedArgv()!;
    expect(got).toContain('--permission-mode');
    expect(got[got.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  test('preserved --permission-mode from origArgs → live reader NOT invoked', async () => {
    const trigger = createHandoffTrigger();
    let readerCalled = false;
    const handler = createRestartHandler({
      origArgs: ['/cwd', '--permission-mode', 'acceptEdits'],
      launchCWD: '/launch/cwd',
      trigger,
      livePermissionModeReader: () => {
        readerCalled = true;
        return 'plan';
      },
    });
    await handler({ op: 'restart', session_id: VALID_SID });
    expect(readerCalled).toBe(false);
    const got = trigger.getStashedArgv()!;
    // Exactly ONE --permission-mode token, value from origArgs.
    const count = got.filter((t) => t === '--permission-mode').length;
    expect(count).toBe(1);
    expect(got[got.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  test('preserved --permission-mode=val (equals form) → live reader NOT invoked', async () => {
    const trigger = createHandoffTrigger();
    let readerCalled = false;
    const handler = createRestartHandler({
      origArgs: ['/cwd', '--permission-mode=plan'],
      launchCWD: '/launch/cwd',
      trigger,
      livePermissionModeReader: () => {
        readerCalled = true;
        return 'default';
      },
    });
    await handler({ op: 'restart', session_id: VALID_SID });
    expect(readerCalled).toBe(false);
  });

  test('live reader returns null → no --permission-mode appended', async () => {
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/launch/cwd',
      trigger,
      livePermissionModeReader: () => null,
    });
    await handler({ op: 'restart', session_id: VALID_SID });
    const got = trigger.getStashedArgv()!;
    expect(got).not.toContain('--permission-mode');
  });

  test('no reader injected → no live capture, no crash', async () => {
    // The production default is to skip live capture (file IO TODO);
    // verify the handler doesn't blow up when no reader is supplied
    // and no caller-provided permission-mode exists.
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: [],
      launchCWD: '/launch/cwd',
      trigger,
    });
    const r = await handler({ op: 'restart', session_id: VALID_SID });
    expect(r.action).toBe('done');
    const got = trigger.getStashedArgv()!;
    expect(got).not.toContain('--permission-mode');
  });
});

// Wiring sanity: the same handler factory main.ts uses must plug into
// createParentDispatcher's handlers map. Drive a fake AcceptedSocket end
// to end so a future refactor that breaks the shape (e.g. handler signature
// drift) is caught here, not at runtime.
describe('createRestartHandler — wiring through createParentDispatcher', () => {
  test('parent dispatcher round-trips restart op end-to-end', async () => {
    const { createParentDispatcher } = await import('../../src/mcp/parent-dispatch.ts');
    const trigger = createHandoffTrigger();
    const handler = createRestartHandler({
      origArgs: ['opus', '/cwd', '--ide'],
      launchCWD: '/launch',
      trigger,
    });
    const dispatcher = createParentDispatcher({
      handlers: {
        restart: handler,
        switch: async () => ({ action: 'done' }),
        spawn: async () => ({ action: 'done' }),
        copy_to_clipboard: async () => ({ action: 'done', clipboard_ok: false }),
      },
    });

    const written: string[] = [];
    let ended = false;
    const accepted = {
      socket: {
        write(data: string): number {
          written.push(data);
          return data.length;
        },
        end(): void {
          ended = true;
        },
      },
      handlers: {
        data: (_s: unknown, _c: unknown) => {},
        error: (_s: unknown, _e: unknown) => {},
        close: (_s: unknown) => {},
      },
    };
    dispatcher(accepted as unknown as Parameters<typeof dispatcher>[0]);

    const line = JSON.stringify({ op: 'restart', session_id: VALID_SID }) + '\n';
    accepted.handlers.data(accepted.socket, Buffer.from(line, 'utf8'));

    // Let the floating dispatch promise resolve.
    await new Promise((r) => setTimeout(r, 5));

    expect(ended).toBe(true);
    expect(written.length).toBe(1);
    const resp = JSON.parse(written[0]!.trimEnd());
    expect(resp.action).toBe('done');
    expect(trigger.getStashedArgv()).toEqual([
      'opus',
      '/launch',
      '--resume',
      VALID_SID,
      '--ide',
    ]);
  });
});
