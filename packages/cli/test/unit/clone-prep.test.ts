import { describe, expect, test } from 'bun:test';

import {
  buildCloneUrl,
  computeCloneDestination,
} from '../../src/repo/clone.ts';
import type { RepoRef } from '../../src/repo/ref.ts';

function ref(partial: Partial<RepoRef> = {}): RepoRef {
  return {
    host: 'github.com',
    owner: 'fnrhombus',
    name: 'arch-setup',
    workspace: '',
    original: 'arch-setup@fnrhombus',
    ...partial,
  };
}

describe('buildCloneUrl', () => {
  test('github.com → https URL with .git suffix', () => {
    expect(buildCloneUrl(ref())).toBe('https://github.com/fnrhombus/arch-setup.git');
  });

  test('gitlab.com is honoured', () => {
    expect(buildCloneUrl(ref({ host: 'gitlab.com', owner: 'org', name: 'thing' })))
      .toBe('https://gitlab.com/org/thing.git');
  });

  test('empty host defaults to github.com', () => {
    expect(buildCloneUrl(ref({ host: '' })))
      .toBe('https://github.com/fnrhombus/arch-setup.git');
  });

  test('empty owner throws — caller should resolve owner first', () => {
    expect(() => buildCloneUrl(ref({ owner: '' }))).toThrow(/owner/);
  });

  test('empty name throws', () => {
    expect(() => buildCloneUrl(ref({ name: '' }))).toThrow(/name/);
  });
});

describe('computeCloneDestination', () => {
  const HOME = '/home/tom';
  const ALIASES = { 'github.com': 'gh', 'gitlab.com': 'gl' };

  test('happy path: full template with host-short + owner + repo', () => {
    const r = computeCloneDestination({
      ref: ref(),
      template: '~/src/{host-short}/{owner}/{repo}',
      hostAliases: ALIASES,
      home: HOME,
    });
    expect(r).toEqual({ ok: true, path: '/home/tom/src/gh/fnrhombus/arch-setup' });
  });

  test("Tom's local convention {repo}@{owner}", () => {
    const r = computeCloneDestination({
      ref: ref(),
      template: '~/src/{repo}@{owner}',
      hostAliases: ALIASES,
      home: HOME,
    });
    expect(r).toEqual({ ok: true, path: '/home/tom/src/arch-setup@fnrhombus' });
  });

  test('template without tilde is left absolute as written', () => {
    const r = computeCloneDestination({
      ref: ref(),
      template: '/srv/repos/{owner}/{repo}',
      hostAliases: ALIASES,
      home: HOME,
    });
    expect(r).toEqual({ ok: true, path: '/srv/repos/fnrhombus/arch-setup' });
  });

  test('host-short miss surfaces the underlying template error', () => {
    const r = computeCloneDestination({
      ref: ref({ host: 'codeberg.org' }),
      template: '~/src/{host-short}/{owner}/{repo}',
      hostAliases: ALIASES,
      home: HOME,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('codeberg.org');
  });

  test('unknown placeholder errors', () => {
    const r = computeCloneDestination({
      ref: ref(),
      template: '~/src/{bogus}',
      hostAliases: ALIASES,
      home: HOME,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('{bogus}');
  });

  test('empty host on ref defaults to github.com for {host-plain}', () => {
    const r = computeCloneDestination({
      ref: ref({ host: '' }),
      template: '~/{host-plain}/{owner}/{repo}',
      hostAliases: ALIASES,
      home: HOME,
    });
    expect(r).toEqual({ ok: true, path: '/home/tom/github/fnrhombus/arch-setup' });
  });

  test('workspace on ref is IGNORED — clone destination is the base repo path', () => {
    const r = computeCloneDestination({
      ref: ref({ workspace: 'my-feature' }),
      template: '~/src/{repo}@{owner}',
      hostAliases: ALIASES,
      home: HOME,
    });
    expect(r).toEqual({ ok: true, path: '/home/tom/src/arch-setup@fnrhombus' });
  });
});
