// Port of src/session_state.go (fnclaude/fnclaude Go reference).
//
// CWD encoding for Claude Code's project dir naming scheme, and JSONL
// permission-mode last-wins scan over a session log.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function home(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Encode a cwd into the directory name Claude Code uses under
 * `~/.claude/projects/`. The scheme: every character that is NOT in
 * `[A-Za-z0-9-]` is replaced with `-`. An absolute path like
 * `/home/tom/src/fnclaude@fnrhombus` becomes
 * `-home-tom-src-fnclaude-fnrhombus`. Verified empirically against real
 * on-disk session directories — claude replaces `/`, `@`, `+`, `_`, `.`,
 * and likely every other non-alphanumeric; the safe rule is the allowlist
 * above.
 */
export function encodeCWDForProjects(cwd: string): string {
  let out = '';
  for (const ch of cwd) {
    const code = ch.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isUpper = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    const isDash = ch === '-';
    out += isLower || isUpper || isDigit || isDash ? ch : '-';
  }
  return out;
}

/**
 * Resolve the path to claude's per-session JSONL log for `sessionID`
 * running in `launchCWD`. The file lives under `~/.claude/projects/`
 * using the encoded-cwd directory name. The caller is responsible for
 * checking existence.
 */
export function sessionJSONLPath(launchCWD: string, sessionID: string): string {
  const encoded = encodeCWDForProjects(launchCWD);
  return join(home(), '.claude', 'projects', encoded, `${sessionID}.jsonl`);
}

/**
 * Return the most recent permission-mode value recorded in claude's
 * session JSONL for `sessionID` under `launchCWD`.
 *
 * Claude Code persists permission mode by appending records of the form
 *
 *   {"type":"permission-mode","permissionMode":"acceptEdits|auto|bypassPermissions|default|dontAsk|plan"}
 *
 * to the per-session JSONL. The file is append-only, so a forward linear
 * scan with last-wins semantics is correct (and adequate at the file
 * sizes real sessions reach).
 *
 * Returns `""` if the file is missing, unreadable, or contains no
 * permission-mode records. Callers should fall back to startup-arg
 * preservation in that case.
 *
 * Only records whose `type` field is literally `"permission-mode"` are
 * considered. Other record types (user / assistant / system messages) may
 * also serialize a `permissionMode` field, but that's a cached snapshot —
 * not authoritative.
 */
export function readLivePermissionMode(
  launchCWD: string,
  sessionID: string,
): string {
  const path = sessionJSONLPath(launchCWD, sessionID);
  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  let latest = '';
  for (const line of data.split('\n')) {
    if (line.length === 0) continue;
    let r: { type?: unknown; permissionMode?: unknown };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue; // malformed line — ignore
    }
    if (r.type === 'permission-mode' && typeof r.permissionMode === 'string' && r.permissionMode !== '') {
      latest = r.permissionMode;
    }
  }
  return latest;
}
