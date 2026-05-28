/**
 * TS port of Go canonical's `session_state.go` — reads the most recent
 * permission-mode claude wrote into its per-session JSONL log.
 *
 * Claude Code appends records of the form
 *
 *   {"type":"permission-mode","permissionMode":"acceptEdits|auto|bypassPermissions|default|dontAsk|plan"}
 *
 * to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` whenever the
 * user toggles permission mode in-session. fnclaude reads the latest
 * value back during §8.1 (restart) and §8.2 (switch) so the relaunched
 * session inherits whatever the user landed on, not whatever flag the
 * session was originally launched with.
 *
 * Three exports mirror the Go shape:
 *
 *   - `encodeCWDForProjects(cwd)` — pure transform: every char NOT in
 *     `[A-Za-z0-9-]` collapses to `-`. Verified empirically against real
 *     on-disk session directories (claude replaces `/`, `@`, `+`, `_`,
 *     `.`, … — the safe rule is the allowlist).
 *   - `sessionJSONLPath(launchCWD, sessionID)` — joins HOME +
 *     `.claude/projects` + encoded-cwd + `<sid>.jsonl`.
 *   - `readLivePermissionMode(launchCWD, sessionID)` — opens, last-wins
 *     scan, returns `null` on miss/error/unreadable.
 *
 * Sync IO via `readFileSync` is fine here: session JSONLs are
 * bounded-size and the call only fires on MCP-dispatched restart/switch,
 * never on a hot path. Streaming would add complexity without benefit.
 *
 * Only `type === "permission-mode"` records are authoritative — other
 * record types (user / assistant / system messages) may serialize a
 * cached `permissionMode` snapshot which is NOT the source of truth per
 * the Go canonical's comment.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Encode `cwd` into the directory name claude uses under
 * `~/.claude/projects/`. The scheme: every character that is NOT in
 * `[A-Za-z0-9-]` becomes `-`. A canonical absolute path like
 * `/home/tom/src/fnclaude@fnclaude` encodes to
 * `-home-tom-src-fnclaude-fnclaude`.
 */
export function encodeCWDForProjects(cwd: string): string {
  let out = '';
  for (const ch of cwd) {
    if (
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-'
    ) {
      out += ch;
    } else {
      out += '-';
    }
  }
  return out;
}

/**
 * Returns the absolute path to claude's per-session JSONL log for
 * `sessionID` running in `launchCWD`. Caller is responsible for
 * checking existence — `readLivePermissionMode` handles ENOENT itself.
 */
export function sessionJSONLPath(launchCWD: string, sessionID: string): string {
  return join(resolveHome(), '.claude', 'projects', encodeCWDForProjects(launchCWD), `${sessionID}.jsonl`);
}

/**
 * Reads the most recent `permission-mode` value recorded in claude's
 * session JSONL for `sessionID` under `launchCWD`. Returns `null` if:
 *
 *   - the file doesn't exist (ENOENT) or is unreadable,
 *   - the file exists but contains no `{type:"permission-mode",...}`
 *     records, or
 *   - every such record has an empty `permissionMode` field.
 *
 * Last-wins semantics: claude's JSONL is append-only, so a forward
 * linear scan returns the most-recently-written value. Malformed lines
 * are skipped silently (defensive against partial writes / future
 * record-shape changes).
 */
export function readLivePermissionMode(launchCWD: string, sessionID: string): string | null {
  const path = sessionJSONLPath(launchCWD, sessionID);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // ENOENT / EACCES / EISDIR / anything else → no live override.
    return null;
  }

  let latest: string | null = null;
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // malformed line — ignore
    }
    if (typeof rec !== 'object' || rec === null) continue;
    const obj = rec as Record<string, unknown>;
    if (obj.type !== 'permission-mode') continue;
    const mode = obj.permissionMode;
    if (typeof mode !== 'string' || mode === '') continue;
    latest = mode;
  }
  return latest;
}

/**
 * HOME resolution. Reads `process.env.HOME` first — it's the canonical
 * source on POSIX, respects per-test env overrides, and is what `claude`
 * itself uses to find `~/.claude/`. Falls back to `homedir()` for the
 * rare case the env var is unset (cron, bare systemd unit), and to `''`
 * if even that throws (defensive — mirrors Go's `os.UserHomeDir()` →
 * `os.Getenv("HOME")` fallback chain, just with the order reversed
 * because `homedir()` caches in Bun and `process.env.HOME` doesn't).
 */
function resolveHome(): string {
  const fromEnv = process.env.HOME;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return homedir();
  } catch {
    return '';
  }
}
