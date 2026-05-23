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
 * Result of a host-aliases load: the merged alias map plus any non-fatal
 * warnings (e.g. malformed files that were skipped). Mirrors
 * `LoadConfigResult` so the caller can thread warnings into the deferred
 * flush.
 */
export interface LoadHostAliasesResult {
  aliases: Record<string, string>;
  warnings: readonly string[];
}

/**
 * Read both files (if present) and merge them, user-level winning per
 * key. Either or both missing returns whatever is available (or empty).
 */
export function loadHostAliases(home: string): LoadHostAliasesResult {
  return mergeHostAliases([HOST_ALIASES_SYSTEM_PATH, hostAliasesUserPath(home)]);
}

/**
 * Read each path (if it exists) and merge per-key with later entries
 * winning over earlier ones. Callers order system-first, user-second so
 * user wins on conflict.
 */
export function mergeHostAliases(paths: string[]): LoadHostAliasesResult {
  const merged: Record<string, string> = {};
  const warnings: string[] = [];
  for (const p of paths) {
    const { aliases, warning } = readHostAliasesFile(p);
    if (warning !== null) warnings.push(warning);
    for (const k of Object.keys(aliases)) {
      merged[k] = aliases[k] as string;
    }
  }
  return { aliases: merged, warnings };
}

export interface ReadHostAliasesFileResult {
  aliases: Record<string, string>;
  warning: string | null;
}

/**
 * Parse one alias file. Missing file is the common path and stays
 * silent. Malformed JSON or non-object roots produce a warning so the
 * user can fix the file rather than wondering why their aliases don't
 * apply. Non-string values are silently dropped (mirrors the JS plugin).
 */
export function readHostAliasesFile(path: string): ReadHostAliasesFileResult {
  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch {
    return { aliases: {}, warning: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (err) {
    return {
      aliases: {},
      warning: `fnclaude: host-aliases file ${path} is malformed, skipping: ${(err as Error).message}`,
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      aliases: {},
      warning: `fnclaude: host-aliases file ${path} has a non-object root, skipping`,
    };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return { aliases: out, warning: null };
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
