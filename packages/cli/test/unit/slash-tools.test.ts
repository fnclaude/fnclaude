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

import { buildTools } from '../../src/mcp/dispatch.ts';
import type { PtyWriter } from '../../src/mcp/handlers/inject-slash.ts';
import {
  createRequestCompactHandler,
  createRunSlashCommandHandler,
  createSetEffortHandler,
  createSetModelHandler,
  slashToolEnabled,
} from '../../src/mcp/handlers/slash-tools.ts';

function spyWriter(): { write: PtyWriter; calls: string[] } {
  const calls: string[] = [];
  return { write: (p) => calls.push(p), calls };
}

describe('request_compact (C1)', () => {
  test('no instructions → queues bare /compact, returns queued, no output', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write });
    const r = await handler({ op: 'compact' });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual(['/compact\r']);
  });

  test('instructions appended after the command', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write });
    await handler({ op: 'compact', instructions: 'focus on the auth refactor' });
    expect(spy.calls).toEqual(['/compact focus on the auth refactor\r']);
  });

  test('follow_up queues a second NON-slash prompt line after /compact, in order', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write });
    const r = await handler({
      op: 'compact',
      instructions: 'keep the renderer work',
      follow_up: 'now continue with step 3',
    });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual([
      '/compact keep the renderer work\r',
      'now continue with step 3\r',
    ]);
    // The follow_up must NOT be a slash command.
    expect(spy.calls[1]!.startsWith('/')).toBe(false);
  });

  test('empty/whitespace follow_up is ignored — only /compact is written', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write });
    await handler({ op: 'compact', follow_up: '   ' });
    expect(spy.calls).toEqual(['/compact\r']);
  });

  test('captures no output — response carries only action', async () => {
    const spy = spyWriter();
    const handler = createRequestCompactHandler({ write: spy.write });
    const r = await handler({ op: 'compact' });
    expect(Object.keys(r).sort()).toEqual(['action']);
  });
});

describe('fnc_set_effort (C2)', () => {
  test('valid level → /effort <level>, queued', async () => {
    const spy = spyWriter();
    const handler = createSetEffortHandler({ write: spy.write });
    const r = await handler({ op: 'set_effort', effort: 'high' });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual(['/effort high\r']);
  });

  test('every vocabulary value is accepted', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'auto']) {
      const spy = spyWriter();
      const handler = createSetEffortHandler({ write: spy.write });
      const r = await handler({ op: 'set_effort', effort: level });
      expect(r.action).toBe('queued');
      expect(spy.calls).toEqual([`/effort ${level}\r`]);
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
    const handler = createSetModelHandler({ write: spy.write });
    const r = await handler({ op: 'set_model', model: 'opus' });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual(['/model opus\r']);
  });

  test('every vocabulary value is accepted', async () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      const spy = spyWriter();
      const handler = createSetModelHandler({ write: spy.write });
      const r = await handler({ op: 'set_model', model });
      expect(r.action).toBe('queued');
      expect(spy.calls).toEqual([`/model ${model}\r`]);
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
    const handler = createRunSlashCommandHandler({ write: spy.write });
    const r = await handler({ op: 'run_slash', command: 'clear' });
    expect(r).toEqual({ action: 'queued' });
    expect(spy.calls).toEqual(['/clear\r']);
  });

  test('leading slash is normalized, args appended', async () => {
    const spy = spyWriter();
    const handler = createRunSlashCommandHandler({ write: spy.write });
    await handler({ op: 'run_slash', command: '/cost', args: ['detail'] });
    expect(spy.calls).toEqual(['/cost detail\r']);
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
