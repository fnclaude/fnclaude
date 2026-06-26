import { describe, expect, test } from 'bun:test';

import { parseYesNo } from '../../src/repo/confirm';

describe('parseYesNo', () => {
  test('y / yes (any case) → true', () => {
    expect(parseYesNo('y', false)).toBe(true);
    expect(parseYesNo('Y', false)).toBe(true);
    expect(parseYesNo('yes', false)).toBe(true);
    expect(parseYesNo('YES', false)).toBe(true);
    expect(parseYesNo('  yes  ', false)).toBe(true);
  });

  test('n / no → false regardless of default', () => {
    expect(parseYesNo('n', true)).toBe(false);
    expect(parseYesNo('N', true)).toBe(false);
    expect(parseYesNo('no', true)).toBe(false);
    expect(parseYesNo('NO', true)).toBe(false);
  });

  test('empty → default', () => {
    expect(parseYesNo('', false)).toBe(false);
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo('   ', false)).toBe(false);
  });

  test('garbage → default', () => {
    expect(parseYesNo('maybe', false)).toBe(false);
    expect(parseYesNo('maybe', true)).toBe(true);
  });
});
