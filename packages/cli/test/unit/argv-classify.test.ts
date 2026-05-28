import { describe, expect, test } from 'bun:test';

import {
  canonicalSubcommand,
  classifyToken,
  EFFORTS,
  MODELS,
  SUBCOMMAND_ALIASES,
} from '../../src/argv/classify.ts';

describe('classifyToken', () => {
  describe('flag-shaped', () => {
    test.each([
      '-h',
      '-v',
      '-w',
      '--help',
      '--version',
      '--name',
      '-BVC', // collapsed shorts
      '--',
      '-', // bare dash
      '--mcp-config',
    ])('%s is flag', (tok) => {
      expect(classifyToken(tok)).toBe('flag');
    });
  });

  describe('model magic', () => {
    test.each(['opus', 'sonnet', 'haiku'])('%s is model', (tok) => {
      expect(classifyToken(tok)).toBe('model');
    });

    // Case sensitivity: Go canonical only matches lowercase exact.
    test.each(['Opus', 'OPUS', 'Sonnet'])('%s is NOT a model (case-sensitive)', (tok) => {
      expect(classifyToken(tok)).toBe('positional');
    });
  });

  describe('effort magic', () => {
    test.each(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])('%s is effort', (tok) => {
      expect(classifyToken(tok)).toBe('effort');
    });
  });

  describe('subcommand magic', () => {
    test.each(['resume', 'res', 'continue', 'con', 'fork', 'fk'])('%s is subcommand', (tok) => {
      expect(classifyToken(tok)).toBe('subcommand');
    });
  });

  describe('positional', () => {
    test.each([
      '~/src/proj',
      '/abs/path',
      './opus', // escape-via-prefix per PRD
      './haiku',
      'arch-setup',
      'fnclaude@fnrhombus',
      'fnrhombus/fnclaude',
      'gh:fnrhombus/fnclaude',
      'https://github.com/fnrhombus/fnclaude',
      'git@github.com:fnrhombus/fnclaude.git', // SSH URL — no leading `-`
      'say hi',
      '',
      '42',
    ])('%s is positional', (tok) => {
      expect(classifyToken(tok)).toBe('positional');
    });
  });
});

describe('exported alphabets', () => {
  test('MODELS contains exactly opus/sonnet/haiku', () => {
    expect(MODELS).toEqual(['opus', 'sonnet', 'haiku']);
  });

  test('EFFORTS contains the six supported levels', () => {
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
  });

  test('SUBCOMMAND_ALIASES maps every alias to its canonical', () => {
    expect(SUBCOMMAND_ALIASES).toEqual({
      resume: 'resume',
      res: 'resume',
      continue: 'continue',
      con: 'continue',
      fork: 'fork',
      fk: 'fork',
    });
  });
});

describe('canonicalSubcommand', () => {
  test('returns canonical for each alias', () => {
    expect(canonicalSubcommand('resume')).toBe('resume');
    expect(canonicalSubcommand('res')).toBe('resume');
    expect(canonicalSubcommand('continue')).toBe('continue');
    expect(canonicalSubcommand('con')).toBe('continue');
    expect(canonicalSubcommand('fork')).toBe('fork');
    expect(canonicalSubcommand('fk')).toBe('fork');
  });

  test('returns null for non-subcommand tokens', () => {
    expect(canonicalSubcommand('opus')).toBeNull();
    expect(canonicalSubcommand('~/src/proj')).toBeNull();
    expect(canonicalSubcommand('--help')).toBeNull();
    expect(canonicalSubcommand('')).toBeNull();
  });
});
