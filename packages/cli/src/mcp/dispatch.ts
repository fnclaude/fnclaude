/**
 * MCP subcommand dispatch. fnc's first arg of "mcp" routes to the embedded
 * JSON-RPC subprocess (the one claude invokes via the injected
 * --mcp-config; see docs/design.mcp.md §2).
 *
 * §2.7 contributed the routing wrapper. §7.5 wires the entry point and
 * the per-tool wire handlers. §7.3 wrote the JSON-RPC scaffold
 * (`createJsonRpcServer`); this module is what connects the two — building
 * the `tools` record and `initializeResponse` from the tool schemas, then
 * pumping stdin lines through `server.handle()` to stdout.
 *
 * Before this wiring landed, the per-line handler was a placeholder that
 * only routed `tools/call` and returned `-32601 method not implemented`
 * for everything else. Claude's first message in the MCP handshake is
 * `initialize`; that error broke the connect handshake outright in cli
 * 2.0.0 and the model never saw the four tools. The fix is to route every
 * method through `createJsonRpcServer`.
 *
 * Matches Go canonical's dispatch shape (src/main.go:879-887): mcp
 * subcommand recognized ONLY at argv[0], '--noop' is the sole flag that
 * affects server behavior, anything else is ignored.
 */

import { readFileSync } from 'node:fs';

import { createJsonRpcServer, type McpTool as JsonRpcMcpTool } from './jsonrpc-server';
import { TOOL_SCHEMAS } from './tool-schemas';
import { dialAndCall, type WireOp, type WireRequest, type WireResponse } from './wire';

const SUBCOMMAND = 'mcp';
const NOOP_FLAG = '--noop';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_SERVER_NAME = 'fnclaude';

export function isMcpSubcommand(args: readonly string[]): boolean {
  return args.length > 0 && args[0] === SUBCOMMAND;
}

export interface McpFlags {
  noop: boolean;
}

export function parseMcpFlags(tail: readonly string[]): McpFlags {
  return { noop: tail.includes(NOOP_FLAG) };
}

/**
 * The four tool names exposed by the subprocess, per design.mcp.md §4.
 * Order matches the spec table; consumers should not depend on order
 * but `tools/list` rendering is deterministic if they do.
 */
export const MCP_TOOL_NAMES = [
  'fnc_restart',
  'fnc_switch_project',
  'fnc_spawn_session',
  'fnc_copy_to_clipboard',
  'request_compact',
  'fnc_set_effort',
  'fnc_set_model',
  'fnc_run_slash_command',
  'get_usage',
  'fnc_sessions',
  'fnc_claim',
  'fnc_release',
  'fnc_ask',
  'fnc_await',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * The generic slash tool (C4) is opt-in: it injects arbitrary slash
 * commands into the live TUI and stays out of the tool list unless the
 * operator enables it with `FNC_ENABLE_SLASH_TOOL=1`. The remaining tools
 * are always registered.
 */
const OPT_IN_TOOLS: ReadonlySet<McpToolName> = new Set(['fnc_run_slash_command']);

function toolEnabled(name: McpToolName, env: Record<string, string | undefined>): boolean {
  if (!OPT_IN_TOOLS.has(name)) return true;
  return env.FNC_ENABLE_SLASH_TOOL === '1';
}

/**
 * Mapping from the MCP-visible tool name to the wire `op` value the
 * parent dispatcher routes on. See design.mcp.md §4.
 */
const TOOL_TO_OP: Record<McpToolName, WireOp> = {
  fnc_restart: 'restart',
  fnc_switch_project: 'switch',
  fnc_spawn_session: 'spawn',
  fnc_copy_to_clipboard: 'copy_to_clipboard',
  request_compact: 'compact',
  fnc_set_effort: 'set_effort',
  fnc_set_model: 'set_model',
  fnc_run_slash_command: 'run_slash',
  get_usage: 'get_usage',
  fnc_sessions: 'sessions',
  fnc_claim: 'claim',
  fnc_release: 'release',
  fnc_ask: 'ask',
  fnc_await: 'await',
};

/**
 * Per-tool overrides of the wire call timeout. `fnc_await` legitimately
 * long-polls in the parent for up to 540s (its own timeoutSeconds cap), so
 * its wire deadline must outlast that — the default 10s would sever every
 * await mid-poll.
 */
const CALL_TIMEOUT_OVERRIDES: Partial<Record<McpToolName, number>> = {
  fnc_await: 560_000,
};

export interface BuildToolsArgs {
  socketPath: string;
  /** Injectable for tests; defaults to the real {@link dialAndCall}. */
  dialAndCall?: (a: {
    socketPath: string;
    request: WireRequest;
    callTimeoutMs?: number;
  }) => Promise<WireResponse>;
  /** Injectable env for the opt-in gate; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Construct the tools record passed to `createJsonRpcServer`. Each entry
 * has the description + JSON-Schema port'd from the Go canonical (via
 * `TOOL_SCHEMAS`) and a handler that wraps the model's tool-args payload
 * in a WireRequest with the matching `op`, then forwards through
 * `dialAndCall`.
 *
 * Per §8 plan, per-tool input validation will land between the payload
 * collation and the `dialAndCall` invocation. createJsonRpcServer wraps
 * the returned object in the MCP `{content: [{type:"text", text: <json>}]}`
 * envelope automatically, so handlers return the raw WireResponse and let
 * the scaffold do the wrapping.
 */
export function buildTools(args: BuildToolsArgs): Record<string, JsonRpcMcpTool> {
  const dialer = args.dialAndCall ?? dialAndCall;
  const env = args.env ?? process.env;
  const tools: Record<string, JsonRpcMcpTool> = {};
  for (const name of MCP_TOOL_NAMES) {
    if (!toolEnabled(name, env)) continue;
    const schema = TOOL_SCHEMAS[name];
    tools[name] = {
      description: schema.description,
      inputSchema: schema.inputSchema,
      handler: async (payload: unknown): Promise<object> => {
        const op = TOOL_TO_OP[name];
        const request: WireRequest = { op };
        if (payload !== null && payload !== undefined && typeof payload === 'object') {
          for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
            // Don't let a caller-supplied `op` field override our routing.
            if (k === 'op') continue;
            (request as Record<string, unknown>)[k] = v;
          }
        }
        // dialAndCall's WireResponse is a `{[k:string]: unknown}` shape —
        // safe to widen to `object` for the jsonrpc-server's content
        // wrapper, which just JSON.stringify's it.
        const callTimeoutMs = CALL_TIMEOUT_OVERRIDES[name];
        return (await dialer({
          socketPath: args.socketPath,
          request,
          ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
        })) as object;
      },
    };
  }
  return tools;
}

let cachedVersion: string | null = null;

function readPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(pkgUrl, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0-dev';
  } catch {
    cachedVersion = '0.0.0-dev';
  }
  return cachedVersion;
}

/**
 * Build the `initialize` result body shared between Go canonical and TS.
 * Per Go (`src/mcp.go:handleInitialize`): protocolVersion + capabilities
 * + serverInfo. `capabilities.tools` is the empty object — claude reads it
 * as "yes, tools/list is supported", not as a list itself.
 */
function buildInitializeResponse(): object {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: {
      name: MCP_SERVER_NAME,
      version: readPackageVersion(),
    },
  };
}

interface ServerForTests {
  handle(line: string): Promise<string | null>;
}

let testServer: ServerForTests | null = null;

/**
 * Test-only handler that drives one stdin line through the live JSON-RPC
 * server. Spinning up the full stdin loop in a unit test is awkward
 * (process.stdin is a global async iterable and contaminating it leaks
 * between tests). Exposing the line handler directly lets tests drive
 * `initialize` / `tools/list` / `notifications/*` without a subprocess.
 *
 * The first call constructs a server pointed at the real `dialAndCall` —
 * tests that exercise `tools/call` should use the e2e harness instead.
 * The server instance is cached so repeated calls share state.
 */
export async function handleMcpLine(line: string): Promise<string | null> {
  if (testServer === null) {
    testServer = createJsonRpcServer({
      tools: buildTools({ socketPath: process.env.FNC_SOCKET ?? '' }),
      initializeResponse: buildInitializeResponse(),
    });
  }
  return testServer.handle(line);
}

/**
 * Entry point for `fnc mcp [--noop]`.
 *
 * Returns the process exit code. The launcher (main.ts) calls
 * `process.exit(exitCode)` with the return value.
 */
export async function runMcpServer(_flags: McpFlags): Promise<number> {
  const socketPath = process.env.FNC_SOCKET;
  if (socketPath === undefined || socketPath === '') {
    process.stderr.write(
      'fnc mcp: FNC_SOCKET not set; subprocess must be invoked by fnclaude launcher.\n',
    );
    return 2;
  }

  const server = createJsonRpcServer({
    tools: buildTools({ socketPath }),
    initializeResponse: buildInitializeResponse(),
  });

  await runStdinLoop(server);
  return 0;
}

/** IO seam for the JSON-RPC line pump — injectable so unit tests can drive it. */
export interface JsonRpcPumpIo {
  input: AsyncIterable<Uint8Array>;
  /** Receives one complete newline-terminated response line per call. */
  write(line: string): void;
}

/**
 * Newline-delimited JSON-RPC pump over an injectable IO pair. Hands each
 * line to `server.handle()`, writes the resulting envelope (if any) via
 * `io.write`. Notifications produce `null` and are dropped silently.
 *
 * Each line's handling FLOATS — the pump never awaits a handler inline.
 * fnc_await legitimately parks for up to 540s (560s wire deadline); a
 * serial pump would head-of-line-block every other JSON-RPC line on this
 * stdin — sibling fnc tool calls and notifications/cancelled included —
 * for the whole poll. JSON-RPC responses carry the request id, so
 * out-of-order replies are legal. Interleaving is impossible mid-line:
 * each response goes out as ONE io.write call, and the underlying stream
 * writes each chunk contiguously. In-flight handlers are drained before
 * returning so EOF can't drop late responses.
 */
export async function pumpJsonRpcLines(
  server: { handle(line: string): Promise<string | null> },
  io: JsonRpcPumpIo,
): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const inFlight = new Set<Promise<void>>();

  const dispatchLine = (line: string): void => {
    const task = server
      .handle(line)
      .then((response) => {
        if (response !== null) {
          io.write(response + '\n');
        }
      })
      .catch(() => {
        // The JSON-RPC scaffold maps handler failures to error envelopes;
        // anything escaping here has no request id left to answer.
      });
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
    });
  };

  for await (const chunk of io.input) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      dispatchLine(line);
    }
  }
  // Flush whatever bytes remain after EOF.
  const tail = buffer.trim();
  if (tail !== '') {
    dispatchLine(tail);
  }
  // Drain: responses still in flight at EOF must not be dropped.
  await Promise.all([...inFlight]);
}

/** Production pump: process.stdin → server.handle → process.stdout. */
async function runStdinLoop(server: { handle(line: string): Promise<string | null> }): Promise<void> {
  await pumpJsonRpcLines(server, {
    input: process.stdin as AsyncIterable<Uint8Array>,
    write(line: string): void {
      process.stdout.write(line);
    },
  });
}
