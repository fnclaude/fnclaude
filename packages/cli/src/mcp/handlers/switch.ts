/**
 * §8.2 — `fnc_switch_project` handler.
 *
 * Spec (specs/design.mcp.md §4.2):
 *   - Required args: `destination`, `name`, `summary`.
 *   - Optional: override fields (`model`, `effort`, `permission_mode`,
 *     `allowed_tools`, `agent`, `brief`, `chrome`, `ide`, `verbose`) and
 *     `session_id` (for live permission-mode capture).
 *
 * Algorithm:
 *   1. Validate the three required strings; missing one → `action: 'error'`.
 *   2. Write `summary` to `<base>/fnclaude-handoff-content-<16hex>.md`
 *      (mode 0600) via `writeSummaryFile`.
 *   3. If `permission_mode === 'never'`: build the relaunch command,
 *      copy it to the clipboard, return `action: 'paste_flow'`. The
 *      current session keeps running.
 *   4. Otherwise:
 *      - `preserved = preserveArgs(origArgs, TRANSFER_DENY_FLAGS, TRANSFER_DENY_BARE_OK)`
 *      - `withOverrides = applyOverrides(preserved, req)`
 *      - If no permission_mode override AND no preserved permission-mode
 *        AND `session_id` is present → live-capture from session JSONL
 *        and append `--permission-mode <live>`.
 *      - `{magic, rest} = splitLeadingMagic(withOverrides)`
 *      - argv = `[...magic, destination, ...rest, '--name', name, '@' + summaryPath]`
 *      - `trigger.stashArgv(argv)` + `trigger.fire()`.
 *      - Return `action: 'done'`.
 *
 * Side effects (clipboard exec, file write, trigger fire) all flow
 * through injected dependencies so unit tests stay hermetic. Production
 * callers in main.ts wire the real `handoffTrigger` singleton and the
 * real clipboard / summary-file modules.
 */

import {
  applyOverrides,
  preserveArgs,
  splitLeadingMagic,
  TRANSFER_DENY_BARE_OK,
  TRANSFER_DENY_FLAGS,
  type OverrideRequest,
} from '../../argv/preserve-args';
import { writeSummaryFile, type BaseDirResolver } from '../../handoff/summary-file';
import type { HandoffTrigger } from '../../handoff/trigger';
import type { ParentDispatchHandler } from '../parent-dispatch';
import type { WireRequest, WireResponse } from '../wire';
import { handleCopyToClipboard } from './clipboard';

/**
 * Read the most recent live permission-mode value from claude's
 * per-session JSONL. Returns null when no record exists or the file
 * isn't reachable. The default factory returns null (live capture is a
 * Wave-2 §8.1/§8.2 add; the §8.2 commit ships the wiring, the JSONL
 * reader lands separately).
 */
export type LivePermissionModeReader = (sessionId: string) => string | null;

const NULL_LIVE_PERMISSION_READER: LivePermissionModeReader = () => null;

/**
 * Write-summary seam — defaults to {@link writeSummaryFile}. Tests pass
 * a stub that records the call and returns a deterministic path.
 */
export type WriteSummaryFn = (args: {
  summary: string;
  baseDir?: BaseDirResolver;
}) => Promise<{ path: string }>;

/**
 * Clipboard seam — defaults to {@link handleCopyToClipboard}. Same
 * signature as the §8.4 handler so production wiring is a direct
 * reference, no adapter needed.
 */
export type CopyToClipboardFn = (req: WireRequest) => Promise<WireResponse>;

export interface CreateSwitchHandlerArgs {
  /**
   * The os.argv[1:] snapshot captured at fnclaude startup. Used to
   * preserve user-supplied flags across the relaunch (minus the
   * transfer denylist).
   */
  origArgs: readonly string[];
  /** Shared handoff trigger — receives `stashArgv` + `fire` on success. */
  trigger: HandoffTrigger;
  /**
   * Optional live permission-mode reader (defaults to a null stub).
   * Production wiring passes the session-JSONL reader from §8.1/§8.2.
   */
  livePermissionModeReader?: LivePermissionModeReader;
  /** Optional summary-file write seam (defaults to `writeSummaryFile`). */
  writeSummary?: WriteSummaryFn;
  /** Optional clipboard handler seam (defaults to `handleCopyToClipboard`). */
  handleCopyToClipboard?: CopyToClipboardFn;
  /** Optional base-dir resolver — forwarded to the summary-file writer. */
  baseDirResolver?: BaseDirResolver;
}

/**
 * Build a `ParentDispatchHandler` bound to the parent's startup state.
 * The returned function is what main.ts plugs into
 * `createParentDispatcher`'s `handlers.switch` slot.
 */
export function createSwitchHandler(args: CreateSwitchHandlerArgs): ParentDispatchHandler {
  const liveReader = args.livePermissionModeReader ?? NULL_LIVE_PERMISSION_READER;
  const writeSummary = args.writeSummary ?? writeSummaryFile;
  const copyToClipboard = args.handleCopyToClipboard ?? handleCopyToClipboard;
  const baseDir = args.baseDirResolver;

  return async (req: WireRequest): Promise<WireResponse> => {
    const destination = stringField(req, 'destination');
    const name = stringField(req, 'name');
    const summary = stringField(req, 'summary');

    if (destination === '' || name === '' || summary === '') {
      const missing: string[] = [];
      if (destination === '') missing.push('destination');
      if (name === '') missing.push('name');
      if (summary === '') missing.push('summary');
      return {
        action: 'error',
        error: `switch requires ${missing.join(', ')}`,
      };
    }

    let summaryPath: string;
    try {
      const r = await writeSummary({ summary, baseDir });
      summaryPath = r.path;
    } catch (err) {
      return {
        action: 'error',
        error: `write summary: ${(err as Error).message}`,
      };
    }

    const overrides = overrideRequestFrom(req);
    const sessionId = stringField(req, 'session_id');

    // Never-mode paste-flow branch. Render the command, copy it, return
    // action='paste_flow'. The current session keeps running — no
    // stashArgv, no fire.
    //
    // 'never' is a control signal, not a real permission-mode value:
    // strip it from the overrides before rendering so the relaunch
    // command the user pastes is a valid invocation. Go canonical
    // (which branches on cfg.Auto.Handoff="never" instead) gets the
    // same result by not having a `--permission-mode never` token to
    // begin with.
    if (overrides.permissionMode === 'never') {
      const pasteOverrides: OverrideRequest = { ...overrides, permissionMode: undefined };
      const preserved = preserveArgs(args.origArgs, TRANSFER_DENY_FLAGS, TRANSFER_DENY_BARE_OK);
      const withOverrides = applyOverrides(preserved, pasteOverrides);
      const { magic, rest } = splitLeadingMagic(withOverrides);
      const command = renderSwitchCommand(magic, destination, rest, name, summaryPath);
      const clipResp = await copyToClipboard({
        op: 'copy_to_clipboard',
        text: command,
      });
      const clipboardOk = clipResp.clipboard_ok === true;
      const message = clipboardOk
        ? "I've prepared the handoff command (already on your clipboard)."
        : 'Copy this command and run it:';
      return {
        action: 'paste_flow',
        message,
        command,
        clipboard_ok: clipboardOk,
      };
    }

    // Normal switch branch. Preserve user flags from startup (minus
    // the transfer denylist), apply MCP overrides, auto-capture the
    // live permission mode when neither side supplied one, then split
    // magic from rest and build the relaunch argv.
    const preserved = preserveArgs(args.origArgs, TRANSFER_DENY_FLAGS, TRANSFER_DENY_BARE_OK);
    let withOverrides = applyOverrides(preserved, overrides);

    const hasPermissionOverride =
      overrides.permissionMode !== undefined && overrides.permissionMode !== '';
    if (!hasPermissionOverride && !flagPresent(withOverrides, '--permission-mode') && sessionId !== '') {
      const live = liveReader(sessionId);
      if (live !== null && live !== '') {
        withOverrides = [...withOverrides, '--permission-mode', live];
      }
    }
    const { magic, rest } = splitLeadingMagic(withOverrides);

    const argv: string[] = [
      ...magic,
      destination,
      ...rest,
      '--name',
      name,
      `@${summaryPath}`,
    ];
    args.trigger.stashArgv(argv);
    args.trigger.fire();
    return { action: 'done' };
  };
}

/**
 * Build the user-visible relaunch command string for paste-flow
 * responses. Mirrors `renderSwitchCommand` in the Go canonical
 * (src/socket_listener.go:451). Magic words come first, then the
 * destination, then the preserved/override flags, then
 * `--name <name> @<summaryPath>`.
 *
 * Each token is shell-safe enough as-is: override values come from a
 * controlled vocabulary (model aliases, effort levels, permission
 * modes, allowedTools comma-list, agent names), and the summary path
 * is `<base>/fnclaude-handoff-content-<hex>.md` — no whitespace, no
 * metacharacters.
 */
function renderSwitchCommand(
  magic: readonly string[],
  destination: string,
  rest: readonly string[],
  name: string,
  summaryPath: string,
): string {
  const parts: string[] = ['fnclaude', ...magic, destination, ...rest, '--name', name, `@${summaryPath}`];
  return parts.join(' ');
}

/**
 * Coerce wire-request fields into an `OverrideRequest`. Wire keys use
 * snake_case per the JSON contract; the override struct uses
 * camelCase. Unknown / missing / wrong-type fields collapse to
 * undefined so `applyOverrides` falls through to its preserve branch.
 */
function overrideRequestFrom(req: WireRequest): OverrideRequest {
  return {
    model: stringFieldOrUndef(req, 'model'),
    effort: stringFieldOrUndef(req, 'effort'),
    permissionMode: stringFieldOrUndef(req, 'permission_mode'),
    allowedTools: stringFieldOrUndef(req, 'allowed_tools'),
    agent: stringFieldOrUndef(req, 'agent'),
    brief: boolFieldOrUndef(req, 'brief'),
    chrome: boolFieldOrUndef(req, 'chrome'),
    ide: boolFieldOrUndef(req, 'ide'),
    verbose: boolFieldOrUndef(req, 'verbose'),
  };
}

function stringField(req: WireRequest, key: string): string {
  const v = req[key];
  return typeof v === 'string' ? v : '';
}

function stringFieldOrUndef(req: WireRequest, key: string): string | undefined {
  const v = req[key];
  return typeof v === 'string' ? v : undefined;
}

function boolFieldOrUndef(req: WireRequest, key: string): boolean | undefined {
  const v = req[key];
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Whether `args` carries `flag` as a bare token or as `flag=value`.
 * Mirrors Go canonical's `flagPresent` (src/socket_listener.go:260).
 */
function flagPresent(argsArr: readonly string[], flag: string): boolean {
  const prefix = `${flag}=`;
  for (const t of argsArr) {
    if (t === flag || t.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
