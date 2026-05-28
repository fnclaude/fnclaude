/**
 * Four-tier repoSettings loader. Reads the `repoSettings` block from each
 * tier's settings.json and shallow-merges per field.
 *
 * Precedence (lowest to highest — later wins):
 *   1. User      — ~/.claude/settings.json
 *   2. Project   — <projectRoot>/.claude/settings.json
 *   3. Local     — <projectRoot>/.claude/settings.local.json
 *   4. Managed   — platform-specific (org policy; can't be overridden)
 *
 * The `projectRoot` for resolution-time settings is the shell cwd at
 * fnclaude startup (per specs.md §18.7), which is evaluated BEFORE path
 * resolution runs — that's why we can read project-tier settings without
 * having resolved the launch cwd yet.
 *
 * Paths are passed in (not hardcoded) so tests can use temp files. Caller
 * wires in the real defaults; managedPath may be omitted on platforms
 * where the managed-settings file is irrelevant.
 *
 * Mirrors Go canonical `src/repo_settings.go:51-89`.
 *
 * Robustness — every failure mode degrades silently to "this tier
 * contributes nothing":
 *   - missing file, malformed JSON, non-object root
 *   - `repoSettings` field is missing OR not an object
 *   - individual field value is not a string (drop that field only,
 *     keep the rest from that tier)
 *
 * Only the four known fields are extracted. Unknown fields under
 * `repoSettings` are ignored. fnclaude itself only acts on
 * `cloneTemplate`; the other three are read for completeness (the
 * claude-code-worktree-paths plugin reads them).
 */

import { readFileSync, statSync } from 'node:fs';

export interface RepoSettings {
  cloneTemplate: string;
  worktreeTemplate: string;
  branchTemplate: string;
  gateEnvVar: string;
}

export interface LoadRepoSettingsArgs {
  userPath: string;
  projectPath: string;
  localPath: string;
  managedPath?: string;
}

const KNOWN_FIELDS: ReadonlyArray<keyof RepoSettings> = [
  'cloneTemplate',
  'worktreeTemplate',
  'branchTemplate',
  'gateEnvVar',
];

function emptySettings(): RepoSettings {
  return { cloneTemplate: '', worktreeTemplate: '', branchTemplate: '', gateEnvVar: '' };
}

export function loadRepoSettings(args: LoadRepoSettingsArgs): RepoSettings {
  const merged = emptySettings();
  const tiers = [args.userPath, args.projectPath, args.localPath, args.managedPath];
  for (const path of tiers) {
    if (path === undefined) continue;
    const tier = readTier(path);
    for (const field of KNOWN_FIELDS) {
      const v = tier[field];
      if (typeof v === 'string') merged[field] = v;
    }
  }
  return merged;
}

function readTier(path: string): Partial<Record<keyof RepoSettings, unknown>> {
  let raw: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return {};
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const repoSettings = (parsed as Record<string, unknown>).repoSettings;
  if (repoSettings === null || typeof repoSettings !== 'object' || Array.isArray(repoSettings)) {
    return {};
  }
  return repoSettings as Record<string, unknown>;
}
