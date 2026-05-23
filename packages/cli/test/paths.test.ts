import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandTildePath } from '../src/paths.js';

// Mirrors expandTildePath in src/resolver.go. Bare "~" returns home; "~/x"
// joins x onto home; everything else (including mid-token "~") is left
// literal.

describe('expandTildePath', () => {
  const home = homedir();

  test('bare tilde returns home', () => {
    expect(expandTildePath('~')).toBe(home);
  });

  test('~/x joins onto home', () => {
    expect(expandTildePath('~/src/proj')).toBe(join(home, 'src/proj'));
  });

  test('~/ alone returns home (trailing slash collapsed by join)', () => {
    expect(expandTildePath('~/')).toBe(home);
  });

  test('absolute path is left untouched', () => {
    expect(expandTildePath('/etc/passwd')).toBe('/etc/passwd');
  });

  test('relative path is left untouched', () => {
    expect(expandTildePath('src/proj')).toBe('src/proj');
  });

  test('mid-token tilde is left literal (matches shell behaviour)', () => {
    expect(expandTildePath('foo~bar')).toBe('foo~bar');
  });

  test('~user form is not expanded (only bare ~ and ~/)', () => {
    expect(expandTildePath('~other/proj')).toBe('~other/proj');
  });

  test('empty string returns empty string', () => {
    expect(expandTildePath('')).toBe('');
  });
});
