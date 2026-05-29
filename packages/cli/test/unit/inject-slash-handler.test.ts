/**
 * Unit tests for the C0 slash-injection keystone —
 * `createInjectSlashHandler`, `formatSlashCommand`, `createPtyWriterHolder`.
 *
 * The keystone writes a queued `/<cmd> [args]\r` payload into the live
 * PTY input via an injected writer seam, returns `queued`, and captures
 * NO output. These tests assert the exact bytes written, the queued
 * response, the no-output-capture contract, and the deferred-binding
 * holder that bridges "dispatcher wired before spawn" against "terminal
 * created at spawn".
 */

import { describe, expect, test } from 'bun:test';

import {
  createInjectSlashHandler,
  createPtyWriterHolder,
  formatSlashCommand,
  type PtyWriter,
} from '../../src/mcp/handlers/inject-slash.ts';

function spyWriter(): { write: PtyWriter; calls: string[] } {
  const calls: string[] = [];
  return { write: (p) => calls.push(p), calls };
}

describe('formatSlashCommand', () => {
  test('bare command, no args → /<cmd>\\r', () => {
    expect(formatSlashCommand('compact')).toBe('/compact\r');
  });

  test('leading slash is not doubled', () => {
    expect(formatSlashCommand('/compact')).toBe('/compact\r');
  });

  test('single arg appended after a space', () => {
    expect(formatSlashCommand('effort', ['high'])).toBe('/effort high\r');
  });

  test('multiple args joined by single spaces', () => {
    expect(formatSlashCommand('run', ['a', 'b', 'c'])).toBe('/run a b c\r');
  });

  test('arg with internal spaces is preserved verbatim', () => {
    expect(formatSlashCommand('model', ['opus 4.8'])).toBe('/model opus 4.8\r');
  });

  test('terminator is carriage return, not newline', () => {
    const payload = formatSlashCommand('compact');
    expect(payload.endsWith('\r')).toBe(true);
    expect(payload.includes('\n')).toBe(false);
  });
});

describe('createInjectSlashHandler — happy path', () => {
  test('writes exact bytes and returns queued', async () => {
    const spy = spyWriter();
    const handler = createInjectSlashHandler({ write: spy.write });

    const r = await handler({ op: 'restart', command: 'compact' } as never);

    expect(r.action).toBe('queued');
    expect(spy.calls).toEqual(['/compact\r']);
  });

  test('command + args produce the joined payload', async () => {
    const spy = spyWriter();
    const handler = createInjectSlashHandler({ write: spy.write });

    const r = await handler({
      op: 'restart',
      command: 'set-model',
      args: ['opus', '4.8'],
    } as never);

    expect(r.action).toBe('queued');
    expect(spy.calls).toEqual(['/set-model opus 4.8\r']);
  });

  test('leading slash supplied by caller is normalized', async () => {
    const spy = spyWriter();
    const handler = createInjectSlashHandler({ write: spy.write });

    await handler({ op: 'restart', command: '/effort', args: ['low'] } as never);

    expect(spy.calls).toEqual(['/effort low\r']);
  });

  test('single string args field treated as one arg', async () => {
    const spy = spyWriter();
    const handler = createInjectSlashHandler({ write: spy.write });

    await handler({ op: 'restart', command: 'effort', args: 'medium' } as never);

    expect(spy.calls).toEqual(['/effort medium\r']);
  });

  test('does NOT capture or surface output — response carries no command output', async () => {
    // The writer "produces output" the model must never see; assert the
    // handler ignores anything beyond handing bytes to the writer.
    const observed: string[] = [];
    const handler = createInjectSlashHandler({
      write: (p) => {
        observed.push(p);
        // simulate the TUI emitting a result the model should NOT receive
      },
    });

    const r = await handler({ op: 'restart', command: 'compact' } as never);

    expect(r.action).toBe('queued');
    expect(r.message).toBeUndefined();
    expect(r.command).toBeUndefined();
    // The only side effect is the single PTY write.
    expect(observed).toEqual(['/compact\r']);
    // Response shape carries nothing resembling captured output.
    expect(Object.keys(r).sort()).toEqual(['action']);
  });
});

describe('createInjectSlashHandler — validation', () => {
  test('missing command → error, no write', async () => {
    const spy = spyWriter();
    const handler = createInjectSlashHandler({ write: spy.write });

    const r = await handler({ op: 'restart' } as never);

    expect(r.action).toBe('error');
    expect(typeof r.error).toBe('string');
    expect(spy.calls).toEqual([]);
  });

  test('empty / whitespace command → error, no write', async () => {
    const spy = spyWriter();
    const handler = createInjectSlashHandler({ write: spy.write });

    const r = await handler({ op: 'restart', command: '   ' } as never);

    expect(r.action).toBe('error');
    expect(spy.calls).toEqual([]);
  });

  test('non-string command → error, no write', async () => {
    const spy = spyWriter();
    const handler = createInjectSlashHandler({ write: spy.write });

    const r = await handler({ op: 'restart', command: 42 } as never);

    expect(r.action).toBe('error');
    expect(spy.calls).toEqual([]);
  });
});

describe('createPtyWriterHolder — deferred binding', () => {
  test('write before bind is a no-op, isBound false', () => {
    const holder = createPtyWriterHolder();
    expect(holder.isBound()).toBe(false);
    // Must not throw.
    holder.write('/compact\r');
    expect(holder.isBound()).toBe(false);
  });

  test('after bind, writes reach the bound sink', () => {
    const holder = createPtyWriterHolder();
    const spy = spyWriter();
    holder.bind(spy.write);

    expect(holder.isBound()).toBe(true);
    holder.write('/compact\r');
    expect(spy.calls).toEqual(['/compact\r']);
  });

  test('holder.write plugs into the handler and routes to the late-bound sink', async () => {
    const holder = createPtyWriterHolder();
    const handler = createInjectSlashHandler({ write: holder.write });

    // Dispatcher wired (handler built) before the terminal exists: a call
    // now is dropped but still returns queued (fire-and-forget).
    const early = await handler({ op: 'restart', command: 'compact' } as never);
    expect(early.action).toBe('queued');

    // Terminal spawns → bind the real sink.
    const spy = spyWriter();
    holder.bind(spy.write);

    const late = await handler({ op: 'restart', command: 'effort', args: ['high'] } as never);
    expect(late.action).toBe('queued');
    expect(spy.calls).toEqual(['/effort high\r']);
  });

  test('last bind wins', () => {
    const holder = createPtyWriterHolder();
    const first = spyWriter();
    const second = spyWriter();
    holder.bind(first.write);
    holder.bind(second.write);
    holder.write('/x\r');
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(['/x\r']);
  });
});
