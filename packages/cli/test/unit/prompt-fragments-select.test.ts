import { describe, expect, test } from 'bun:test';

import {
  isInteractiveSession,
  selectFragments,
} from '../../src/prompts/select';

describe('isInteractiveSession', () => {
  test('empty passthrough → interactive', () => {
    expect(isInteractiveSession([])).toBe(true);
  });
  test('--verbose → interactive', () => {
    expect(isInteractiveSession(['--verbose'])).toBe(true);
  });
  test('-p → not interactive', () => {
    expect(isInteractiveSession(['-p'])).toBe(false);
  });
  test('--print → not interactive', () => {
    expect(isInteractiveSession(['--print'])).toBe(false);
  });
  test('-p anywhere in passthrough → not interactive', () => {
    expect(isInteractiveSession(['--verbose', '-p', '--'])).toBe(false);
  });
});

describe('selectFragments — interactive non-noop', () => {
  test('default interactive non-noop → 5 fragments incl. budget', () => {
    expect(
      selectFragments({ usedNoopFallback: false, passthrough: [] }),
    ).toEqual(['agent-pitfall.md', 'spawn.md', 'budget.md', 'project-switch.md', 'restart.md']);
  });

  test('interactive non-noop with verbose flag → same set', () => {
    expect(
      selectFragments({ usedNoopFallback: false, passthrough: ['--verbose'] }),
    ).toEqual(['agent-pitfall.md', 'spawn.md', 'budget.md', 'project-switch.md', 'restart.md']);
  });
});

describe('selectFragments — noop interactive', () => {
  test('noop fallback interactive → agent-pitfall + spawn + budget + noop-router (no project-switch/restart)', () => {
    expect(
      selectFragments({ usedNoopFallback: true, passthrough: [] }),
    ).toEqual(['agent-pitfall.md', 'spawn.md', 'budget.md', 'noop-router.md']);
  });
});

describe('selectFragments — budget.md always-on interactive (#171)', () => {
  test('budget.md present in every interactive session (non-noop)', () => {
    expect(selectFragments({ usedNoopFallback: false, passthrough: [] })).toContain('budget.md');
  });
  test('budget.md present in noop interactive session', () => {
    expect(selectFragments({ usedNoopFallback: true, passthrough: [] })).toContain('budget.md');
  });
  test('budget.md absent in print mode (no fragments at all)', () => {
    expect(selectFragments({ usedNoopFallback: false, passthrough: ['-p'] })).not.toContain(
      'budget.md',
    );
  });
});

describe('selectFragments — print mode (no fragments)', () => {
  test('-p in passthrough, non-noop → no fragments', () => {
    expect(
      selectFragments({ usedNoopFallback: false, passthrough: ['-p'] }),
    ).toEqual([]);
  });
  test('--print in passthrough, noop → no fragments', () => {
    expect(
      selectFragments({ usedNoopFallback: true, passthrough: ['--print'] }),
    ).toEqual([]);
  });
});
