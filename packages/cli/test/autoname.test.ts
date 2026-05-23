// Tests for autoname.ts — mirrors autoname_test.go from the Go reference.
//
// The Anthropic SDK is mocked via the injectable LlmClientFn seam; no real
// API calls are made.

import { describe, expect, test } from 'bun:test';
import {
  extractPrompt,
  generateName,
  heuristicName,
  sanitizeSlug,
  shouldAutoName,
  type LlmClientFn,
} from '../src/autoname.js';
import type { NameConfig } from '../src/config.js';

// ── shouldAutoName ────────────────────────────────────────────────────────────

describe('shouldAutoName', () => {
  const yes = (name: string, args: string[]) =>
    test(name, () => expect(shouldAutoName(args)).toBe(true));
  const no = (name: string, args: string[]) =>
    test(name, () => expect(shouldAutoName(args)).toBe(false));

  yes('has separator + prompt', ['--', 'fix the bug']);
  yes('flags before separator', ['--model', 'sonnet', '--', 'do something']);
  yes('multiple tokens after sep', ['--', 'word1', 'word2']);

  no('no separator', ['fix the bug']);
  no('separator with no non-empty tokens', ['--']);
  no('separator with only empty tokens', ['--', '', '']);
  no('has --name flag', ['--name', 'my-session', '--', 'prompt']);
  no('has --name= form', ['--name=my-session', '--', 'prompt']);
  no('has -n flag', ['-n', 'my-session', '--', 'prompt']);
  no('has -n= form', ['-n=my-session', '--', 'prompt']);
  no('has --print flag', ['--print', '--', 'prompt']);
  no('has -p flag', ['-p', '--', 'prompt']);
  no('has --resume flag', ['--resume', 'abc', '--', 'prompt']);
  no('has --resume= form', ['--resume=abc', '--', 'prompt']);
  no('has -r flag', ['-r', 'abc', '--', 'prompt']);
  no('has -r= form', ['-r=abc', '--', 'prompt']);
  no('has --continue flag', ['--continue', '--', 'prompt']);
  no('has -c flag', ['-c', '--', 'prompt']);
  no('has --from-pr flag', ['--from-pr', '42', '--', 'prompt']);
  no('has --from-pr= form', ['--from-pr=42', '--', 'prompt']);
  no('has -P flag', ['-P', '42', '--', 'prompt']);
  no('has -P= form', ['-P=42', '--', 'prompt']);
});

// ── extractPrompt ─────────────────────────────────────────────────────────────

describe('extractPrompt', () => {
  test('returns first non-empty token after --', () => {
    expect(extractPrompt(['--', 'fix the bug'])).toBe('fix the bug');
  });
  test('skips empty tokens before first non-empty', () => {
    expect(extractPrompt(['--', '', 'second'])).toBe('second');
  });
  test('no separator → empty string', () => {
    expect(extractPrompt(['fix the bug'])).toBe('');
  });
  test('separator with no tokens → empty string', () => {
    expect(extractPrompt(['--'])).toBe('');
  });
  test('separator with only empty tokens → empty string', () => {
    expect(extractPrompt(['--', '', ''])).toBe('');
  });
});

// ── heuristicName ─────────────────────────────────────────────────────────────

describe('heuristicName', () => {
  test('basic three words', () => {
    expect(heuristicName('fix the login bug')).toBe('fix-login-bug');
  });
  test('stop words stripped', () => {
    expect(heuristicName('please can you do this')).toBe('you');
  });
  test('caps lowercased', () => {
    expect(heuristicName('Add Dark Mode')).toBe('add-dark-mode');
  });
  test('non-alphanum stripped', () => {
    expect(heuristicName('fix the bug!')).toBe('fix-bug');
  });
  test('only stop words → "session"', () => {
    expect(heuristicName('the a an')).toBe('session');
  });
  test('empty string → "session"', () => {
    expect(heuristicName('')).toBe('session');
  });
  test('caps to at most 3 segments', () => {
    expect(heuristicName('refactor auth middleware handler')).toBe(
      'refactor-auth-middleware',
    );
  });
});

// ── sanitizeSlug ──────────────────────────────────────────────────────────────

describe('sanitizeSlug', () => {
  test('already clean', () => {
    expect(sanitizeSlug('fix-login-bug')).toBe('fix-login-bug');
  });
  test('leading/trailing whitespace stripped', () => {
    expect(sanitizeSlug('  add-dark-mode  ')).toBe('add-dark-mode');
  });
  test('spaces become dashes', () => {
    expect(sanitizeSlug('add dark mode')).toBe('add-dark-mode');
  });
  test('uppercased → lowercased', () => {
    expect(sanitizeSlug('Fix-Login-Bug')).toBe('fix-login-bug');
  });
  test('non-alphanumeric non-dash stripped', () => {
    expect(sanitizeSlug("'fix-login-bug'")).toBe('fix-login-bug');
  });
  test('multi-dash collapsed', () => {
    expect(sanitizeSlug('fix--login--bug')).toBe('fix-login-bug');
  });
  test('leading/trailing dashes stripped', () => {
    expect(sanitizeSlug('-fix-login-bug-')).toBe('fix-login-bug');
  });
  test('4-segment input capped at 3', () => {
    expect(sanitizeSlug('fix-login-bug-now')).toBe('fix-login-bug');
  });
  test('empty string → empty string', () => {
    expect(sanitizeSlug('')).toBe('');
  });
  test('only non-slug chars → empty string', () => {
    expect(sanitizeSlug("'''")).toBe('');
  });
});

// ── generateName ──────────────────────────────────────────────────────────────

const testCfg: NameConfig = {
  model: 'claude-haiku-4-5',
  timeout: 3_000,
  quietMissingAPIKey: false,
};

describe('generateName', () => {
  test('uses llmFn result when clean', async () => {
    const llmFn: LlmClientFn = async () => 'fix-login-bug';
    const name = await generateName('fix the login bug', testCfg, 'test-key', llmFn);
    expect(name).toBe('fix-login-bug');
  });

  test('sanitizes raw LLM output', async () => {
    const llmFn: LlmClientFn = async () => "'Add Dark Mode'";
    const name = await generateName('add dark mode', testCfg, 'test-key', llmFn);
    expect(name).toBe('add-dark-mode');
  });

  test('falls back to heuristic when llmFn throws', async () => {
    const llmFn: LlmClientFn = async () => {
      throw new Error('API error');
    };
    const name = await generateName('fix the login bug', testCfg, 'test-key', llmFn);
    expect(name).toBe('fix-login-bug');
  });

  test('falls back to heuristic when sanitized result is empty', async () => {
    const llmFn: LlmClientFn = async () => "'''"; // all non-slug
    const name = await generateName('fix the login bug', testCfg, 'test-key', llmFn);
    expect(name).toBe('fix-login-bug');
  });

  test('respects timeout: fast llmFn resolves in time', async () => {
    const fastCfg: NameConfig = { ...testCfg, timeout: 2_000 };
    const llmFn: LlmClientFn = async () => 'fast-name';
    const name = await generateName('prompt', fastCfg, 'key', llmFn);
    expect(name).toBe('fast-name');
  });

  test('times out and falls back to heuristic', async () => {
    // Use a very short timeout so the slow llmFn is reliably aborted.
    const shortCfg: NameConfig = { ...testCfg, timeout: 20 };
    const llmFn: LlmClientFn = (_model, _prompt, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    const name = await generateName('fix the bug', shortCfg, 'key', llmFn);
    // heuristic: fix + bug (stop word "the" is skipped)
    expect(name).toBe('fix-bug');
  });

  test('llmFn receives model and prompt', async () => {
    let gotModel = '';
    let gotPrompt = '';
    const llmFn: LlmClientFn = async (model, prompt) => {
      gotModel = model;
      gotPrompt = prompt;
      return 'ok';
    };
    await generateName('my-prompt', testCfg, 'key', llmFn);
    expect(gotModel).toBe('claude-haiku-4-5');
    expect(gotPrompt).toBe('my-prompt');
  });
});
