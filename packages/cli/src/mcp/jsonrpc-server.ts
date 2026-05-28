/**
 * JSON-RPC 2.0 server scaffold for the MCP subprocess.
 *
 * The fnclaude MCP subprocess (spawned by claude via the injected
 * `--mcp-config`) is a Model Context Protocol server that speaks
 * newline-delimited JSON-RPC 2.0 over stdio. This module is the pure
 * routing layer — transport (read stdin lines, write stdout lines) is the
 * subprocess entry point's job (§7.5); per-call dialing of the parent
 * socket is the tool handler's job (§7.6 / §8).
 *
 * Methods routed:
 *   - "initialize"        → returns the injected initializeResponse
 *   - "tools/list"        → returns { tools: [{name, description, inputSchema}, ...] }
 *                           in registration order (Object.entries order on
 *                           the tools record)
 *   - "tools/call"        → dispatches to tools[name].handler(args), wraps
 *                           the return value in MCP's content shape
 *                           ({ content: [{ type: "text", text: <json> }] })
 *   - anything else       → JSON-RPC error -32601 (method not found)
 *
 * Notifications (requests with no `id` field) are processed but produce no
 * response — handle() returns null.
 *
 * Error codes follow the JSON-RPC 2.0 spec:
 *   -32700 Parse error       (malformed JSON)
 *   -32600 Invalid Request   (not an object, missing method)
 *   -32601 Method not found  (unknown method or unknown tool name)
 *   -32603 Internal error    (handler throw)
 *
 * Per design.mcp.md §3, the wire format is one JSON object per line; this
 * function takes one line and returns one line (or null for
 * notifications). Pipelining is not used.
 *
 * Tool registration is by injection — the four real tools (fnc_restart,
 * fnc_switch_project, fnc_spawn_session, fnc_copy_to_clipboard) come in
 * §8; tests use fakes.
 */

export type JsonRpcId = number | string | null;

export interface McpTool {
  description: string;
  inputSchema: object;
  handler: (args: unknown) => Promise<object>;
}

export interface CreateJsonRpcServerArgs {
  tools: Record<string, McpTool>;
  initializeResponse: object;
}

export interface JsonRpcServer {
  handle(line: string): Promise<string | null>;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId | undefined;
  method?: unknown;
  params?: unknown;
}

export function createJsonRpcServer(
  args: CreateJsonRpcServerArgs,
): JsonRpcServer {
  return {
    async handle(line: string): Promise<string | null> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return serializeError(null, -32700, 'Parse error: malformed JSON');
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return serializeError(null, -32600, 'Invalid Request: not a JSON-RPC object');
      }

      const req = parsed as JsonRpcRequest;
      const id = normalizeId(req.id);
      const isNotification = req.id === undefined;

      if (typeof req.method !== 'string') {
        if (isNotification) return null;
        return serializeError(id, -32600, 'Invalid Request: missing method');
      }

      const method = req.method;

      if (isNotification) {
        // Notifications are processed but produce no response.
        return null;
      }

      if (method === 'initialize') {
        return serializeResult(id, args.initializeResponse);
      }

      if (method === 'tools/list') {
        const tools = Object.entries(args.tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
        return serializeResult(id, { tools });
      }

      if (method === 'tools/call') {
        const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';
        if (!name || !(name in args.tools)) {
          return serializeError(id, -32601, `Unknown tool: ${name || '(missing name)'}`);
        }
        const tool = args.tools[name]!;
        const toolArgs =
          params.arguments !== undefined && params.arguments !== null
            ? params.arguments
            : {};
        let result: object;
        try {
          result = await tool.handler(toolArgs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return serializeError(id, -32603, `Internal error: ${msg}`);
        }
        return serializeResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        });
      }

      return serializeError(id, -32601, `Method not found: ${method}`);
    },
  };
}

function normalizeId(id: unknown): JsonRpcId {
  if (typeof id === 'number' || typeof id === 'string' || id === null) {
    return id;
  }
  return null;
}

function serializeResult(id: JsonRpcId, result: object): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function serializeError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}
