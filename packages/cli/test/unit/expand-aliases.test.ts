import { describe, expect, test } from 'bun:test';

import { parseArgs, type ParsedArgsOk } from '../../src/argv/parse';
import { expandAliases } from '../../src/argv/expand';

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

  test('fable → --model fable', () => {
    expect(expandAliases(parsed(['fable']))).toEqual(['--model', 'fable']);
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

describe('expandAliases — versioned model aliases resolve to full IDs', () => {
  test('opus5 → --model claude-opus-5', () => {
    expect(expandAliases(parsed(['opus5']))).toEqual(['--model', 'claude-opus-5']);
  });

  test('opus46 → --model claude-opus-4-6', () => {
    expect(expandAliases(parsed(['opus46']))).toEqual(['--model', 'claude-opus-4-6']);
  });

  test('sonnet5 → --model claude-sonnet-5', () => {
    expect(expandAliases(parsed(['sonnet5']))).toEqual(['--model', 'claude-sonnet-5']);
  });

  test('fable5 → --model claude-fable-5', () => {
    expect(expandAliases(parsed(['fable5']))).toEqual(['--model', 'claude-fable-5']);
  });

  test('haiku45 → --model claude-haiku-4-5-20251001', () => {
    expect(expandAliases(parsed(['haiku45']))).toEqual(['--model', 'claude-haiku-4-5-20251001']);
  });

  test('opus46 + effort → resolved model + effort', () => {
    expect(expandAliases(parsed(['opus46', 'high']))).toEqual([
      '--model',
      'claude-opus-4-6',
      '--effort',
      'high',
    ]);
  });

  test('sonnet5 + subcommand', () => {
    expect(expandAliases(parsed(['sonnet5', 'resume']))).toEqual([
      '--model',
      'claude-sonnet-5',
      '--resume',
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

describe('expandAliases — ultracode effort (delivered via initial prompt, not --effort)', () => {
  // claude's --effort flag does NOT accept 'ultracode'; it rides as the
  // `/effort ultracode` initial-prompt slash command (assembled in main.ts).
  // expandAliases must therefore emit the implied --model opus but NO
  // --effort and NOT leak the literal 'ultracode' token.
  test('bare ultracode → --model opus only (no --effort)', () => {
    expect(expandAliases(parsed(['ultracode']))).toEqual(['--model', 'opus']);
  });

  test('ultracode with passthrough → --model opus + passthrough, no --effort', () => {
    expect(expandAliases(parsed(['ultracode', '--', 'hi']))).toEqual([
      '--model',
      'opus',
      '--',
      'hi',
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

describe('expandAliases — subcommand expansion (§4.4)', () => {
  test('resume → --resume', () => {
    expect(expandAliases(parsed(['resume']))).toEqual(['--resume']);
  });

  test('res (short) → --resume', () => {
    expect(expandAliases(parsed(['res']))).toEqual(['--resume']);
  });

  test('continue → --continue', () => {
    expect(expandAliases(parsed(['continue']))).toEqual(['--continue']);
  });

  test('con (short) → --continue', () => {
    expect(expandAliases(parsed(['con']))).toEqual(['--continue']);
  });

  test('fork → --resume --fork-session', () => {
    expect(expandAliases(parsed(['fork']))).toEqual(['--resume', '--fork-session']);
  });

  test('fk (short) → --resume --fork-session', () => {
    expect(expandAliases(parsed(['fk']))).toEqual(['--resume', '--fork-session']);
  });

  test('subcommand AFTER magic — opus resume', () => {
    expect(expandAliases(parsed(['opus', 'resume']))).toEqual([
      '--model',
      'opus',
      '--resume',
    ]);
  });

  test('subcommand BEFORE magic — resume opus (subcommand is position-independent)', () => {
    expect(expandAliases(parsed(['resume', 'opus']))).toEqual([
      '--model',
      'opus',
      '--resume',
    ]);
  });

  test('model + effort + subcommand — all three in order', () => {
    expect(expandAliases(parsed(['opus', 'high', 'fork']))).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
      '--resume',
      '--fork-session',
    ]);
  });

  test('subcommand + passthrough flags preserved', () => {
    expect(expandAliases(parsed(['resume', '--', 'hello']))).toEqual([
      '--resume',
      '--',
      'hello',
    ]);
  });
});
