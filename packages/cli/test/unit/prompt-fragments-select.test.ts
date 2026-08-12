import { describe, expect, test } from 'bun:test';

import {
  isInteractiveSession,
  isOneShotPrint,
  selectFragments,
  usesStreamJson,
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

describe('usesStreamJson', () => {
  test('--output-format stream-json (separate tokens) → true', () => {
    expect(usesStreamJson(['--output-format', 'stream-json'])).toBe(true);
  });
  test('--input-format stream-json (separate tokens) → true', () => {
    expect(usesStreamJson(['--input-format', 'stream-json'])).toBe(true);
  });
  test('--output-format=stream-json (inline) → true', () => {
    expect(usesStreamJson(['--output-format=stream-json'])).toBe(true);
  });
  test('--input-format=stream-json (inline) → true', () => {
    expect(usesStreamJson(['--input-format=stream-json'])).toBe(true);
  });
  test('empty → false', () => {
    expect(usesStreamJson([])).toBe(false);
  });
  test('--output-format text → false', () => {
    expect(usesStreamJson(['--output-format', 'text'])).toBe(false);
  });
  test('--verbose → false', () => {
    expect(usesStreamJson(['--verbose'])).toBe(false);
  });
});

describe('isOneShotPrint', () => {
  test('-p → true', () => {
    expect(isOneShotPrint(['-p'])).toBe(true);
  });
  test('--print → true', () => {
    expect(isOneShotPrint(['--print'])).toBe(true);
  });
  test('empty (interactive) → false', () => {
    expect(isOneShotPrint([])).toBe(false);
  });
  test('-p with stream-json → false', () => {
    expect(isOneShotPrint(['-p', '--output-format', 'stream-json'])).toBe(false);
  });
});

describe('selectFragments — interactive non-noop', () => {
  test('default interactive non-noop → 6 fragments incl. budget + coordination', () => {
    expect(
      selectFragments({ usedNoopFallback: false, passthrough: [] }),
    ).toEqual([
      'agent-pitfall.md',
      'spawn.md',
      'budget.md',
      'coordination.md',
      'project-switch.md',
      'restart.md',
    ]);
  });

  test('interactive non-noop with verbose flag → same set', () => {
    expect(
      selectFragments({ usedNoopFallback: false, passthrough: ['--verbose'] }),
    ).toEqual([
      'agent-pitfall.md',
      'spawn.md',
      'budget.md',
      'coordination.md',
      'project-switch.md',
      'restart.md',
    ]);
  });
});

describe('selectFragments — noop interactive', () => {
  test('noop fallback interactive → agent-pitfall + spawn + budget + coordination + noop-router (no project-switch/restart)', () => {
    expect(
      selectFragments({ usedNoopFallback: true, passthrough: [] }),
    ).toEqual(['agent-pitfall.md', 'spawn.md', 'budget.md', 'coordination.md', 'noop-router.md']);
  });
});

describe('selectFragments — budget.md always-on interactive (#171)', () => {
  test('budget.md present in every interactive session (non-noop)', () => {
    expect(selectFragments({ usedNoopFallback: false, passthrough: [] })).toContain('budget.md');
  });
  test('budget.md present in noop interactive session', () => {
    expect(selectFragments({ usedNoopFallback: true, passthrough: [] })).toContain('budget.md');
  });
  test('budget.md absent in one-shot print mode', () => {
    expect(selectFragments({ usedNoopFallback: false, passthrough: ['-p'] })).not.toContain(
      'budget.md',
    );
  });
});

describe('selectFragments — coordination.md always-on interactive (#350)', () => {
  test('coordination.md present in every interactive session (non-noop)', () => {
    expect(selectFragments({ usedNoopFallback: false, passthrough: [] })).toContain(
      'coordination.md',
    );
  });
  test('coordination.md present in noop interactive session', () => {
    expect(selectFragments({ usedNoopFallback: true, passthrough: [] })).toContain(
      'coordination.md',
    );
  });
  test('coordination.md absent in one-shot print mode', () => {
    expect(selectFragments({ usedNoopFallback: false, passthrough: ['-p'] })).not.toContain(
      'coordination.md',
    );
  });
});

describe('selectFragments — one-shot print mode', () => {
  test('-p in passthrough, non-noop → one-shot.md', () => {
    expect(
      selectFragments({ usedNoopFallback: false, passthrough: ['-p'] }),
    ).toEqual(['one-shot.md']);
  });
  test('--print in passthrough, noop → one-shot.md', () => {
    expect(
      selectFragments({ usedNoopFallback: true, passthrough: ['--print'] }),
    ).toEqual(['one-shot.md']);
  });
});

describe('selectFragments — print + stream-json (program-driven)', () => {
  test('-p with input+output stream-json → no fragments', () => {
    expect(
      selectFragments({
        usedNoopFallback: false,
        passthrough: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'],
      }),
    ).toEqual([]);
  });
  test('-p with inline --output-format=stream-json → no fragments', () => {
    expect(
      selectFragments({
        usedNoopFallback: false,
        passthrough: ['-p', '--output-format=stream-json'],
      }),
    ).toEqual([]);
  });
});
