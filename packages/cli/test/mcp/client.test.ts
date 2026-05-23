// Mirrors the relevant parts of src/mcp_test.go. Tests the MCP subprocess
// stdio loop, tool registration, JSON-RPC protocol compliance, and per-tool
// Request shaping. The parent's socket layer is mocked via the injectable
// `dial` function — per project conventions we don't mock our own listener
// in the listener tests, but the MCP client tests stub the *parent* socket
// because the parent isn't running in unit tests.

import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  runMCPServer,
  type DialFn,
} from '../../src/mcp/client.js';
import type { Request, Response } from '../../src/mcp/protocol.js';

// ── harness ────────────────────────────────────────────────────────────────

interface DialCall {
  socketPath: string;
  req: Request;
}

interface RunResult {
  /** All JSON-RPC response objects emitted to stdout, parsed. */
  responses: Array<Record<string, unknown>>;
  /** All dial() calls observed (in order). */
  dialCalls: DialCall[];
  /** runMCPServer's return value. */
  exitCode: number;
}

interface RunOpts {
  noop?: boolean;
  socketPath?: string;
  msgs: Array<Record<string, unknown>>;
  dialResponse?: Response | ((req: Request) => Response);
  dialError?: Error;
}

async function runMCP(opts: RunOpts): Promise<RunResult> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stdoutBufs: Buffer[] = [];
  stdout.on('data', (b: Buffer) => stdoutBufs.push(Buffer.isBuffer(b) ? b : Buffer.from(b)));

  const dialCalls: DialCall[] = [];
  const dial: DialFn = async (socketPath, req) => {
    dialCalls.push({ socketPath, req });
    if (opts.dialError) throw opts.dialError;
    const r = opts.dialResponse;
    if (typeof r === 'function') return r(req);
    return r ?? { action: 'done' };
  };

  // Write all input then EOF.
  for (const msg of opts.msgs) {
    stdin.write(`${JSON.stringify(msg)}\n`);
  }
  stdin.end();

  const exitCode = await runMCPServer({
    noop: opts.noop ?? false,
    stdin,
    stdout,
    socketPath: opts.socketPath ?? '',
    dial,
  });

  // Give stdout a tick to drain any tail writes.
  await new Promise((r) => setImmediate(r));

  const raw = Buffer.concat(stdoutBufs).toString('utf8');
  const responses: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      responses.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // not JSON — skip
    }
  }
  return { responses, dialCalls, exitCode };
}

/** Find the response with the given id. */
function findResp(
  result: RunResult,
  id: number,
): Record<string, unknown> | undefined {
  return result.responses.find((r) => r.id === id);
}

/** Find the text content of a tools/call result. */
function toolResultText(resp: Record<string, unknown> | undefined): string {
  if (!resp) throw new Error('no response');
  if ('error' in resp && resp.error) {
    throw new Error(`got JSON-RPC error: ${JSON.stringify(resp.error)}`);
  }
  const result = resp.result as { content?: Array<{ type: string; text: string }> };
  if (!result?.content?.[0]?.text) {
    throw new Error(`no text content: ${JSON.stringify(resp)}`);
  }
  return result.content[0].text;
}

/** Assert that a response is a tool-level error with the substring in text. */
function expectToolError(resp: Record<string, unknown> | undefined, substr: string): void {
  if (!resp) throw new Error('no response');
  // Tool-level errors: result.isError + content text
  if ('error' in resp && resp.error) {
    const msg = JSON.stringify(resp.error);
    expect(msg.toLowerCase()).toContain(substr.toLowerCase());
    return;
  }
  const result = resp.result as {
    isError?: boolean;
    content?: Array<{ type: string; text: string }>;
  };
  expect(result?.isError).toBe(true);
  const text = result?.content?.[0]?.text ?? '';
  expect(text.toLowerCase()).toContain(substr.toLowerCase());
}

const initializeMsg = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

const initializedMsg = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
};

function toolsListMsg(id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/list' };
}

function toolsCallMsg(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

// ── tool registration ──────────────────────────────────────────────────────

describe('tool registration', () => {
  test('non-noop registers restart + switch + spawn', async () => {
    const out = await runMCP({
      noop: false,
      msgs: [initializeMsg, initializedMsg, toolsListMsg(2)],
    });
    const resp = findResp(out, 2);
    const result = resp?.result as { tools?: Array<{ name: string }> };
    const names = (result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['fnc_restart', 'fnc_spawn_session', 'fnc_switch_project']);
  });

  test('noop registers switch + spawn + copy_to_clipboard', async () => {
    const out = await runMCP({
      noop: true,
      msgs: [initializeMsg, initializedMsg, toolsListMsg(2)],
    });
    const resp = findResp(out, 2);
    const result = resp?.result as { tools?: Array<{ name: string }> };
    const names = (result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['fnc_copy_to_clipboard', 'fnc_spawn_session', 'fnc_switch_project']);
  });

  test('fnc_restart schema requires session_id and mentions $CLAUDE_CODE_SESSION_ID', async () => {
    const out = await runMCP({
      noop: false,
      msgs: [initializeMsg, initializedMsg, toolsListMsg(2)],
    });
    const resp = findResp(out, 2);
    const result = resp?.result as { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }> };
    const restart = result.tools.find((t) => t.name === 'fnc_restart')!;
    expect(restart).toBeDefined();
    expect(restart.inputSchema.properties).toHaveProperty('session_id');
    expect(restart.inputSchema.required).toContain('session_id');
    expect(restart.description).toContain('CLAUDE_CODE_SESSION_ID');
  });

  test('switch/spawn schemas omit "confirmed" argument', async () => {
    const out = await runMCP({
      noop: false,
      msgs: [initializeMsg, initializedMsg, toolsListMsg(2)],
    });
    const resp = findResp(out, 2);
    const result = resp?.result as { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }> };
    for (const name of ['fnc_switch_project', 'fnc_spawn_session']) {
      const tool = result.tools.find((t) => t.name === name)!;
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties).not.toHaveProperty('confirmed');
      for (const banned of ['needs_confirmation', 'auto_countdown', 'confirmed=true']) {
        expect(tool.description).not.toContain(banned);
      }
    }
  });
});

// ── capability gating: socketPath empty → tool error ──────────────────────

describe('capability gating (no socket)', () => {
  test('restart returns tool error', async () => {
    const out = await runMCP({
      noop: false,
      socketPath: '',
      msgs: [initializeMsg, initializedMsg, toolsCallMsg(2, 'fnc_restart', {})],
    });
    expectToolError(findResp(out, 2), 'unavailable');
  });
  test('switch returns tool error', async () => {
    const out = await runMCP({
      noop: false,
      socketPath: '',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_switch_project', { destination: 'x', name: 'y', summary: 'z' }),
      ],
    });
    expectToolError(findResp(out, 2), 'unavailable');
  });
  test('spawn returns tool error', async () => {
    const out = await runMCP({
      noop: false,
      socketPath: '',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_spawn_session', { destination: 'x', name: 'y', summary: 'z' }),
      ],
    });
    expectToolError(findResp(out, 2), 'unavailable');
  });
  test('copy returns tool error', async () => {
    const out = await runMCP({
      noop: true,
      socketPath: '',
      msgs: [initializeMsg, initializedMsg, toolsCallMsg(2, 'fnc_copy_to_clipboard', { text: 'hi' })],
    });
    expectToolError(findResp(out, 2), 'unavailable');
  });
});

// ── per-tool Request shaping ───────────────────────────────────────────────

describe('Request serialization', () => {
  test('restart: forwards session_id verbatim', async () => {
    const sid = '01234567-89ab-cdef-0123-456789abcdef';
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_restart', { session_id: sid }),
      ],
      dialResponse: { action: 'done' },
    });
    expect(out.dialCalls).toHaveLength(1);
    const call = out.dialCalls[0]!;
    expect(call.req.op).toBe('restart');
    expect(call.req.session_id).toBe(sid);
  });

  test('restart: missing session_id returns tool error (no dial)', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [initializeMsg, initializedMsg, toolsCallMsg(2, 'fnc_restart', {})],
    });
    expectToolError(findResp(out, 2), 'session_id');
    expect(out.dialCalls).toHaveLength(0);
  });

  test('restart: non-UUID session_id returns tool error (no dial)', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_restart', { session_id: 'not-a-uuid' }),
      ],
    });
    expectToolError(findResp(out, 2), 'uuid');
    expect(out.dialCalls).toHaveLength(0);
  });

  test('switch: forwards destination/name/summary', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_switch_project', {
          destination: 'arch-setup@fnrhombus',
          name: 'fix-auth-bug',
          summary: 'working on auth',
        }),
      ],
      dialResponse: { action: 'done' },
    });
    const req = out.dialCalls[0]!.req;
    expect(req.op).toBe('switch');
    expect(req.destination).toBe('arch-setup@fnrhombus');
    expect(req.name).toBe('fix-auth-bug');
    expect(req.summary).toBe('working on auth');
  });

  test('switch: tolerates legacy "confirmed" argument', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_switch_project', {
          destination: 'arch-setup@fnrhombus',
          name: 'fix-auth-bug',
          summary: 'working on auth',
          confirmed: true,
        }),
      ],
      dialResponse: { action: 'done' },
    });
    const resp = findResp(out, 2);
    expect(resp).toBeDefined();
    expect(resp!.error).toBeUndefined();
  });

  test('spawn: forwards destination/name/summary', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_spawn_session', {
          destination: 'arch-setup@fnrhombus',
          name: 'side-thing',
          summary: 'side task content',
        }),
      ],
      dialResponse: { action: 'done' },
    });
    const req = out.dialCalls[0]!.req;
    expect(req.op).toBe('spawn');
    expect(req.destination).toBe('arch-setup@fnrhombus');
    expect(req.name).toBe('side-thing');
    expect(req.summary).toBe('side task content');
  });

  test('copy: forwards text', async () => {
    const out = await runMCP({
      noop: true,
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_copy_to_clipboard', { text: 'fnclaude arch-setup' }),
      ],
      dialResponse: { action: 'done' },
    });
    const req = out.dialCalls[0]!.req;
    expect(req.op).toBe('copy_to_clipboard');
    expect(req.text).toBe('fnclaude arch-setup');
  });
});

// ── handler end-to-end: Action shape reflected in tool result text ─────────

describe('Response relay', () => {
  test('done Response → text contains action:done', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_restart', {
          session_id: '01234567-89ab-cdef-0123-456789abcdef',
        }),
      ],
      dialResponse: { action: 'done' },
    });
    expect(toolResultText(findResp(out, 2))).toContain('"action":"done"');
  });

  test('paste_flow + clipboard_ok=true', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_switch_project', {
          destination: 'arch-setup',
          name: 'fix-thing',
          summary: '...',
        }),
      ],
      dialResponse: {
        action: 'paste_flow',
        message: 'Command copied to clipboard.',
        command: 'fnclaude arch-setup --name fix-thing',
        clipboard_ok: true,
      },
    });
    const text = toolResultText(findResp(out, 2));
    expect(text).toContain('"action":"paste_flow"');
    expect(text).toContain('"clipboard_ok":true');
    expect(text).toContain('fnclaude arch-setup --name fix-thing');
  });

  test('paste_flow without clipboard_ok (false omitted/absent)', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_switch_project', {
          destination: 'arch-setup',
          name: 'fix-thing',
          summary: '...',
        }),
      ],
      dialResponse: {
        action: 'paste_flow',
        message: 'Copy manually:',
        command: 'fnclaude arch-setup --name fix-thing',
        clipboard_ok: false,
      },
    });
    const text = toolResultText(findResp(out, 2));
    expect(text).toContain('"action":"paste_flow"');
    // clipboard_ok=false is sent on wire; the assertion in Go is that it's
    // NOT clipboard_ok:true — the false form is allowed.
    expect(text).not.toContain('"clipboard_ok":true');
  });

  test('error Response: text contains error message', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_switch_project', {
          destination: 'nonexistent',
          name: 'fix-thing',
          summary: '...',
        }),
      ],
      dialResponse: { action: 'error', error: 'destination not found' },
    });
    expect(toolResultText(findResp(out, 2))).toContain('destination not found');
  });

  test('dial throws → returns tool error', async () => {
    const out = await runMCP({
      socketPath: '/no/such/sock',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_restart', {
          session_id: '01234567-89ab-cdef-0123-456789abcdef',
        }),
      ],
      dialError: new Error('dial ENOENT'),
    });
    expectToolError(findResp(out, 2), 'dial ENOENT');
  });
});

// ── MCP protocol compliance ────────────────────────────────────────────────

describe('MCP protocol compliance', () => {
  test('initialize returns protocolVersion + serverInfo', async () => {
    const out = await runMCP({ msgs: [initializeMsg] });
    const resp = findResp(out, 1);
    const result = resp?.result as { protocolVersion?: string; serverInfo?: { name: string } };
    expect(result?.protocolVersion).toBeTruthy();
    expect(result?.serverInfo?.name).toBe('fnclaude');
  });

  test('unknown method returns JSON-RPC error', async () => {
    const out = await runMCP({
      msgs: [initializeMsg, initializedMsg, { jsonrpc: '2.0', id: 2, method: 'unknown/method' }],
    });
    const resp = findResp(out, 2);
    expect(resp?.error).toBeDefined();
    expect((resp!.error as { code: number }).code).toBe(-32601);
  });

  test('notifications (no id) are not responded to', async () => {
    const out = await runMCP({
      msgs: [
        initializeMsg,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        toolsListMsg(2),
      ],
    });
    // 2 ids in input: 1 (init), 2 (tools/list). Should see 2 responses.
    expect(out.responses.filter((r) => r.id !== undefined && r.id !== null)).toHaveLength(2);
  });

  test('clean stdin EOF returns exit code 0', async () => {
    const out = await runMCP({ msgs: [initializeMsg] });
    expect(out.exitCode).toBe(0);
  });
});

// ── unknown tool ───────────────────────────────────────────────────────────

describe('unknown tool', () => {
  test('returns method-not-found error', async () => {
    const out = await runMCP({
      socketPath: '/x',
      msgs: [
        initializeMsg,
        initializedMsg,
        toolsCallMsg(2, 'fnc_bogus_tool', {}),
      ],
    });
    const resp = findResp(out, 2);
    expect(resp?.error).toBeDefined();
  });
});
