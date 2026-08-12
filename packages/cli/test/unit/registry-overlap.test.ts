/**
 * Unit tests for the coordination registry's key-overlap rule.
 *
 * Keys are strings, usually absolute paths. Normalization strips trailing
 * slashes; two keys overlap iff they are equal or one is a "/"-boundary
 * prefix of the other. The boundary cases matter: /a vs /ab must NOT
 * overlap (sibling with a shared name prefix), while /a vs /a/b must
 * (directory containment). Abstract non-path keys (git:stash:fnclaude)
 * fall out of the same rule as exact-match-only in practice.
 */

import { describe, expect, test } from 'bun:test';

import { keysOverlap, normalizeKey } from '../../src/registry/key-overlap';

describe('normalizeKey', () => {
  test('strips a single trailing slash', () => {
    expect(normalizeKey('/a/b/')).toBe('/a/b');
  });

  test('strips repeated trailing slashes', () => {
    expect(normalizeKey('/a///')).toBe('/a');
  });

  test('leaves a bare path untouched', () => {
    expect(normalizeKey('/a/b')).toBe('/a/b');
  });

  test('root "/" normalizes to the empty prefix (overlaps everything)', () => {
    expect(normalizeKey('/')).toBe('');
  });

  test('abstract keys pass through unchanged', () => {
    expect(normalizeKey('git:stash:fnclaude')).toBe('git:stash:fnclaude');
  });
});

describe('keysOverlap', () => {
  test('identical keys overlap', () => {
    expect(keysOverlap('/a/b', '/a/b')).toBe(true);
  });

  test('parent contains child: /a vs /a/b overlaps', () => {
    expect(keysOverlap('/a', '/a/b')).toBe(true);
  });

  test('child inside parent: /a/b vs /a overlaps (symmetric)', () => {
    expect(keysOverlap('/a/b', '/a')).toBe(true);
  });

  test('shared name prefix without "/" boundary: /a vs /ab does NOT overlap', () => {
    expect(keysOverlap('/a', '/ab')).toBe(false);
  });

  test('/a/b vs /a/bc does NOT overlap', () => {
    expect(keysOverlap('/a/b', '/a/bc')).toBe(false);
  });

  test('trailing slashes are normalized before comparing', () => {
    expect(keysOverlap('/a/', '/a/b')).toBe(true);
    expect(keysOverlap('/a/', '/ab/')).toBe(false);
  });

  test('root "/" overlaps any absolute path', () => {
    expect(keysOverlap('/', '/etc/fstab')).toBe(true);
  });

  test('abstract keys: exact match overlaps', () => {
    expect(keysOverlap('git:stash:fnclaude', 'git:stash:fnclaude')).toBe(true);
  });

  test('abstract keys: distinct keys do not overlap', () => {
    expect(keysOverlap('git:stash:fnclaude', 'git:stash:other')).toBe(false);
  });

  test('unrelated absolute paths do not overlap', () => {
    expect(keysOverlap('/home/u/src/a', '/home/u/src/b')).toBe(false);
  });
});
