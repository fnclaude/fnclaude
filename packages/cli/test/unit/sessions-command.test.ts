/**
 * Unit tests for the `fnc sessions` subcommand: argv detection and the
 * pure human-readable formatter over live registry entries. The dir
 * scanning itself is readLiveEntries (covered in registry-store.test.ts);
 * the subcommand's end-to-end plumbing is covered in registry-e2e.test.ts.
 */

import { describe, expect, test } from 'bun:test';

import type { RegistryEntry } from '../../src/registry/RegistryEntry';
import { formatSessions, isSessionsSubcommand } from '../../src/registry/sessions-command';

describe('isSessionsSubcommand', () => {
  test('recognized ONLY at argv[0]', () => {
    expect(isSessionsSubcommand(['sessions'])).toBe(true);
    expect(isSessionsSubcommand(['sessions', '--whatever'])).toBe(true);
    expect(isSessionsSubcommand(['foo', 'sessions'])).toBe(false);
    expect(isSessionsSubcommand([])).toBe(false);
  });
});

describe('formatSessions', () => {
  const ENTRY: RegistryEntry = {
    session: { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'fix-auth-bug' },
    owner: { pid: 4242, starttime: '555' },
    cwd: '/home/u/src/proj',
    startedAt: '2026-08-11T12:00:00.000Z',
    claims: [
      { key: '/home/u/src/proj', mode: 'exclusive', implicit: 'cwd' },
      { key: '/home/u/.cache/go-build', mode: 'using', note: 'go build in flight' },
    ],
  };

  test('empty registry → explicit no-sessions line', () => {
    expect(formatSessions([])).toContain('No live fnclaude sessions');
  });

  test('renders name, pid, cwd, and every claim with mode/implicit/note', () => {
    const out = formatSessions([ENTRY]);
    expect(out).toContain('fix-auth-bug');
    expect(out).toContain('4242');
    expect(out).toContain('/home/u/src/proj');
    expect(out).toContain('exclusive');
    expect(out).toContain('[cwd]');
    expect(out).toContain('using');
    expect(out).toContain('/home/u/.cache/go-build');
    expect(out).toContain('go build in flight');
  });

  test('unnamed sessions render a placeholder, not "null"', () => {
    const out = formatSessions([
      { ...ENTRY, session: { id: ENTRY.session.id, name: null } },
    ]);
    expect(out).toContain('(unnamed)');
    expect(out).not.toContain('null');
  });

  test('counts sessions in the header', () => {
    const two = formatSessions([
      ENTRY,
      { ...ENTRY, session: { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'other' } },
    ]);
    expect(two).toContain('2 live fnclaude sessions');
    expect(formatSessions([ENTRY])).toContain('1 live fnclaude session');
  });
});
