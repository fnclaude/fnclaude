/**
 * AF_UNIX MCP listener — parent half of the in-process transport.
 *
 * Per docs/design.mcp.md §2.1, the launcher binds + listens BEFORE
 * spawning claude, so the MCP subprocess (which claude spawns from the
 * injected --mcp-config) can dial back via $FNC_SOCKET on every tool
 * call. The accept loop runs `onConnection` per incoming dial; the
 * caller (parent-side dispatch in §7.7) wires per-connection
 * read-one-request / write-one-response logic onto each socket.
 *
 * Today the listener is generic: it doesn't parse requests itself. That
 * lets §7.2 ship in isolation — wire-format + JSON-RPC scaffolding land
 * in §7.3 and §7.6.
 *
 * Cleanup contract (matches Go canonical and design.mcp.md §7):
 *   - Best-effort unlink of any stale socket file before bind. Covers
 *     unclean shutdowns from a prior PID-colliding fnclaude.
 *   - On stop(), close the listener and best-effort unlink the file.
 *     Bun.listen.stop() already removes the file on Linux, but the
 *     explicit unlink mirrors the design's defense-in-depth posture.
 *   - stop() is idempotent — calling it twice is a no-op the second
 *     time (the listener is null after first stop).
 *
 * Cross-platform: throws NotImplementedYet on win32. AF_UNIX over
 * Bun.listen({ unix }) is Unix-only today; the Windows named-pipe path
 * is a sibling §7 follow-up. Callers (main.ts) skip listener startup
 * entirely on win32 so the launcher still works without self-MCP.
 */

import { unlink } from 'node:fs/promises';
import type { Socket, SocketHandler } from 'bun';

/**
 * Per-connection socket exposed to onConnection. The `handlers` field is
 * a writable wrapper around the static Bun socket handlers so per-call
 * code can install its own data() / close() / error() implementations
 * without each implementation having to be re-registered as a separate
 * Bun.listen call. The dispatch layer (§7.7) overrides these to drive
 * the newline-delimited JSON protocol.
 */
export interface AcceptedSocket {
  socket: Socket<undefined>;
  handlers: {
    data?: (socket: Socket<undefined>, data: Buffer) => void;
    close?: (socket: Socket<undefined>) => void;
    error?: (socket: Socket<undefined>, error: Error) => void;
  };
}

export interface StartMcpListenerArgs {
  socketPath: string;
  onConnection: (accepted: AcceptedSocket) => void;
}

export interface McpListener {
  socketPath: string;
  stop: () => Promise<void>;
}

export async function startMcpListener(args: StartMcpListenerArgs): Promise<McpListener> {
  if (process.platform === 'win32') {
    throw new Error(
      'startMcpListener: win32 not yet supported (AF_UNIX path only); see build-plan §7 follow-up',
    );
  }

  // Best-effort unlink of a stale socket file from a prior crashed run.
  // ENOENT is the normal "no leftover" case — swallow it; anything else
  // is also swallowed because bind() will surface a clearer error in a
  // moment (EADDRINUSE if the file's still there as a real bound socket,
  // EACCES if perms are wrong, etc.).
  try {
    await unlink(args.socketPath);
  } catch {
    // intentionally ignored
  }

  // Per-connection routing table. Bun.listen takes a single static
  // handler block; we route per-socket via a WeakMap keyed on the
  // Socket object so each connection's onConnection callback can hang
  // its own handlers without affecting siblings.
  const perSocketHandlers = new WeakMap<Socket<undefined>, AcceptedSocket['handlers']>();

  const handler: SocketHandler<undefined> = {
    open(socket) {
      const handlers: AcceptedSocket['handlers'] = {};
      perSocketHandlers.set(socket, handlers);
      args.onConnection({ socket, handlers });
    },
    data(socket, data) {
      const h = perSocketHandlers.get(socket);
      h?.data?.(socket, data);
    },
    close(socket) {
      const h = perSocketHandlers.get(socket);
      h?.close?.(socket);
      perSocketHandlers.delete(socket);
    },
    error(socket, error) {
      const h = perSocketHandlers.get(socket);
      h?.error?.(socket, error);
    },
  };

  // Bun.listen throws synchronously on bind failure (verified empirically
  // against Bun 1.3.14 — ENOENT for bad parent dir, EADDRINUSE for
  // already-bound). Wrap in try/catch + reject so the contract matches a
  // promise-returning startup; main.ts treats rejection as fatal.
  let bunListener;
  try {
    bunListener = Bun.listen<undefined>({
      unix: args.socketPath,
      socket: handler,
    });
  } catch (err) {
    throw new Error(
      `startMcpListener: failed to bind ${args.socketPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    bunListener.stop();
    // Defense-in-depth unlink. Bun.listen.stop() already removes the
    // file on Linux, but design.mcp.md §7 calls for an explicit unlink
    // so platforms that don't auto-clean still get covered.
    try {
      await unlink(args.socketPath);
    } catch {
      // already gone — expected on Linux/macOS
    }
  };

  return {
    socketPath: args.socketPath,
    stop,
  };
}
