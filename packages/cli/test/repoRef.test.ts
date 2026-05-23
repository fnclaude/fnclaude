import { describe, expect, test } from 'bun:test';
import { parseRepoRef } from '../src/repoRef.js';

// Mirrors src/repo_ref_test.go. parseRepoRef returns null instead of throwing
// when the input is unparseable (TS callers branch on null rather than
// catching).

describe('parseRepoRef', () => {
  test('bare name', () => {
    const r = parseRepoRef('arch-setup');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('arch-setup');
    expect(r!.owner).toBe('');
    expect(r!.host).toBe('');
    expect(r!.workspace).toBe('');
  });

  test('name@owner (Tom local convention)', () => {
    const r = parseRepoRef('arch-setup@fnrhombus');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('arch-setup');
    expect(r!.owner).toBe('fnrhombus');
  });

  test('owner/name', () => {
    const r = parseRepoRef('fnrhombus/arch-setup');
    expect(r).not.toBeNull();
    expect(r!.owner).toBe('fnrhombus');
    expect(r!.name).toBe('arch-setup');
  });

  test('gh:owner/name shorthand', () => {
    const r = parseRepoRef('gh:fnrhombus/arch-setup');
    expect(r).not.toBeNull();
    expect(r!.host).toBe('github.com');
    expect(r!.owner).toBe('fnrhombus');
    expect(r!.name).toBe('arch-setup');
  });

  test('https URL', () => {
    const r = parseRepoRef('https://github.com/fnrhombus/arch-setup');
    expect(r).not.toBeNull();
    expect(r!.host).toBe('github.com');
    expect(r!.owner).toBe('fnrhombus');
    expect(r!.name).toBe('arch-setup');
  });

  test('https URL with .git suffix', () => {
    const r = parseRepoRef('https://github.com/fnrhombus/arch-setup.git');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('arch-setup');
  });

  test('ssh URL', () => {
    const r = parseRepoRef('ssh://git@github.com/fnrhombus/arch-setup.git');
    expect(r).not.toBeNull();
    expect(r!.host).toBe('github.com');
    expect(r!.owner).toBe('fnrhombus');
    expect(r!.name).toBe('arch-setup');
  });

  test('git@host:owner/name.git', () => {
    const r = parseRepoRef('git@github.com:fnrhombus/arch-setup.git');
    expect(r).not.toBeNull();
    expect(r!.host).toBe('github.com');
    expect(r!.owner).toBe('fnrhombus');
    expect(r!.name).toBe('arch-setup');
  });

  test('git@host:owner/name (no .git)', () => {
    const r = parseRepoRef('git@gitlab.com:org/name');
    expect(r).not.toBeNull();
    expect(r!.host).toBe('gitlab.com');
    expect(r!.owner).toBe('org');
    expect(r!.name).toBe('name');
  });

  test('name@owner+workspace', () => {
    const r = parseRepoRef('arch-setup@fnrhombus+my-feature');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('arch-setup');
    expect(r!.owner).toBe('fnrhombus');
    expect(r!.workspace).toBe('my-feature');
  });

  test('bare name with workspace', () => {
    const r = parseRepoRef('arch-setup+my-feature');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('arch-setup');
    expect(r!.workspace).toBe('my-feature');
  });

  test('empty workspace after + returns null', () => {
    expect(parseRepoRef('arch-setup+')).toBeNull();
  });

  test('empty input returns null', () => {
    expect(parseRepoRef('')).toBeNull();
  });

  test('multiple slashes are rejected', () => {
    expect(parseRepoRef('a/b/c')).toBeNull();
  });

  test('original is preserved', () => {
    const r = parseRepoRef('arch-setup@fnrhombus+wt');
    expect(r).not.toBeNull();
    expect(r!.original).toBe('arch-setup@fnrhombus+wt');
  });

  test('effective host defaults to github.com for bare name', () => {
    const r = parseRepoRef('arch-setup');
    expect(r).not.toBeNull();
    expect(r!.effectiveHost).toBe('github.com');
  });

  test('effective host preserves explicit host', () => {
    const r = parseRepoRef('https://gitlab.com/org/name');
    expect(r).not.toBeNull();
    expect(r!.effectiveHost).toBe('gitlab.com');
  });

  test('hasResolvedOwner', () => {
    const cases: { in: string; hasOwner: boolean }[] = [
      { in: 'arch-setup', hasOwner: false },
      { in: 'arch-setup@fnrhombus', hasOwner: true },
      { in: 'fnrhombus/arch-setup', hasOwner: true },
      { in: 'gh:fnrhombus/arch-setup', hasOwner: true },
    ];
    for (const c of cases) {
      const r = parseRepoRef(c.in);
      expect(r).not.toBeNull();
      expect(r!.hasResolvedOwner).toBe(c.hasOwner);
    }
  });
});
