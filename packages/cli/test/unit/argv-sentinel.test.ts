import { describe, expect, test } from 'bun:test';

import {
  findPromptSentinel,
  hasPromptBody,
  promptBody,
  preSentinelArgs,
} from '../../src/argv/sentinel.ts';

describe('findPromptSentinel', () => {
  test('returns -1 when no sentinel', () => {
    expect(findPromptSentinel([])).toBe(-1);
    expect(findPromptSentinel(['--verbose'])).toBe(-1);
    expect(findPromptSentinel(['--verbose', '--name', 'foo'])).toBe(-1);
  });

  test('returns the index of the first `--`', () => {
    expect(findPromptSentinel(['--'])).toBe(0);
    expect(findPromptSentinel(['--verbose', '--', 'say hi'])).toBe(1);
  });

  test('first `--` wins when multiple appear (downstream `--` is prompt content)', () => {
    expect(findPromptSentinel(['--', 'foo', '--', 'bar'])).toBe(0);
  });

  test('distinguishes `--` from `--name`, `--no-tmux`, etc. (exact match only)', () => {
    expect(findPromptSentinel(['--name', '--no-tmux', '--', 'p'])).toBe(2);
  });
});

describe('promptBody', () => {
  test('returns [] when no sentinel', () => {
    expect(promptBody([])).toEqual([]);
    expect(promptBody(['--verbose'])).toEqual([]);
  });

  test('returns everything after the sentinel', () => {
    expect(promptBody(['--', 'say hi'])).toEqual(['say hi']);
    expect(promptBody(['--verbose', '--', 'word1', 'word2'])).toEqual(['word1', 'word2']);
  });

  test('post-sentinel `--` is preserved as prompt content', () => {
    expect(promptBody(['--', 'foo', '--', 'bar'])).toEqual(['foo', '--', 'bar']);
  });

  test('empty body: `--` with nothing after', () => {
    expect(promptBody(['--'])).toEqual([]);
    expect(promptBody(['--verbose', '--'])).toEqual([]);
  });
});

describe('hasPromptBody', () => {
  test('false when no sentinel', () => {
    expect(hasPromptBody([])).toBe(false);
    expect(hasPromptBody(['--verbose'])).toBe(false);
  });

  test('false when sentinel present but no content after', () => {
    expect(hasPromptBody(['--'])).toBe(false);
    expect(hasPromptBody(['--verbose', '--'])).toBe(false);
  });

  test('true when sentinel + at least one token after', () => {
    expect(hasPromptBody(['--', 'say hi'])).toBe(true);
    expect(hasPromptBody(['--verbose', '--', 'p'])).toBe(true);
  });
});

describe('preSentinelArgs', () => {
  test('returns full input when no sentinel', () => {
    expect(preSentinelArgs([])).toEqual([]);
    expect(preSentinelArgs(['--verbose', '--name', 'foo'])).toEqual(['--verbose', '--name', 'foo']);
  });

  test('returns slice up to but not including the sentinel', () => {
    expect(preSentinelArgs(['--verbose', '--', 'say hi'])).toEqual(['--verbose']);
    expect(preSentinelArgs(['--', 'say hi'])).toEqual([]);
  });

  test('returns up to FIRST sentinel only', () => {
    expect(preSentinelArgs(['--name', 'a', '--', 'b', '--', 'c'])).toEqual(['--name', 'a']);
  });
});
