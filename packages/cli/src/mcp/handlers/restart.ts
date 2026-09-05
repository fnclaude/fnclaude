/**
 * §8.1 — `fnc_restart` handler.
 *
 * Ports the Go canonical `handleRestart` from
 * `fnclaude/src/socket_listener.go` lines 221-256. This handler is
 * now a THIN wire adapter over the shared {@link restartInPlace} core
 * (`../../restart/restart-core`): it validates the wire request shape, maps
 * snake_case override fields → the core's `OverrideRequest`, delegates the
 * argv-build + stash/fire, then maps the core result back to a wire response.
 * The `//restart` slash command calls the same core, so the two paths stay in
 * lockstep on the #205 single-`--resume` guarantee, overrides, and live
 * permission-mode capture.
 *
 * Design: specs/design.mcp.md §4.1, §5; specs/design.md §12-13.
 */

import type { OverrideRequest } from '../../argv/preserve-args';
import type { HandoffTrigger } from '../../handoff/trigger';
import {
  type LivePermissionModeReader,
  restartInPlace,
} from '../../restart/restart-core';
import type { ParentDispatchHandler } from '../parent-dispatch';
import type { WireRequest, WireResponse } from '../wire';

export type { LivePermissionModeReader };

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

    const result = restartInPlace({
      sessionId: sessionID,
      launchCWD,
      origArgs,
      // Apply MCP-supplied overrides. Wire snake_case → OverrideRequest camelCase.
      overrides: wireToOverrideRequest(req),
      trigger,
      ...(livePermissionModeReader !== undefined ? { livePermissionModeReader } : {}),
    });

    if (!result.ok) {
      // `missing-session-id` is already handled above; only the invalid-UUID
      // case can reach here.
      return {
        action: 'error',
        error: `session_id ${JSON.stringify(sessionID)} is not a valid UUID; expected the 8-4-4-4-12 hex form.`,
      };
    }
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
