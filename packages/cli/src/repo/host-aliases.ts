/**
 * Two-layer host-aliases LUT loader for {host-short} template substitution.
 *
 * Mirrors Go canonical's `src/host_aliases.go:25-95`. Both fnclaude (this
 * file) and the claude-code-worktree-paths plugin (`src/host-aliases.ts`
 * over there) read the same files so a single config feeds both tools.
 *
 * Real default file locations (see design.md §23):
 *   system: /usr/share/fnrhombus/host-aliases.json
 *   user:   ~/.local/share/fnrhombus/host-aliases.json
 *
 * Paths are injected here so tests can use temp files; callers wire in
 * the real defaults.
 *
 * Robustness: missing file, malformed JSON, non-object root → that
 * file's contribution is empty. Individual non-string values within an
 * otherwise-valid object → drop that key only, keep the rest. The user
 * file's keys win over system file's keys on conflict.
 */

import { readFileSync, statSync } from 'node:fs';

export interface LoadHostAliasesArgs {
  systemPath: string;
  userPath: string;
}

export function loadHostAliases(args: LoadHostAliasesArgs): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const v of Object.entries(readOneLayer(args.systemPath))) merged[v[0]] = v[1];
  for (const v of Object.entries(readOneLayer(args.userPath))) merged[v[0]] = v[1];
  return merged;
}

function readOneLayer(path: string): Record<string, string> {
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
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
