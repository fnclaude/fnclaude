/**
 * Unit tests for the `+workspace` split.
 *
 * This is the one piece of repo-reference parsing fnc kept, because fngit
 * knows nothing about it: `fnc repo+feature` means "that repo, in a worktree
 * called feature", and the suffix has to come off before the reference is
 * handed over.
 */

import { describe, expect, test } from 'bun:test';

import { splitWorkspaceSuffix } from '../../src/repo/workspace-suffix';

describe('splitWorkspaceSuffix', () => {
  test('no suffix', () => {
    expect(splitWorkspaceSuffix('fnclaude')).toEqual({ body: 'fnclaude', workspace: '' });
  });

  test('splits on the first +', () => {
    expect(splitWorkspaceSuffix('fnclaude+feat')).toEqual({ body: 'fnclaude', workspace: 'feat' });
  });

  test('a worktree name may contain further +', () => {
    expect(splitWorkspaceSuffix('repo+a+b')).toEqual({ body: 'repo', workspace: 'a+b' });
  });

  test('works on every reference form, since the suffix is positional', () => {
    expect(splitWorkspaceSuffix('name@owner+ws')).toEqual({ body: 'name@owner', workspace: 'ws' });
    expect(splitWorkspaceSuffix('owner/name+ws')).toEqual({ body: 'owner/name', workspace: 'ws' });
    expect(splitWorkspaceSuffix('gh:owner/name+ws')).toEqual({
      body: 'gh:owner/name',
      workspace: 'ws',
    });
    expect(splitWorkspaceSuffix('https://github.com/o/n+ws')).toEqual({
      body: 'https://github.com/o/n',
      workspace: 'ws',
    });
    expect(splitWorkspaceSuffix('~/src/thing+ws')).toEqual({ body: '~/src/thing', workspace: 'ws' });
  });

  test('a trailing + yields no workspace — a typo should not name a worktree ""', () => {
    expect(splitWorkspaceSuffix('repo+')).toEqual({ body: 'repo', workspace: '' });
  });

  test('a leading + leaves an empty body for the caller to reject', () => {
    expect(splitWorkspaceSuffix('+ws')).toEqual({ body: '', workspace: 'ws' });
  });

  test('empty input', () => {
    expect(splitWorkspaceSuffix('')).toEqual({ body: '', workspace: '' });
  });
});
