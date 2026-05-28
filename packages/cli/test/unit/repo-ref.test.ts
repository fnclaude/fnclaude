import { describe, expect, test } from 'bun:test';

import {
  effectiveHost,
  hasResolvedOwner,
  parseRepoRef,
  type RepoRef,
} from '../../src/repo/ref.ts';

// Helper for ok-result assertions — TS-narrowing the result union.
function assertOk(r: ReturnType<typeof parseRepoRef>): RepoRef {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('test bug: expected ok');
  return r.ref;
}

describe('parseRepoRef — supported forms', () => {
  test('bare name', () => {
    const ref = assertOk(parseRepoRef('arch-setup'));
    expect(ref).toEqual({
      host: '',
      owner: '',
      name: 'arch-setup',
      workspace: '',
      original: 'arch-setup',
    });
  });

  test('name@owner (Tom local-convention)', () => {
    const ref = assertOk(parseRepoRef('arch-setup@fnrhombus'));
    expect(ref.name).toBe('arch-setup');
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.host).toBe('');
    expect(ref.workspace).toBe('');
  });

  test('owner/name', () => {
    const ref = assertOk(parseRepoRef('fnrhombus/arch-setup'));
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.name).toBe('arch-setup');
    expect(ref.host).toBe('');
  });

  test('gh:owner/name', () => {
    const ref = assertOk(parseRepoRef('gh:fnrhombus/arch-setup'));
    expect(ref.host).toBe('github.com');
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.name).toBe('arch-setup');
  });

  test('https URL', () => {
    const ref = assertOk(parseRepoRef('https://github.com/fnrhombus/arch-setup'));
    expect(ref.host).toBe('github.com');
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.name).toBe('arch-setup');
  });

  test('https URL with .git suffix', () => {
    const ref = assertOk(parseRepoRef('https://github.com/fnrhombus/arch-setup.git'));
    expect(ref.name).toBe('arch-setup');
  });

  test('http (not https) URL', () => {
    const ref = assertOk(parseRepoRef('http://github.com/fnrhombus/arch-setup'));
    expect(ref.host).toBe('github.com');
    expect(ref.name).toBe('arch-setup');
  });

  test('ssh URL', () => {
    const ref = assertOk(parseRepoRef('ssh://git@github.com/fnrhombus/arch-setup.git'));
    expect(ref.host).toBe('github.com');
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.name).toBe('arch-setup');
  });

  test('git@host:owner/name (scp-style ssh)', () => {
    const ref = assertOk(parseRepoRef('git@github.com:fnrhombus/arch-setup.git'));
    expect(ref.host).toBe('github.com');
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.name).toBe('arch-setup');
  });

  test('git@host:owner/name (no .git suffix)', () => {
    const ref = assertOk(parseRepoRef('git@gitlab.com:org/name'));
    expect(ref.host).toBe('gitlab.com');
    expect(ref.owner).toBe('org');
    expect(ref.name).toBe('name');
  });
});

describe('parseRepoRef — workspace suffix', () => {
  test('name@owner+workspace', () => {
    const ref = assertOk(parseRepoRef('arch-setup@fnrhombus+my-feature'));
    expect(ref.name).toBe('arch-setup');
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.workspace).toBe('my-feature');
  });

  test('bare-name+workspace', () => {
    const ref = assertOk(parseRepoRef('arch-setup+my-feature'));
    expect(ref.name).toBe('arch-setup');
    expect(ref.workspace).toBe('my-feature');
  });

  test('owner/name+workspace', () => {
    const ref = assertOk(parseRepoRef('fnrhombus/arch-setup+my-feature'));
    expect(ref.owner).toBe('fnrhombus');
    expect(ref.name).toBe('arch-setup');
    expect(ref.workspace).toBe('my-feature');
  });

  test('empty workspace after `+` is an error', () => {
    const r = parseRepoRef('arch-setup+');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty workspace/);
  });
});

describe('parseRepoRef — error cases', () => {
  test('empty input', () => {
    const r = parseRepoRef('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty repo/);
  });

  test('a/b/c (multiple slashes, no scheme)', () => {
    const r = parseRepoRef('a/b/c');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ambiguous|unparseable/);
  });

  test('gh: with no owner/name', () => {
    const r = parseRepoRef('gh:onlyname');
    expect(r.ok).toBe(false);
  });

  test('owner with @ in it', () => {
    const r = parseRepoRef('owner/@something');
    expect(r.ok).toBe(false);
  });
});

describe('hasResolvedOwner', () => {
  test('false when only bare name', () => {
    const ref = assertOk(parseRepoRef('arch-setup'));
    expect(hasResolvedOwner(ref)).toBe(false);
  });

  test('true when name@owner', () => {
    const ref = assertOk(parseRepoRef('arch-setup@fnrhombus'));
    expect(hasResolvedOwner(ref)).toBe(true);
  });

  test('true when URL', () => {
    const ref = assertOk(parseRepoRef('https://github.com/fnrhombus/arch-setup'));
    expect(hasResolvedOwner(ref)).toBe(true);
  });
});

describe('effectiveHost', () => {
  test('defaults to github.com when host empty', () => {
    const ref = assertOk(parseRepoRef('arch-setup'));
    expect(effectiveHost(ref)).toBe('github.com');
  });

  test('keeps explicit host (gitlab)', () => {
    const ref = assertOk(parseRepoRef('https://gitlab.com/org/name'));
    expect(effectiveHost(ref)).toBe('gitlab.com');
  });

  test('keeps explicit host from scp form', () => {
    const ref = assertOk(parseRepoRef('git@bitbucket.org:org/name'));
    expect(effectiveHost(ref)).toBe('bitbucket.org');
  });
});
