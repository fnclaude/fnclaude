/**
 * End-to-end coverage for the full MCP wire handoff round-trip.
 *
 * Real chain, no stubs of fnclaude code:
 *   test → spawn real `fnc mcp` subprocess
 *        → write JSON-RPC `tools/call` to its stdin
 *        → subprocess dials real AF_UNIX socket
 *        → test's parent dispatcher receives the WireRequest
 *        → capturing handler returns WireResponse
 *        → subprocess writes JSON-RPC response to stdout
 *        → test reads + asserts
 *
 * The dispatcher here is the SAME `createParentDispatcher` main.ts uses —
 * only the per-op handlers are swapped for capturing variants that record
 * what they received and return a fixed response. That's the test playing
 * the role of main.ts, not a mock of fnclaude code.
 *
 * mcp-dispatch-e2e.test.ts already covers the entry-point error path
 * (`fnc mcp` without `$FNC_SOCKET` → exit 2); this file adds the happy
 * path and the JSON-RPC error paths that flow through a real socket.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startMcpListener, type McpListener } from '../../src/mcp/listener.ts';
import { createParentDispatcher } from '../../src/mcp/parent-dispatch.ts';
import type { WireOp, WireRequest, WireResponse } from '../../src/mcp/wire.ts';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');

interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn `fnc mcp` with `$FNC_SOCKET` pointed at our test listener, feed it
 * one JSON-RPC line over stdin, then collect stdout/stderr/exit. Mirrors
 * how claude drives the real subprocess (one tool call per stdin line).
 */
async function runMcpWithStdin(
  socketPath: string,
  stdinLine: string,
): Promise<SubprocessResult> {
  // Strip any stray FNC_SOCKET from the inherited env, then point at ours.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'FNC_SOCKET') env[k] = v;
  }
  env.FNC_SOCKET = socketPath;

  const proc = Bun.spawn(['node', BIN, 'mcp'], {
    cwd: CLI_ROOT,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin?.write(stdinLine);
  proc.stdin?.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Per-test capturing handlers. Holds the most recent WireRequest the
 * parent dispatcher saw, and returns a fixed WireResponse per op.
 */
interface CapturingHandlers {
  handlers: Record<WireOp, (req: WireRequest) => Promise<WireResponse>>;
  capturedFor: (op: WireOp) => WireRequest | null;
}

function makeCapturingHandlers(
  responses: Record<WireOp, WireResponse>,
): CapturingHandlers {
  const captured: Partial<Record<WireOp, WireRequest>> = {};
  const make = (op: WireOp) => async (req: WireRequest): Promise<WireResponse> => {
    captured[op] = req;
    return responses[op];
  };
  return {
    handlers: {
      restart: make('restart'),
      switch: make('switch'),
      spawn: make('spawn'),
      copy_to_clipboard: make('copy_to_clipboard'),
    },
    capturedFor: (op) => captured[op] ?? null,
  };
}

/**
 * One JSON-RPC `tools/call` line with id = 1.
 */
function makeJsonRpcCall(toolName: string, args: object): string {
  return (
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }) + '\n'
  );
}

interface ParsedRpcEnvelope {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

/**
 * Find the first JSON-RPC envelope on stdout. The subprocess may emit
 * unrelated lines (none expected today, but be lenient) — we look for
 * the line that parses as an envelope with jsonrpc === '2.0'.
 */
function parseFirstRpcEnvelope(stdout: string): ParsedRpcEnvelope {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ParsedRpcEnvelope;
      if (parsed.jsonrpc === '2.0') return parsed;
    } catch {
      // skip non-JSON lines
    }
  }
  throw new Error(`no JSON-RPC envelope found in stdout: ${JSON.stringify(stdout)}`);
}

describe.skipIf(SKIP_WINDOWS)('mcp wire handoff round-trip', () => {
  let socketDir: string;
  let socketPath: string;
  let listener: McpListener | null;

  beforeEach(() => {
    socketDir = mkdtempSync(join(tmpdir(), 'fnc-mcp-handoff-e2e-'));
    socketPath = join(socketDir, 'sock');
    listener = null;
  });

  afterEach(async () => {
    if (listener !== null) {
      await listener.stop();
      listener = null;
    }
    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('fnc_copy_to_clipboard round-trips text payload through real wire', async () => {
    const { handlers, capturedFor } = makeCapturingHandlers({
      restart: { action: 'done' },
      switch: { action: 'done' },
      spawn: { action: 'done' },
      copy_to_clipboard: { action: 'done', clipboard_ok: true },
    });
    listener = await startMcpListener({
      socketPath,
      onConnection: createParentDispatcher({ handlers }),
    });

    const { stdout, exitCode } = await runMcpWithStdin(
      socketPath,
      makeJsonRpcCall('fnc_copy_to_clipboard', { text: 'hello world' }),
    );

    expect(exitCode).toBe(0);
    expect(capturedFor('copy_to_clipboard')).toEqual({
      op: 'copy_to_clipboard',
      text: 'hello world',
    });

    const envelope = parseFirstRpcEnvelope(stdout);
    expect(envelope.id).toBe(1);
    expect(envelope.error).toBeUndefined();
    const textContent = envelope.result?.content?.[0];
    expect(textContent?.type).toBe('text');
    const payload = JSON.parse(textContent?.text ?? '') as WireResponse;
    expect(payload.action).toBe('done');
    expect(payload.clipboard_ok).toBe(true);
  });

  test('fnc_restart round-trips session_id payload through real wire', async () => {
    const { handlers, capturedFor } = makeCapturingHandlers({
      restart: { action: 'done', message: 'restarting' },
      switch: { action: 'done' },
      spawn: { action: 'done' },
      copy_to_clipboard: { action: 'done' },
    });
    listener = await startMcpListener({
      socketPath,
      onConnection: createParentDispatcher({ handlers }),
    });

    const { stdout, exitCode } = await runMcpWithStdin(
      socketPath,
      makeJsonRpcCall('fnc_restart', { session_id: 'sess-abc-123' }),
    );

    expect(exitCode).toBe(0);
    expect(capturedFor('restart')).toEqual({
      op: 'restart',
      session_id: 'sess-abc-123',
    });

    const envelope = parseFirstRpcEnvelope(stdout);
    expect(envelope.id).toBe(1);
    expect(envelope.error).toBeUndefined();
    const payload = JSON.parse(
      envelope.result?.content?.[0]?.text ?? '',
    ) as WireResponse;
    expect(payload.action).toBe('done');
    expect(payload.message).toBe('restarting');
  });

  test('fnc_switch_project round-trips destination/name/summary through real wire', async () => {
    const { handlers, capturedFor } = makeCapturingHandlers({
      restart: { action: 'done' },
      switch: { action: 'done' },
      spawn: { action: 'done' },
      copy_to_clipboard: { action: 'done' },
    });
    listener = await startMcpListener({
      socketPath,
      onConnection: createParentDispatcher({ handlers }),
    });

    const { stdout, exitCode } = await runMcpWithStdin(
      socketPath,
      makeJsonRpcCall('fnc_switch_project', {
        destination: '/tmp/dest',
        name: 'switched',
        summary: 'short summary',
      }),
    );

    expect(exitCode).toBe(0);
    expect(capturedFor('switch')).toEqual({
      op: 'switch',
      destination: '/tmp/dest',
      name: 'switched',
      summary: 'short summary',
    });

    const envelope = parseFirstRpcEnvelope(stdout);
    expect(envelope.id).toBe(1);
    expect(envelope.error).toBeUndefined();
    const payload = JSON.parse(
      envelope.result?.content?.[0]?.text ?? '',
    ) as WireResponse;
    expect(payload.action).toBe('done');
  });

  test('fnc_spawn_session round-trips initial_prompt through real wire', async () => {
    const { handlers, capturedFor } = makeCapturingHandlers({
      restart: { action: 'done' },
      switch: { action: 'done' },
      spawn: { action: 'done' },
      copy_to_clipboard: { action: 'done' },
    });
    listener = await startMcpListener({
      socketPath,
      onConnection: createParentDispatcher({ handlers }),
    });

    const { stdout, exitCode } = await runMcpWithStdin(
      socketPath,
      makeJsonRpcCall('fnc_spawn_session', { initial_prompt: 'do thing' }),
    );

    expect(exitCode).toBe(0);
    expect(capturedFor('spawn')).toEqual({
      op: 'spawn',
      initial_prompt: 'do thing',
    });

    const envelope = parseFirstRpcEnvelope(stdout);
    expect(envelope.id).toBe(1);
    expect(envelope.error).toBeUndefined();
    const payload = JSON.parse(
      envelope.result?.content?.[0]?.text ?? '',
    ) as WireResponse;
    expect(payload.action).toBe('done');
  });

  test('unknown tool name → JSON-RPC error -32601, subprocess exits 0', async () => {
    const { handlers } = makeCapturingHandlers({
      restart: { action: 'done' },
      switch: { action: 'done' },
      spawn: { action: 'done' },
      copy_to_clipboard: { action: 'done' },
    });
    listener = await startMcpListener({
      socketPath,
      onConnection: createParentDispatcher({ handlers }),
    });

    const { stdout, exitCode } = await runMcpWithStdin(
      socketPath,
      makeJsonRpcCall('fnc_nonexistent', {}),
    );

    expect(exitCode).toBe(0);
    const envelope = parseFirstRpcEnvelope(stdout);
    expect(envelope.id).toBe(1);
    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32601);
    expect(envelope.error?.message.toLowerCase()).toContain('unknown tool');
  });

  test('malformed JSON-RPC line → parse-error envelope code -32700, exit 0', async () => {
    const { handlers } = makeCapturingHandlers({
      restart: { action: 'done' },
      switch: { action: 'done' },
      spawn: { action: 'done' },
      copy_to_clipboard: { action: 'done' },
    });
    listener = await startMcpListener({
      socketPath,
      onConnection: createParentDispatcher({ handlers }),
    });

    const { stdout, exitCode } = await runMcpWithStdin(socketPath, 'not-json\n');

    expect(exitCode).toBe(0);
    const envelope = parseFirstRpcEnvelope(stdout);
    expect(envelope.id).toBeNull();
    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32700);
  });

  test('parent socket missing → JSON-RPC tool error -32000, subprocess exits 0', async () => {
    // No listener for this case — point $FNC_SOCKET at a path that
    // doesn't exist. The subprocess should surface the dial failure as
    // a tool-level JSON-RPC error rather than crashing.
    const missingSocket = `/tmp/no-such-socket-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const { stdout, exitCode } = await runMcpWithStdin(
      missingSocket,
      makeJsonRpcCall('fnc_copy_to_clipboard', { text: 'x' }),
    );

    expect(exitCode).toBe(0);
    const envelope = parseFirstRpcEnvelope(stdout);
    expect(envelope.id).toBe(1);
    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32000);
  });
});
