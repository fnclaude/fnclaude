/**
 * Write fnc's config back to disk.
 *
 * Two rules from the contract (specs/rhombus-rocks-config.md):
 *
 *   - Writers emit **JSON with a `$schema` line**, whatever format was read.
 *     JSON's `$schema` is the one form every editor honours without extra
 *     setup; TOML needs Taplo's `#:schema` comment and YAML needs
 *     yaml-language-server, so neither is a good default for a file a wizard
 *     creates. A user who prefers TOML keeps their `config.toml` — the reader
 *     still accepts it; only writes land in `config.json`.
 *   - Writers **merge**, preserving keys they don't own. The OOBE writes each
 *     answer the moment it is given (which is what makes an interrupted wizard
 *     resumable), so a write must never be a whole-document replace.
 *
 * The merge is a recursive shallow-per-level object merge: nested objects are
 * merged key by key, arrays and scalars replace wholesale. That matches how
 * the config is shaped — `auto`, `claude`, `exec`, `context` are namespaces,
 * `claude.defaultArgs` is a value.
 *
 * Rewriting drops comments. Accepted, and stated in the contract.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';

import { FNC_CONFIG_SCHEMA_URL } from './schema';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Merge `patch` into `base`. Nested plain objects merge recursively; every
 * other value (array, string, number, boolean, null) replaces. An explicit
 * `undefined` in the patch DELETES the key, which is how the wizard clears an
 * answer the user changed their mind about.
 */
export function mergeConfig(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete out[k];
      continue;
    }
    const existing = out[k];
    out[k] = isPlainObject(existing) && isPlainObject(v) ? mergeConfig(existing, v) : v;
  }
  return out;
}

/**
 * Order the document so `$schema` is the first key. Editors don't require it,
 * but a human opening the file should see what it conforms to on line 2.
 */
function withSchemaFirst(doc: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = doc;
  return { $schema: FNC_CONFIG_SCHEMA_URL, ...rest };
}

/**
 * Read whatever document currently lives at `path` so a write can merge into
 * it. Only JSON/JSONC are read here: `path` is always a `config.json` this
 * module wrote (or is about to create). A user's hand-kept `config.toml` at
 * the same location is a DIFFERENT file that the reader still honours; the
 * first write creates `config.json` alongside it, and the reader prefers the
 * JSON from then on.
 */
function readExisting(path: string): Record<string, unknown> {
  try {
    if (!statSync(path).isFile()) return {};
  } catch {
    return {};
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  try {
    // JSON.parse handles the file this module writes. JSONC is only reachable
    // if a user renamed a commented file to .json; a parse failure there falls
    // through to {} rather than throwing away the write.
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the config at `path` and write it back as JSON with a
 * `$schema` line. Creates the directory if needed. Throws on an fs failure —
 * callers that must not fail (the migration in `load.ts`) catch.
 */
export function writeFncConfig(path: string, patch: Record<string, unknown>): void {
  const merged = withSchemaFirst(mergeConfig(readExisting(path), patch));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

/** True when `path` is a config file this module can write (i.e. JSON). */
export function isWritableConfigPath(path: string): boolean {
  return extname(path) === '.json';
}
