import { describe, expect, test } from 'bun:test';

import { isNotFoundNoiseLine } from '../../src/repo/gh-runner.ts';

describe('isNotFoundNoiseLine', () => {
  test('true for the GraphQL not-found line', () => {
    expect(
      isNotFoundNoiseLine(
        "GraphQL: Could not resolve to a Repository with the name 'fnclaude/fnstatus'. (repository)",
      ),
    ).toBe(true);
  });

  test('true for "Repository not found" variants', () => {
    expect(isNotFoundNoiseLine('remote: Repository not found')).toBe(true);
    expect(isNotFoundNoiseLine('ERROR: Repository not found.')).toBe(true);
  });

  test('false for normal git progress lines', () => {
    expect(isNotFoundNoiseLine("Cloning into '/home/tom/src/foo'...")).toBe(false);
    expect(isNotFoundNoiseLine('remote: Enumerating objects: 42, done.')).toBe(false);
  });
});
