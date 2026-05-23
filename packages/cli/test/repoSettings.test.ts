import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRepoSettings, type RepoSettings } from '../src/repoSettings.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fnclaude-rs-'));
}
function writeJSON(path: string, v: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(v));
}

describe('mergeRepoSettings', () => {
  test('empty paths → empty struct', () => {
    expect(mergeRepoSettings([])).toEqual({} as RepoSettings);
  });

  test('single tier loads cloneTemplate', () => {
    const dir = tmp();
    const p = join(dir, 'u.json');
    writeJSON(p, { repoSettings: { cloneTemplate: '~/src/{repo}@{owner}' } });
    expect(mergeRepoSettings([p]).cloneTemplate).toBe('~/src/{repo}@{owner}');
  });

  test('higher tier overrides lower (later wins)', () => {
    const dir = tmp();
    const user = join(dir, 'user.json');
    const proj = join(dir, 'project.json');
    writeJSON(user, { repoSettings: { cloneTemplate: 'user-clone' } });
    writeJSON(proj, { repoSettings: { cloneTemplate: 'project-clone' } });
    expect(mergeRepoSettings([user, proj]).cloneTemplate).toBe('project-clone');
  });

  test('lower tier fields survive when higher tier omits them', () => {
    const dir = tmp();
    const user = join(dir, 'user.json');
    const proj = join(dir, 'project.json');
    writeJSON(user, {
      repoSettings: { cloneTemplate: 'user-clone', worktreeTemplate: 'user-wt' },
    });
    writeJSON(proj, { repoSettings: { worktreeTemplate: 'project-wt' } });
    const got = mergeRepoSettings([user, proj]);
    expect(got.cloneTemplate).toBe('user-clone');
    expect(got.worktreeTemplate).toBe('project-wt');
  });

  test('missing file is skipped', () => {
    const dir = tmp();
    expect(mergeRepoSettings([join(dir, 'nope.json')])).toEqual(
      {} as RepoSettings,
    );
  });

  test('malformed file is skipped, later good file still loads', () => {
    const dir = tmp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not valid json');
    const good = join(dir, 'good.json');
    writeJSON(good, { repoSettings: { cloneTemplate: 'kept' } });
    expect(mergeRepoSettings([bad, good]).cloneTemplate).toBe('kept');
  });

  test('file lacking repoSettings key is skipped silently', () => {
    const dir = tmp();
    const p = join(dir, 'p.json');
    writeJSON(p, { unrelatedKey: 'x' });
    expect(mergeRepoSettings([p])).toEqual({} as RepoSettings);
  });
});
