/**
 * MCP server subprocess — invoked by Claude Code as `fnclaude mcp [--noop]`
 * via `--mcp-config`. Reads JSON-RPC 2.0 from stdin and writes responses
 * to stdout. When a tool (fnc_restart / fnc_switch_project /
 * fnc_spawn_session / fnc_copy_to_clipboard) is invoked, dials the parent's
 * AF_UNIX socket (path in $FNC_SOCKET), sends a Request (mcp/protocol.ts),
 * reads Response, relays the outcome back to Claude as a text content item.
 *
 * Ported from src/mcp.go in the Go reference (fnclaude@fnrhombus).
 */

import { Buffer } from 'node:buffer';
import { connect, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import {
  encodeRequest,
  type Op,
  readResponse,
  type Request,
  type Response,
} from './protocol.js';
import pkg from '../../package.json' with { type: 'json' };

// ── version (read from package.json at build time) ──────────────────────────

/**
 * Binary version surfaced via the `initialize` response's serverInfo.
 * Read from package.json at build time, inlined by the TypeScript compiler
 * and bundler.
 */
export const MCP_SERVER_VERSION = pkg.version;

// ── Session ID validation ─────────────────────────────────────────────────

const SESSION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ── JSON-RPC 2.0 types ────────────────────────────────────────────────────

interface JSONRPCRequest {
  jsonrpc: string;
  id?: unknown; // null / number / string; absent for notifications
  method: string;
  params?: unknown;
}

interface JSONRPCErrorObject {
  code: number;
  message: string;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: JSONRPCErrorObject;
}

const CODE_PARSE_ERROR = -32700;
const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;

// ── MCP protocol types ────────────────────────────────────────────────────

interface MCPSchemaProperty {
  type: string;
  description: string;
}

interface MCPSchema {
  type: string;
  properties?: Record<string, MCPSchemaProperty>;
  required?: string[];
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPSchema;
}

interface MCPContent {
  type: 'text';
  text: string;
}

interface MCPCallToolResult {
  content: MCPContent[];
  isError?: boolean;
}

interface MCPCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

// ── socket dial seam (injectable for tests) ──────────────────────────────

/**
 * Dial the parent fnclaude's AF_UNIX socket at `socketPath`, send `req`,
 * and return the Response. Each invocation opens a fresh connection
 * (one-request-per-conn per the wire protocol). Throws on dial error /
 * write error / timeout / EOF without a response.
 */
export type DialFn = (socketPath: string, req: Request) => Promise<Response>;

const DEFAULT_DIAL_TIMEOUT_MS = 10_000;

export const defaultDial: DialFn = async (socketPath, req) => {
  const sock: Socket = connect(socketPath);

  // Attach an error catcher up front so an early ECONNREFUSED doesn't
  // crash the process via 'error' before we await.
  let earlyErr: Error | null = null;
  sock.on('error', (e) => {
    if (!earlyErr) earlyErr = e;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        sock.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        sock.off('connect', onConnect);
        reject(err);
      };
      const onTimeout = (): void => {
        sock.off('connect', onConnect);
        sock.off('error', onError);
        reject(new Error(`dial timeout after ${DEFAULT_DIAL_TIMEOUT_MS}ms`));
      };
      sock.once('connect', onConnect);
      sock.once('error', onError);
      // setTimeout idle timeout — bound the whole exchange.
      sock.setTimeout(DEFAULT_DIAL_TIMEOUT_MS, onTimeout);
      if (earlyErr) {
        sock.off('connect', onConnect);
        reject(earlyErr);
      }
    });

    sock.write(encodeRequest(req));
    const resp = await readResponse(sock);
    if (resp === null) {
      throw new Error('read response: EOF before any line');
    }
    return resp;
  } finally {
    sock.destroy();
  }
};

// ── Tool registration ─────────────────────────────────────────────────────

const SOCKET_UNAVAILABLE_MSG =
  'fnclaude socket unavailable; this MCP server was launched outside an fnclaude-managed session.';

const toolRestart: MCPTool = {
  name: 'fnc_restart',
  description:
    "Restart the current fnclaude session in place, preserving conversation context. Use when the user asks to restart their session. fnclaude preserves the user's original startup flags (--ide, --brief, --allowedTools, etc.); the optional override args below let you change individual flags for the restarted session when the user requests it. Args: session_id (the current Claude session ID — read it from your shell env as $CLAUDE_CODE_SESSION_ID via Bash, since the env var isn't exposed to MCP tool input directly). Optional overrides: model, effort, permission_mode, allowed_tools, agent, brief, chrome, ide, verbose.",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description:
          'The current Claude session ID. Read the value of $CLAUDE_CODE_SESSION_ID from your shell env via Bash and pass it verbatim.',
      },
      model: { type: 'string', description: 'Optional. The model alias to use for the restarted session (e.g. opus, sonnet, haiku). --model is slash-command-mutable but has no env exposure; pass it only when the user explicitly requested a model change for this restart. Omit to preserve the startup --model (or its bare-magic equivalent).' },
      effort: { type: 'string', description: "Optional. The current in-session effort level. Read `$CLAUDE_EFFORT` via Bash before calling — claude updates this env var on `/effort` slash commands, and the assistant's Bash subprocess sees the live value. Pass it verbatim. Omit if unset; fnclaude will preserve the startup --effort if any." },
      permission_mode: { type: 'string', description: "Optional. Override the permission mode. fnclaude auto-captures the live mode from this session's JSONL log, so omit unless the user explicitly requested a change for this restart." },
      allowed_tools: { type: 'string', description: 'Optional. Override --allowedTools (immutable per session; preservation from startup is the only fallback).' },
      agent: { type: 'string', description: 'Optional. Override --agent (immutable per session).' },
      brief: { type: 'boolean', description: 'Optional. true → ensure --brief is on; false → off; omit → preserve startup.' },
      chrome: { type: 'boolean', description: 'Optional. true → ensure --chrome is on; false → off; omit → preserve startup.' },
      ide: { type: 'boolean', description: 'Optional. true → ensure --ide is on; false → off; omit → preserve startup.' },
      verbose: { type: 'boolean', description: 'Optional. true → ensure --verbose is on; false → off; omit → preserve startup.' },
    },
    required: ['session_id'],
  },
};

const toolSwitchProject: MCPTool = {
  name: 'fnc_switch_project',
  description:
    'Switch this fnclaude session to a different project, carrying a continuity summary. ONE-SHOT: call once and the session is killed and re-launched at the destination. Because the call ends this session, print a brief cancellation-window line to the user (e.g. "Transferring in 3 seconds. Ctrl-C to cancel.") and run a Bash sleep BEFORE calling this tool; if the sleep completes uninterrupted, call once. fnclaude preserves the user\'s startup flags (minus a denylist of destination-bound ones like --add-dir, --mcp-config, --from-pr, --name, etc.); the optional override args below replace individual flags. Args: destination (verbatim user reference: a short repo name like \'arch-setup\', a name@owner like \'arch-setup@fnrhombus\', an owner/name like \'fnrhombus/arch-setup\', a URL, or an absolute path; a +workspace suffix is supported for worktrees), name (a 3-6 word kebab-case session topic, e.g. \'fix-auth-bug\'), summary (a /compact-style continuity summary that lets the receiving session pick up where this one left off — what the user asked for, decisions made, files touched, work in flight, open questions, user-specific observations), session_id (the current session UUID, read from $CLAUDE_CODE_SESSION_ID; used by fnclaude to auto-capture the live permission-mode from this session\'s JSONL log). Optional overrides: model, effort, permission_mode, allowed_tools, agent, brief, chrome, ide, verbose. Response.action will be done (transfer in flight), paste_flow (auto-handoff disabled — copy/paste the rendered command), or error.',
  inputSchema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'Verbatim user reference to the destination project.' },
      name: { type: 'string', description: 'A 3-6 word kebab-case session topic.' },
      summary: { type: 'string', description: 'A /compact-style continuity summary.' },
      session_id: { type: 'string', description: "Optional. The current Claude session ID (read $CLAUDE_CODE_SESSION_ID via Bash). Used by fnclaude to auto-capture live permission-mode from the session JSONL when no explicit override is set." },
      model: { type: 'string', description: 'Optional. Override --model. Slash-command-mutable but has no env exposure; pass only when the user explicitly requested a change. Omit to preserve startup --model.' },
      effort: { type: 'string', description: "Optional. The current in-session effort level. Read `$CLAUDE_EFFORT` via Bash before calling — claude updates this env var on `/effort` slash commands, and the assistant's Bash subprocess sees the live value. Pass it verbatim. Omit if unset; fnclaude will preserve the startup --effort if any." },
      permission_mode: { type: 'string', description: "Optional. Override the permission mode. fnclaude auto-captures the live mode from this session's JSONL log, so omit unless the user explicitly requested a change for this transfer." },
      allowed_tools: { type: 'string', description: 'Optional. Override --allowedTools.' },
      agent: { type: 'string', description: 'Optional. Override --agent.' },
      brief: { type: 'boolean', description: 'Optional. true → ensure --brief on; false → off; omit → preserve startup.' },
      chrome: { type: 'boolean', description: 'Optional. true → ensure --chrome on; false → off; omit → preserve startup.' },
      ide: { type: 'boolean', description: 'Optional. true → ensure --ide on; false → off; omit → preserve startup.' },
      verbose: { type: 'boolean', description: 'Optional. true → ensure --verbose on; false → off; omit → preserve startup.' },
    },
    required: ['destination', 'name', 'summary'],
  },
};

const toolSpawnSession: MCPTool = {
  name: 'fnc_spawn_session',
  description:
    "Spawn a sibling fnclaude session for a different project in a new terminal window, while leaving the CURRENT session running. Use when, in the middle of a task here, the user discovers an unrelated task in another project but doesn't want to abandon what's happening in this session. (Use fnc_switch_project instead when the current session should be replaced.) ONE-SHOT: call once; no countdown or cancellation window is needed — the current session keeps running regardless. Spawn is a fresh start — it does NOT preserve this session's startup flags; pass the optional override args when the user wants the sibling to start with explicit tooling choices. Args: destination (verbatim user reference: short repo name, name@owner, owner/name, URL, or absolute path; +workspace suffix supported), name (3-6 word kebab-case session topic for the new session, e.g. 'fix-css-bug'), summary (a /compact-style continuity summary for the new session — what the user wants done in that other project, with enough context to start cold). Optional overrides (applied to the sibling, not this session): model, effort, permission_mode, allowed_tools, agent, brief, chrome, ide, verbose. Response.action will be done (sibling launched), paste_flow (no launcher available — copy/paste the rendered command into a new terminal), or error.",
  inputSchema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'Verbatim user reference to the destination project for the sibling session.' },
      name: { type: 'string', description: 'A 3-6 word kebab-case session topic for the sibling session.' },
      summary: { type: 'string', description: "A /compact-style continuity summary scoped to the sibling session's task." },
      model: { type: 'string', description: 'Optional. --model for the sibling (e.g. opus, sonnet, haiku).' },
      effort: { type: 'string', description: 'Optional. --effort for the sibling (low, medium, high, xhigh, max). For the *current* session\'s live effort, read `$CLAUDE_EFFORT` via Bash.' },
      permission_mode: { type: 'string', description: 'Optional. --permission-mode for the sibling.' },
      allowed_tools: { type: 'string', description: 'Optional. --allowedTools for the sibling.' },
      agent: { type: 'string', description: 'Optional. --agent for the sibling.' },
      brief: { type: 'boolean', description: 'Optional. true → start sibling with --brief; false / omit → no --brief.' },
      chrome: { type: 'boolean', description: 'Optional. true → start sibling with --chrome.' },
      ide: { type: 'boolean', description: 'Optional. true → start sibling with --ide.' },
      verbose: { type: 'boolean', description: 'Optional. true → start sibling with --verbose.' },
    },
    required: ['destination', 'name', 'summary'],
  },
};

const toolCopyToClipboard: MCPTool = {
  name: 'fnc_copy_to_clipboard',
  description:
    'Copy text to the user\'s clipboard. Args: text. Useful for paste-flow handoffs when auto-switching is disabled.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to copy to the clipboard.' },
    },
    required: ['text'],
  },
};

// ── MCPServer ─────────────────────────────────────────────────────────────

export interface MCPServerOptions {
  /** When true, register fnc_switch_project + fnc_spawn_session + fnc_copy_to_clipboard. When false, register fnc_restart + fnc_switch_project + fnc_spawn_session. */
  noop: boolean;
  /** Stdin source for JSON-RPC requests. */
  stdin: Readable;
  /** Stdout sink for JSON-RPC responses. */
  stdout: Writable;
  /** Parent fnclaude's AF_UNIX socket path; empty string = no parent. */
  socketPath: string;
  /** Override the dial implementation — tests stub this. */
  dial?: DialFn;
}

/**
 * MCP server entry point. Reads newline-delimited JSON-RPC 2.0 messages
 * from stdin and writes responses to stdout. Returns 0 on clean stdin
 * EOF, non-zero on a protocol error that's worth aborting on.
 */
export async function runMCPServer(opts: MCPServerOptions): Promise<number> {
  const dial = opts.dial ?? defaultDial;
  const reader = new LineReader(opts.stdin);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await reader.readLine();
    if (line === null) return 0; // clean EOF
    try {
      await handleLine(opts, dial, line);
    } catch (err) {
      // Sending an error response is the right behavior; abort the loop
      // only if the write itself fails.
      try {
        const msg = (err as Error).message;
        sendError(opts.stdout, null, CODE_PARSE_ERROR, `parse error: ${msg}`);
      } catch {
        return 1;
      }
    }
  }
}

async function handleLine(
  opts: MCPServerOptions,
  dial: DialFn,
  line: string,
): Promise<void> {
  let req: JSONRPCRequest;
  try {
    req = JSON.parse(line) as JSONRPCRequest;
  } catch (err) {
    sendError(opts.stdout, null, CODE_PARSE_ERROR, `parse error: ${(err as Error).message}`);
    return;
  }

  // Notifications (no id) are fire-and-forget.
  if (req.id === undefined) {
    // notifications/initialized is the standard handshake completion ack.
    // No state to flip in this lean port (Go tracks `initialized` but
    // never gates on it).
    return;
  }

  const method = req.method;
  switch (method) {
    case 'initialize':
      handleInitialize(opts.stdout, req);
      return;
    case 'tools/list':
      handleToolsList(opts, req);
      return;
    case 'tools/call':
      await handleToolsCall(opts, dial, req);
      return;
    default:
      sendError(opts.stdout, req.id, CODE_METHOD_NOT_FOUND, `method not found: ${JSON.stringify(method)}`);
  }
}

function handleInitialize(stdout: Writable, req: JSONRPCRequest): void {
  sendResult(stdout, req.id, {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'fnclaude', version: MCP_SERVER_VERSION },
  });
}

function handleToolsList(opts: MCPServerOptions, req: JSONRPCRequest): void {
  sendResult(opts.stdout, req.id, { tools: toolsFor(opts.noop) });
}

async function handleToolsCall(
  opts: MCPServerOptions,
  dial: DialFn,
  req: JSONRPCRequest,
): Promise<void> {
  let params: MCPCallToolParams;
  try {
    params = (req.params ?? {}) as MCPCallToolParams;
  } catch (err) {
    sendError(opts.stdout, req.id, CODE_INVALID_PARAMS, `invalid params: ${(err as Error).message}`);
    return;
  }

  const args = (params.arguments ?? {}) as Record<string, unknown>;
  switch (params.name) {
    case 'fnc_restart':
      await callRestart(opts, dial, req.id, args);
      return;
    case 'fnc_switch_project':
      await callSwitch(opts, dial, req.id, args);
      return;
    case 'fnc_spawn_session':
      await callSpawn(opts, dial, req.id, args);
      return;
    case 'fnc_copy_to_clipboard':
      await callCopy(opts, dial, req.id, args);
      return;
    default:
      sendError(opts.stdout, req.id, CODE_METHOD_NOT_FOUND, `unknown tool: ${JSON.stringify(params.name)}`);
  }
}

// ── tool handlers ─────────────────────────────────────────────────────────

function toolsFor(noop: boolean): MCPTool[] {
  if (noop) {
    return [toolSwitchProject, toolSpawnSession, toolCopyToClipboard];
  }
  // fnc_restart is always registered: Claude Code does not propagate
  // CLAUDE_CODE_SESSION_ID into MCP stdio subprocess envs (upstream
  // #24371 closed "not planned"), so any env-based gate would
  // permanently omit the tool. Session id flows through the model
  // instead — it reads $CLAUDE_CODE_SESSION_ID via Bash and passes it
  // as the fnc_restart session_id argument.
  return [toolRestart, toolSwitchProject, toolSpawnSession];
}

function readStringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function readBoolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === 'boolean' ? v : undefined;
}

async function callRestart(
  opts: MCPServerOptions,
  dial: DialFn,
  id: unknown,
  args: Record<string, unknown>,
): Promise<void> {
  if (opts.socketPath === '') {
    sendToolError(opts.stdout, id, SOCKET_UNAVAILABLE_MSG);
    return;
  }
  const sid = readStringArg(args, 'session_id');
  if (sid === '') {
    sendToolError(
      opts.stdout,
      id,
      'fnc_restart requires session_id: read it from your shell env ($CLAUDE_CODE_SESSION_ID) via Bash and pass it as the session_id argument.',
    );
    return;
  }
  if (!SESSION_ID_PATTERN.test(sid)) {
    sendToolError(
      opts.stdout,
      id,
      `session_id ${JSON.stringify(sid)} is not a valid UUID; the value of $CLAUDE_CODE_SESSION_ID should match the 8-4-4-4-12 hex form.`,
    );
    return;
  }
  const req: Request = {
    op: 'restart' satisfies Op,
    session_id: sid,
    model: readStringArg(args, 'model'),
    effort: readStringArg(args, 'effort'),
    permission_mode: readStringArg(args, 'permission_mode'),
    allowed_tools: readStringArg(args, 'allowed_tools'),
    agent: readStringArg(args, 'agent'),
    brief: readBoolArg(args, 'brief'),
    chrome: readBoolArg(args, 'chrome'),
    ide: readBoolArg(args, 'ide'),
    verbose: readBoolArg(args, 'verbose'),
  };
  await dialAndRelay(opts, dial, id, req);
}

async function callSwitch(
  opts: MCPServerOptions,
  dial: DialFn,
  id: unknown,
  args: Record<string, unknown>,
): Promise<void> {
  if (opts.socketPath === '') {
    sendToolError(opts.stdout, id, SOCKET_UNAVAILABLE_MSG);
    return;
  }
  const req: Request = {
    op: 'switch' satisfies Op,
    destination: readStringArg(args, 'destination'),
    name: readStringArg(args, 'name'),
    summary: readStringArg(args, 'summary'),
    confirmed: readBoolArg(args, 'confirmed') === true,
    session_id: readStringArg(args, 'session_id'),
    model: readStringArg(args, 'model'),
    effort: readStringArg(args, 'effort'),
    permission_mode: readStringArg(args, 'permission_mode'),
    allowed_tools: readStringArg(args, 'allowed_tools'),
    agent: readStringArg(args, 'agent'),
    brief: readBoolArg(args, 'brief'),
    chrome: readBoolArg(args, 'chrome'),
    ide: readBoolArg(args, 'ide'),
    verbose: readBoolArg(args, 'verbose'),
  };
  await dialAndRelay(opts, dial, id, req);
}

async function callSpawn(
  opts: MCPServerOptions,
  dial: DialFn,
  id: unknown,
  args: Record<string, unknown>,
): Promise<void> {
  if (opts.socketPath === '') {
    sendToolError(opts.stdout, id, SOCKET_UNAVAILABLE_MSG);
    return;
  }
  const req: Request = {
    op: 'spawn' satisfies Op,
    destination: readStringArg(args, 'destination'),
    name: readStringArg(args, 'name'),
    summary: readStringArg(args, 'summary'),
    confirmed: readBoolArg(args, 'confirmed') === true,
    model: readStringArg(args, 'model'),
    effort: readStringArg(args, 'effort'),
    permission_mode: readStringArg(args, 'permission_mode'),
    allowed_tools: readStringArg(args, 'allowed_tools'),
    agent: readStringArg(args, 'agent'),
    brief: readBoolArg(args, 'brief'),
    chrome: readBoolArg(args, 'chrome'),
    ide: readBoolArg(args, 'ide'),
    verbose: readBoolArg(args, 'verbose'),
  };
  await dialAndRelay(opts, dial, id, req);
}

async function callCopy(
  opts: MCPServerOptions,
  dial: DialFn,
  id: unknown,
  args: Record<string, unknown>,
): Promise<void> {
  if (opts.socketPath === '') {
    sendToolError(opts.stdout, id, SOCKET_UNAVAILABLE_MSG);
    return;
  }
  const req: Request = {
    op: 'copy_to_clipboard' satisfies Op,
    text: readStringArg(args, 'text'),
  };
  await dialAndRelay(opts, dial, id, req);
}

async function dialAndRelay(
  opts: MCPServerOptions,
  dial: DialFn,
  id: unknown,
  req: Request,
): Promise<void> {
  let resp: Response;
  try {
    resp = await dial(opts.socketPath, req);
  } catch (err) {
    sendToolError(opts.stdout, id, (err as Error).message);
    return;
  }
  sendToolResult(opts.stdout, id, resp);
}

// ── result / error helpers ────────────────────────────────────────────────

function sendResult(stdout: Writable, id: unknown, result: unknown): void {
  writeResponse(stdout, { jsonrpc: '2.0', id, result });
}

function sendError(
  stdout: Writable,
  id: unknown,
  code: number,
  message: string,
): void {
  writeResponse(stdout, {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message },
  });
}

/**
 * Send an MCP tool-level error result (isError=true, content with the
 * error message). Distinct from a JSON-RPC protocol error — the JSON-RPC
 * call succeeded but the tool operation failed.
 */
function sendToolError(stdout: Writable, id: unknown, msg: string): void {
  sendResult(stdout, id, {
    isError: true,
    content: [{ type: 'text', text: msg }],
  } satisfies MCPCallToolResult);
}

/**
 * Marshal the Response as JSON and return it as a single text content
 * item. Claude reads JSON tool results fine; the Action + Message +
 * Command + ClipboardOK + CountdownSeconds + Error fields carry all the
 * UX guidance the prompt needs.
 */
function sendToolResult(stdout: Writable, id: unknown, resp: Response): void {
  let text: string;
  try {
    text = JSON.stringify(resp);
  } catch (err) {
    sendToolError(stdout, id, `internal marshal error: ${(err as Error).message}`);
    return;
  }
  sendResult(stdout, id, {
    content: [{ type: 'text', text }],
  } satisfies MCPCallToolResult);
}

function writeResponse(stdout: Writable, resp: JSONRPCResponse): void {
  stdout.write(`${JSON.stringify(resp)}\n`);
}

// ── stdin line reader ─────────────────────────────────────────────────────

/**
 * Buffer reader for newline-delimited stdin. Holds a leftover Buffer
 * across `readLine` calls so the stream can deliver multiple lines per
 * chunk and partial lines across chunks.
 */
class LineReader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private pending: ((line: string | null) => void) | null = null;

  constructor(private readonly stream: Readable) {
    stream.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      this.tryDeliver();
    });
    stream.on('end', () => {
      this.ended = true;
      this.tryDeliver();
    });
    stream.on('close', () => {
      this.ended = true;
      this.tryDeliver();
    });
  }

  readLine(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.pending = resolve;
      this.tryDeliver();
    });
  }

  private tryDeliver(): void {
    if (!this.pending) return;
    const nl = this.buf.indexOf(0x0a);
    if (nl >= 0) {
      const line = this.buf.subarray(0, nl + 1).toString('utf8');
      this.buf = this.buf.subarray(nl + 1);
      const cb = this.pending;
      this.pending = null;
      cb(line);
      return;
    }
    if (this.ended) {
      const cb = this.pending;
      this.pending = null;
      if (this.buf.length === 0) {
        cb(null);
      } else {
        const tail = this.buf.toString('utf8');
        this.buf = Buffer.alloc(0);
        cb(tail);
      }
    }
  }
}
