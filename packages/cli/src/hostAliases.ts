// Load the {host-short} alias map.
//
// Builtin defaults (BUILTIN_HOST_ALIASES) ship with the package — npm install
// has no hook to drop a JSON file under /usr/share, so the canonical 4 host
// mappings live in source. Users override per-key via
// ~/.local/share/fnrhombus/host-aliases.json.
//
// Missing user file is silently treated as empty. If a user template uses
// {host-short} and the merged map has no entry for the current host, the
// substitution step calls missingHostShortError() to produce a message
// naming the user file path and a copy-pasteable JSON example.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Bundled host-alias defaults. These ship with the package and are
 * always present; the user file (if any) overrides per key.
 *
 * Kept in sync with the Go reference's AUR PKGBUILD install fixture.
 */
export const BUILTIN_HOST_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'github.com': 'gh',
  'gitlab.com': 'gl',
  'bitbucket.org': 'bb',
  'codeberg.org': 'cb',
});

/**
 * Per-user override path. Wins per-key against the builtin defaults.
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
 * Return the merged alias map: builtin defaults overlaid with the user
 * file (if present). User entries win per key. Missing user file is the
 * common path and stays silent.
 */
export function loadHostAliases(home: string): LoadHostAliasesResult {
  const userResult = mergeHostAliases([hostAliasesUserPath(home)]);
  const merged: Record<string, string> = { ...BUILTIN_HOST_ALIASES };
  for (const k of Object.keys(userResult.aliases)) {
    merged[k] = userResult.aliases[k] as string;
  }
  return { aliases: merged, warnings: userResult.warnings };
}

/**
 * Read each path (if it exists) and merge per-key with later entries
 * winning over earlier ones.
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
 * is configured for the current host. Points only at the user file path
 * since builtins already cover the common forges and any further
 * overrides go in the user file.
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
      `Add an entry to:\n` +
      `  ${userPath}\n` +
      `Example:\n` +
      `  { "github.com": "gh", "gitlab.com": "gl" }`,
  );
}
