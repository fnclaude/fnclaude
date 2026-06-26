import { describe, expect, test } from 'bun:test';

import { autoName, type AutoNameOptions } from '../../src/name/auto-name';

async function run(opts: Partial<AutoNameOptions> & { prompt: string }): Promise<string> {
  return autoName({ timeoutMs: 1000, ...opts });
}

describe('autoName — without LLM', () => {
  test('no llmCall provided → heuristic', async () => {
    expect(await run({ prompt: 'fix the login bug' })).toBe('fix-login-bug');
  });

  test('no llmCall, empty prompt → "session"', async () => {
    expect(await run({ prompt: '' })).toBe('session');
  });
});

describe('autoName — with successful LLM', () => {
  test('LLM returns clean slug → used as-is', async () => {
    const r = await run({
      prompt: 'whatever',
      llmCall: async () => 'fix-login-bug',
    });
    expect(r).toBe('fix-login-bug');
  });

  test('LLM returns messy output → sanitized', async () => {
    const r = await run({
      prompt: 'whatever',
      llmCall: async () => 'Label: Fix-Login!!',
    });
    expect(r).toBe('label-fix-login');
  });

  test('LLM returns more than 3 segments → capped to 3', async () => {
    const r = await run({
      prompt: 'whatever',
      llmCall: async () => 'a-b-c-d-e',
    });
    expect(r).toBe('a-b-c');
  });
});

describe('autoName — LLM failure modes fall back to heuristic', () => {
  test('LLM throws → heuristic', async () => {
    const r = await run({
      prompt: 'add dark mode',
      llmCall: async () => {
        throw new Error('no api key');
      },
    });
    expect(r).toBe('add-dark-mode');
  });

  test('LLM returns empty → heuristic', async () => {
    const r = await run({
      prompt: 'refactor auth module',
      llmCall: async () => '',
    });
    expect(r).toBe('refactor-auth-module');
  });

  test('LLM returns only-bad-chars (sanitizes to empty) → heuristic', async () => {
    const r = await run({
      prompt: 'fix login flow',
      llmCall: async () => '!!!',
    });
    expect(r).toBe('fix-login-flow');
  });
});

describe('autoName — timeout', () => {
  test('LLM exceeds timeout → heuristic', async () => {
    const r = await autoName({
      prompt: 'add dark mode',
      timeoutMs: 30,
      llmCall: () => new Promise<string>((resolve) => setTimeout(() => resolve('too-late'), 200)),
    });
    expect(r).toBe('add-dark-mode');
  });

  test('LLM resolves within timeout → LLM wins', async () => {
    const r = await autoName({
      prompt: 'whatever',
      timeoutMs: 500,
      llmCall: () => new Promise<string>((resolve) => setTimeout(() => resolve('in-time'), 10)),
    });
    expect(r).toBe('in-time');
  });
});
