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
 * Injecting through that same `term.write` puts input exactly where the
 * user's keystrokes go. But claude enables bracketed-paste mode (DEC
 * 2004), so a single `"<line>\r"` write is lexed as a PASTE and the
 * trailing `\r` never submits — it lands in the box as literal text.
 * Submitting therefore takes TWO writes: the body bracketed-paste-wrapped
 * (no CR), then a SEPARATE bare `\r` that lexes as a standalone Return
 * keypress. See {@link injectSubmittedLine}, which every consumer (the
 * Batch-2 tools and the context-size notice) routes through.
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

import type { ParentDispatchHandler } from '../parent-dispatch';
import type { WireRequest, WireResponse } from '../wire';

/**
 * Sink for the formatted slash-command payload. In production this wraps
 * `Bun.Terminal.write`; in tests it's a spy. Synchronous and
 * fire-and-forget — the contract is "hand these bytes to the PTY", not
 * "wait for claude to process them".
 */
export type PtyWriter = (payload: string) => void;

/** Bracketed-paste start sequence (DEC mode 2004). */
const PASTE_START = '\x1b[200~';
/** Bracketed-paste end sequence. */
const PASTE_END = '\x1b[201~';
/** Bare carriage return — the Return keypress claude's line editor submits on. */
const SUBMIT_CR = '\r';
/** Default gap (ms) between the pasted body and the first submit CR. */
const DEFAULT_ENTER_DELAY_MS = 10;
/** Default gap (ms) between successive submit CRs when `crCount` > 1. */
export const DEFAULT_CR_INTERVAL_MS = 1000;

/**
 * Seams for {@link injectSubmittedLine}. `write` is the PTY sink; `schedule`
 * and `enterDelayMs` exist so unit tests can run the writes synchronously
 * (`schedule: (fn) => fn()`) and assert their exact order without a real timer.
 * `crCount`/`crIntervalMs`/`shouldSubmit` drive the retry-CR behavior (see
 * {@link injectSubmittedLine}); all default to the single-CR-immediately shape
 * so existing callers are unchanged.
 */
export interface InjectSubmittedLineDeps {
  /** The PTY input sink. */
  write: PtyWriter;
  /** Timer seam for the separate CR write(s). Defaults to {@link setTimeout}. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the FIRST CR write. Defaults to {@link DEFAULT_ENTER_DELAY_MS}. */
  enterDelayMs?: number;
  /**
   * How many submit CRs to fire (clamped to ≥ 1). Default 1 — the generic
   * slash tools keep the single-CR behavior. Control messages pass > 1 so a
   * submit swallowed while claude ingests a large paste is retried.
   */
  crCount?: number;
  /** Gap between successive CRs when `crCount` > 1. Defaults to {@link DEFAULT_CR_INTERVAL_MS}. */
  crIntervalMs?: number;
  /**
   * Checked at EACH CR's fire time; the CR is skipped when it returns false.
   * Default `() => true`. Callers wire this to a "user is drafting" predicate
   * so a late retry CR never submits a line the user has since started typing.
   */
  shouldSubmit?: () => boolean;
}

/**
 * Submit one line into the live claude TUI so it is actually DISPATCHED,
 * not just dropped into the input box.
 *
 * Why two writes. claude enables bracketed-paste mode (DEC 2004). A single
 * bulk `term.write("<text>\r")` is therefore lexed as a PASTE: the trailing
 * `\r` is buffered as literal text (a newline inside the input box) and is
 * never delivered as a Return keypress — the line lands but never submits.
 * This mirrors claude's own internal injector, which:
 *
 *   1. writes the body on its own, bracketed-paste wrapped, with NO trailing
 *      CR (`\x1b[200~` + body + `\x1b[201~`) — this also keeps a multi-line
 *      body intact as one input rather than N submitted turns; then
 *   2. after a short delay, writes a bare `\r` as a SEPARATE write so it
 *      lexes as a standalone Return keypress and submits the pasted line.
 *
 * The body and the CR MUST be separate writes with a gap between them.
 *
 * Retry CRs. A SINGLE CR after a large paste is unreliable: for a long body
 * the Return fires while claude is still ingesting/collapsing the paste, so it
 * is swallowed and the line never submits (observed live — sometimes it only
 * lands when the next injection appends to the buffer, merging two turns). When
 * `crCount` > 1 we therefore fire that many CRs, spaced `crIntervalMs` apart
 * (`enterDelayMs + i*crIntervalMs`), so a stuck submit gets re-sent until it
 * takes. `shouldSubmit` is re-checked at each CR's fire time and skips that CR
 * when false — the guard that stops a LATE retry from submitting a line the
 * user has since started typing (their fresh draft). `crCount` is clamped to
 * ≥ 1. Fire-and-forget: returns once the body is written; the CRs are
 * scheduled, not awaited.
 */
export function injectSubmittedLine(text: string, deps: InjectSubmittedLineDeps): void {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const enterDelayMs = deps.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS;
  const crIntervalMs = deps.crIntervalMs ?? DEFAULT_CR_INTERVAL_MS;
  const crCount = Math.max(1, deps.crCount ?? 1);
  const shouldSubmit = deps.shouldSubmit ?? ((): boolean => true);

  deps.write(`${PASTE_START}${text}${PASTE_END}`);
  for (let i = 0; i < crCount; i++) {
    schedule(() => {
      if (shouldSubmit()) deps.write(SUBMIT_CR);
    }, enterDelayMs + i * crIntervalMs);
  }
}

/**
 * Format a slash command + optional args into the BODY of a submitted
 * prompt line — no trailing CR. The separate Return keypress is supplied by
 * {@link injectSubmittedLine}, which the consumers route through; embedding
 * the CR here is the bug (a single `body\r` write is swallowed by claude's
 * bracketed-paste mode).
 *
 *   - Always single leading slash, regardless of whether the caller
 *     passed `"compact"` or `"/compact"`.
 *   - Args joined by single spaces after the command.
 *
 * Examples:
 *   formatSlashCommand('compact')              → "/compact"
 *   formatSlashCommand('/effort', ['high'])    → "/effort high"
 *   formatSlashCommand('model', ['opus 4.8'])  → "/model opus 4.8"
 */
export function formatSlashCommand(command: string, args: readonly string[] = []): string {
  const bare = command.startsWith('/') ? command.slice(1) : command;
  const head = `/${bare}`;
  const tail = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `${head}${tail}`;
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
  /**
   * Timer seam threaded into {@link injectSubmittedLine} for the separate
   * CR write. Defaults (inside the primitive) to {@link setTimeout}. Tests
   * pass a synchronous `(fn) => fn()` so the two writes land deterministically.
   */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the CR write, threaded into {@link injectSubmittedLine}. */
  enterDelayMs?: number;
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
 * On success it SUBMITS the formatted line via {@link injectSubmittedLine}
 * (bracketed-paste body + a separate CR) and returns `{ action: 'queued' }`.
 * It never blocks on, reads, or returns command output.
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

    // Fire-and-forget: submit the line (formatSlashCommand returns the body
    // only; injectSubmittedLine supplies the Return keypress) and return
    // immediately. No output capture — the model does not get the output.
    injectSubmittedLine(formatSlashCommand(command, cmdArgs), {
      write,
      schedule: args.schedule,
      enterDelayMs: args.enterDelayMs,
    });

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
