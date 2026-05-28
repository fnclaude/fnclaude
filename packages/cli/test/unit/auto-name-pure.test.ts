import { describe, expect, test } from 'bun:test';

import {
  heuristicName,
  sanitizeLLMOutput,
  shouldAutoName,
} from '../../src/name/auto-name.ts';
import { parseArgs, type ParsedArgsOk } from '../../src/argv/parse.ts';

function parsed(args: string[]): ParsedArgsOk {
  const r = parseArgs(args);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r;
}

describe('shouldAutoName — gating conditions', () => {
  test('no `--` sentinel → false', () => {
    expect(shouldAutoName(parsed(['--verbose']))).toBe(false);
  });

  test('`--` with no body → false', () => {
    expect(shouldAutoName(parsed(['--']))).toBe(false);
  });

  test('`--` with empty-string body → false', () => {
    expect(shouldAutoName(parsed(['--', '']))).toBe(false);
  });

  test('`--` with a non-empty body → true (baseline)', () => {
    expect(shouldAutoName(parsed(['--', 'hello']))).toBe(true);
  });

  test('--name <val> in passthrough → false', () => {
    expect(shouldAutoName(parsed(['--name', 'foo', '--', 'hello']))).toBe(false);
  });

  test('--name=val → false', () => {
    expect(shouldAutoName(parsed(['--name=foo', '--', 'hello']))).toBe(false);
  });

  test('-n <val> → false', () => {
    expect(shouldAutoName(parsed(['-n', 'foo', '--', 'hello']))).toBe(false);
  });

  test('-n=val → false', () => {
    expect(shouldAutoName(parsed(['-n=foo', '--', 'hello']))).toBe(false);
  });

  test('-p → false', () => {
    expect(shouldAutoName(parsed(['-p', '--', 'hello']))).toBe(false);
  });

  test('--print → false', () => {
    expect(shouldAutoName(parsed(['--print', '--', 'hello']))).toBe(false);
  });

  test('-r → false', () => {
    expect(shouldAutoName(parsed(['-r', '--', 'hello']))).toBe(false);
  });

  test('--resume → false', () => {
    expect(shouldAutoName(parsed(['--resume', '--', 'hello']))).toBe(false);
  });

  test('-r=<id> → false', () => {
    expect(shouldAutoName(parsed(['-r=abc', '--', 'hello']))).toBe(false);
  });

  test('--resume=<id> → false', () => {
    expect(shouldAutoName(parsed(['--resume=abc', '--', 'hello']))).toBe(false);
  });

  test('-c → false', () => {
    expect(shouldAutoName(parsed(['-c', '--', 'hello']))).toBe(false);
  });

  test('--continue → false', () => {
    expect(shouldAutoName(parsed(['--continue', '--', 'hello']))).toBe(false);
  });

  test('--from-pr → false', () => {
    expect(shouldAutoName(parsed(['--from-pr', '123', '--', 'hello']))).toBe(false);
  });

  test('--from-pr=123 → false', () => {
    expect(shouldAutoName(parsed(['--from-pr=123', '--', 'hello']))).toBe(false);
  });

  test('-P → false', () => {
    expect(shouldAutoName(parsed(['-P', '--', 'hello']))).toBe(false);
  });

  test('-P=123 → false', () => {
    expect(shouldAutoName(parsed(['-P=123', '--', 'hello']))).toBe(false);
  });

  test('multiple non-empty body tokens → true', () => {
    expect(shouldAutoName(parsed(['--', 'fix', 'the', 'bug']))).toBe(true);
  });
});

describe('sanitizeLLMOutput — slug cleanup', () => {
  test('plain lowercase preserved', () => {
    expect(sanitizeLLMOutput('fix-login-bug')).toBe('fix-login-bug');
  });

  test('uppercased → lower', () => {
    expect(sanitizeLLMOutput('Fix-Login')).toBe('fix-login');
  });

  test('leading/trailing whitespace trimmed', () => {
    expect(sanitizeLLMOutput('  hello  ')).toBe('hello');
  });

  test('whitespace runs → single dash', () => {
    expect(sanitizeLLMOutput('hello   world')).toBe('hello-world');
  });

  test('strip non-slug chars', () => {
    expect(sanitizeLLMOutput("can't-fix!")).toBe('cant-fix');
  });

  test('collapse multi-dash', () => {
    expect(sanitizeLLMOutput('a---b')).toBe('a-b');
  });

  test('trim leading/trailing dashes', () => {
    expect(sanitizeLLMOutput('---foo---')).toBe('foo');
  });

  test('cap to first 3 segments', () => {
    expect(sanitizeLLMOutput('a-b-c-d-e-f')).toBe('a-b-c');
  });

  test('quoted output stripped to slug', () => {
    expect(sanitizeLLMOutput('"fix-login"')).toBe('fix-login');
  });

  test('"Label: foo" prefix stripped (colon falls out)', () => {
    expect(sanitizeLLMOutput('Label: fix-login')).toBe('label-fix-login');
  });

  test('empty input → empty', () => {
    expect(sanitizeLLMOutput('')).toBe('');
  });

  test('only-bad-chars input → empty', () => {
    expect(sanitizeLLMOutput('!!!')).toBe('');
  });
});

describe('heuristicName — fallback name from prompt', () => {
  test('"fix the login bug" → fix-login-bug (stop words dropped)', () => {
    expect(heuristicName('fix the login bug')).toBe('fix-login-bug');
  });

  test('"add dark mode" → add-dark-mode', () => {
    expect(heuristicName('add dark mode')).toBe('add-dark-mode');
  });

  test('takes first 3 non-stop words', () => {
    expect(heuristicName('refactor the authentication subsystem for better testability')).toBe(
      'refactor-authentication-subsystem',
    );
  });

  test('strips non-alphanumeric within each word', () => {
    expect(heuristicName("don't crash on Ctrl+C")).toBe('dont-crash-ctrlc');
  });

  test('all stop words → "session"', () => {
    expect(heuristicName('the a is')).toBe('session');
  });

  test('empty input → "session"', () => {
    expect(heuristicName('')).toBe('session');
  });

  test('uppercase normalized to lower', () => {
    expect(heuristicName('FIX LOGIN BUG')).toBe('fix-login-bug');
  });

  test('punctuation-only words drop out', () => {
    expect(heuristicName('fix !!! bug')).toBe('fix-bug');
  });
});
