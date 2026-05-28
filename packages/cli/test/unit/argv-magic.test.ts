import { describe, expect, test } from 'bun:test';

import { scanMagic } from '../../src/argv/magic.ts';

describe('scanMagic — empty and trivial cases', () => {
  test('empty argv', () => {
    expect(scanMagic([])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: null,
      consumed: 0,
    });
  });

  test('no magic at position 1: single positional', () => {
    expect(scanMagic(['~/src/proj'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: null,
      consumed: 0,
    });
  });

  test('no magic at position 1: flag', () => {
    expect(scanMagic(['--help'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: null,
      consumed: 0,
    });
  });
});

describe('scanMagic — model and effort', () => {
  test('model only', () => {
    expect(scanMagic(['opus', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: null,
      subcommand: null,
      consumed: 1,
    });
  });

  test('model + effort', () => {
    expect(scanMagic(['opus', 'max', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'max',
      subcommand: null,
      consumed: 2,
    });
  });

  test('effort-only at position 1 implies opus (rewrite extension)', () => {
    expect(scanMagic(['max', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'max',
      subcommand: null,
      consumed: 1,
    });
  });

  test('effort-only "low" at position 1 implies opus', () => {
    expect(scanMagic(['low', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'low',
      subcommand: null,
      consumed: 1,
    });
  });

  test('"auto" is a valid effort (rewrite extension)', () => {
    expect(scanMagic(['opus', 'auto', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'auto',
      subcommand: null,
      consumed: 2,
    });
  });

  test('model + non-effort positional: magic stops at pos 2', () => {
    expect(scanMagic(['opus', '~/src/proj', 'max'])).toEqual({
      ok: true,
      model: 'opus',
      effort: null,
      subcommand: null,
      consumed: 1,
    });
  });

  test('model at pos 1, flag at pos 2: magic stops at flag', () => {
    expect(scanMagic(['opus', '--help'])).toEqual({
      ok: true,
      model: 'opus',
      effort: null,
      subcommand: null,
      consumed: 1,
    });
  });
});

describe('scanMagic — subcommands (order-independent, do not advance state)', () => {
  test('subcommand only at pos 1', () => {
    expect(scanMagic(['resume', '~/src/proj'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: 'resume',
      consumed: 1,
    });
  });

  test('subcommand + model + effort', () => {
    expect(scanMagic(['resume', 'opus', 'max', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'max',
      subcommand: 'resume',
      consumed: 3,
    });
  });

  test('model + subcommand + effort (subcommand between model and effort)', () => {
    expect(scanMagic(['opus', 'fork', 'max', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'max',
      subcommand: 'fork',
      consumed: 3,
    });
  });

  test('model + effort + subcommand', () => {
    expect(scanMagic(['opus', 'max', 'continue', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'max',
      subcommand: 'continue',
      consumed: 3,
    });
  });

  test('subcommand alias "res" canonicalizes to "resume"', () => {
    expect(scanMagic(['res', '~/src/proj'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: 'resume',
      consumed: 1,
    });
  });

  test('subcommand alias "con" canonicalizes to "continue"', () => {
    expect(scanMagic(['con', '~/src/proj'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: 'continue',
      consumed: 1,
    });
  });

  test('subcommand alias "fk" canonicalizes to "fork"', () => {
    expect(scanMagic(['fk', '~/src/proj'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: 'fork',
      consumed: 1,
    });
  });

  test('subcommand + effort-implies-opus', () => {
    expect(scanMagic(['resume', 'max', '~/src/proj'])).toEqual({
      ok: true,
      model: 'opus',
      effort: 'max',
      subcommand: 'resume',
      consumed: 2,
    });
  });

  test('two subcommands is an error', () => {
    expect(scanMagic(['resume', 'fork'])).toEqual({
      ok: false,
      error: 'fnc: only one of resume/continue/fork may be used per invocation',
    });
  });

  test('two subcommands via aliases is also an error', () => {
    expect(scanMagic(['res', 'fk', '~/src/proj'])).toEqual({
      ok: false,
      error: 'fnc: only one of resume/continue/fork may be used per invocation',
    });
  });

  test('subcommand after model + effort + subcommand is an error', () => {
    expect(scanMagic(['opus', 'max', 'resume', 'fork'])).toEqual({
      ok: false,
      error: 'fnc: only one of resume/continue/fork may be used per invocation',
    });
  });

  test('subcommand then non-magic positional: magic stops, sub still recorded', () => {
    expect(scanMagic(['resume', '~/src/proj', 'fork'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: 'resume',
      consumed: 1,
    });
  });
});

describe('scanMagic — flag-stops-magic boundary', () => {
  test('flag at pos 1: magic stops immediately', () => {
    expect(scanMagic(['--help', 'opus', 'max'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: null,
      consumed: 0,
    });
  });

  test('subcommand then flag: subcommand consumed, magic stops at flag', () => {
    expect(scanMagic(['resume', '--help'])).toEqual({
      ok: true,
      model: null,
      effort: null,
      subcommand: 'resume',
      consumed: 1,
    });
  });

  test('model then flag: model consumed, magic stops at flag', () => {
    expect(scanMagic(['opus', '--help'])).toEqual({
      ok: true,
      model: 'opus',
      effort: null,
      subcommand: null,
      consumed: 1,
    });
  });

  test('"--" sentinel stops magic too', () => {
    expect(scanMagic(['opus', '--', 'say hi'])).toEqual({
      ok: true,
      model: 'opus',
      effort: null,
      subcommand: null,
      consumed: 1,
    });
  });
});
