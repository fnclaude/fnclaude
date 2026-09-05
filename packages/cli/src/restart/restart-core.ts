/**
 * Shared restart core — the argv-build + handoff used by BOTH the MCP
 * `fnc_restart` handler and the fnc-native `//restart` slash command.
 *
 * The restart flow rebuilds the launch argv with the same magic prefix the
 * user originally typed, strips any stale session-reference flag, applies
 * caller overrides, optionally captures the live permission-mode, splices in
 * `--resume <sessionId>` immediately after the cwd positional, then stashes
 * the result + fires the handoff trigger so the awaiter (§8.5 in PTY mode, the
 * handoff awaiter) can tear claude down and re-exec fnc.
 *
 * `restart.ts` (MCP) wraps this to map the wire request → args and the result
 * → wire response. The `//restart` slash command calls it directly. Keeping
 * the argv-build + stash/fire in ONE place means both callers stay identical
 * where it matters (#205's single-`--resume` guarantee, override handling, live
 * permission capture) and only differ in how the caller sources `sessionId` and
 * who listens on the trigger.
 */

import {
  applyOverrides,
  type OverrideRequest,
  preserveArgs,
  splitLeadingMagic,
} from '../argv/preserve-args';
import type { HandoffTrigger } from '../handoff/trigger';

/** Canonical 8-4-4-4-12 hex UUID shape claude requires for `--resume`. */
const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Flags stripped from the preserved restart argv. Restart re-supplies the
 * session reference itself (`--resume <sessionId>` spliced after the cwd), so
 * any session-reference flag already present in origArgs MUST be dropped —
 * otherwise the stale flag is preserved AND a fresh one is prepended,
 * accumulating one extra `--resume` per generation (#205). Unlike a project
 * transfer, restart keeps everything else (worktree, name, add-dir, etc.) — the
 * denylist is scoped to just the session-reference flags.
 */
export const RESTART_DENY_FLAGS: ReadonlySet<string> = new Set([
  '-r',
  '--resume',
  '-c',
  '--continue',
  '-F',
  '--fork-session',
]);

/**
 * Subset of `RESTART_DENY_FLAGS` that may appear in bare (no-value) form — a
 * bare `--resume` (the picker) carries no session id. For these, `preserveArgs`
 * only consumes the following token when it isn't itself a flag, so a bare
 * occurrence doesn't swallow the next real flag.
 */
export const RESTART_DENY_BARE_OK: ReadonlySet<string> = new Set([
  '-r',
  '--resume',
  '-c',
  '--continue',
  '-F',
  '--fork-session',
]);

/**
 * Reader for the live permission-mode value claude persists in the session
 * JSONL (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). `launchCWD` is
 * bound at construction time by the caller, so the reader only takes the
 * per-call `sessionID`. Returns `null` when no value is available (file
 * missing, no matching record, etc.) — the auto-capture append is skipped in
 * that case.
 */
export type LivePermissionModeReader = (sessionID: string) => string | null;

/** Inputs for {@link buildRestartArgv} (pure — no trigger, no side effects). */
export interface BuildRestartArgvArgs {
  /** claude's session id to `--resume`. Must be a valid UUID. */
  sessionId: string;
  /** The directory fnc launched claude into — emitted as the first positional. */
  launchCWD: string;
  /** The user's original argv as fnc saw it at startup (post-readArgv). */
  origArgs: readonly string[];
  /** Caller overrides (model/effort/permission-mode/bools). */
  overrides?: OverrideRequest;
  /** Optional live permission-mode reader. Omit to disable live capture. */
  livePermissionModeReader?: LivePermissionModeReader;
}

/**
 * Build the relaunch argv:
 *   `[...magic, launchCWD, '--resume', sessionId, ...rest]`
 *
 * Preserves the user's flags (minus any stale session-reference flag), applies
 * overrides, and — when neither an override nor a preserved `--permission-mode`
 * is present and a reader is supplied — appends the live permission-mode claude
 * wrote into the session JSONL. Pure: no validation, no I/O beyond the injected
 * reader, no trigger interaction.
 */
export function buildRestartArgv(args: BuildRestartArgvArgs): string[] {
  const overrides = args.overrides ?? {};

  // Preserve user flags, stripping any stale session-reference flag so the
  // fresh `--resume <sessionId>` spliced below is the ONLY one (#205).
  const preserved = preserveArgs(args.origArgs, RESTART_DENY_FLAGS, RESTART_DENY_BARE_OK);
  let withOverrides = applyOverrides(preserved, overrides);

  // Auto-capture live permission-mode when no override was passed AND no
  // preserved flag carries one. Runs only when an injected reader is available.
  const callerSuppliedPermissionMode =
    typeof overrides.permissionMode === 'string' && overrides.permissionMode !== '';
  if (
    !callerSuppliedPermissionMode &&
    !flagPresent(withOverrides, '--permission-mode') &&
    args.livePermissionModeReader !== undefined
  ) {
    const live = args.livePermissionModeReader(args.sessionId);
    if (live !== null && live !== '') {
      withOverrides = [...withOverrides, '--permission-mode', live];
    }
  }

  const { magic, rest } = splitLeadingMagic(withOverrides);
  return [...magic, args.launchCWD, '--resume', args.sessionId, ...rest];
}

/** Inputs for {@link restartInPlace}. */
export interface RestartInPlaceArgs extends BuildRestartArgvArgs {
  /** Shared handoff trigger; first-stash-wins for argv, then fired. */
  trigger: HandoffTrigger;
}

/**
 * Outcome of {@link restartInPlace}. `ok: true` carries the built argv (already
 * stashed + fired). `ok: false` names WHY validation failed so each caller can
 * format a context-appropriate message for its own surface.
 */
export type RestartInPlaceResult =
  | { ok: true; argv: string[] }
  | { ok: false; reason: 'missing-session-id' | 'invalid-session-id' };

/**
 * Validate the session id, build the relaunch argv, stash it into the trigger
 * (first-stash-wins) and fire the trigger. The listener on the other end of the
 * trigger performs the actual kill-and-exec. Returns the built argv on success
 * or a validation failure reason.
 */
export function restartInPlace(args: RestartInPlaceArgs): RestartInPlaceResult {
  const { sessionId } = args;
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, reason: 'missing-session-id' };
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    return { ok: false, reason: 'invalid-session-id' };
  }

  const argv = buildRestartArgv(args);
  args.trigger.stashArgv(argv);
  args.trigger.fire();
  return { ok: true, argv };
}

/**
 * Returns true when `args` contains `flag` as a standalone token or in
 * `--flag=value` form. Mirrors Go canonical's `flagPresent`.
 */
function flagPresent(args: readonly string[], flag: string): boolean {
  const eqPrefix = `${flag}=`;
  for (const tok of args) {
    if (tok === flag || tok.startsWith(eqPrefix)) return true;
  }
  return false;
}
