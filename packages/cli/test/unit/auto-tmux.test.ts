import { describe, expect, test } from 'bun:test';

import {
  shouldInjectTmux,
  type AutoTmuxArgs,
} from '../../src/worktree/auto-tmux.ts';

function args(overrides: Partial<AutoTmuxArgs> = {}): AutoTmuxArgs {
  return {
    configAutoTmux: 'worktree',
    worktreeSet: true,
    worktreeMatched: false,
    noTmux: false,
    passthrough: [],
    ...overrides,
  };
}

describe('shouldInjectTmux — happy path', () => {
  test('all conditions met → true', () => {
    expect(shouldInjectTmux(args())).toBe(true);
  });
});

describe('shouldInjectTmux — config gating', () => {
  test('config undefined → false', () => {
    expect(shouldInjectTmux(args({ configAutoTmux: undefined }))).toBe(false);
  });
  test('config "never" → false', () => {
    expect(shouldInjectTmux(args({ configAutoTmux: 'never' }))).toBe(false);
  });
  test('config unknown string → false', () => {
    expect(shouldInjectTmux(args({ configAutoTmux: 'always-please' }))).toBe(false);
  });
});

describe('shouldInjectTmux — worktree gating', () => {
  test('worktreeSet=false → false (user did not ask for a worktree)', () => {
    expect(shouldInjectTmux(args({ worktreeSet: false }))).toBe(false);
  });
  test('worktreeMatched=true → false (existing worktree, no creation)', () => {
    expect(shouldInjectTmux(args({ worktreeMatched: true }))).toBe(false);
  });
});

describe('shouldInjectTmux — explicit escape hatches', () => {
  test('--no-tmux flag set → false', () => {
    expect(shouldInjectTmux(args({ noTmux: true }))).toBe(false);
  });
  test('--tmux already in passthrough → false', () => {
    expect(shouldInjectTmux(args({ passthrough: ['--tmux'] }))).toBe(false);
  });
  test('--tmux=<val> already in passthrough → false', () => {
    expect(shouldInjectTmux(args({ passthrough: ['--tmux=session'] }))).toBe(false);
  });
  test('--tmux somewhere deep in passthrough → false', () => {
    expect(shouldInjectTmux(args({ passthrough: ['--verbose', '--tmux', '--', 'hi'] }))).toBe(false);
  });
});

describe('shouldInjectTmux — pass-through edge cases', () => {
  test('similarly-named flag (--no-tmux) in passthrough does NOT block', () => {
    // Note: --no-tmux is fnclaude-eaten by parser, so it'd never appear in
    // passthrough; but defensive check.
    expect(shouldInjectTmux(args({ passthrough: ['--something-tmux'] }))).toBe(true);
  });
  test('empty passthrough OK', () => {
    expect(shouldInjectTmux(args({ passthrough: [] }))).toBe(true);
  });
});
