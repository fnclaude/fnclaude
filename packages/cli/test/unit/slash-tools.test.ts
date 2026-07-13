/**
 * Unit tests for the Batch-2 slash-injection MCP tool handlers
 * (request_compact, fnc_set_effort, fnc_set_model,
 * fnc_run_slash_command) and the opt-in registration gate for the
 * generic slash tool.
 *
 * Each handler is a thin wrapper over the C0 keystone: it formats a slash
 * command, writes the exact bytes into the injected PTY writer, and
 * returns `{ action: 'queued' }` with NO captured output. The tests
 * assert the formatted payload via a spy writer, the queued response, the
 * no-output contract, validation for effort/model, and that the generic
 * tool appears only when opted in.
 */

import { describe, expect, test } from 'bun:test';

import { buildTools } from '../../src/mcp/dispatch';
import type { PtyWriter } from '../../src/mcp/handlers/inject-slash';
import {
  createRequestCompactHandler,
  createRunSlashCommandHandler,
  createSetEffortHandler,
  createSetModelHandler,
  slashToolEnabled,
} from '../../src/mcp/handlers/slash-tools';

function spyWriter(): { write: PtyWriter; calls: string[] } {
  const calls: string[] = [];
  return { write: (p) => calls.push(p), calls };
}

/** Synchronous schedule seam so the separate CR write lands deterministically. */
const syncSchedule = (fn: () => void): void => fn();

describe('request_compact (C1)', () => {
  test('no instructions → submits /compact as bracket-wrapped body + separate CR', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write, schedule: syncSchedule });
    const r = await handler({ op: 'compact' });
    expect(r).toEqual({ action: 'queued' });
    // The bug: a single bulk write of "/compact\r" is treated as a paste and
    // the trailing CR is swallowed. The fix submits the body bracketed-paste
    // wrapped, then SEPARATE bare CRs so one lexes as a Return keypress. Control
    // messages fire 3 retry CRs (a single CR after a large paste is unreliable).
    expect(spy.calls).toEqual(['\x1b[200~/compact\x1b[201~', '\r', '\r', '\r']);
  });

  test('instructions appended after the command, submitted as body + retry CRs', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write, schedule: syncSchedule });
    await handler({ op: 'compact', instructions: 'focus on the auth refactor' });
    expect(spy.calls).toEqual([
      '\x1b[200~/compact focus on the auth refactor\x1b[201~',
      '\r',
      '\r',
      '\r',
    ]);
  });

  test('follow_up is NOT written back-to-back — only /compact lands before the gate resolves', async () => {
    const spy = spyWriter();
    // A pending gate we control: the follow_up must wait for it.
    let release!: () => void;
    const gate = (): Promise<void> => new Promise<void>((res) => (release = res));
    let tracked: Promise<void> | undefined;
    const handler = createRequestCompactHandler({
      write: spy.write,
      schedule: syncSchedule,
      followUpGate: gate,
      trackFollowUp: (p) => (tracked = p),
    });
    const r = await handler({
      op: 'compact',
      instructions: 'keep the renderer work',
      follow_up: 'now continue with step 3',
    });
    expect(r).toEqual({ action: 'queued' });
    // ONLY /compact so far — the follow_up has NOT been written (never back-to-back).
    expect(spy.calls).toEqual([
      '\x1b[200~/compact keep the renderer work\x1b[201~',
      '\r',
      '\r',
      '\r',
    ]);

    // Resolve the gate; await the detached follow_up work.
    release();
    await tracked;
    // Now the follow_up lands as its OWN submit (body + 3 retry CRs), AFTER /compact.
    expect(spy.calls).toEqual([
      '\x1b[200~/compact keep the renderer work\x1b[201~',
      '\r',
      '\r',
      '\r',
      '\x1b[200~now continue with step 3\x1b[201~',
      '\r',
      '\r',
      '\r',
    ]);
    // The follow_up body must NOT be a slash command.
    expect(spy.calls[4]!.includes('/now')).toBe(false);
  });

  test('short single-line follow_up is injected INLINE (no file spill)', async () => {
    const spy = spyWriter();
    let spilled: string | null = null;
    let tracked: Promise<void> | undefined;
    const handler = createRequestCompactHandler({
      write: spy.write,
      schedule: syncSchedule,
      followUpGate: async () => {},
      spillFollowUp: (c) => {
        spilled = c;
        return '/tmp/should-not-be-used.md';
      },
      trackFollowUp: (p) => (tracked = p),
    });
    await handler({ op: 'compact', follow_up: 'continue with step 3' });
    await tracked;
    expect(spilled).toBeNull(); // never spilled
    expect(spy.calls).toEqual([
      '\x1b[200~/compact\x1b[201~',
      '\r',
      '\r',
      '\r',
      '\x1b[200~continue with step 3\x1b[201~',
      '\r',
      '\r',
      '\r',
    ]);
  });

  test('long follow_up spills to a file — an @file reference is injected, not the body', async () => {
    const spy = spyWriter();
    const long = 'x'.repeat(250);
    let spilled: string | null = null;
    let tracked: Promise<void> | undefined;
    const handler = createRequestCompactHandler({
      write: spy.write,
      schedule: syncSchedule,
      followUpGate: async () => {},
      spillFollowUp: (c) => {
        spilled = c;
        return '/tmp/fnc-followup-FIXED.md';
      },
      trackFollowUp: (p) => (tracked = p),
    });
    await handler({ op: 'compact', follow_up: long });
    await tracked;
    expect(spilled).toBe(long); // full body persisted
    expect(spy.calls).toEqual([
      '\x1b[200~/compact\x1b[201~',
      '\r',
      '\r',
      '\r',
      '\x1b[200~@/tmp/fnc-followup-FIXED.md\x1b[201~',
      '\r',
      '\r',
      '\r',
    ]);
  });

  test('multi-line follow_up spills to a file even when short', async () => {
    const spy = spyWriter();
    let spilled: string | null = null;
    let tracked: Promise<void> | undefined;
    const handler = createRequestCompactHandler({
      write: spy.write,
      schedule: syncSchedule,
      followUpGate: async () => {},
      spillFollowUp: (c) => {
        spilled = c;
        return '/tmp/fnc-followup-ML.md';
      },
      trackFollowUp: (p) => (tracked = p),
    });
    await handler({ op: 'compact', follow_up: 'line one\nline two' });
    await tracked;
    expect(spilled).toBe('line one\nline two');
    // /compact paste + 3 CRs occupy [0..3]; the follow_up @file paste is [4].
    expect(spy.calls[4]).toBe('\x1b[200~@/tmp/fnc-followup-ML.md\x1b[201~');
  });

  test('empty/whitespace follow_up is ignored — only /compact is written', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({
      write: spy.write,
      schedule: syncSchedule,
      followUpGate: async () => {},
    });
    await handler({ op: 'compact', follow_up: '   ' });
    expect(spy.calls).toEqual(['\x1b[200~/compact\x1b[201~', '\r', '\r', '\r']);
  });

  test('captures no output — response carries only action', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write, schedule: syncSchedule });
    const r = await handler({ op: 'compact' });
    expect(Object.keys(r).sort()).toEqual(['action']);
  });
});

describe('fnc_set_effort (C2)', () => {
  test('valid level → /effort <level>, queued', async () => {
    const spy = spyWriter();
    const handler = createSetEffortHandler({ write: spy.write, schedule: syncSchedule });
    const r = await handler({ op: 'set_effort', effort: 'high' });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual(['\x1b[200~/effort high\x1b[201~', '\r']);
  });

  test('every vocabulary value is accepted', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'auto']) {
      const spy = spyWriter();
      const handler = createSetEffortHandler({ write: spy.write, schedule: syncSchedule });
      const r = await handler({ op: 'set_effort', effort: level });
      expect(r.action).toBe('queued');
      expect(spy.calls).toEqual([`\x1b[200~/effort ${level}\x1b[201~`, '\r']);
    }
  });

  test('invalid level → error, no write', async () => {
    const spy = spyWriter();
    const handler = createSetEffortHandler({ write: spy.write });
    const r = await handler({ op: 'set_effort', effort: 'turbo' });
    expect(r.action).toBe('error');
    expect(typeof r.error).toBe('string');
    expect(spy.calls).toEqual([]);
  });

  test('missing level → error, no write', async () => {
    const spy = spyWriter();
    const handler = createSetEffortHandler({ write: spy.write });
    const r = await handler({ op: 'set_effort' });
    expect(r.action).toBe('error');
    expect(spy.calls).toEqual([]);
  });
});

describe('fnc_set_model (C3)', () => {
  test('valid model → /model <name>, queued', async () => {
    const spy = spyWriter();
    const handler = createSetModelHandler({ write: spy.write, schedule: syncSchedule });
    const r = await handler({ op: 'set_model', model: 'opus' });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual(['\x1b[200~/model opus\x1b[201~', '\r']);
  });

  test('every vocabulary value is accepted', async () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'fable']) {
      const spy = spyWriter();
      const handler = createSetModelHandler({ write: spy.write, schedule: syncSchedule });
      const r = await handler({ op: 'set_model', model });
      expect(r.action).toBe('queued');
      expect(spy.calls).toEqual([`\x1b[200~/model ${model}\x1b[201~`, '\r']);
    }
  });

  test('invalid model → error, no write', async () => {
    const spy = spyWriter();
    const handler = createSetModelHandler({ write: spy.write });
    const r = await handler({ op: 'set_model', model: 'gpt-9' });
    expect(r.action).toBe('error');
    expect(spy.calls).toEqual([]);
  });

  test('missing model → error, no write', async () => {
    const spy = spyWriter();
    const handler = createSetModelHandler({ write: spy.write });
    const r = await handler({ op: 'set_model' });
    expect(r.action).toBe('error');
    expect(spy.calls).toEqual([]);
  });
});

describe('fnc_run_slash_command (C4)', () => {
  test('arbitrary command → /<command>, queued', async () => {
    const spy = spyWriter();
    const handler = createRunSlashCommandHandler({ write: spy.write, schedule: syncSchedule });
    const r = await handler({ op: 'run_slash', command: 'clear' });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual(['\x1b[200~/clear\x1b[201~', '\r']);
  });

  test('leading slash is normalized, args appended', async () => {
    const spy = spyWriter();
    const handler = createRunSlashCommandHandler({ write: spy.write, schedule: syncSchedule });
    await handler({ op: 'run_slash', command: '/cost', args: ['detail'] });
    expect(spy.calls).toEqual(['\x1b[200~/cost detail\x1b[201~', '\r']);
  });

  test('empty command → error, no write', async () => {
    const spy = spyWriter();
    const handler = createRunSlashCommandHandler({ write: spy.write });
    const r = await handler({ op: 'run_slash', command: '  ' });
    expect(r.action).toBe('error');
    expect(spy.calls).toEqual([]);
  });
});

describe('slashToolEnabled (C4 opt-in gate)', () => {
  test('true only when FNC_ENABLE_SLASH_TOOL=1', () => {
    expect(slashToolEnabled({ FNC_ENABLE_SLASH_TOOL: '1' })).toBe(true);
    expect(slashToolEnabled({ FNC_ENABLE_SLASH_TOOL: '0' })).toBe(false);
    expect(slashToolEnabled({ FNC_ENABLE_SLASH_TOOL: 'true' })).toBe(false);
    expect(slashToolEnabled({})).toBe(false);
  });
});

describe('buildTools — C4 registration gate', () => {
  const dial = async () => ({ action: 'queued' });

  test('fnc_run_slash_command absent when not opted in', () => {
    const tools = buildTools({ socketPath: '/run/x.sock', dialAndCall: dial, env: {} });
    expect('fnc_run_slash_command' in tools).toBe(false);
    // The always-on slash tools are still present.
    expect('request_compact' in tools).toBe(true);
    expect('fnc_set_effort' in tools).toBe(true);
    expect('fnc_set_model' in tools).toBe(true);
  });

  test('fnc_run_slash_command present when FNC_ENABLE_SLASH_TOOL=1', () => {
    const tools = buildTools({
      socketPath: '/run/x.sock',
      dialAndCall: dial,
      env: { FNC_ENABLE_SLASH_TOOL: '1' },
    });
    expect('fnc_run_slash_command' in tools).toBe(true);
  });

  test('opted-in run_slash tool routes to op "run_slash"', async () => {
    const calls: Array<{ request: { op: string } }> = [];
    const tools = buildTools({
      socketPath: '/run/x.sock',
      dialAndCall: async (a) => {
        calls.push(a as { request: { op: string } });
        return { action: 'queued' };
      },
      env: { FNC_ENABLE_SLASH_TOOL: '1' },
    });
    await tools['fnc_run_slash_command']!.handler({ command: 'clear' });
    expect(calls[0]!.request.op).toBe('run_slash');
  });
});
