/**
 * MCP subcommand dispatch. fnc's first arg of "mcp" routes to the embedded
 * JSON-RPC subprocess (the one claude invokes via the injected
 * --mcp-config; see docs/design.mcp.md §2).
 *
 * §2.7 contributed the routing wrapper. §7.5 (here) wires the entry point:
 *   - Read $FNC_SOCKET from env; fatal exit 2 if absent.
 *   - Build the four tool handlers, each of which dials the parent over
 *     the AF_UNIX socket using §7.6's dialAndCall.
 *   - Read line-delimited JSON-RPC requests from stdin until EOF, route
 *     `tools/call` requests to the appropriate handler, and write JSON
 *     responses to stdout. (Full JSON-RPC scaffolding — initialize,
 *     tools/list, notifications — lands in §7.3.)
 *
 * Matches Go canonical's dispatch shape (src/main.go:879-887): mcp
 * subcommand recognized ONLY at argv[0], '--noop' is the sole flag that
 * affects server behavior, anything else is ignored.
 */

import { dialAndCall, type WireOp, type WireRequest, type WireResponse } from './wire.ts';

const SUBCOMMAND = 'mcp';
const NOOP_FLAG = '--noop';

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
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Mapping from the MCP-visible tool name to the wire `op` value the
 * parent dispatcher routes on. See design.mcp.md §4.
 */
const TOOL_TO_OP: Record<McpToolName, WireOp> = {
  fnc_restart: 'restart',
  fnc_switch_project: 'switch',
  fnc_spawn_session: 'spawn',
  fnc_copy_to_clipboard: 'copy_to_clipboard',
};

export interface McpTool {
  name: McpToolName;
  handler: (args: unknown) => Promise<WireResponse>;
}

export interface BuildToolsArgs {
  socketPath: string;
  /** Injectable for tests; defaults to the real {@link dialAndCall}. */
  dialAndCall?: (a: {
    socketPath: string;
    request: WireRequest;
  }) => Promise<WireResponse>;
}

/**
 * Construct the four tool handlers. Each handler accepts an MCP tool-args
 * payload (object literal from the model's `tools/call`), wraps it in a
 * WireRequest with the matching `op`, and forwards through `dialAndCall`.
 *
 * §8 will add per-tool input validation in front of `dialAndCall`. This
 * function ships the wiring shape; the validation hooks in beside the
 * `op:` field assignment without changing the call-graph.
 */
export function buildTools(args: BuildToolsArgs): McpTool[] {
  const dialer = args.dialAndCall ?? dialAndCall;
  return MCP_TOOL_NAMES.map((name) => ({
    name,
    handler: async (payload: unknown): Promise<WireResponse> => {
      const op = TOOL_TO_OP[name];
      const request: WireRequest = { op };
      if (payload !== null && payload !== undefined && typeof payload === 'object') {
        for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
          // Don't let a caller-supplied `op` field override our routing.
          if (k === 'op') continue;
          (request as Record<string, unknown>)[k] = v;
        }
      }
      return dialer({ socketPath: args.socketPath, request });
    },
  }));
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

  const tools = buildTools({ socketPath });
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  await runStdinLoop({ toolsByName });
  return 0;
}

interface StdinLoopArgs {
  toolsByName: Map<string, McpTool>;
}

/**
 * Placeholder JSON-RPC loop until §7.3 lands. Reads newline-delimited
 * JSON from stdin; for each `tools/call` request, calls the matching
 * handler and writes a minimal JSON-RPC 2.0 response. For everything
 * else (including the eventual `initialize` / `tools/list`) writes a
 * method-not-found error.
 *
 * The shape here is just enough to surface a real tool-call to the
 * parent over the wire; §7.3 replaces this with the full scaffold.
 */
async function runStdinLoop(args: StdinLoopArgs): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // Read raw bytes from stdin; node:process exposes stdin as an async
  // iterable of Uint8Array chunks.
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      await handleLine({ line, toolsByName: args.toolsByName });
    }
  }
  // Flush whatever bytes remain after EOF.
  const tail = buffer.trim();
  if (tail !== '') {
    await handleLine({ line: tail, toolsByName: args.toolsByName });
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

async function handleLine(args: {
  line: string;
  toolsByName: Map<string, McpTool>;
}): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(args.line) as JsonRpcRequest;
  } catch (err) {
    writeRpcError(null, -32700, `parse error: ${(err as Error).message}`);
    return;
  }

  // Notifications (no `id`) get no response, even on error.
  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
    const tool = params.name !== undefined ? args.toolsByName.get(params.name) : undefined;
    if (tool === undefined) {
      if (!isNotification) {
        writeRpcError(id, -32601, `unknown tool: ${params.name ?? '<missing>'}`);
      }
      return;
    }
    try {
      const result = await tool.handler(params.arguments);
      if (!isNotification) writeRpcToolResult(id, result);
    } catch (err) {
      if (!isNotification) {
        writeRpcError(id, -32000, `tool error: ${(err as Error).message}`);
      }
    }
    return;
  }

  // Full method dispatch (initialize, tools/list, etc.) lands with §7.3.
  if (!isNotification) {
    writeRpcError(id, -32601, `method not implemented yet (§7.3): ${req.method ?? '<missing>'}`);
  }
}

function writeRpcToolResult(
  id: number | string | null,
  result: WireResponse,
): void {
  // Per design.mcp.md §2.3: marshal the Response JSON as a single text
  // content item. The model reads `action` / `message` / `command` /
  // `clipboard_ok` out of the embedded JSON string.
  const envelope = {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    },
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

function writeRpcError(
  id: number | string | null,
  code: number,
  message: string,
): void {
  const envelope = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
}
