import { describe, expect, test } from 'bun:test';
import { parseGithubOrigin, resolveGithubRepo } from './github-origin';

describe('parseGithubOrigin', () => {
  test('SSH/SCP form with .git suffix', () => {
    expect(parseGithubOrigin('git@github.com:fnclaude/fnclaude.git')).toEqual({
      owner: 'fnclaude',
      name: 'fnclaude',
    });
  });

  test('SSH/SCP form without .git suffix', () => {
    expect(parseGithubOrigin('git@github.com:octocat/Hello-World')).toEqual({
      owner: 'octocat',
      name: 'Hello-World',
    });
  });

  test('HTTPS form with .git suffix', () => {
    expect(parseGithubOrigin('https://github.com/fnclaude/fnclaude.git')).toEqual({
      owner: 'fnclaude',
      name: 'fnclaude',
    });
  });

  test('HTTPS form without .git suffix', () => {
    expect(parseGithubOrigin('https://github.com/octocat/Hello-World')).toEqual({
      owner: 'octocat',
      name: 'Hello-World',
    });
  });

  test('ssh:// scheme form', () => {
    expect(parseGithubOrigin('ssh://git@github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      name: 'repo',
    });
  });

  test('non-github host returns null', () => {
    expect(parseGithubOrigin('git@gitlab.com:owner/repo.git')).toBeNull();
    expect(parseGithubOrigin('https://bitbucket.org/owner/repo')).toBeNull();
  });

  test('garbage returns null', () => {
    expect(parseGithubOrigin('not a url')).toBeNull();
    expect(parseGithubOrigin('')).toBeNull();
  });
});

describe('resolveGithubRepo', () => {
  test('resolves via injected reader for a github origin', async () => {
    const repo = await resolveGithubRepo('/anywhere', async () => 'git@github.com:o/n.git');
    expect(repo).toEqual({ owner: 'o', name: 'n' });
  });

  test('null when the reader yields no origin', async () => {
    expect(await resolveGithubRepo('/anywhere', async () => null)).toBeNull();
  });

  test('null when origin is non-github', async () => {
    const repo = await resolveGithubRepo('/x', async () => 'https://example.com/o/n.git');
    expect(repo).toBeNull();
  });
});
