/**
 * Unit tests for the fnc-native slash-command registry + resolver.
 *
 * The resolver is the primary TDD target: it implements the locked `//`
 * prefix + unique-prefix rules. `resolveIn` is tested against fixture command
 * sets so the ambiguous-across-two-commands case doesn't depend on there being
 * two real registrations, and `resolve`/`dispatchSlashLine` are exercised
 * against the live registry (where `restart`/`reload` are one command).
 */

import { describe, expect, test } from 'bun:test';

import { createHandoffTrigger } from '../../src/handoff/trigger';
import {
  dispatchSlashLine,
  parseSlashLine,
  REGISTRY,
  resolve,
  resolveIn,
  type SlashCommand,
} from '../../src/slash/registry';

const VALID_SID = '01234567-89ab-cdef-0123-456789abcdef';

const noop = (): { ok: boolean; message: string } => ({ ok: true, message: 'ok' });
const cmd = (name: string, aliases: string[]): SlashCommand => ({
  name,
  aliases,
  description: name,
  handler: noop,
});

describe('resolveIn — prefix + unique-command rules', () => {
  const restart = cmd('restart', ['reload']);
  const model = cmd('model', []);
  const commands = [restart, model];

  test('exact name → unique', () => {
    const r = resolveIn('restart', commands);
    expect(r.kind).toBe('unique');
    expect(r.kind === 'unique' && r.command).toBe(restart);
  });

  test('prefix matching one command → unique', () => {
    const r = resolveIn('rest', commands);
    expect(r.kind === 'unique' && r.command.name).toBe('restart');
  });

  test('alias prefix resolves to its command', () => {
    const r = resolveIn('rel', commands);
    expect(r.kind === 'unique' && r.command.name).toBe('restart');
  });

  test('prefix hitting name AND alias of the SAME command → unique (not ambiguous)', () => {
    // `re` prefixes both `restart` (name) and `reload` (alias) — same command.
    const r = resolveIn('re', [restart]);
    expect(r.kind === 'unique' && r.command.name).toBe('restart');
  });

  test('prefix spanning TWO distinct commands → ambiguous with candidates', () => {
    const rename = cmd('rename', []);
    const r = resolveIn('re', [restart, rename]);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.sort()).toEqual(['rename', 'restart']);
  });

  test('no match → none', () => {
    expect(resolveIn('zzz', commands).kind).toBe('none');
  });

  test('empty token → none', () => {
    expect(resolveIn('', commands).kind).toBe('none');
  });
});

describe('parseSlashLine — token + args split', () => {
  test('strips // and splits on the first space', () => {
    expect(parseSlashLine('//restart now please')).toEqual({ token: 'restart', args: 'now please' });
  });
  test('no args → empty args', () => {
    expect(parseSlashLine('//restart')).toEqual({ token: 'restart', args: '' });
  });
  test('bare // → empty token', () => {
    expect(parseSlashLine('//')).toEqual({ token: '', args: '' });
  });
});

describe('resolve — live registry', () => {
  test('//re resolves to the single restart command (name + reload alias)', () => {
    const r = resolve('re');
    expect(r.kind === 'unique' && r.command.name).toBe('restart');
  });
  test('reload alias resolves to restart', () => {
    expect(resolve('reload').kind).toBe('unique');
  });
  test('restart is registry entry #1', () => {
    expect(REGISTRY[0]?.name).toBe('restart');
  });
});

describe('dispatchSlashLine — end to end', () => {
  const base = {
    sessionId: VALID_SID,
    launchCWD: '/launch/cwd',
    origArgs: [] as readonly string[],
  };

  test('unknown command → feedback, nothing thrown', async () => {
    const trigger = createHandoffTrigger();
    const r = await dispatchSlashLine('//nope', { ...base, trigger });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('unknown');
    expect(trigger.getStashedArgv()).toBeNull();
  });

  test('//res → restart runs, stashes a resume argv', async () => {
    const trigger = createHandoffTrigger();
    const r = await dispatchSlashLine('//res', { ...base, trigger });
    expect(r.ok).toBe(true);
    const argv = trigger.getStashedArgv()!;
    expect(argv).toEqual(['/launch/cwd', '--resume', VALID_SID]);
  });

  test('//reload alias also restarts', async () => {
    const trigger = createHandoffTrigger();
    const r = await dispatchSlashLine('//reload', { ...base, trigger });
    expect(r.ok).toBe(true);
    expect(trigger.getStashedArgv()).not.toBeNull();
  });

  test('restart with unknown session id → friendly failure, nothing stashed', async () => {
    const trigger = createHandoffTrigger();
    const r = await dispatchSlashLine('//restart', { ...base, sessionId: null, trigger });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('session id');
    expect(trigger.getStashedArgv()).toBeNull();
  });
});
