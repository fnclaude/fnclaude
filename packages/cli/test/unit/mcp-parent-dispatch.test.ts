/**
 * §7.7 — Per-tool dispatch on the parent side of the AF_UNIX MCP socket.
 *
 * The parent's listener accepts each subprocess dial, reads one
 * newline-delimited JSON request, routes by the `op` field to one of the
 * four per-tool handlers, writes a single newline-delimited JSON
 * response, then closes. Each connection runs concurrently — a slow
 * handler can't block sibling dispatches.
 *
 * These tests cover the pure dispatcher factory and a real-socket
 * round-trip that mirrors how main.ts wires it in. Bun.listen + Bun.connect
 * stand up an actual AF_UNIX socket for the integration case; mocks would
 * hide exactly the wire-protocol bugs this layer exists to prevent.
 *
 * Design: docs/design.mcp.md §2.3, §3.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMcpListener } from '../../src/mcp/listener';
import { createParentDispatcher } from '../../src/mcp/parent-dispatch';
import type { WireOp, WireRequest, WireResponse } from '../../src/mcp/wire';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-parent-dispatch-test-'));
  cleanupPaths.push(dir);
  return join(dir, 'sock');
}

/**
 * Build a record of stub handlers that record what they saw and return a
 * deterministic response. Tests can override individual ops by passing
 * `overrides` to spy on specific routing decisions.
 */
function makeRecordingHandlers(overrides?: Partial<Record<WireOp, (req: WireRequest) => Promise<WireResponse>>>): {
  handlers: Record<WireOp, (req: WireRequest) => Promise<WireResponse>>;
  seen: { op: WireOp; request: WireRequest }[];
} {
  const seen: { op: WireOp; request: WireRequest }[] = [];
  const make = (op: WireOp): (req: WireRequest) => Promise<WireResponse> => async (req: WireRequest) => {
    seen.push({ op, request: req });
    return { action: 'done', message: `handled ${op}` };
  };
  const handlers: Record<WireOp, (req: WireRequest) => Promise<WireResponse>> = {
    restart: overrides?.restart ?? make('restart'),
    switch: overrides?.switch ?? make('switch'),
    spawn: overrides?.spawn ?? make('spawn'),
    copy_to_clipboard: overrides?.copy_to_clipboard ?? make('copy_to_clipboard'),
  };
  return { handlers, seen };
}

// ---------------------------------------------------------------
// Pure routing / parsing — no socket layer involved.
// These exercise the dispatcher's response shape directly by faking
// an AcceptedSocket whose data() handler we drive in-process.
// ---------------------------------------------------------------

interface FakeSocket {
  written: string[];
  ended: boolean;
  write(data: string): number;
  end(): void;
}

function makeFakeSocket(): FakeSocket {
  const sock: FakeSocket = {
    written: [],
    ended: false,
    write(data: string): number {
      sock.written.push(data);
      return data.length;
    },
    end(): void {
      sock.ended = true;
    },
  };
  return sock;
}

/**
 * Drive the dispatcher's onConnection callback by mimicking the
 * AcceptedSocket shape the listener exposes. The pure path lets us
 * exercise routing + response framing without binding a real socket.
 */
async function driveDispatcher(
  onConnection: (accepted: {
    socket: unknown;
    handlers: {
      data?: (socket: unknown, data: Buffer) => void;
      close?: (socket: unknown) => void;
      error?: (socket: unknown, error: Error) => void;
    };
  }) => void,
  payload: string,
): Promise<FakeSocket> {
  const fake = makeFakeSocket();
  const handlers: {
    data?: (socket: unknown, data: Buffer) => void;
    close?: (socket: unknown) => void;
    error?: (socket: unknown, error: Error) => void;
  } = {};
  onConnection({ socket: fake, handlers });
  handlers.data?.(fake, Buffer.from(payload, 'utf8'));
  // Give the async handler chain a chance to complete before assertion.
  await new Promise((r) => setTimeout(r, 30));
  return fake;
}

describe('createParentDispatcher — pure routing', () => {
  test('routes restart op to restart handler and writes ndjson response', async () => {
    const { handlers, seen } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });
    const fake = await driveDispatcher(
      dispatcher,
      JSON.stringify({ op: 'restart', session_id: 'abc' }) + '\n',
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.op).toBe('restart');
    expect(seen[0]?.request).toEqual({ op: 'restart', session_id: 'abc' });

    expect(fake.written).toHaveLength(1);
    const line = fake.written[0]!;
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trimEnd())).toEqual({ action: 'done', message: 'handled restart' });
    expect(fake.ended).toBe(true);
  });

  test('routes switch / spawn / copy_to_clipboard to their respective handlers', async () => {
    const { handlers, seen } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });

    for (const op of ['switch', 'spawn', 'copy_to_clipboard'] as const) {
      const fake = await driveDispatcher(dispatcher, JSON.stringify({ op }) + '\n');
      expect(fake.ended).toBe(true);
      expect(fake.written).toHaveLength(1);
    }

    expect(seen.map((s) => s.op)).toEqual(['switch', 'spawn', 'copy_to_clipboard']);
  });

  test('malformed JSON → error response and socket closed', async () => {
    const { handlers, seen } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });
    const fake = await driveDispatcher(dispatcher, 'not-json-at-all\n');

    expect(seen).toHaveLength(0);
    expect(fake.written).toHaveLength(1);
    const reply = JSON.parse(fake.written[0]!.trimEnd()) as WireResponse;
    expect(reply.action).toBe('error');
    expect(typeof reply.error).toBe('string');
    expect(fake.ended).toBe(true);
  });

  test('unknown op → error response and socket closed', async () => {
    const { handlers, seen } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });
    const fake = await driveDispatcher(
      dispatcher,
      JSON.stringify({ op: 'not-a-real-op' }) + '\n',
    );

    expect(seen).toHaveLength(0);
    expect(fake.written).toHaveLength(1);
    const reply = JSON.parse(fake.written[0]!.trimEnd()) as WireResponse;
    expect(reply.action).toBe('error');
    expect(reply.error).toContain('unknown op');
    expect(fake.ended).toBe(true);
  });

  test('missing op field → error response and socket closed', async () => {
    const { handlers, seen } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });
    const fake = await driveDispatcher(
      dispatcher,
      JSON.stringify({ no_op: true }) + '\n',
    );

    expect(seen).toHaveLength(0);
    expect(fake.written).toHaveLength(1);
    const reply = JSON.parse(fake.written[0]!.trimEnd()) as WireResponse;
    expect(reply.action).toBe('error');
    expect(fake.ended).toBe(true);
  });

  test('handler that throws surfaces as error response (no crash)', async () => {
    const { handlers } = makeRecordingHandlers({
      restart: async () => {
        throw new Error('handler exploded');
      },
    });
    const dispatcher = createParentDispatcher({ handlers });
    const fake = await driveDispatcher(
      dispatcher,
      JSON.stringify({ op: 'restart' }) + '\n',
    );

    expect(fake.written).toHaveLength(1);
    const reply = JSON.parse(fake.written[0]!.trimEnd()) as WireResponse;
    expect(reply.action).toBe('error');
    expect(reply.error).toContain('handler exploded');
    expect(fake.ended).toBe(true);
  });

  test('handles request delivered in multiple data chunks', async () => {
    const { handlers, seen } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });

    const payload = JSON.stringify({ op: 'restart', session_id: 'abc' }) + '\n';
    const fake = makeFakeSocket();
    const sockHandlers: {
      data?: (socket: unknown, data: Buffer) => void;
      close?: (socket: unknown) => void;
      error?: (socket: unknown, error: Error) => void;
    } = {};
    dispatcher({ socket: fake, handlers: sockHandlers });
    sockHandlers.data?.(fake, Buffer.from(payload.slice(0, 8), 'utf8'));
    sockHandlers.data?.(fake, Buffer.from(payload.slice(8), 'utf8'));
    await new Promise((r) => setTimeout(r, 30));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.request).toEqual({ op: 'restart', session_id: 'abc' });
    expect(fake.ended).toBe(true);
  });
});

// ---------------------------------------------------------------
// Real-socket integration — exercises the listener + dispatcher
// end-to-end through Bun.listen / Bun.connect.
// ---------------------------------------------------------------

const SKIP_WINDOWS = process.platform === 'win32';

describe.skipIf(SKIP_WINDOWS)('createParentDispatcher — real AF_UNIX integration', () => {
  test('round-trip: client writes request, receives response, parent closes connection', async () => {
    const socketPath = makeSocketPath();
    const { handlers, seen } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });

    const listener = await startMcpListener({ socketPath, onConnection: dispatcher });

    try {
      const response = await dialOnce(socketPath, { op: 'spawn', destination: '/tmp' });
      expect(response).toEqual({ action: 'done', message: 'handled spawn' });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.op).toBe('spawn');
    } finally {
      await listener.stop();
    }
  });

  test('two simultaneous dials both get responses (concurrency)', async () => {
    const socketPath = makeSocketPath();
    // Slow each handler so they're guaranteed to be in flight together.
    const inflight: { count: number; max: number } = { count: 0, max: 0 };
    const { handlers } = makeRecordingHandlers({
      spawn: async (req) => {
        inflight.count++;
        inflight.max = Math.max(inflight.max, inflight.count);
        await new Promise((r) => setTimeout(r, 80));
        inflight.count--;
        return { action: 'done', message: `spawn ${(req as { tag?: string }).tag ?? ''}`.trim() };
      },
    });
    const dispatcher = createParentDispatcher({ handlers });

    const listener = await startMcpListener({ socketPath, onConnection: dispatcher });

    try {
      const [a, b] = await Promise.all([
        dialOnce(socketPath, { op: 'spawn', tag: 'A' }),
        dialOnce(socketPath, { op: 'spawn', tag: 'B' }),
      ]);
      expect([a.message, b.message].sort()).toEqual(['spawn A', 'spawn B']);
      // If dispatch were serialized the max would be 1.
      expect(inflight.max).toBeGreaterThanOrEqual(2);
    } finally {
      await listener.stop();
    }
  });

  test('malformed JSON over real socket → error response', async () => {
    const socketPath = makeSocketPath();
    const { handlers } = makeRecordingHandlers();
    const dispatcher = createParentDispatcher({ handlers });

    const listener = await startMcpListener({ socketPath, onConnection: dispatcher });

    try {
      const response = await dialRaw(socketPath, 'not json\n');
      expect(response.action).toBe('error');
      expect(typeof response.error).toBe('string');
    } finally {
      await listener.stop();
    }
  });
});

/**
 * Connect, write one JSON line, read one JSON line, close. Mirrors the
 * subprocess's per-call dial shape from §7.6.
 */
async function dialOnce(socketPath: string, request: WireRequest): Promise<WireResponse> {
  return dialRaw(socketPath, JSON.stringify(request) + '\n');
}

async function dialRaw(socketPath: string, payload: string): Promise<WireResponse> {
  return new Promise<WireResponse>((resolve, reject) => {
    let buffered = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`dialOnce: timeout after 2000ms (${socketPath})`));
    }, 2000);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(payload);
        },
        data(socket, chunk) {
          buffered += chunk.toString('utf8');
          const nl = buffered.indexOf('\n');
          if (nl === -1) return;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            const line = buffered.slice(0, nl);
            resolve(JSON.parse(line) as WireResponse);
          } catch (err) {
            reject(err as Error);
          }
          try {
            socket.end();
          } catch {
            // ignore
          }
        },
        error(_s, err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err as Error);
        },
        close() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('dialOnce: closed before response'));
        },
      },
    }).catch((err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err as Error);
    });
  });
}
