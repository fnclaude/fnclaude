/**
 * C0 — Slash-command injection keystone.
 *
 * This is the parent-side primitive that the Batch-2 MCP tools
 * (`fnc_request_compact`, `fnc_set_effort`, `fnc_set_model`,
 * `fnc_run_slash_command`) all build on. It does ONE thing: format a
 * queued slash command and write it into the live `Bun.Terminal` input
 * of the running claude TUI, exactly where the user's own keystrokes go.
 *
 * Mechanism. main.ts (§9.0) forwards user stdin into claude with
 * `term.write(chunk)` — raw-mode bytes straight onto the PTY master.
 * Injecting `/<cmd> [args]\r` through that same `term.write` makes the
 * TUI see it as a typed-and-submitted prompt line. The trailing `\r`
 * (carriage return) is the Enter keypress; that's what a real terminal
 * delivers when the user hits return, and what claude's line editor
 * reads as "submit".
 *
 * Fire-and-forget. The handler returns `{ action: 'queued' }` the moment
 * the bytes are handed to the writer. There is deliberately NO output
 * capture: we do not read, buffer, or surface anything the command
 * prints back to the model. The model asked for the command to run; it
 * does not get the command's output back through this path.
 *
 * Testability seam. The PTY write is injected as a `PtyWriter` function
 * rather than reached for directly, so unit tests can assert the exact
 * bytes without a real terminal. main.ts binds the real writer (a thin
 * wrapper over `term.write`) once the terminal exists — see
 * {@link createPtyWriterHolder} for the deferred-binding shape that
 * bridges "dispatcher wired before spawn" against "term created at spawn".
 *
 * ── How Batch 2 calls this ──────────────────────────────────────────
 * The four follow-on tools do NOT each re-implement injection. They
 * translate their own MCP args into a `(command, args)` pair and call
 * the handler this module builds. Sketch:
 *
 *     // fnc_request_compact  → "/compact"            (no args)
 *     // fnc_set_effort        → "/effort", [level]
 *     // fnc_set_model         → "/model",  [name]
 *     // fnc_run_slash_command → "/<command>", [...rest]
 *
 * Wire them by registering new WireOps that route to a handler built
 * with `createInjectSlashHandler`, reading the command + args from the
 * WireRequest fields each tool defines. The keystone stays generic: it
 * neither knows nor validates which slash commands exist — that's the
 * per-tool layer's job. Keep this handler unregistered as a user-facing
 * tool; it is internal-only.
 */

import type { ParentDispatchHandler } from '../parent-dispatch.ts';
import type { WireRequest, WireResponse } from '../wire.ts';

/**
 * Sink for the formatted slash-command payload. In production this wraps
 * `Bun.Terminal.write`; in tests it's a spy. Synchronous and
 * fire-and-forget — the contract is "hand these bytes to the PTY", not
 * "wait for claude to process them".
 */
export type PtyWriter = (payload: string) => void;

/**
 * Format a slash command + optional args into the exact byte string the
 * TUI accepts as a submitted prompt line.
 *
 *   - Always single leading slash, regardless of whether the caller
 *     passed `"compact"` or `"/compact"`.
 *   - Args joined by single spaces after the command.
 *   - Trailing `\r` is the Enter keypress (submit). NOT `\n` — a real
 *     terminal sends CR for the return key under raw mode.
 *
 * Examples:
 *   formatSlashCommand('compact')              → "/compact\r"
 *   formatSlashCommand('/effort', ['high'])    → "/effort high\r"
 *   formatSlashCommand('model', ['opus 4.8'])  → "/model opus 4.8\r"
 */
export function formatSlashCommand(command: string, args: readonly string[] = []): string {
  const bare = command.startsWith('/') ? command.slice(1) : command;
  const head = `/${bare}`;
  const tail = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `${head}${tail}\r`;
}

export interface InjectSlashRequest extends WireRequest {
  /** Slash command name, with or without the leading slash. Required. */
  command?: unknown;
  /** Optional positional args appended after the command. */
  args?: unknown;
}

export interface CreateInjectSlashHandlerArgs {
  /**
   * The PTY input sink. Injected so the handler is unit-testable without
   * a live terminal. May be a {@link createPtyWriterHolder} `.write` that
   * is bound late (after the terminal spawns).
   */
  write: PtyWriter;
}

/**
 * Build the slash-injection handler with its PTY writer bound. The
 * returned function plugs straight into the parent dispatcher's handler
 * map under whatever WireOp the Batch-2 tools route on.
 *
 * Validation is minimal by design — the keystone only refuses a missing
 * or empty command (so we never inject a bare `/\r`). Everything else
 * (which commands are valid, arg shapes) belongs to the per-tool layer.
 *
 * On success it writes the formatted payload and returns
 * `{ action: 'queued' }`. It never blocks on, reads, or returns command
 * output.
 */
export function createInjectSlashHandler(args: CreateInjectSlashHandlerArgs): ParentDispatchHandler {
  const { write } = args;

  return async (req: WireRequest): Promise<WireResponse> => {
    const r = req as InjectSlashRequest;

    if (typeof r.command !== 'string' || r.command.trim() === '') {
      return {
        action: 'error',
        error: 'inject_slash requires a non-empty command string.',
      };
    }

    const command = r.command.trim();
    const cmdArgs = normalizeArgs(r.args);

    const payload = formatSlashCommand(command, cmdArgs);

    // Fire-and-forget: hand the bytes to the PTY and return immediately.
    // No output capture — the model does not get the command's output.
    write(payload);

    return { action: 'queued' };
  };
}

/**
 * Coerce the wire `args` field into a clean string array. Accepts a
 * string array (each element stringified defensively), a single string
 * (treated as one arg), or nothing. Non-string array elements are
 * stringified so a sloppy caller can't inject `[object Object]`-shaped
 * surprises silently — they become their `String()` form, which the
 * per-tool layer is expected to have validated already.
 */
function normalizeArgs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') return raw === '' ? [] : [raw];
  if (Array.isArray(raw)) {
    return raw.filter((v) => v !== undefined && v !== null).map((v) => String(v));
  }
  return [];
}

/**
 * Deferred-binding holder for the PTY writer.
 *
 * The MCP dispatcher is wired BEFORE claude spawns (main.ts binds it so
 * the subprocess can dial back the instant it starts), but the
 * `Bun.Terminal` whose `.write` we need only exists AFTER the spawn. This
 * holder closes that gap: hand `holder.write` to
 * `createInjectSlashHandler` at wiring time, then call `holder.bind(fn)`
 * once the terminal is live.
 *
 * Before `bind`, a `write` call is a no-op that records nothing was
 * delivered — the handler still returns `queued` (fire-and-forget
 * contract), but the bytes are dropped. In practice the terminal is bound
 * microseconds after spawn and long before any tool call can arrive, so
 * the unbound window is not reachable by a real dispatch; the no-op is
 * purely defensive.
 */
export interface PtyWriterHolder {
  /** The {@link PtyWriter} to hand to `createInjectSlashHandler`. */
  write: PtyWriter;
  /** Bind the real sink once the terminal exists. Last bind wins. */
  bind: (fn: PtyWriter) => void;
  /** True once a sink has been bound — for diagnostics/tests. */
  isBound: () => boolean;
}

export function createPtyWriterHolder(): PtyWriterHolder {
  let sink: PtyWriter | null = null;
  return {
    write: (payload: string) => {
      if (sink !== null) sink(payload);
    },
    bind: (fn: PtyWriter) => {
      sink = fn;
    },
    isBound: () => sink !== null,
  };
}
