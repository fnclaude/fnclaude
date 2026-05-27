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
 * Shared override fields applicable to OpRestart / OpSwitch / OpSpawn.
 *
 * Empty/undef string values mean "preserve what was on the original
 * command line" (for restart/transfer) or "don't pass this flag" (for
 * spawn). For boolean fields: undefined = preserve existing; true =
 * ensure present; false = ensure absent.
 */
export interface RequestOverrides {
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

/**
 * Discriminated union of Request variants — exactly one shape per Op.
 * Adding a new Op requires extending this union *and* every `switch`
 * over `req.op` (the dispatcher uses an exhaustive-never check so the
 * compiler enforces this).
 *
 * The wire shape uses snake_case keys (matching Go's `json:` tags). All
 * non-required fields are optional on the wire; the listener tolerates
 * missing keys.
 */
export type Request =
  | RestartRequest
  | SwitchRequest
  | SpawnRequest
  | CopyRequest;

/** OpRestart: restart the current session in place. */
export interface RestartRequest extends RequestOverrides {
  op: 'restart';
  /** Required UUID — the current Claude session. */
  session_id?: string;
}

/** OpSwitch: kill claude and relaunch at destination. */
export interface SwitchRequest extends RequestOverrides {
  op: 'switch';
  /** Destination project ref. */
  destination?: string;
  /** 3-6 word kebab-case session topic. */
  name?: string;
  /** Continuity summary content. */
  summary?: string;
  /**
   * Optional UUID for live-permission-mode auto-capture. Used to read the
   * session JSONL when no explicit permission_mode override was set.
   */
  session_id?: string;
  /**
   * Deprecated; no longer read by the server. Left on the type so older
   * clients that still serialize confirmed=true don't break.
   */
  confirmed?: boolean;
}

/** OpSpawn: launch a sibling fnclaude in a new window. */
export interface SpawnRequest extends RequestOverrides {
  op: 'spawn';
  /** Destination project ref. */
  destination?: string;
  /** 3-6 word kebab-case session topic. */
  name?: string;
  /** Continuity summary content. */
  summary?: string;
  /**
   * Deprecated; no longer read by the server. Left on the type so older
   * clients that still serialize confirmed=true don't break.
   */
  confirmed?: boolean;
}

/** OpCopy: write text to the clipboard. Carries no override fields. */
export interface CopyRequest {
  op: 'copy_to_clipboard';
  /** Text to write to the clipboard. */
  text?: string;
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
 * Throws on malformed JSON or on payloads that fail boundary validation
 * (see `validateRequest` for the rules). Wire input is untrusted —
 * anything that knows the socket path can submit JSON, and the dispatcher
 * acts on it (re-exec, file writes, clipboard). Validate before handing
 * to the dispatcher rather than scattering checks across handlers.
 */
export function decodeRequest(line: string | Buffer): Request {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  const raw: unknown = JSON.parse(trimmed);
  return validateRequest(raw);
}

// ── Request validation ─────────────────────────────────────────────────────

/**
 * Maximum byte length for each string field on a Request. Values are sized
 * to the field's job:
 *   - overrides (model, effort, permission_mode, agent): short identifiers
 *   - allowed_tools: comma-joined tool names, room for ~30 longest
 *   - session_id: UUID-shaped, but we don't pre-validate the shape here
 *     (that lives in the handler so the error message can mention UUID)
 *   - destination / name: filesystem paths / kebab-case names
 *   - text (clipboard): bounded for typical clipboard payloads
 *   - summary: continuity blob — generous but bounded; a malicious peer
 *     submitting hundreds of MB would otherwise wedge the writeFile path
 */
const STRING_LIMITS: Record<string, number> = {
  // Shared overrides
  model: 64,
  effort: 64,
  permission_mode: 64,
  allowed_tools: 4096,
  agent: 256,
  // Restart / switch / spawn
  session_id: 128,
  destination: 4096,
  name: 256,
  summary: 1024 * 1024, // 1 MiB
  // Copy
  text: 1024 * 1024, // 1 MiB
};

/** Discriminated union of fields legal for each Op. */
const STRING_FIELDS_BY_OP: Record<Op, readonly string[]> = {
  restart: ['session_id', 'model', 'effort', 'permission_mode', 'allowed_tools', 'agent'],
  switch: [
    'destination',
    'name',
    'summary',
    'session_id',
    'model',
    'effort',
    'permission_mode',
    'allowed_tools',
    'agent',
  ],
  spawn: [
    'destination',
    'name',
    'summary',
    'model',
    'effort',
    'permission_mode',
    'allowed_tools',
    'agent',
  ],
  copy_to_clipboard: ['text'],
};

const BOOL_FIELDS: readonly string[] = ['brief', 'chrome', 'ide', 'verbose', 'confirmed'];

/** Field names that are filesystem paths and must reject ".." traversal. */
const PATH_FIELDS: readonly string[] = ['destination'];

const KNOWN_OPS: readonly Op[] = ['restart', 'switch', 'spawn', 'copy_to_clipboard'];

/**
 * Validate a parsed JSON value as a Request. Returns the validated value
 * (typed as Request) on success; throws Error with a human-readable
 * reason on failure. The caller (`decodeRequest`) is the only intended
 * entry point — handlers consume the typed Request and trust its shape.
 *
 * Checks performed:
 *  1. Value is a plain object (not array, null, or scalar).
 *  2. `op` is one of the four known string discriminants.
 *  3. Every string field on the per-op allowlist is either absent or a
 *     string under its byte-length cap, with no null bytes.
 *  4. Path-shaped fields (`destination`) additionally reject `..`
 *     segments (delimited by `/` or string ends).
 *  5. Boolean override fields are either absent, true, false, or null
 *     (null is treated as "preserve existing" by handlers).
 *
 * Unknown extra keys are tolerated (forward compatibility with newer
 * clients) but their values are not validated.
 */
export function validateRequest(value: unknown): Request {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request must be a JSON object');
  }
  const obj = value as Record<string, unknown>;
  const op = obj.op;
  if (typeof op !== 'string' || !KNOWN_OPS.includes(op as Op)) {
    throw new Error(`unknown op ${JSON.stringify(op)}`);
  }
  const allowed = STRING_FIELDS_BY_OP[op as Op];
  for (const field of allowed) {
    const v = obj[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      throw new Error(`field ${field} must be a string`);
    }
    if (v.includes('\x00')) {
      throw new Error(`field ${field} contains a null byte`);
    }
    const cap = STRING_LIMITS[field] ?? 1024;
    if (Buffer.byteLength(v, 'utf8') > cap) {
      throw new Error(`field ${field} exceeds max length ${cap}`);
    }
    if (PATH_FIELDS.includes(field) && hasParentSegment(v)) {
      throw new Error(`field ${field} contains a path-traversal segment ("..")`);
    }
  }
  for (const field of BOOL_FIELDS) {
    const v = obj[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') {
      throw new Error(`field ${field} must be a boolean`);
    }
  }
  return obj as unknown as Request;
}

/**
 * Returns true when the path contains a literal `..` segment — i.e. `..`
 * delimited by `/` (or by start/end of the string). Catches `../etc`,
 * `/foo/../bar`, `foo/..`, and bare `..`; ignores `foo..bar` and any
 * other substring where `..` is part of a larger name.
 */
function hasParentSegment(p: string): boolean {
  // Split on '/' is sufficient — POSIX path semantics, and a Windows
  // backslash path would never be a legitimate destination on the wire.
  return p.split('/').includes('..');
}

/** Decode one newline-terminated JSON line into a Response. */
export function decodeResponse(line: string | Buffer): Response {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return JSON.parse(trimmed) as Response;
}

/**
 * A minimal Readable surface: `on('data' | 'end' | 'error' | 'close', ...)`.
 * Both Node's `net.Socket` and the Readable streams from `node:stream`
 * satisfy this. We deliberately avoid `for await ... of` on the socket —
 * breaking out of that loop calls the iterator's return() which
 * **destroys the underlying socket**, preventing the response write.
 */
export interface DataStream {
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end' | 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  off(event: 'data', listener: (chunk: Buffer) => void): this;
  off(event: 'end' | 'close', listener: () => void): this;
  off(event: 'error', listener: (err: Error) => void): this;
}

/**
 * Read one newline-terminated JSON line from a data-emitting stream (a
 * `net.Socket` is the common case). Returns the decoded Request or
 * undefined if the stream ended cleanly before any line was seen
 * (analogous to Go's `io.EOF` return).
 *
 * Buffers across chunk boundaries. Stops at the first '\n'; bytes past
 * it are silently dropped (the wire protocol is one-line-per-connection).
 *
 * Crucially, this does NOT use `for await ... of socket` — that
 * iterator's automatic cleanup destroys the socket on break/return,
 * which would prevent the caller from writing the response back. The
 * event-listener form leaves the socket fully writable.
 */
export async function readRequest(stream: DataStream): Promise<Request | undefined> {
  const line = await readLine(stream);
  if (line === undefined) return undefined;
  return decodeRequest(line);
}

/** Read one newline-terminated JSON line and decode it as a Response. */
export async function readResponse(stream: DataStream): Promise<Response | undefined> {
  const line = await readLine(stream);
  if (line === undefined) return undefined;
  return decodeResponse(line);
}

/** Internal — read up to and including the first '\n' via stream events. */
async function readLine(stream: DataStream): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onError);
    };
    const settle = (value: string | undefined, err?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (raw: Buffer): void => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        chunks.push(buf);
        total += buf.length;
        return;
      }
      // Slice everything up to and including the newline; drop trailing
      // bytes in the same chunk (one line per connection).
      const head = Buffer.concat([...chunks, buf.subarray(0, nl + 1)]);
      settle(head.toString('utf8'));
    };
    const onEnd = (): void => {
      if (total === 0) {
        settle(undefined);
        return;
      }
      settle(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (err: Error): void => settle(undefined, err);

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
  });
}
