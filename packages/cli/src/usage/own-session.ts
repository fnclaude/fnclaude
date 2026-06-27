/**
 * Resolve THIS session's own claude session id for the context monitor.
 *
 * The context monitor must read its OWN session JSONL
 * (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) to report context
 * size. It used to GUESS which file was its own (oldest post-baseline
 * `*.jsonl`), which mis-pins when two sessions run in the same cwd — the
 * second session reads the first's (fatter) file and cites its token curve.
 *
 * fnc spawns claude, so it can instead KNOW the id rather than guess:
 *   - Fresh interactive session → mint a UUID and inject `--session-id <uuid>`.
 *     claude writes `<uuid>.jsonl`; fnc knows the exact path with no round-trip.
 *   - `--resume <uuid>` (no fork) → claude reuses that id + file; parse it.
 *   - User already passed `--session-id <uuid>` → use it, inject nothing.
 *   - `--continue`, `--fork-session`, resume-without-uuid, or `--print` → the
 *     id isn't knowable up front; return `null` and let the caller fall back
 *     to the legacy heuristic (no worse than today for these rarer shapes).
 *
 * Flag detection covers BOTH `--flag value` and `--flag=value` forms: claude
 * (commander-based) accepts the `=` form, and fnc's short-flag/alias expansion
 * passes long `--flag=value` tokens through verbatim, so a `--resume=<uuid>`
 * must be recognised as a resume — otherwise it would be misread as a fresh
 * session and get a conflicting injected `--session-id` (which claude rejects).
 *
 * Pure over `(claudeArgs, mintUuid)` — the UUID source is an injected seam so
 * the planner is unit-testable without `crypto`.
 */

/** Canonical 8-4-4-4-12 hex UUID shape claude requires for `--session-id`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnSessionPlan {
  /** The session id once known up front, else `null` (caller falls back). */
  sessionId: string | null;
  /**
   * Flag tokens to inject into `claudeArgs` so claude adopts the minted id
   * (`['--session-id', '<uuid>']`), or `[]` when nothing should be injected.
   */
  inject: readonly string[];
}

/** Is `flag` present in either `--flag` or `--flag=value` form? */
function flagPresent(args: readonly string[], flag: string): boolean {
  return args.some((t) => t === flag || t.startsWith(`${flag}=`));
}

/**
 * Value for `flag`, supporting both `--flag value` (next token) and
 * `--flag=value` (suffix). The `=` form is checked first so it wins even when
 * a bare `--flag` also appears. `undefined` when the flag is absent or has no
 * value (e.g. `--resume` as the last token, the resume picker).
 */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const eqPrefix = `${flag}=`;
  for (const tok of args) {
    if (tok.startsWith(eqPrefix)) return tok.slice(eqPrefix.length);
  }
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function anyFlagPresent(args: readonly string[], flags: readonly string[]): boolean {
  return flags.some((f) => flagPresent(args, f));
}

/**
 * Decide how the context monitor learns this session's own JSONL. See the
 * module doc for the full decision table. `claudeArgs` is the fully-assembled
 * claude argv (post short-flag/alias expansion); `mintUuid` supplies a fresh
 * UUID for the fresh-session case.
 */
export function planOwnSession(
  claudeArgs: readonly string[],
  mintUuid: () => string,
): OwnSessionPlan {
  // Print: decline to mint/inject — there is no own context to pin. (The
  // monitor itself is gated elsewhere; the point here is simply not to add a
  // `--session-id` to a print invocation.)
  if (anyFlagPresent(claudeArgs, ['--print', '-p'])) return { sessionId: null, inject: [] };

  // User already pinned a session id → honour it, inject nothing. If they
  // passed `--session-id` with a malformed value, don't inject a second one
  // (claude will reject theirs); just decline to track.
  if (flagPresent(claudeArgs, '--session-id')) {
    const userId = flagValue(claudeArgs, '--session-id');
    return { sessionId: userId !== undefined && UUID_RE.test(userId) ? userId : null, inject: [] };
  }

  // Resume <uuid> WITHOUT a fork → claude reuses that id and appends to the
  // same file. A fork mints a new id we can't know up front.
  if (!flagPresent(claudeArgs, '--fork-session')) {
    const resumeId = flagValue(claudeArgs, '--resume') ?? flagValue(claudeArgs, '-r');
    if (resumeId !== undefined && UUID_RE.test(resumeId)) {
      return { sessionId: resumeId, inject: [] };
    }
  }

  // Continue / fork / resume-picker (no uuid) → id not knowable up front.
  if (anyFlagPresent(claudeArgs, ['--continue', '-c', '--fork-session', '--resume', '-r'])) {
    return { sessionId: null, inject: [] };
  }

  // Fresh interactive session → mint + inject so claude adopts our id.
  const id = mintUuid();
  return { sessionId: id, inject: ['--session-id', id] };
}
