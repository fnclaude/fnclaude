/**
 * §7.6 — Newline-delimited JSON wire format for the AF_UNIX MCP socket.
 *
 * One request → one response per connection. Subprocess dials, writes
 * one JSON line, reads one JSON line, closes. Connections are not
 * reused (per design.mcp.md §3). Each tool call gets a fresh dial.
 *
 * Timeouts (per design.mcp.md §3.3):
 *   - 10s dial timeout: connect() must complete in 10s
 *   - 10s per-call deadline: covers the open-connection write+read window
 *
 * On either timeout, the dial/call is rejected. Callers (the four tool
 * handlers in §8) surface the rejection to claude as a tool-level error
 * — i.e. a successful MCP response containing an error-shaped payload,
 * NOT a JSON-RPC protocol error.
 *
 * Types are intentionally permissive: the wire shape is defined by the
 * parent server in §7.7, so the subprocess only needs to carry fields
 * through. WireRequest's `op` field is the one we constrain.
 */

export type WireOp =
  | 'restart'
  | 'switch'
  | 'spawn'
  | 'copy_to_clipboard'
  | 'compact'
  | 'set_effort'
  | 'set_model'
  | 'run_slash'
  | 'get_usage';

export interface WireRequest {
  op: WireOp;
  [key: string]: unknown;
}

export interface WireResponse {
  ok?: boolean;
  action?: 'done' | 'paste_flow' | 'error' | string;
  message?: string;
  command?: string;
  clipboard_ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface DialAndCallArgs {
  socketPath: string;
  request: WireRequest;
  /** Connect timeout in milliseconds. Default 10s per design.mcp.md §3.3. */
  dialTimeoutMs?: number;
  /** Write+read deadline once the socket is open. Default 10s. */
  callTimeoutMs?: number;
}

const DEFAULT_DIAL_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/**
 * Dial the AF_UNIX socket at `socketPath`, write `request` as one JSON
 * line, read back one JSON line, close. Rejects on dial timeout, call
 * timeout, malformed JSON in the response, or any underlying socket
 * error (ECONNREFUSED, ENOENT, EPIPE, etc).
 *
 * The connection lifetime is bounded by the call timeout — even an
 * actively-writing server can't keep us pinned past callTimeoutMs.
 */
export async function dialAndCall(args: DialAndCallArgs): Promise<WireResponse> {
  const dialTimeoutMs = args.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
  const callTimeoutMs = args.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const payload = JSON.stringify(args.request) + '\n';

  return new Promise<WireResponse>((resolve, reject) => {
    let settled = false;
    let dialTimer: ReturnType<typeof setTimeout> | undefined;
    let callTimer: ReturnType<typeof setTimeout> | undefined;
    let buffered = '';
    // The Bun.connect Promise resolves with a Socket once the OS-level
    // connect completes; we keep a handle here so the timeout branches
    // can close it.
    let socketHandle: { end: () => unknown } | undefined;

    const cleanup = () => {
      if (dialTimer !== undefined) clearTimeout(dialTimer);
      if (callTimer !== undefined) clearTimeout(callTimer);
      try {
        socketHandle?.end();
      } catch {
        // ignore — socket may already be closed
      }
    };

    const settleResolve = (value: WireResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    dialTimer = setTimeout(() => {
      settleReject(
        new Error(
          `dialAndCall: dial timeout after ${dialTimeoutMs}ms connecting to ${args.socketPath}`,
        ),
      );
    }, dialTimeoutMs);

    Bun.connect({
      unix: args.socketPath,
      socket: {
        open(socket) {
          if (settled) {
            socket.end();
            return;
          }
          if (dialTimer !== undefined) clearTimeout(dialTimer);
          dialTimer = undefined;
          socketHandle = socket;
          callTimer = setTimeout(() => {
            settleReject(
              new Error(
                `dialAndCall: call timeout after ${callTimeoutMs}ms (socket ${args.socketPath})`,
              ),
            );
          }, callTimeoutMs);
          socket.write(payload);
        },
        data(socket, chunk) {
          buffered += chunk.toString('utf8');
          const nl = buffered.indexOf('\n');
          if (nl === -1) return;
          const line = buffered.slice(0, nl);
          let parsed: WireResponse;
          try {
            parsed = JSON.parse(line) as WireResponse;
          } catch (err) {
            settleReject(
              new Error(
                `dialAndCall: malformed JSON response: ${(err as Error).message}`,
              ),
            );
            return;
          }
          // Resolve BEFORE closing — Bun fires `close` synchronously
          // from `end()`, which would otherwise race the settle flag.
          settleResolve(parsed);
          try {
            socket.end();
          } catch {
            // ignore
          }
        },
        error(_socket, err) {
          settleReject(
            new Error(
              `dialAndCall: socket error (${args.socketPath}): ${(err as Error).message ?? err}`,
            ),
          );
        },
        close(_socket) {
          if (!settled) {
            settleReject(
              new Error(
                `dialAndCall: connection closed before response (${args.socketPath})`,
              ),
            );
          }
        },
      },
    }).catch((err: unknown) => {
      // Bun.connect's returned Promise rejects on synchronous connect
      // failures (ENOENT for a missing socket file, ECONNREFUSED if no
      // listener, etc.). The `error` handler above covers post-open
      // breaks; this catches the rest.
      settleReject(
        new Error(
          `dialAndCall: connect failed (${args.socketPath}): ${(err as Error).message ?? err}`,
        ),
      );
    });
  });
}
