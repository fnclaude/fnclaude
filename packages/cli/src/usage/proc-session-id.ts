/**
 * Resolve THIS fnc session's REAL claude session id by reading it out of the
 * fnc MCP child's `/proc` environment — the identity the context monitor pins
 * to when fnc can't know the session id up front. That "unknown up front" case
 * is `fnc resume <repo>` (bare resume), `--continue`, `--fork-session`, and the
 * resume picker: {@link planOwnSession} returns `sessionId: null` for those, and
 * the reader would otherwise fall back to an oldest-mtime GUESS that mis-pins a
 * SIBLING session's JSONL in a shared cwd (citing the wrong session's context).
 *
 * ── Why /proc, and why the MCP child (not claude itself) ─────────────────────
 * claude adopts its session id at runtime and exports `CLAUDE_CODE_SESSION_ID`
 * into its OWN environment only AFTER exec — so claude's `/proc/<pid>/environ`
 * does NOT carry it. But claude spawns fnc's own MCP server as a child (via the
 * injected `--mcp-config`; see mcp/inject-config.ts), and that child inherits
 * `CLAUDE_CODE_SESSION_ID` from claude's post-exec environment. So the reliable
 * source is: find the fnc MCP child of claude's pid and read the id from ITS
 * environ. The fnc PARENT knows claude's pid (it's the subprocess fnc spawned).
 *
 * ── Identification ───────────────────────────────────────────────────────────
 * A process is the fnc MCP child of `claudePid` iff:
 *   - its `PPid` (from `/proc/<pid>/status`) equals `claudePid`, AND
 *   - its cmdline is the fnc MCP invocation `<bun> <…/fnc[.js]> mcp [--noop]`
 *     (mcp/inject-config.ts), matched by BOTH {@link FNC_CMDLINE_RE} and
 *     {@link MCP_CMDLINE_RE}.
 * The PPid scoping is what prevents cross-session leakage: a SIBLING session's
 * MCP child has a different claude parent, so it's excluded even though its
 * cmdline also matches fnc+mcp.
 *
 * ── Platform / testability ───────────────────────────────────────────────────
 * Linux-only — there is no `/proc` elsewhere (fnc's MCP transport is already
 * Unix-only). Every `/proc` access is an injected seam ({@link ProcSessionIdDeps})
 * so unit tests never touch real `/proc`; the defaults swallow per-pid read
 * errors (a process can vanish mid-scan) and a missing `/proc` (return null).
 */

import { readFileSync, readdirSync } from 'node:fs';

import { UUID_RE } from './own-session';

/** The env var claude exports (post-exec) carrying its adopted session id. */
const SESSION_ID_ENV = 'CLAUDE_CODE_SESSION_ID';

/** Matches the fnc bin in a cmdline: `…/fnc`, `…/fnc.js`, `fnclaude`, etc. */
const FNC_CMDLINE_RE = /(^|\/)fnc/;

/** Matches the `mcp` subcommand token in a cmdline. */
const MCP_CMDLINE_RE = /\bmcp\b/;

/**
 * Injectable `/proc` access seams. Defaults read the real `/proc`; tests pass
 * fakes so nothing touches the live filesystem. `readPpid` returns `null` when
 * the status file is missing/unparseable; the read seams return `''` on any
 * error (a vanished process reads as "no match").
 */
export interface ProcSessionIdDeps {
  /** All process ids currently present (numeric `/proc` entries). */
  listPids: () => number[];
  /** The parent pid from `/proc/<pid>/status`, or `null` if unavailable. */
  readPpid: (pid: number) => number | null;
  /** `/proc/<pid>/cmdline` with NUL separators flattened to spaces. */
  readCmdline: (pid: number) => string;
  /** Raw `/proc/<pid>/environ` (NUL-separated `KEY=VALUE` pairs). */
  readEnviron: (pid: number) => string;
}

function defaultListPids(): number[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    // No /proc (non-Linux) — nothing to scan.
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    if (/^\d+$/.test(name)) {
      pids.push(Number(name));
    }
  }
  return pids;
}

function defaultReadPpid(pid: number): number | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    return null;
  }
  const m = /^PPid:\s+(\d+)/m.exec(text);
  return m !== null ? Number(m[1]) : null;
}

function defaultReadCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function defaultReadEnviron(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return '';
  }
}

/** Pull a canonical-UUID `CLAUDE_CODE_SESSION_ID` out of a raw environ blob. */
function extractSessionId(environ: string): string | null {
  if (!environ) {
    return null;
  }
  const prefix = `${SESSION_ID_ENV}=`;
  // environ pairs are NUL-separated; tolerate newline-separated fakes too.
  for (const entry of environ.split(/[\0\n]/)) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const value = entry.slice(prefix.length);
    if (UUID_RE.test(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Scan `/proc` for the fnc MCP child of `claudePid` and return the
 * `CLAUDE_CODE_SESSION_ID` it carries, or `null` when none is found. See the
 * module doc for the identification rule. Per-pid read errors are swallowed (a
 * process can vanish mid-scan); a missing `/proc` yields `null`.
 */
export function resolveOwnSessionIdViaProc(
  claudePid: number,
  deps: Partial<ProcSessionIdDeps> = {},
): string | null {
  const listPids = deps.listPids ?? defaultListPids;
  const readPpid = deps.readPpid ?? defaultReadPpid;
  const readCmdline = deps.readCmdline ?? defaultReadCmdline;
  const readEnviron = deps.readEnviron ?? defaultReadEnviron;

  let pids: number[];
  try {
    pids = listPids();
  } catch {
    return null;
  }

  for (const pid of pids) {
    try {
      if (readPpid(pid) !== claudePid) {
        continue;
      }
      const cmdline = readCmdline(pid);
      if (!FNC_CMDLINE_RE.test(cmdline) || !MCP_CMDLINE_RE.test(cmdline)) {
        continue;
      }
      const id = extractSessionId(readEnviron(pid));
      if (id !== null) {
        return id;
      }
    } catch {
      // Process vanished mid-scan / unreadable — skip it and keep looking.
    }
  }
  return null;
}

/**
 * Wrap {@link resolveOwnSessionIdViaProc} in a LAZY, cached resolver: it
 * rescans `/proc` on each call while the id is still unknown (the MCP child may
 * not have spawned yet), and once it yields a non-null id it caches and keeps
 * returning that id without rescanning. Suits the monitor's per-tick polling.
 */
export function createProcSessionIdResolver(
  claudePid: number,
  deps: Partial<ProcSessionIdDeps> = {},
): () => string | null {
  let cached: string | null = null;
  return (): string | null => {
    if (cached !== null) {
      return cached;
    }
    cached = resolveOwnSessionIdViaProc(claudePid, deps);
    return cached;
  };
}

/**
 * Build the context monitor's `ownSessionFile` resolver — the basename of THIS
 * session's own JSONL (`<session-id>.jsonl`), or `null` until it's known.
 * Identity ALWAYS beats the oldest-mtime guess:
 *   - `upfrontId` present (fresh / `--resume <uuid>` / user `--session-id`) →
 *     pin by it directly; never scan `/proc`.
 *   - `upfrontId` null but `claudePid` known (PTY-launch branch) → resolve the
 *     REAL id from the fnc MCP child's `/proc` environ. The resolver returns
 *     `null` until the id is known, keeping the monitor silent rather than
 *     guessing a sibling's file.
 *   - `upfrontId` null and no `claudePid` (e.g. renderer mode, where the spawn
 *     is owned by the renderer) → `undefined`, so the reader falls back to its
 *     legacy heuristic exactly as before.
 */
export function makeOwnSessionFileResolver(args: {
  upfrontId: string | null;
  claudePid: number | null;
  deps?: Partial<ProcSessionIdDeps>;
}): (() => string | null) | undefined {
  if (args.upfrontId !== null) {
    const file = `${args.upfrontId}.jsonl`;
    return (): string => file;
  }
  if (args.claudePid !== null) {
    const resolve = createProcSessionIdResolver(args.claudePid, args.deps);
    return (): string | null => {
      const id = resolve();
      return id !== null ? `${id}.jsonl` : null;
    };
  }
  return undefined;
}
