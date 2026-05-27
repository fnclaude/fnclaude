// Port of src/session_state.go (fnclaude/fnclaude Go reference).
//
// CWD encoding for Claude Code's project dir naming scheme, and JSONL
// permission-mode last-wins scan over a session log.

import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
 * Returns `undefined` if the file is missing, unreadable, or contains no
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
): string | undefined {
  const path = sessionJSONLPath(launchCWD, sessionID);
  let data: string;
  try {
    data = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let latest: string | undefined;
  for (const line of data.split('\n')) {
    if (line.length === 0) continue;
    let r: { type?: unknown; permissionMode?: unknown };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue; // malformed line — ignore
    }
    if (r.type === 'permission-mode' && typeof r.permissionMode === 'string' && r.permissionMode) {
      latest = r.permissionMode;
    }
  }
  return latest;
}

/**
 * Overrides that may have landed alongside the restart. When any of these
 * are set the appended reminder names them so the resumed model can briefly
 * acknowledge the change before continuing the pre-restart work.
 */
export interface RestartReminderOverrides {
  model?: string;
  effort?: string;
  permissionMode?: string;
  agent?: string;
  /** True iff `--ide` is being added on the relaunch. */
  ide?: boolean;
}

/**
 * Read the trailing entries of `data` and return the most recent `uuid`
 * field, or `undefined` if none found. Used to link the appended reminder
 * into the JSONL parent-chain.
 */
function lastEntryUUID(data: string): string | undefined {
  const lines = data.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    let parsed: { uuid?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (typeof parsed.uuid === 'string' && parsed.uuid.length > 0) {
      return parsed.uuid;
    }
  }
  return undefined;
}

/** Render the system-reminder body text, optionally naming overrides. */
export function renderRestartReminderContent(
  overrides?: RestartReminderOverrides,
): string {
  const parts: string[] = [];
  if (overrides?.model) {
    parts.push(`model swap to ${overrides.model}`);
  }
  if (overrides?.effort) {
    parts.push(`effort=${overrides.effort}`);
  }
  if (overrides?.permissionMode) {
    parts.push(`permission-mode=${overrides.permissionMode}`);
  }
  if (overrides?.agent) {
    parts.push(`agent=${overrides.agent}`);
  }
  if (overrides?.ide) {
    parts.push('--ide connected');
  }
  const overrideClause =
    parts.length > 0
      ? ` Restart-specific overrides applied: ${parts.join(', ')} — acknowledge briefly, then continue.`
      : '';
  return (
    '<system-reminder>\n' +
    'This session was restarted via fnc_restart (all prior context and the ' +
    'session JSONL are preserved). Resume the work that was in flight ' +
    'before the restart — finish the task, monitor what you were ' +
    'monitoring, surface results — rather than treating this as a fresh ' +
    'session.' +
    overrideClause +
    '\n</system-reminder>'
  );
}

/**
 * Append an `isMeta:true` user-message bearing a `<system-reminder>` block
 * to the session JSONL at `launchCWD` / `sessionID`. Best-effort: missing
 * or unreadable JSONL is silently tolerated (the restart should still
 * proceed; the reminder is a UX nicety, not a hard requirement).
 *
 * Shape matches the entries Claude Code itself emits for inline reminders
 * — `type:"user"`, `message:{role:"user",content:"<system-reminder>…</system-reminder>"}`,
 * `isMeta:true`. The `parentUuid` is linked to the most recent entry's
 * `uuid` so the resumed session reads it as a fresh terminal user turn.
 */
export function appendRestartReminder(
  launchCWD: string,
  sessionID: string,
  overrides?: RestartReminderOverrides,
): void {
  const path = sessionJSONLPath(launchCWD, sessionID);
  let existing: string;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    // No JSONL — nothing to append to. The relaunched claude will start
    // fresh anyway, so the reminder would be off-target.
    return;
  }
  // JSONL parentUuid is on the wire — keep null encoding for "no parent"
  // entries to match Claude Code's own writer.
  const parentUuid = lastEntryUUID(existing) ?? null;
  const entry = {
    parentUuid,
    isSidechain: false,
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: renderRestartReminderContent(overrides),
    },
    isMeta: true,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: 'external' as const,
    cwd: launchCWD,
    sessionId: sessionID,
  };
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort — disk full, permission denied, raced unlink, etc. The
    // restart proceeds; user gets the historical "Restarted." idle behavior
    // rather than a hard failure.
  }
}
