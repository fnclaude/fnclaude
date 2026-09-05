import { describe, expect, test } from 'bun:test';

import {
  canonicalSubcommand,
  classifyToken,
  EFFORTS,
  MODEL_ALIASES,
  MODELS,
  resolveModel,
  SUBCOMMAND_ALIASES,
} from '../../src/argv/classify';

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
    test.each(['opus', 'sonnet', 'haiku', 'fable'])('%s is model (bare)', (tok) => {
      expect(classifyToken(tok)).toBe('model');
    });

    test.each(['opus5', 'opus46', 'sonnet5', 'fable5', 'haiku45'])('%s is model (versioned alias)', (tok) => {
      expect(classifyToken(tok)).toBe('model');
    });

    // Case sensitivity: Go canonical only matches lowercase exact.
    test.each(['Opus', 'OPUS', 'Sonnet', 'Opus5', 'OPUS46'])('%s is NOT a model (case-sensitive)', (tok) => {
      expect(classifyToken(tok)).toBe('positional');
    });
  });

  describe('effort magic', () => {
    test.each(['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'ultracode'])('%s is effort', (tok) => {
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
      'fnclaude@fnclaude',
      'fnclaude/fnclaude',
      'gh:fnclaude/fnclaude',
      'https://github.com/fnclaude/fnclaude',
      'git@github.com:fnclaude/fnclaude.git', // SSH URL — no leading `-`
      'say hi',
      '',
      '42',
    ])('%s is positional', (tok) => {
      expect(classifyToken(tok)).toBe('positional');
    });
  });
});

describe('exported alphabets', () => {
  test('MODELS contains exactly opus/sonnet/haiku/fable', () => {
    expect(MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  test('MODEL_ALIASES maps versioned shorthand to full model IDs', () => {
    expect(MODEL_ALIASES).toEqual({
      opus5: 'claude-opus-5',
      opus46: 'claude-opus-4-6',
      sonnet5: 'claude-sonnet-5',
      fable5: 'claude-fable-5',
      haiku45: 'claude-haiku-4-5-20251001',
    });
  });

  test('EFFORTS contains the supported levels incl. ultracode', () => {
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'ultracode']);
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

describe('resolveModel', () => {
  test('bare names pass through unchanged', () => {
    expect(resolveModel('opus')).toBe('opus');
    expect(resolveModel('sonnet')).toBe('sonnet');
    expect(resolveModel('haiku')).toBe('haiku');
    expect(resolveModel('fable')).toBe('fable');
  });

  test('versioned aliases resolve to full model IDs', () => {
    expect(resolveModel('opus5')).toBe('claude-opus-5');
    expect(resolveModel('opus46')).toBe('claude-opus-4-6');
    expect(resolveModel('sonnet5')).toBe('claude-sonnet-5');
    expect(resolveModel('fable5')).toBe('claude-fable-5');
    expect(resolveModel('haiku45')).toBe('claude-haiku-4-5-20251001');
  });

  test('unknown tokens pass through unchanged', () => {
    expect(resolveModel('claude-opus-5')).toBe('claude-opus-5');
    expect(resolveModel('whatever')).toBe('whatever');
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
