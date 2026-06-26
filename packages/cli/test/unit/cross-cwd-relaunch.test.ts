/**
 * §9.3 — Cross-cwd silent relaunch decision.
 *
 * `decideCrossCwdRelaunch` is the pure decision function the post-exit
 * path consults to figure out whether to silently re-exec into a new
 * fnclaude instance pointed at a different cwd + session uuid.
 *
 * The decision boils down to:
 *   1. claude must have exited cleanly (code 0). Non-zero → no relaunch.
 *   2. The handoff trigger must not have already stashed argv. If it has,
 *      the MCP-handoff path owns the relaunch; cross-cwd would race.
 *   3. The captured PTY tail must contain a valid "To resume, run:"
 *      cross-cwd hint (parseCrossCwdHint returns non-null).
 *
 * When all three pass, the function returns the reconstructed relaunch
 * argv. Reconstruction port mirrors Go canonical's reconstructArgv —
 * preserveArgs with empty deny + bareOK sets, splitLeadingMagic, then
 * `[...magic, dest, '--resume', uuid, ...rest]`.
 */

import { describe, expect, test } from 'bun:test';

import { decideCrossCwdRelaunch } from '../../src/launch/cross-cwd-relaunch';

// 8-4-4-4-12 hex UUID for the hint matcher.
const UUID = '68aa15ae-af23-4c7a-b59f-5cee07c61790';
const HINT = (cwd: string, uuid: string): string =>
  `To resume, run:\n  cd ${cwd} && claude --resume ${uuid}\n`;

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('decideCrossCwdRelaunch — gate conditions', () => {
  test('non-zero exit → relaunch:false', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 1,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['src/'],
    });
    expect(d.relaunch).toBe(false);
  });

  test('handoff already stashed → relaunch:false', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: true,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['src/'],
    });
    expect(d.relaunch).toBe(false);
  });

  test('empty ring → relaunch:false', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: new Uint8Array(0),
      origArgs: ['src/'],
    });
    expect(d.relaunch).toBe(false);
  });

  test('ring without hint → relaunch:false', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode('normal claude output — no resume message here\n'),
      origArgs: ['src/'],
    });
    expect(d.relaunch).toBe(false);
  });

  test('hint with unsafe cwd → relaunch:false', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/home/$USER', UUID)),
      origArgs: ['src/'],
    });
    expect(d.relaunch).toBe(false);
  });
});

describe('decideCrossCwdRelaunch — loop guard (session must resolve in hint cwd)', () => {
  // The picker loop: claude's hint gives a cwd that does NOT host the
  // session's <uuid>.jsonl (e.g. an orphaned worktree session whose
  // recorded cwd encodes to a different project dir). Relaunching
  // `claude --resume <uuid>` from that cwd hits "No conversation found"
  // and bounces straight back to the picker — an infinite loop. fnc must
  // detect the mismatch and refuse to relaunch.

  test('hint cwd does NOT host the session → relaunch:false with reason', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/home/tom/gone', UUID)),
      origArgs: [],
      sessionExists: () => false, // the loop-trigger condition
    });
    expect(d).toEqual({ relaunch: false, reason: 'unresolvable', cwd: '/home/tom/gone', uuid: UUID });
  });

  test('hint cwd DOES host the session → relaunch proceeds', () => {
    const seen: Array<[string, string]> = [];
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: [],
      sessionExists: (cwd, uuid) => {
        seen.push([cwd, uuid]);
        return true;
      },
    });
    expect(d).toEqual({ relaunch: true, argv: ['/dest/dir', '--resume', UUID] });
    expect(seen).toEqual([['/dest/dir', UUID]]);
  });

  test('no sessionExists seam → defaults to allowing relaunch (back-compat)', () => {
    // When the caller doesn't supply the probe, behavior is unchanged:
    // relaunch proceeds. The production call-site supplies a real FS probe.
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: [],
    });
    expect(d).toEqual({ relaunch: true, argv: ['/dest/dir', '--resume', UUID] });
  });
});

describe('decideCrossCwdRelaunch — argv reconstruction', () => {
  test('no orig args → [dest, --resume, uuid]', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: [],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['/dest/dir', '--resume', UUID],
    });
  });

  test('single positional path → replaced by dest', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['src/'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['/dest/dir', '--resume', UUID],
    });
  });

  test('two positionals → both replaced by single dest', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['src/', 'extra/'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['/dest/dir', '--resume', UUID],
    });
  });

  test('model preserved before dest', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['opus', 'src/'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['opus', '/dest/dir', '--resume', UUID],
    });
  });

  test('model + effort preserved; flag preserved after --resume', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['opus', 'max', 'src/', '-V'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['opus', 'max', '/dest/dir', '--resume', UUID, '-V'],
    });
  });

  test('path then flags', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['src/', '--model', 'sonnet', '-V'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['/dest/dir', '--resume', UUID, '--model', 'sonnet', '-V'],
    });
  });

  test('flag taking a value (no positionals)', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['--verbose'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['/dest/dir', '--resume', UUID, '--verbose'],
    });
  });

  test('magic-only argv (no positional)', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['haiku', 'low', '--verbose'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['haiku', 'low', '/dest/dir', '--resume', UUID, '--verbose'],
    });
  });

  test('multiple magic + multiple paths + flag', () => {
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['opus', 'xhigh', 'path1/', 'path2/', '--flag'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['opus', 'xhigh', '/dest/dir', '--resume', UUID, '--flag'],
    });
  });

  test('fork subcommand dropped (non-magic positional)', () => {
    // The fork-subcommand keyword sits in Phase-2 territory (non-magic
    // non-flag), so it's stripped along with positional cwds. On
    // relaunch claude resumes the already-forked session by UUID — we
    // don't want to fork again in the redirected cwd.
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(HINT('/dest/dir', UUID)),
      origArgs: ['fork'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['/dest/dir', '--resume', UUID],
    });
  });

  test('hint with surrounding ANSI escapes still drives a valid relaunch', () => {
    const ansi =
      '\x1b[36mTo resume, run:\x1b[0m\n  \x1b[2mcd /tmp/work && claude --resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\x1b[0m';
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(ansi),
      origArgs: [],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['/tmp/work', '--resume', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    });
  });

  test('multiple hints in ring → last one wins', () => {
    const text =
      HINT('/home/one', '11111111-1111-4111-8111-111111111111') +
      'later output\n' +
      HINT('/home/two', '22222222-2222-4222-8222-222222222222');
    const d = decideCrossCwdRelaunch({
      exitCode: 0,
      alreadyStashed: false,
      ringSnapshot: encode(text),
      origArgs: ['opus', 'src/'],
    });
    expect(d).toEqual({
      relaunch: true,
      argv: ['opus', '/home/two', '--resume', '22222222-2222-4222-8222-222222222222'],
    });
  });
});
