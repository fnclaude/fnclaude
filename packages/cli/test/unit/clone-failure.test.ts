import { describe, expect, test } from 'bun:test';

import { isRepoNotFoundError } from '../../src/repo/clone-failure';

describe('isRepoNotFoundError', () => {
  test('true for GraphQL "Could not resolve to a Repository"', () => {
    const stderr =
      "GraphQL: Could not resolve to a Repository with the name 'rhombus-toolkit/ioc'.";
    expect(isRepoNotFoundError(stderr)).toBe(true);
  });

  test('true for "Repository not found"', () => {
    expect(isRepoNotFoundError('remote: Repository not found.')).toBe(true);
    expect(isRepoNotFoundError('Repository not found')).toBe(true);
  });

  test('false for an auth error', () => {
    const stderr =
      'To get started with GitHub CLI, please run: gh auth login\nerror: not authenticated';
    expect(isRepoNotFoundError(stderr)).toBe(false);
  });

  test('false for a network error', () => {
    const stderr =
      'dial tcp: lookup api.github.com: no such host\nfailed to connect';
    expect(isRepoNotFoundError(stderr)).toBe(false);
  });

  test('false for empty stderr', () => {
    expect(isRepoNotFoundError('')).toBe(false);
  });
});
