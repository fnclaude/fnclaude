import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRepoSettings, type LoadRepoSettingsArgs } from '../../src/repo/repo-settings.ts';

let tmpRoot: string;
let paths: LoadRepoSettingsArgs;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fnc-repo-settings-'));
  paths = {
    userPath: join(tmpRoot, 'user.json'),
    projectPath: join(tmpRoot, 'project.json'),
    localPath: join(tmpRoot, 'local.json'),
    managedPath: join(tmpRoot, 'managed.json'),
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function write(path: string, body: unknown) {
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
}

describe('loadRepoSettings — empty/missing', () => {
  test('all tiers missing → all fields empty string', () => {
    expect(loadRepoSettings(paths)).toEqual({
      cloneTemplate: '',
      worktreeTemplate: '',
      branchTemplate: '',
      gateEnvVar: '',
    });
  });

  test('settings.json without a repoSettings block → all fields empty', () => {
    write(paths.userPath, { theme: 'dark' });
    expect(loadRepoSettings(paths)).toEqual({
      cloneTemplate: '',
      worktreeTemplate: '',
      branchTemplate: '',
      gateEnvVar: '',
    });
  });

  test('repoSettings present but unrelated keys ignored', () => {
    write(paths.userPath, { repoSettings: { somethingElse: 'x', cloneTemplate: '~/src/{repo}@{owner}' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('~/src/{repo}@{owner}');
  });
});

describe('loadRepoSettings — single tier reads', () => {
  test('user tier: cloneTemplate read', () => {
    write(paths.userPath, { repoSettings: { cloneTemplate: '~/src/{repo}@{owner}' } });
    expect(loadRepoSettings(paths)).toEqual({
      cloneTemplate: '~/src/{repo}@{owner}',
      worktreeTemplate: '',
      branchTemplate: '',
      gateEnvVar: '',
    });
  });

  test('project tier: worktreeTemplate read (fnclaude does not act, but reads for completeness)', () => {
    write(paths.projectPath, { repoSettings: { worktreeTemplate: '{repo-dir}@worktrees/{input}' } });
    expect(loadRepoSettings(paths).worktreeTemplate).toBe('{repo-dir}@worktrees/{input}');
  });

  test('local tier: branchTemplate read', () => {
    write(paths.localPath, { repoSettings: { branchTemplate: '{input}' } });
    expect(loadRepoSettings(paths).branchTemplate).toBe('{input}');
  });

  test('managed tier: gateEnvVar read', () => {
    write(paths.managedPath, { repoSettings: { gateEnvVar: 'CLAUDE_WORKTREE' } });
    expect(loadRepoSettings(paths).gateEnvVar).toBe('CLAUDE_WORKTREE');
  });
});

describe('loadRepoSettings — precedence (managed > local > project > user)', () => {
  test('local overrides project overrides user for cloneTemplate', () => {
    write(paths.userPath, { repoSettings: { cloneTemplate: 'user-tpl' } });
    write(paths.projectPath, { repoSettings: { cloneTemplate: 'project-tpl' } });
    write(paths.localPath, { repoSettings: { cloneTemplate: 'local-tpl' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('local-tpl');
  });

  test('managed wins over local (org policy beats user opt-in)', () => {
    write(paths.localPath, { repoSettings: { cloneTemplate: 'local-tpl' } });
    write(paths.managedPath, { repoSettings: { cloneTemplate: 'managed-tpl' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('managed-tpl');
  });

  test('per-FIELD merge — distinct fields from different tiers coexist', () => {
    write(paths.userPath, { repoSettings: { cloneTemplate: 'user-clone' } });
    write(paths.projectPath, { repoSettings: { worktreeTemplate: 'project-wt' } });
    write(paths.localPath, { repoSettings: { branchTemplate: 'local-br' } });
    write(paths.managedPath, { repoSettings: { gateEnvVar: 'managed-env' } });
    expect(loadRepoSettings(paths)).toEqual({
      cloneTemplate: 'user-clone',
      worktreeTemplate: 'project-wt',
      branchTemplate: 'local-br',
      gateEnvVar: 'managed-env',
    });
  });

  test('missing field in higher tier does NOT clobber lower tier with empty string', () => {
    write(paths.userPath, { repoSettings: { cloneTemplate: 'user-clone' } });
    write(paths.localPath, { repoSettings: { worktreeTemplate: 'local-wt' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('user-clone');
    expect(loadRepoSettings(paths).worktreeTemplate).toBe('local-wt');
  });

  test('managedPath omitted → managed tier absent, lower tiers still merge', () => {
    write(paths.userPath, { repoSettings: { cloneTemplate: 'user-tpl' } });
    const { managedPath: _, ...withoutManaged } = paths;
    expect(loadRepoSettings(withoutManaged).cloneTemplate).toBe('user-tpl');
  });
});

describe('loadRepoSettings — malformed inputs degrade silently', () => {
  test('malformed JSON in user tier: that tier dropped, others kept', () => {
    writeFileSync(paths.userPath, '{ not valid');
    write(paths.projectPath, { repoSettings: { cloneTemplate: 'project-tpl' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('project-tpl');
  });

  test('non-object root: dropped', () => {
    write(paths.userPath, ['array', 'root']);
    write(paths.projectPath, { repoSettings: { cloneTemplate: 'project-tpl' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('project-tpl');
  });

  test('repoSettings is not an object: dropped (treated as absent)', () => {
    write(paths.userPath, { repoSettings: 'a string instead of object' });
    write(paths.projectPath, { repoSettings: { cloneTemplate: 'project-tpl' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('project-tpl');
  });

  test('non-string field value: drop that field only', () => {
    write(paths.userPath, {
      repoSettings: { cloneTemplate: 42, worktreeTemplate: 'good' },
    });
    expect(loadRepoSettings(paths)).toEqual({
      cloneTemplate: '',
      worktreeTemplate: 'good',
      branchTemplate: '',
      gateEnvVar: '',
    });
  });

  test('directory at the path (instead of a file): silent skip', () => {
    mkdirSync(paths.userPath);
    write(paths.projectPath, { repoSettings: { cloneTemplate: 'project-tpl' } });
    expect(loadRepoSettings(paths).cloneTemplate).toBe('project-tpl');
  });
});
