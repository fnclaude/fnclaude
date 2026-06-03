import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCrossCwdHint } from '../../src/launch/cross-cwd-parse.ts';

describe('parseCrossCwdHint', () => {
  test('empty text → null', () => {
    expect(parseCrossCwdHint('')).toBeNull();
  });

  test('text without "To resume, run:" → null', () => {
    expect(parseCrossCwdHint('nothing of interest here')).toBeNull();
  });

  test('text mentioning resume but no full pattern → null', () => {
    expect(parseCrossCwdHint('To resume, run: do something else')).toBeNull();
  });

  test('single valid hint → returns {cwd, uuid}', () => {
    const text =
      'To resume, run:\n  cd /home/tom/projects/foo && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    const r = parseCrossCwdHint(text);
    expect(r).not.toBeNull();
    expect(r).toEqual({
      cwd: '/home/tom/projects/foo',
      uuid: '12345678-1234-4abc-89ab-1234567890ab',
    });
  });

  test('multiple hints → returns the LAST one', () => {
    const text =
      'To resume, run:\n  cd /home/tom/one && claude --resume 11111111-1111-4111-8111-111111111111\n' +
      'later output\n' +
      'To resume, run:\n  cd /home/tom/two && claude --resume 22222222-2222-4222-8222-222222222222';
    const r = parseCrossCwdHint(text);
    expect(r).toEqual({
      cwd: '/home/tom/two',
      uuid: '22222222-2222-4222-8222-222222222222',
    });
  });

  test('three hints → still returns the LAST', () => {
    const text =
      'To resume, run: cd /a && claude --resume aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ' +
      'To resume, run: cd /b && claude --resume bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb ' +
      'To resume, run: cd /c && claude --resume cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const r = parseCrossCwdHint(text);
    expect(r?.cwd).toBe('/c');
    expect(r?.uuid).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  test('hint with `..` in path → null', () => {
    const text =
      'To resume, run: cd /home/tom/../etc && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('hint with `;` in path → null', () => {
    const text =
      'To resume, run: cd /home/tom;rm && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('hint with `$` in path → null', () => {
    const text =
      'To resume, run: cd /home/$USER && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('hint with backtick in path → null', () => {
    const text =
      'To resume, run: cd /home/`id` && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test("hint with single quote in path → null", () => {
    const text =
      "To resume, run: cd /home/o'tool && claude --resume 12345678-1234-4abc-89ab-1234567890ab";
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('hint with double quote in path → null', () => {
    const text =
      'To resume, run: cd /home/"q" && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('hint with pipe in path → null', () => {
    const text =
      'To resume, run: cd /home/a|b && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('hint with relative path → null', () => {
    const text =
      'To resume, run: cd projects/foo && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('hint with bare cwd (no slash) → null', () => {
    const text =
      'To resume, run: cd foo && claude --resume 12345678-1234-4abc-89ab-1234567890ab';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('malformed uuid (35 chars) does not match regex → null', () => {
    const text =
      'To resume, run: cd /home/tom && claude --resume 12345678-1234-4abc-89ab-1234567890a';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('uuid with wrong segment shape (no dashes) → null', () => {
    // Regex requires 36 chars of hex+dashes. A 36-char hex-only run still
    // matches the regex (the character class allows hex+dash but doesn't
    // enforce the 8-4-4-4-12 split), so the defensive shape check should
    // reject this.
    const text =
      'To resume, run: cd /home/tom && claude --resume 123456781234abcd89ab1234567890abcdef';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('valid hint with surrounding ANSI escape codes still matches', () => {
    const text =
      '\x1b[36mTo resume, run:\x1b[0m\n  \x1b[2mcd /tmp/work && claude --resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\x1b[0m';
    const r = parseCrossCwdHint(text);
    expect(r).toEqual({
      cwd: '/tmp/work',
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
  });

  test('last match is invalid → returns null (does NOT fall back to earlier valid)', () => {
    const text =
      'To resume, run: cd /home/tom/valid && claude --resume 11111111-1111-4111-8111-111111111111\n' +
      'To resume, run: cd /home/$USER && claude --resume 22222222-2222-4222-8222-222222222222';
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  // claude shell-quotes the cwd in its cross-cwd hint when the path
  // contains a char outside [A-Za-z0-9_./:=@+,-] (its O4 builder). The
  // emitted command then looks like:
  //   cd '/home/tom/my project' && claude --resume <uuid>
  // The exact text claude prints (verbatim from its binary's template).
  const claudeHint = (command: string): string =>
    [
      '',
      'This conversation is from a different directory.',
      '',
      'To resume, run:',
      `  ${command}`,
      '',
      '(Command copied to clipboard)',
      '',
    ].join('\n');

  test('quoted cwd with a space → unquoted and accepted', () => {
    const uuid = '12345678-1234-4abc-89ab-1234567890ab';
    const text = claudeHint(`cd '/home/tom/my project' && claude --resume ${uuid}`);
    const r = parseCrossCwdHint(text);
    expect(r).toEqual({
      cwd: '/home/tom/my project',
      uuid,
    });
  });

  test('quoted cwd containing an escaped single quote → unquoted', () => {
    // claude escapes an inner ' as '"'"' inside the single-quoted run.
    // Path: /home/tom/o'brien dir
    const uuid = '12345678-1234-4abc-89ab-1234567890ab';
    const text = claudeHint(
      `cd '/home/tom/o'"'"'brien dir' && claude --resume ${uuid}`,
    );
    const r = parseCrossCwdHint(text);
    expect(r).toEqual({
      cwd: "/home/tom/o'brien dir",
      uuid,
    });
  });

  test('bare cwd (no quoting needed) still works', () => {
    const uuid = '12345678-1234-4abc-89ab-1234567890ab';
    const text = claudeHint(`cd /home/tom/plain && claude --resume ${uuid}`);
    expect(parseCrossCwdHint(text)).toEqual({
      cwd: '/home/tom/plain',
      uuid,
    });
  });

  test('quoted cwd with a $ char → accepted (real filename byte claude quoted)', () => {
    // claude quotes precisely because the path has a char outside its
    // bare-safe set; $ in a quoted run is a legitimate filename byte, not
    // injection — the dest is handed to Bun.spawn as cwd, never to a shell.
    const uuid = '12345678-1234-4abc-89ab-1234567890ab';
    const text = claudeHint(`cd '/home/tom/$weird dir' && claude --resume ${uuid}`);
    expect(parseCrossCwdHint(text)).toEqual({
      cwd: '/home/tom/$weird dir',
      uuid,
    });
  });

  test('quoted cwd with a `..` traversal segment → null', () => {
    // The `..` and absolute-path checks still apply to quoted paths.
    const uuid = '12345678-1234-4abc-89ab-1234567890ab';
    const text = claudeHint(`cd '/home/tom/../etc bad' && claude --resume ${uuid}`);
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('quoted relative path → null', () => {
    const uuid = '12345678-1234-4abc-89ab-1234567890ab';
    const text = claudeHint(`cd 'rel ative/dir' && claude --resume ${uuid}`);
    expect(parseCrossCwdHint(text)).toBeNull();
  });

  test('realistic claude output fixture (plain-text form, older claude)', () => {
    // Plain-text "To resume, run:" / cd / --resume sequence. Older claude
    // versions emit the hint line with literal spaces; current 2.1.x emits
    // CHA escapes between the words (see the #210 cases below). Both must
    // parse — keep this plain-text coverage green.
    const text = [
      'This conversation is from a different directory.',
      '',
      'To resume, run:',
      '  cd /home/tom/src/myproject && claude --resume 9f8e7d6c-5b4a-4321-8765-abcdef012345',
      '',
      '(or press Ctrl-D to exit)',
    ].join('\n');
    const r = parseCrossCwdHint(text);
    expect(r).toEqual({
      cwd: '/home/tom/src/myproject',
      uuid: '9f8e7d6c-5b4a-4321-8765-abcdef012345',
    });
  });

  // Issue #210. claude 2.1.161 renders the cross-project dialog with Ink,
  // which positions each word using a CHA escape (`ESC [ <n> G`) IN PLACE OF
  // the inter-word space, with `\r\r\n` line endings. So the raw ring-buffer
  // bytes contain no literal space between `cd` and the path, nor between
  // the path and `&&` — the older `realistic claude output fixture` above
  // assumed plain ASCII and is wrong for this version. parseCrossCwdHint
  // must strip the escapes (mapping them to a word boundary) before HINT_RE
  // runs, or the hint never parses and fnc exits without relaunching.
  const RAW_FIXTURE = readFileSync(
    join(import.meta.dir, '..', 'fixtures', 'claude-crosscwd-2.1.161.raw'),
  );

  test('#210: real 2.1.161 picker bytes (Uint8Array → decode) extract dest+uuid', () => {
    // The EXACT 12041 bytes of a real picker session captured against
    // claude 2.1.161 (claude --resume → Ctrl-A all-projects → pick a
    // cross-dir session → claude exits), decoded the way the ring buffer
    // decodes its snapshot.
    const text = new TextDecoder().decode(RAW_FIXTURE);
    const r = parseCrossCwdHint(text);
    expect(r).toEqual({
      cwd: '/home/tom/.config/fnclaude/noop',
      uuid: '1c494eae-b982-44dd-b40c-f4b1c86b6acc',
    });
  });

  test('#210: hand-written CHA-escaped hint (general, not tied to capture width)', () => {
    // Same CHA-escaped shape with DIFFERENT column numbers than the 220-col
    // capture — guards against a fix that matches the capture's specific
    // escape positions rather than normalizing escapes generally.
    const uuid = 'abcdef01-2345-4678-89ab-cdef01234567';
    const text =
      'To\x1b[9Gresume,\x1b[40Grun:\r\r\n' +
      '\x1b[3Gcd\x1b[7G/home/tom/.config/fnclaude/noop\x1b[99G&&\x1b[120Gclaude\x1b[200G--resume\x1b[5G' +
      uuid +
      '\r\r\n';
    expect(parseCrossCwdHint(text)).toEqual({
      cwd: '/home/tom/.config/fnclaude/noop',
      uuid,
    });
  });
});
