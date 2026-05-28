/**
 * Unit coverage for the AF_UNIX MCP listener.
 *
 * The listener is the parent half of the in-process MCP transport: the
 * subprocess claude spawns dials this socket once per tool call. Per
 * design.mcp.md §2.1, the parent binds + listens BEFORE spawning claude
 * and explicitly unlinks the socket on shutdown. These tests cover:
 *
 *   1. Happy path: bind, accept a client connection, fire onConnection,
 *      receive data on the wire, stop cleanly.
 *   2. Stale-socket cleanup: a leftover file at the socket path from a
 *      prior crashed run is unlinked best-effort before bind.
 *   3. Bind failure: rejects with a descriptive error (caller treats as
 *      fatal per Go canonical).
 *   4. stop() cleanup: socket file is gone after stop(), idempotent on
 *      repeat invocation.
 *
 * Skipped on win32 — AF_UNIX over Bun.listen({ unix }) is Unix-only
 * today; the Windows path (named pipes) is a §7 follow-up.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMcpListener } from '../../src/mcp/listener.ts';

const SKIP_WINDOWS = process.platform === 'win32';

// Each test allocates its own path; collect them so afterEach can sweep.
const cleanups: string[] = [];

function tempSocketPath(label: string): string {
  // Short, predictable, unlikely-to-collide. Stays well under the
  // 108-byte AF_UNIX sun_path limit on Linux.
  const path = join(tmpdir(), `fnc-mcp-test-${label}-${process.pid}-${Date.now()}.sock`);
  cleanups.push(path);
  return path;
}

afterEach(() => {
  for (const p of cleanups.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      // already gone — fine
    }
  }
});

describe.skipIf(SKIP_WINDOWS)('startMcpListener', () => {
  test('happy path: binds, accepts a client, fires onConnection, cleans up on stop', async () => {
    const socketPath = tempSocketPath('happy');
    let connectionFired = false;
    const dataReceived: string[] = [];

    const listener = await startMcpListener({
      socketPath,
      onConnection: (socket) => {
        connectionFired = true;
        // Hook into the per-socket data path by stashing what we see.
        // The handler shape exposed by Bun.listen calls data() on the
        // socket-handler obj, but onConnection here just gives us the
        // socket; the listener's data() pump forwards through to it.
        socket.handlers.data = (_s, chunk) => {
          dataReceived.push(new TextDecoder().decode(chunk));
        };
      },
    });

    expect(listener.socketPath).toBe(socketPath);
    expect(existsSync(socketPath)).toBe(true);

    // Dial. Bun.connect resolves once open() fires; write a byte, give
    // the listener a tick to process, then tear down.
    const client = await Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          s.write('hello\n');
        },
        data() {},
        close() {},
        error() {},
      },
    });

    // Yield to let the listener's data() handler run.
    await new Promise((r) => setTimeout(r, 50));

    expect(connectionFired).toBe(true);
    expect(dataReceived.join('')).toContain('hello');

    client.end();
    await listener.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test('stale socket file at path: best-effort unlinked before bind', async () => {
    const socketPath = tempSocketPath('stale');
    // Simulate a prior crashed run leaving a file behind at the path.
    writeFileSync(socketPath, 'not a real socket');
    expect(existsSync(socketPath)).toBe(true);

    // If startMcpListener didn't unlink, bind would EADDRINUSE.
    const listener = await startMcpListener({
      socketPath,
      onConnection: () => {},
    });

    expect(existsSync(socketPath)).toBe(true);
    await listener.stop();
  });

  test('bind failure rejects the promise', async () => {
    // Bind to a parent dir that doesn't exist → ENOENT.
    const badPath = '/nonexistent-parent-dir-for-fnc-listener-test/sock';

    await expect(
      startMcpListener({
        socketPath: badPath,
        onConnection: () => {},
      }),
    ).rejects.toThrow();
  });

  test('stop() is idempotent', async () => {
    const socketPath = tempSocketPath('idem');
    const listener = await startMcpListener({
      socketPath,
      onConnection: () => {},
    });

    await listener.stop();
    expect(existsSync(socketPath)).toBe(false);

    // Second stop() must not throw.
    await listener.stop();
    expect(existsSync(socketPath)).toBe(false);
  });
});
