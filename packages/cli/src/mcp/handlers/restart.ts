/**
 * §8.1 — `fnc_restart` handler.
 *
 * Ports the Go canonical `handleRestart` from
 * `fnclaude@fnrhombus/src/socket_listener.go` lines 221-256. The
 * restart flow rebuilds the launch argv with the same magic prefix the
 * user originally typed, swaps in `--resume <session_id>` immediately
 * after the cwd positional, applies MCP-supplied overrides, then stashes
 * the result + fires the handoff trigger so §8.5's awaiter can SIGTERM
 * claude and re-exec fnc with the new argv.
 *
 * Algorithm (matches Go canonical):
 *   1. Validate session_id present + UUID 8-4-4-4-12 hex.
 *   2. `preserveArgs(origArgs, ∅, ∅)` — restart uses NO denylist.
 *   3. `applyOverrides(preserved, req)` — splices in MCP overrides.
 *   4. If no caller-supplied permission_mode AND no preserved
 *      `--permission-mode`, ask the injected `livePermissionModeReader`
 *      for the value claude wrote into the session JSONL. The reader is
 *      optional; production wiring stubs it out for now (TODO file IO).
 *   5. Split the leading magic-word run; rebuild argv as:
 *        `[...magic, launchCWD, '--resume', sid, ...rest]`
 *   6. `trigger.stashArgv(argv)` (first-stash-wins).
 *   7. `trigger.fire()` to wake §8.5's awaiter.
 *   8. Respond `{ action: 'done' }`.
 *
 * Design: docs/design.mcp.md §4.1, §5; docs/design.md §12-13.
 */

import {
  applyOverrides,
  preserveArgs,
  splitLeadingMagic,
  type OverrideRequest,
} from '../../argv/preserve-args.ts';
import type { HandoffTrigger } from '../../handoff/trigger.ts';
import type { ParentDispatchHandler } from '../parent-dispatch.ts';
import type { WireRequest, WireResponse } from '../wire.ts';

const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Flags stripped from the preserved restart argv. Restart re-supplies the
 * session reference itself (`--resume <session_id>` spliced after the cwd),
 * so any session-reference flag already present in origArgs MUST be dropped
 * — otherwise the stale flag is preserved AND a fresh one is prepended,
 * accumulating one extra `--resume` per generation (#205). Unlike a project
 * transfer, restart keeps everything else (worktree, name, add-dir, etc.) —
 * the denylist is scoped to just the session-reference flags.
 */
const RESTART_DENY_FLAGS: ReadonlySet<string> = new Set([
  '-r',
  '--resume',
  '-c',
  '--continue',
  '-F',
  '--fork-session',
]);

/**
 * Subset of `RESTART_DENY_FLAGS` that may appear in bare (no-value) form —
 * a bare `--resume` (the picker) carries no session id. For these,
 * `preserveArgs` only consumes the following token when it isn't itself a
 * flag, so a bare occurrence doesn't swallow the next real flag.
 */
const RESTART_DENY_BARE_OK: ReadonlySet<string> = new Set([
  '-r',
  '--resume',
  '-c',
  '--continue',
  '-F',
  '--fork-session',
]);

/**
 * Reader for the live permission-mode value claude persists in the
 * session JSONL (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`).
 * `launchCWD` is bound at construction time in main.ts, so the reader
 * only takes the per-call `sessionID`. Returns `null` when no value is
 * available (file missing, no matching record, etc.) — the auto-capture
 * append is skipped in that case. Same shape as switch.ts uses, so a
 * single closure can be wired into both handlers.
 */
export type LivePermissionModeReader = (sessionID: string) => string | null;

export interface CreateRestartHandlerArgs {
  /** The user's original argv as fnc saw it at startup (post-readArgv). */
  origArgs: readonly string[];
  /** The directory fnc launched claude into — emitted as the first positional. */
  launchCWD: string;
  /** Shared handoff trigger; first-stash-wins for argv. */
  trigger: HandoffTrigger;
  /** Optional injected reader. Omit to disable live-capture entirely. */
  livePermissionModeReader?: LivePermissionModeReader;
}

/**
 * Build the restart handler with all collaborators bound. Returned
 * function plugs straight into `createParentDispatcher({ handlers: { restart, ... } })`.
 */
export function createRestartHandler(args: CreateRestartHandlerArgs): ParentDispatchHandler {
  const { origArgs, launchCWD, trigger, livePermissionModeReader } = args;

  return async (req: WireRequest): Promise<WireResponse> => {
    const sessionID = req.session_id;
    if (typeof sessionID !== 'string' || sessionID === '') {
      return {
        action: 'error',
        error:
          'restart requires a session id; pass it as the fnc_restart session_id argument (read $CLAUDE_CODE_SESSION_ID via Bash).',
      };
    }
    if (!SESSION_ID_RE.test(sessionID)) {
      return {
        action: 'error',
        error: `session_id ${JSON.stringify(sessionID)} is not a valid UUID; expected the 8-4-4-4-12 hex form.`,
      };
    }

    // Preserve user flags, stripping any stale session-reference flag
    // (--resume / --continue / --fork-session) so the fresh `--resume
    // <session_id>` spliced below is the ONLY one — otherwise it accumulates
    // one extra copy per restart generation (#205).
    const preserved = preserveArgs(origArgs, RESTART_DENY_FLAGS, RESTART_DENY_BARE_OK);

    // Apply MCP-supplied overrides. Wire snake_case → OverrideRequest camelCase.
    const overrides = wireToOverrideRequest(req);
    let withOverrides = applyOverrides(preserved, overrides);

    // Auto-capture live permission-mode when no override was passed AND
    // no preserved flag carries one. Mirrors Go canonical — runs only
    // when an injected reader is available.
    const permissionModeFromReq = req.permission_mode;
    const callerSuppliedPermissionMode =
      typeof permissionModeFromReq === 'string' && permissionModeFromReq !== '';
    if (
      !callerSuppliedPermissionMode &&
      !flagPresent(withOverrides, '--permission-mode') &&
      livePermissionModeReader !== undefined
    ) {
      const live = livePermissionModeReader(sessionID);
      if (live !== null && live !== '') {
        withOverrides = [...withOverrides, '--permission-mode', live];
      }
    }

    const { magic, rest } = splitLeadingMagic(withOverrides);
    const argv: string[] = [...magic, launchCWD, '--resume', sessionID, ...rest];

    trigger.stashArgv(argv);
    trigger.fire();
    return { action: 'done' };
  };
}

/**
 * Translate the wire request's snake_case override fields into the
 * `OverrideRequest` shape `applyOverrides` consumes. Fields not present
 * (or of the wrong type) are silently omitted — the caller's MCP layer
 * validates shapes; defensive typing here just keeps applyOverrides safe.
 */
function wireToOverrideRequest(req: WireRequest): OverrideRequest {
  const out: OverrideRequest = {};
  if (typeof req.model === 'string' && req.model !== '') out.model = req.model;
  if (typeof req.effort === 'string' && req.effort !== '') out.effort = req.effort;
  if (typeof req.permission_mode === 'string' && req.permission_mode !== '') {
    out.permissionMode = req.permission_mode;
  }
  if (typeof req.allowed_tools === 'string' && req.allowed_tools !== '') {
    out.allowedTools = req.allowed_tools;
  }
  if (typeof req.agent === 'string' && req.agent !== '') out.agent = req.agent;
  if (typeof req.brief === 'boolean') out.brief = req.brief;
  if (typeof req.chrome === 'boolean') out.chrome = req.chrome;
  if (typeof req.ide === 'boolean') out.ide = req.ide;
  if (typeof req.verbose === 'boolean') out.verbose = req.verbose;
  return out;
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
