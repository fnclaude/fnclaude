// Port of src/host_aliases.go (fnclaude/fnclaude Go reference).
//
// Load the {host-short} alias map from up to two layered files. System file
// ships with fnclaude (canonical defaults, root-owned, regenerated on
// upgrade); user file optionally overrides per-key. Both files are JSON
// objects mapping fully-qualified host → short alias.
//
// Missing files are silently treated as empty maps. If a user template uses
// {host-short} and the merged map has no entry for the current host, the
// substitution step calls missingHostShortError() to produce a message
// naming both file paths and a copy-pasteable JSON example.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Install-dir LUT, owned by the fnclaude package. The AUR PKGBUILD installs
 * the file here with sensible defaults.
 */
export const HOST_ALIASES_SYSTEM_PATH = '/usr/share/fnrhombus/host-aliases.json';

/**
 * Per-user override path. Wins per-key against the system file.
 */
export function hostAliasesUserPath(home: string): string {
  return join(home, '.local', 'share', 'fnrhombus', 'host-aliases.json');
}

/**
 * Read both files (if present) and merge them, user-level winning per
 * key. Either or both missing returns whatever is available (or empty).
 */
export function loadHostAliases(home: string): Record<string, string> {
  return mergeHostAliases([HOST_ALIASES_SYSTEM_PATH, hostAliasesUserPath(home)]);
}

/**
 * Read each path (if it exists) and merge per-key with later entries
 * winning over earlier ones. Callers order system-first, user-second so
 * user wins on conflict.
 */
export function mergeHostAliases(paths: string[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const p of paths) {
    const entries = readHostAliasesFile(p);
    for (const k of Object.keys(entries)) {
      merged[k] = entries[k] as string;
    }
  }
  return merged;
}

/**
 * Parse one alias file. Missing file, malformed JSON, non-object root,
 * and non-string values all degrade to "no aliases from this file"
 * silently — same fail-soft posture as the JS plugin.
 */
export function readHostAliasesFile(path: string): Record<string, string> {
  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Build the error emitted when a template uses {host-short} but no alias
 * is configured for the current host. Same message shape as the JS
 * plugin's missingHostShortError so users see consistent guidance from
 * either consumer.
 *
 * `home` is injected so callers in tests can pin the user-path output
 * without touching $HOME; production callers should pass `process.env.HOME
 * ?? os.homedir()`.
 */
export function missingHostShortError(host: string, home?: string): Error {
  const h = home ?? process.env.HOME ?? homedir();
  const userPath = hostAliasesUserPath(h);
  return new Error(
    `cannot resolve {host-short} for host ${JSON.stringify(host)}: no alias configured.\n` +
      `Add an entry to one of:\n` +
      `  ${HOST_ALIASES_SYSTEM_PATH}  (system, requires sudo)\n` +
      `  ${userPath}  (user-level, takes precedence on conflict)\n` +
      `Example:\n` +
      `  { "github.com": "gh", "gitlab.com": "gl" }`,
  );
}
