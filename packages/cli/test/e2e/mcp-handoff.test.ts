/**
 * End-to-end test of the MCP handoff round-trip.
 *
 * Real components in this test:
 *
 *   - The parent-side SocketListener (mcp/socketListener.ts), bound to a
 *     real AF_UNIX socket in a temp dir under XDG_RUNTIME_DIR.
 *   - The MCP server subprocess — actually `bun bin/fnc.js mcp` spawned
 *     via Bun.spawn. The subprocess opens a real socket connection to the
 *     parent and runs the real JSON-RPC stdio loop.
 *
 * The flow:
 *
 *   1. Test starts SocketListener listening on a temp socket.
 *   2. Test spawns `bun bin/fnc.js mcp` with FNC_SOCKET=<temp socket>.
 *   3. Test writes a JSON-RPC initialize + tools/call request to the
 *      subprocess's stdin.
 *   4. Subprocess dials the parent socket, sends the Request, the
 *      listener handles it, returns a Response.
 *   5. Subprocess relays the Response back to the test via stdout as a
 *      JSON-RPC result.
 *   6. Test asserts the listener's Triggered() promise resolved with the
 *      expected argv (for fnc_restart) and that the JSON-RPC result on
 *      stdout reports action=done.
 *
 * Why this matters: the listener and the MCP client have separate unit
 * tests (test/mcp/socketListener.test.ts and test/mcp/client.test.ts)
 * that stub each other out. This test is the only one that verifies the
 * wire-protocol round-trip works end-to-end across two real processes.
 *
 * Skipped on Windows — the listener uses AF_UNIX, which the Windows port
 * stubs out (see src/pty/windows.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultConfig } from '../../src/config.js';
import type { HandoffSpec } from '../../src/handoff.js';
import { SocketListener } from '../../src/mcp/socketListener.js';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');
const BIN = resolve(CLI_ROOT, 'bin', 'fnc.js');
const BUN = process.execPath;

interface Fixture {
  dir: string;
  socketPath: string;
  listener: SocketListener;
  cleanup: () => Promise<void>;
}

let fixtures: Fixture[] = [];

beforeEach(() => {
  fixtures = [];
});
afterEach(async () => {
  for (const fx of fixtures) {
    await fx.cleanup();
  }
  fixtures = [];
});

async function makeFixture(launchCWD: string): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'fnclaude-e2e-mcp-'));
  // PID-style filename, but using process.pid + random suffix so the test
  // doesn't collide with itself across parallel runs (Bun runs tests in
  // a single process so this is mostly belt-and-braces).
  const sockName = `fnclaude-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.sock`;
  const socketPath = join(dir, sockName);
  const cfg = defaultConfig();
  const spec: HandoffSpec = {
    mode: 'ask',
    socketPath,
    originalArgs: [],
  };
  const listener = await SocketListener.start({
    spec,
    cfg,
    launchCWD,
    // No clipboard / spawn stubs needed — the ops we exercise (restart,
    // copy_to_clipboard) don't need them, and any that do (spawn) will
    // get the no-op defaults from defaultDeps().
  });
  const fx: Fixture = {
    dir,
    socketPath,
    listener,
    cleanup: async () => {
      await listener.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  fixtures.push(fx);
  return fx;
}

interface CallResult {
  /** Parsed JSON-RPC stdout lines from the subprocess. */
  rpcResponses: Array<Record<string, unknown>>;
  /** Subprocess exit code. */
  exitCode: number;
  /** Captured stderr from the subprocess. */
  stderr: string;
}

/**
 * Spawn `bun bin/fnc.js mcp` with FNC_SOCKET pointing at the test
 * listener, feed it the given JSON-RPC requests on stdin, close stdin,
 * and collect the stdout responses.
 */
async function spawnMCPAndCall(
  socketPath: string,
  reqs: ReadonlyArray<Record<string, unknown>>,
  opts: { timeoutMs?: number; noop?: boolean } = {},
): Promise<CallResult> {
  const timeout = opts.timeoutMs ?? 15_000;
  const args = ['mcp'];
  if (opts.noop === true) args.push('--noop');

  const stdin = `${reqs.map((r) => JSON.stringify(r)).join('\n')}\n`;

  const proc = Bun.spawn([BUN, BIN, ...args], {
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      FNC_SOCKET: socketPath,
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const rpcResponses = stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { rpcResponses, exitCode, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(SKIP_WINDOWS)('MCP handoff e2e (real socket + real subprocess)', () => {
  test('fnc_restart round-trip fires Triggered() with the expected argv', async () => {
    const launchCWD = '/launch/cwd/for/e2e';
    const fx = await makeFixture(launchCWD);

    const sid = 'abcdef12-3456-7890-abcd-ef1234567890';
    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };
    const callReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'fnc_restart',
        arguments: { session_id: sid },
      },
    };

    const result = await spawnMCPAndCall(fx.socketPath, [initReq, callReq]);

    // Subprocess exited cleanly on stdin EOF.
    expect(result.exitCode).toBe(0);
    expect(result.rpcResponses.length).toBe(2);

    // 1st response: initialize → result.protocolVersion.
    const initResp = result.rpcResponses[0]!;
    expect(initResp.id).toBe(1);
    const initRes = initResp.result as Record<string, unknown>;
    expect(initRes.protocolVersion).toBe('2024-11-05');

    // 2nd response: tools/call result wraps the Response as a text content.
    const callResp = result.rpcResponses[1]!;
    expect(callResp.id).toBe(2);
    const callRes = callResp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(callRes.isError).toBeFalsy();
    expect(callRes.content.length).toBe(1);
    const inner = JSON.parse(callRes.content[0]!.text) as Record<string, unknown>;
    expect(inner.action).toBe('done');

    // Listener should have stashed an argv and fired the triggered promise.
    await Promise.race([
      fx.listener.triggered(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('triggered() never resolved')), 3_000)),
    ]);
    const stashed = fx.listener.getHandoffArgv();
    expect(stashed).not.toBeUndefined();
    // Restart shape: [launchCWD, '--resume', sid] (no preserved magic since
    // origArgs was []).
    expect(stashed).toEqual([launchCWD, '--resume', sid]);
  });

  test('fnc_copy_to_clipboard round-trip returns action=done', async () => {
    // Uses the noop clipboard stub from defaultDeps() — `ok` will be false
    // since no clipboard backend is wired, but the action is still 'done'.
    const fx = await makeFixture('/launch/cwd');
    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };
    const callReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'fnc_copy_to_clipboard',
        arguments: { text: 'hello from e2e' },
      },
    };

    const result = await spawnMCPAndCall(fx.socketPath, [initReq, callReq], { noop: true });
    expect(result.exitCode).toBe(0);
    expect(result.rpcResponses.length).toBe(2);

    const callResp = result.rpcResponses[1]!;
    const callRes = callResp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(callRes.isError).toBeFalsy();
    const inner = JSON.parse(callRes.content[0]!.text) as Record<string, unknown>;
    expect(inner.action).toBe('done');
    // No-op default reports clipboard_ok=false.
    expect(inner.clipboard_ok).toBe(false);
  });

  test('fnc_restart without session_id returns a tool-level error', async () => {
    const fx = await makeFixture('/launch/cwd');
    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };
    const callReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'fnc_restart',
        arguments: {}, // no session_id
      },
    };

    const result = await spawnMCPAndCall(fx.socketPath, [initReq, callReq]);
    expect(result.exitCode).toBe(0);
    const callResp = result.rpcResponses[1]!;
    const callRes = callResp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(callRes.isError).toBe(true);
    expect(callRes.content[0]!.text.toLowerCase()).toContain('session_id');

    // Triggered() should NOT have fired.
    const fired = await Promise.race([
      fx.listener.triggered().then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 250)),
    ]);
    expect(fired).toBe(false);
    expect(fx.listener.getHandoffArgv()).toBeUndefined();
  });

  test('subprocess with no FNC_SOCKET returns socket-unavailable error', async () => {
    // The bin we spawn here doesn't get FNC_SOCKET — the client code path
    // returns the SOCKET_UNAVAILABLE_MSG tool error WITHOUT trying to dial.
    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    };
    const callReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'fnc_restart',
        arguments: { session_id: 'abcdef12-3456-7890-abcd-ef1234567890' },
      },
    };
    // Pass empty socket path explicitly (env-less path).
    const proc = Bun.spawn([BUN, BIN, 'mcp'], {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        FNC_SOCKET: '', // explicitly empty
      },
      stdin: new TextEncoder().encode(`${JSON.stringify(initReq)}\n${JSON.stringify(callReq)}\n`),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const callResp = JSON.parse(lines[1]!) as Record<string, unknown>;
    const callRes = callResp.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(callRes.isError).toBe(true);
    expect(callRes.content[0]!.text.toLowerCase()).toContain('socket');
  });
});
