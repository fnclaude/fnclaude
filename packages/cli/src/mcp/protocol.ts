/**
 * MCP internal wire protocol — newline-delimited JSON exchanged on the
 * parent-listener AF_UNIX socket. The `fnclaude mcp` subprocess is the
 * client; the parent fnclaude process is the server. Each connection
 * carries exactly one Request and receives exactly one Response, then
 * closes. No persistent state on the wire; each call stands on its own.
 *
 * Ported from src/mcp_protocol.go in the Go reference (fnclaude@fnrhombus).
 * Wire-format compatibility is the contract — the field names, op string
 * values, and Action string values MUST match Go byte-for-byte: in
 * production the parent listener and the `fnclaude mcp` subprocess will
 * still be a heterogeneous Go/TS pair during cutover.
 */

// ── Op ─────────────────────────────────────────────────────────────────────

/** Identifies the requested operation on the parent. */
export type Op = 'restart' | 'switch' | 'spawn' | 'copy_to_clipboard';

export const OpRestart: Op = 'restart';
export const OpSwitch: Op = 'switch';
export const OpSpawn: Op = 'spawn';
export const OpCopy: Op = 'copy_to_clipboard';

// ── Action ─────────────────────────────────────────────────────────────────

/**
 * High-level instruction the parent returns to the MCP subprocess, which
 * relays it back to claude as the tool result. Each Action maps to a
 * distinct UX claude will perform.
 */
export type Action =
  | 'done'
  | 'needs_confirmation' // deprecated, no longer emitted
  | 'auto_countdown' // deprecated, no longer emitted
  | 'paste_flow'
  | 'error';

/**
 * The requested operation has been performed. For OpSwitch this means the
 * parent will kill claude and re-exec; the MCP subprocess and claude are
 * both about to be terminated. For OpRestart and OpCopy the parent has
 * completed the work.
 */
export const ActionDone: Action = 'done';

/**
 * Deprecated. Historical — ask mode used to return this to force a
 * needs_confirmation prompt before performing the switch. The constant is
 * retained so older test fixtures that pattern-match on the literal still
 * compile.
 */
export const ActionNeedsConfirmation: Action = 'needs_confirmation';

/**
 * Deprecated. Historical — numeric mode used to return this so claude
 * would print a countdown announcement, sleep, then call the tool again
 * with confirmed=true. The cancellation-window UX now lives in the
 * prompt.
 */
export const ActionAutoCountdown: Action = 'auto_countdown';

/**
 * The parent has prepared the relaunch Command. If ClipboardOK is true
 * the command is already on the user's clipboard; otherwise claude should
 * tell the user to copy Command manually.
 */
export const ActionPasteFlow: Action = 'paste_flow';

/**
 * The parent could not perform the operation. Error is the human-readable
 * reason; claude should surface it to the user.
 */
export const ActionError: Action = 'error';

// ── Request ────────────────────────────────────────────────────────────────

/**
 * Request sent from the MCP subprocess to the parent listener.
 *
 * The wire shape uses snake_case keys (matching Go's `json:` tags). All
 * non-required fields are optional on the wire; the listener tolerates
 * missing keys.
 *
 * Override fields (Model/Effort/PermissionMode/AllowedTools/Agent and the
 * four bools) are applicable to OpRestart/OpSwitch/OpSpawn. Empty/undef
 * string values mean "preserve what was on the original command line"
 * (for restart/transfer) or "don't pass this flag" (for spawn). For
 * boolean fields: undefined = preserve existing; true = ensure present;
 * false = ensure absent.
 */
export interface Request {
  op: Op;

  /** OpRestart: required UUID — the current Claude session. */
  session_id?: string;

  /** OpSwitch / OpSpawn: destination project ref. */
  destination?: string;
  /** OpSwitch / OpSpawn: 3-6 word kebab-case session topic. */
  name?: string;
  /** OpSwitch / OpSpawn: continuity summary content. */
  summary?: string;
  /**
   * Deprecated; no longer read by the server. Left on the type so older
   * clients that still serialize confirmed=true don't break.
   */
  confirmed?: boolean;

  /** OpCopy: text to write to the clipboard. */
  text?: string;

  // Overrides.
  model?: string;
  effort?: string;
  permission_mode?: string;
  allowed_tools?: string;
  agent?: string;
  brief?: boolean | null;
  chrome?: boolean | null;
  ide?: boolean | null;
  verbose?: boolean | null;
}

// ── Response ───────────────────────────────────────────────────────────────

/** Response returned by the parent listener. */
export interface Response {
  action: Action;
  /** Natural-language guidance for claude / the user. */
  message?: string;
  /** ActionPasteFlow: literal command string the user should paste-and-run. */
  command?: string;
  /** ActionPasteFlow: whether the parent succeeded in copying Command to clipboard. */
  clipboard_ok?: boolean;
  /** ActionAutoCountdown only (deprecated). */
  countdown_seconds?: number;
  /** ActionError: human-readable reason. */
  error?: string;
}

// ── Codec ──────────────────────────────────────────────────────────────────

/**
 * Encode req as a single newline-terminated JSON line. Returned as a
 * Buffer; callers that want a string can `.toString()`.
 */
export function encodeRequest(req: Request): Buffer {
  return Buffer.from(`${JSON.stringify(req)}\n`, 'utf8');
}

/** Encode resp as a single newline-terminated JSON line. */
export function encodeResponse(resp: Response): Buffer {
  return Buffer.from(`${JSON.stringify(resp)}\n`, 'utf8');
}

/**
 * Decode one newline-terminated JSON line into a Request.
 *
 * The line may or may not include the terminating '\n'; both are accepted
 * (matches Go's bufio.ReadBytes which keeps the delimiter).
 *
 * Throws on malformed JSON.
 */
export function decodeRequest(line: string | Buffer): Request {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return JSON.parse(trimmed) as Request;
}

/** Decode one newline-terminated JSON line into a Response. */
export function decodeResponse(line: string | Buffer): Response {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return JSON.parse(trimmed) as Response;
}

/**
 * Read one newline-terminated JSON line from an async iterable of Buffer
 * chunks (e.g. a `net.Socket`). Returns the decoded Request or null if
 * the stream ended cleanly before any line was seen (analogous to Go's
 * `io.EOF` return).
 *
 * Buffers across chunk boundaries — a single line may arrive spread
 * across multiple reads. Stops at the first '\n'; bytes past it are
 * silently dropped (the wire protocol is one-line-per-connection).
 */
export async function readRequest(
  stream: AsyncIterable<Buffer | Uint8Array>,
): Promise<Request | null> {
  const line = await readLine(stream);
  if (line === null) return null;
  return decodeRequest(line);
}

/** Read one newline-terminated JSON line and decode it as a Response. */
export async function readResponse(
  stream: AsyncIterable<Buffer | Uint8Array>,
): Promise<Response | null> {
  const line = await readLine(stream);
  if (line === null) return null;
  return decodeResponse(line);
}

/** Internal — read up to and including the first '\n' from an async iter. */
async function readLine(
  stream: AsyncIterable<Buffer | Uint8Array>,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    // Search for newline in this chunk.
    const nl = buf.indexOf(0x0a);
    if (nl >= 0) {
      // Slice everything up to and including the newline; ignore any
      // trailing bytes in the same chunk (one line per connection).
      const before = chunks.slice(0, -1);
      const head = Buffer.concat([...before, buf.subarray(0, nl + 1)]);
      return head.toString('utf8');
    }
  }
  if (total === 0) return null;
  return Buffer.concat(chunks).toString('utf8');
}
