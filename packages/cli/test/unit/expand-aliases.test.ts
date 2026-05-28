import { describe, expect, test } from 'bun:test';

import { parseArgs, type ParsedArgsOk } from '../../src/argv/parse.ts';
import { expandAliases } from '../../src/argv/expand.ts';

// Helper: parse + assert ok, return the parsed args.
function parsed(args: string[]): ParsedArgsOk {
  const r = parseArgs(args);
  if (!r.ok) throw new Error(`unexpected parse error: ${r.error}`);
  return r;
}

describe('expandAliases — model alias (§4.1)', () => {
  test('opus first-positional → --model opus prepended', () => {
    expect(expandAliases(parsed(['opus']))).toEqual(['--model', 'opus']);
  });

  test('sonnet → --model sonnet', () => {
    expect(expandAliases(parsed(['sonnet']))).toEqual(['--model', 'sonnet']);
  });

  test('haiku → --model haiku', () => {
    expect(expandAliases(parsed(['haiku']))).toEqual(['--model', 'haiku']);
  });

  test('explicit --model in passthrough also present (last-wins is claude\'s problem)', () => {
    expect(expandAliases(parsed(['opus', '--', 'hi']))).toEqual([
      '--model',
      'opus',
      '--',
      'hi',
    ]);
  });
});

describe('expandAliases — effort alias (§4.2)', () => {
  test('high after model → both flags', () => {
    expect(expandAliases(parsed(['opus', 'high']))).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
  });

  test('all effort levels emit their value', () => {
    for (const lv of ['low', 'medium', 'high', 'xhigh', 'max', 'auto']) {
      expect(expandAliases(parsed(['opus', lv]))).toEqual([
        '--model',
        'opus',
        '--effort',
        lv,
      ]);
    }
  });
});

describe('expandAliases — bare effort → opus injection (§4.3)', () => {
  test('bare high → --model opus + --effort high', () => {
    expect(expandAliases(parsed(['high']))).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
  });

  test('bare auto → opus + auto', () => {
    expect(expandAliases(parsed(['auto']))).toEqual([
      '--model',
      'opus',
      '--effort',
      'auto',
    ]);
  });
});

describe('expandAliases — no magic captured', () => {
  test('empty argv → empty', () => {
    expect(expandAliases(parsed([]))).toEqual([]);
  });

  test('only a positional path → no magic flags, path stays as firstPath (not in passthrough)', () => {
    expect(expandAliases(parsed(['/some/dir']))).toEqual([]);
  });

  test('plain flag passthrough preserved verbatim', () => {
    expect(expandAliases(parsed(['--verbose']))).toEqual(['--verbose']);
  });

  test('flag + sentinel + body preserved verbatim', () => {
    expect(expandAliases(parsed(['--verbose', '--', 'hi']))).toEqual([
      '--verbose',
      '--',
      'hi',
    ]);
  });
});

describe('expandAliases — magic + existing passthrough flags', () => {
  test('opus high --foo bar → magic flags first, passthrough after', () => {
    expect(expandAliases(parsed(['opus', 'high', '--foo', 'bar']))).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
      '--foo',
      'bar',
    ]);
  });

  test('positional path is NOT in passthrough; only flags', () => {
    expect(expandAliases(parsed(['opus', '/some/path', '--foo']))).toEqual([
      '--model',
      'opus',
      '--foo',
    ]);
  });
});
