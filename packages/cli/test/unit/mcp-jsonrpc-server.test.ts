import { describe, expect, test } from 'bun:test';

import { createJsonRpcServer } from '../../src/mcp/jsonrpc-server';

const INITIALIZE_RESPONSE = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'fnclaude', version: '0.0.0' },
};

function parseLine(line: string | null): Record<string, unknown> {
  if (line === null) throw new Error('expected response, got null');
  return JSON.parse(line) as Record<string, unknown>;
}

describe('createJsonRpcServer — initialize', () => {
  test('initialize round-trip echoes id + returns injected response', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }),
    );
    const res = parseLine(out);
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe(1);
    expect(res.result).toEqual(INITIALIZE_RESPONSE);
    expect(res.error).toBeUndefined();
  });

  test('initialize tolerates string ids', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 'init-1', method: 'initialize' }),
    );
    const res = parseLine(out);
    expect(res.id).toBe('init-1');
    expect(res.result).toEqual(INITIALIZE_RESPONSE);
  });
});

describe('createJsonRpcServer — tools/list', () => {
  test('returns registered tools as {name, description, inputSchema}', async () => {
    const server = createJsonRpcServer({
      tools: {
        alpha: {
          description: 'alpha tool',
          inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
          handler: async () => ({ ok: true }),
        },
        beta: {
          description: 'beta tool',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ ok: false }),
        },
      },
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    );
    const res = parseLine(out);
    expect(res.id).toBe(7);
    const tools = (res.result as { tools: unknown[] }).tools;
    expect(tools).toEqual([
      {
        name: 'alpha',
        description: 'alpha tool',
        inputSchema: {
          type: 'object',
          properties: { x: { type: 'string' } },
        },
      },
      {
        name: 'beta',
        description: 'beta tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
  });

  test('empty tools registry returns empty list', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    );
    const res = parseLine(out);
    expect((res.result as { tools: unknown[] }).tools).toEqual([]);
  });
});

describe('createJsonRpcServer — tools/call', () => {
  test('dispatches to handler, passes args, wraps response as MCP text content', async () => {
    let receivedArgs: unknown = null;
    const server = createJsonRpcServer({
      tools: {
        echo: {
          description: 'echo',
          inputSchema: { type: 'object' },
          handler: async (args: unknown) => {
            receivedArgs = args;
            return { echoed: args };
          },
        },
      },
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'echo', arguments: { hello: 'world', n: 3 } },
      }),
    );
    const res = parseLine(out);
    expect(res.id).toBe(42);
    expect(receivedArgs).toEqual({ hello: 'world', n: 3 });
    const result = res.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    const decoded = JSON.parse(result.content[0]!.text);
    expect(decoded).toEqual({ echoed: { hello: 'world', n: 3 } });
  });

  test('missing arguments → handler gets empty object', async () => {
    let receivedArgs: unknown = 'unset';
    const server = createJsonRpcServer({
      tools: {
        noargs: {
          description: 'no args',
          inputSchema: { type: 'object' },
          handler: async (args: unknown) => {
            receivedArgs = args;
            return { ok: true };
          },
        },
      },
      initializeResponse: INITIALIZE_RESPONSE,
    });
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'noargs' },
      }),
    );
    expect(receivedArgs).toEqual({});
  });

  test('unknown tool name returns JSON-RPC method-not-found error', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'nope' },
      }),
    );
    const res = parseLine(out);
    expect(res.id).toBe(9);
    expect(res.result).toBeUndefined();
    const err = res.error as { code: number; message: string };
    expect(err.code).toBe(-32601);
    expect(err.message.toLowerCase()).toContain('nope');
  });

  test('handler throw surfaces as JSON-RPC internal error', async () => {
    const server = createJsonRpcServer({
      tools: {
        kaboom: {
          description: 'throws',
          inputSchema: { type: 'object' },
          handler: async () => {
            throw new Error('handler exploded');
          },
        },
      },
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'kaboom' },
      }),
    );
    const res = parseLine(out);
    expect(res.id).toBe(11);
    const err = res.error as { code: number; message: string };
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('handler exploded');
  });
});

describe('createJsonRpcServer — notifications', () => {
  test('notification (no id) returns null, no response written', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(out).toBeNull();
  });

  test('notification with params still returns null', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1, reason: 'user' },
      }),
    );
    expect(out).toBeNull();
  });
});

describe('createJsonRpcServer — error cases', () => {
  test('unknown method returns -32601 method-not-found', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'completely/made-up' }),
    );
    const res = parseLine(out);
    expect(res.id).toBe(5);
    const err = res.error as { code: number; message: string };
    expect(err.code).toBe(-32601);
  });

  test('malformed JSON returns -32700 parse error with null id', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle('{not valid json');
    const res = parseLine(out);
    expect(res.id).toBeNull();
    const err = res.error as { code: number; message: string };
    expect(err.code).toBe(-32700);
  });

  test('JSON that is not an object returns -32600 invalid request', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(JSON.stringify(['array', 'not', 'object']));
    const res = parseLine(out);
    expect(res.id).toBeNull();
    const err = res.error as { code: number };
    expect(err.code).toBe(-32600);
  });

  test('missing method field returns -32600 invalid request', async () => {
    const server = createJsonRpcServer({
      tools: {},
      initializeResponse: INITIALIZE_RESPONSE,
    });
    const out = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1 }));
    const res = parseLine(out);
    expect(res.id).toBe(1);
    const err = res.error as { code: number };
    expect(err.code).toBe(-32600);
  });
});
