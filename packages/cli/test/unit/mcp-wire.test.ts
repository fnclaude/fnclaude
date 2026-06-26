/**
 * §7.6 — AF_UNIX wire format for the parent fnclaude MCP listener.
 *
 * Newline-delimited JSON. One request → one response per connection.
 * Tests use Bun.listen({ unix }) to stand up tiny servers and verify
 * dialAndCall's round-trip + timeout semantics.
 *
 * Design: docs/design.mcp.md §3.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dialAndCall } from '../../src/mcp/wire';

const cleanupPaths: string[] = [];

afterEach(() => {
  // Best-effort cleanup of sockets/tempdirs created by individual tests.
  for (const p of cleanupPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-wire-test-'));
  cleanupPaths.push(dir);
  return join(dir, 'sock');
}

describe('dialAndCall — round-trip', () => {
  test('writes one JSON line, reads one JSON line, closes', async () => {
    const socketPath = makeSocketPath();
    const seen: string[] = [];

    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket, data) {
          seen.push(data.toString('utf8'));
          // Echo back a canned response, newline-terminated.
          socket.write(
            JSON.stringify({ ok: true, action: 'done', message: 'hi' }) + '\n',
          );
        },
      },
    });

    try {
      const response = await dialAndCall({
        socketPath,
        request: { op: 'restart', session_id: 'abc' },
      });
      expect(response).toEqual({ ok: true, action: 'done', message: 'hi' });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(
        JSON.stringify({ op: 'restart', session_id: 'abc' }) + '\n',
      );
    } finally {
      server.stop(true);
    }
  });

  test('handles response delivered in multiple chunks', async () => {
    const socketPath = makeSocketPath();
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket, _data) {
          const payload = JSON.stringify({ ok: true, action: 'done' }) + '\n';
          // Split the reply across two writes to confirm dialAndCall
          // accumulates until newline.
          socket.write(payload.slice(0, 10));
          setTimeout(() => socket.write(payload.slice(10)), 10);
        },
      },
    });

    try {
      const response = await dialAndCall({
        socketPath,
        request: { op: 'switch', destination: '/tmp' },
      });
      expect(response).toEqual({ ok: true, action: 'done' });
    } finally {
      server.stop(true);
    }
  });
});

describe('dialAndCall — timeouts', () => {
  test('rejects when server accepts but never replies (callTimeoutMs)', async () => {
    const socketPath = makeSocketPath();
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data() {
          // Accept the request bytes; never write a reply.
        },
      },
    });

    try {
      const start = Date.now();
      await expect(
        dialAndCall({
          socketPath,
          request: { op: 'restart' },
          callTimeoutMs: 100,
        }),
      ).rejects.toThrow(/timeout/i);
      const elapsed = Date.now() - start;
      // Allow generous slack — test infrastructure is noisy.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      server.stop(true);
    }
  });

  test('rejects when socket path does not exist (dial error)', async () => {
    const socketPath = makeSocketPath() + '-nonexistent';
    await expect(
      dialAndCall({
        socketPath,
        request: { op: 'restart' },
        dialTimeoutMs: 100,
        callTimeoutMs: 100,
      }),
    ).rejects.toThrow();
  });
});
