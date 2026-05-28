import { afterEach, describe, expect, test } from 'bun:test';

import { readArgv } from '../../src/argv/intake.ts';

const ORIGINAL_ENV = process.env.FNC_ARGS_JSON;
const ORIGINAL_ARGV = process.argv;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.FNC_ARGS_JSON;
  else process.env.FNC_ARGS_JSON = ORIGINAL_ENV;
  process.argv = ORIGINAL_ARGV;
});

describe('readArgv', () => {
  test('returns process.argv.slice(2) when FNC_ARGS_JSON is unset', () => {
    delete process.env.FNC_ARGS_JSON;
    process.argv = ['bun', '/path/to/fnc.js', 'opus', '--', 'say hi'];
    expect(readArgv()).toEqual(['opus', '--', 'say hi']);
  });

  test('returns parsed FNC_ARGS_JSON when set, ignoring process.argv', () => {
    process.env.FNC_ARGS_JSON = JSON.stringify(['sonnet', '--', 'do it']);
    process.argv = ['bun', '/path/to/fnc.js', 'noise']; // should be ignored
    expect(readArgv()).toEqual(['sonnet', '--', 'do it']);
  });

  test('FNC_ARGS_JSON preserves the literal "--" sentinel that bun strips from process.argv', () => {
    process.env.FNC_ARGS_JSON = JSON.stringify(['--', 'prompt-body']);
    expect(readArgv()).toEqual(['--', 'prompt-body']);
  });

  test('empty argv: FNC_ARGS_JSON unset, process.argv has only runtime + script', () => {
    delete process.env.FNC_ARGS_JSON;
    process.argv = ['bun', '/path/to/fnc.js'];
    expect(readArgv()).toEqual([]);
  });

  test('empty argv: FNC_ARGS_JSON set to []', () => {
    process.env.FNC_ARGS_JSON = '[]';
    expect(readArgv()).toEqual([]);
  });

  test('malformed FNC_ARGS_JSON falls back to process.argv with a stderr warning', () => {
    process.env.FNC_ARGS_JSON = 'not-valid-json';
    process.argv = ['bun', '/path/to/fnc.js', 'fallback'];
    // Don't actually assert on the stderr write (Bun.write to stderr is async-y);
    // the contract is: it MUST NOT throw, and the fallback applies.
    expect(readArgv()).toEqual(['fallback']);
  });

  test('FNC_ARGS_JSON that parses to a non-array falls back to process.argv', () => {
    process.env.FNC_ARGS_JSON = JSON.stringify({ not: 'an array' });
    process.argv = ['bun', '/path/to/fnc.js', 'fallback'];
    expect(readArgv()).toEqual(['fallback']);
  });

  test('FNC_ARGS_JSON that parses to an array with non-string elements falls back', () => {
    process.env.FNC_ARGS_JSON = JSON.stringify(['ok', 42, 'mixed']);
    process.argv = ['bun', '/path/to/fnc.js', 'fallback'];
    expect(readArgv()).toEqual(['fallback']);
  });
});
