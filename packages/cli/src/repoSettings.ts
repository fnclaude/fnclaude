// Port of src/repo_settings.go (fnclaude/fnclaude Go reference).
//
// Read the `repoSettings` block from Claude Code's four settings tiers,
// shallow-merged per field. Documented precedence (highest → lowest):
//
//   managed > local > project > user
//
// Mirrors the JS plugin's settings.ts behavior so both consumers agree on
// what each tier provides.

import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * fnclaude's view of the shared `repoSettings` block. Only the keys
 * fnclaude consumes are documented as load-bearing here; the plugin-only
 * keys (worktreeTemplate, branchTemplate, gateEnvVar) are decoded for
 * completeness so callers can inspect them, but fnclaude doesn't act on
 * them.
 */
export interface RepoSettings {
  /** Template fnclaude uses to compute where a freshly-cloned repo should live. */
  cloneTemplate?: string;
  /** Template the worktree-paths plugin uses for `claude --worktree`. */
  worktreeTemplate?: string;
  /** Template the worktree-paths plugin uses for newly-created worktree branch names. */
  branchTemplate?: string;
  /** Env-var name the plugin uses to conditionally apply its templates. */
  gateEnvVar?: string;
}

interface SettingsFile {
  repoSettings?: RepoSettings;
}

function home(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Result of a repo-settings load: the merged settings plus any non-fatal
 * warnings (e.g. malformed JSON files that were skipped). Mirrors
 * `LoadConfigResult` so the caller can thread warnings into the deferred
 * flush.
 */
export interface LoadRepoSettingsResult {
  settings: RepoSettings;
  warnings: readonly string[];
}

/**
 * Resolve the four-tier merge for the user's environment.
 * `projectRoot` is the cwd Claude Code anchors project/local tiers
 * against — typically the launch cwd or the resolved git toplevel.
 */
export function loadRepoSettings(
  homeDir: string,
  projectRoot: string,
): LoadRepoSettingsResult {
  const paths: string[] = [
    join(homeDir, '.claude', 'settings.json'), // user
    join(projectRoot, '.claude', 'settings.json'), // project
    join(projectRoot, '.claude', 'settings.local.json'), // local
  ];
  const mp = managedSettingsPath();
  if (mp) paths.push(mp);
  return mergeRepoSettings(paths);
}

/**
 * Read each path (if it exists) and merge per-field with later entries
 * winning over earlier ones. Missing files are silently skipped (the
 * fail-soft posture the plugin matches); malformed files produce a
 * warning so the user can fix them rather than wondering why their
 * settings don't apply.
 */
export function mergeRepoSettings(paths: string[]): LoadRepoSettingsResult {
  const merged: RepoSettings = {};
  const warnings: string[] = [];
  for (const p of paths) {
    const { settings: f, warning } = readRepoSettings(p);
    if (warning !== null) warnings.push(warning);
    if (!f) continue;
    // Shallow-merge per field: only overwrite when the higher tier sets
    // a non-empty value.
    if (f.cloneTemplate) merged.cloneTemplate = f.cloneTemplate;
    if (f.worktreeTemplate) merged.worktreeTemplate = f.worktreeTemplate;
    if (f.branchTemplate) merged.branchTemplate = f.branchTemplate;
    if (f.gateEnvVar) merged.gateEnvVar = f.gateEnvVar;
  }
  return { settings: merged, warnings };
}

interface ReadRepoSettingsResult {
  settings: RepoSettings | null;
  warning: string | null;
}

function readRepoSettings(path: string): ReadRepoSettingsResult {
  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch {
    // Missing file is the common path — stay silent.
    return { settings: null, warning: null };
  }
  let f: SettingsFile;
  try {
    f = JSON.parse(data) as SettingsFile;
  } catch (err) {
    return {
      settings: null,
      warning: `fnclaude: repo-settings file ${path} is malformed, skipping: ${(err as Error).message}`,
    };
  }
  return { settings: f.repoSettings ?? null, warning: null };
}

/**
 * Platform-specific path to Claude Code's managed-settings.json, or
 * `null` on platforms with no such convention.
 */
export function managedSettingsPath(): string | null {
  switch (platform()) {
    case 'linux':
      return '/etc/claude-code/managed-settings.json';
    case 'darwin':
      return '/Library/Application Support/ClaudeCode/managed-settings.json';
    case 'win32': {
      const pd = process.env.ProgramData;
      if (pd) return join(pd, 'ClaudeCode', 'managed-settings.json');
      return null;
    }
    default:
      return null;
  }
}

// Re-export for callers that don't pass homeDir explicitly.
export function userHome(): string {
  return home();
}
