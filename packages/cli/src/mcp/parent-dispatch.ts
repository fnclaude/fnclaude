/**
 * §7.7 — Per-tool dispatch on the parent side of the MCP socket.
 *
 * `createParentDispatcher` returns the `onConnection` callback that
 * `startMcpListener` (§7.2) invokes for every accepted AF_UNIX dial. For
 * each connection it:
 *
 *   1. Buffers inbound bytes until the first '\n'.
 *   2. Parses the line as a WireRequest (§7.6 — newline-delimited JSON,
 *      one request per connection).
 *   3. Routes by the `op` field to one of the four per-tool handlers.
 *   4. Awaits the handler's WireResponse, writes it back as one
 *      newline-delimited JSON line, then closes the socket.
 *
 * Concurrency: each accepted connection drives its own handler chain —
 * the listener's data() pump is itself per-socket, so a slow handler on
 * one connection can't block sibling dispatches. We deliberately do not
 * await handler completion in the listener thread (the listener doesn't
 * have a "thread" — Bun.listen calls our data() then returns
 * immediately); the handler chain runs as a floating Promise that ends
 * by writing + closing on its own socket.
 *
 * Stub handlers from §8.1–§8.5 fill in the real per-tool behavior. Until
 * then, default stubs return a placeholder `{ action: 'done',
 * message: '§8.X not yet implemented' }` so the wire still round-trips.
 *
 * Design: docs/design.mcp.md §2.3, §3.
 */

import type { AcceptedSocket } from './listener';
import type { WireOp, WireRequest, WireResponse } from './wire';

export type ParentDispatchHandler = (req: WireRequest) => Promise<WireResponse>;

export type ParentDispatchHandlers = Record<WireOp, ParentDispatchHandler>;

export interface CreateParentDispatcherArgs {
  handlers: ParentDispatchHandlers;
}

/**
 * Default per-tool stub handlers — the wire round-trips cleanly so the
 * full §7 chain can be exercised before §8 lands the real implementations.
 * Each returns `action: 'done'` plus a marker `message` that names the
 * §8.x slot that will replace it.
 */
export const stubParentHandlers: ParentDispatchHandlers = {
  restart: async (_req) => ({ action: 'done', message: '§8.1 fnc_restart not yet implemented' }),
  switch: async (_req) => ({ action: 'done', message: '§8.2 fnc_switch_project not yet implemented' }),
  spawn: async (_req) => ({ action: 'done', message: '§8.3 fnc_spawn_session not yet implemented' }),
  copy_to_clipboard: async (_req) => ({
    action: 'done',
    message: '§8.4 fnc_copy_to_clipboard not yet implemented',
  }),
  // Batch-2 slash-injection ops. Stubbed until main.ts binds the live PTY
  // writer; the keystone-backed handlers replace these at wiring time.
  compact: async (_req) => ({ action: 'queued' }),
  set_effort: async (_req) => ({ action: 'queued' }),
  set_model: async (_req) => ({ action: 'queued' }),
  run_slash: async (_req) => ({ action: 'queued' }),
  // get_usage returns structured data — stub yields an empty report until
  // main.ts binds the launchCWD-bound reader.
  get_usage: async (_req) => ({
    action: 'usage',
    session: { cost_usd: 0, by_model: {} },
    limits: null,
    context: { used: null, model: null },
  }),
};

const KNOWN_OPS = new Set<WireOp>([
  'restart',
  'switch',
  'spawn',
  'copy_to_clipboard',
  'compact',
  'set_effort',
  'set_model',
  'run_slash',
  'get_usage',
]);

function isWireOp(value: unknown): value is WireOp {
  return typeof value === 'string' && KNOWN_OPS.has(value as WireOp);
}

/**
 * Build the `onConnection` callback shape that `startMcpListener` expects.
 * The returned function is invoked once per accepted dial; the listener
 * passes both the underlying `Socket` and the per-connection `handlers`
 * slot, which we populate with our data/close/error implementations.
 */
export function createParentDispatcher(args: CreateParentDispatcherArgs): (accepted: AcceptedSocket) => void {
  return (accepted) => {
    let buffered = '';
    let consumed = false;

    const reply = async (response: WireResponse): Promise<void> => {
      // Wire-protocol contract: write exactly one ndjson line, then close.
      // Wrap write/end in try/catch — the peer may already have closed the
      // half-duplex link by the time we finish the handler.
      try {
        accepted.socket.write(JSON.stringify(response) + '\n');
      } catch {
        // ignore — socket may be gone
      }
      try {
        accepted.socket.end();
      } catch {
        // ignore
      }
    };

    const errorReply = (err: string): Promise<void> => reply({ action: 'error', error: err });

    accepted.handlers.data = (_socket, chunk) => {
      if (consumed) {
        // Per design.mcp.md §3 we read exactly one request per connection.
        // Discard any pipelined bytes — subprocess never sends two on one dial.
        return;
      }
      buffered += chunk.toString('utf8');
      const nl = buffered.indexOf('\n');
      if (nl === -1) return;
      consumed = true;
      const line = buffered.slice(0, nl);

      // Float the handler chain — listener doesn't await us, and we don't
      // need to block sibling sockets on this connection's handler latency.
      void dispatchOne(line, args.handlers, reply, errorReply);
    };

    accepted.handlers.error = (_socket, _err) => {
      // Nothing useful to do here — the subprocess errored its half of
      // the connection. We've either already responded (in which case our
      // .end() raced) or we're past the point of writing back anyway.
      // §8 may want to log; for now stay quiet.
    };

    accepted.handlers.close = (_socket) => {
      // Peer closed before we finished. Nothing to clean up — the
      // dispatcher's state is per-call and goes out of scope on close.
    };
  };
}

async function dispatchOne(
  line: string,
  handlers: ParentDispatchHandlers,
  reply: (r: WireResponse) => Promise<void>,
  errorReply: (msg: string) => Promise<void>,
): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch (err) {
    await errorReply(`malformed request: ${(err as Error).message}`);
    return;
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    await errorReply('malformed request: expected JSON object');
    return;
  }
  const op = (request as { op?: unknown }).op;
  if (!isWireOp(op)) {
    await errorReply(`unknown op: ${typeof op === 'string' ? op : '<missing>'}`);
    return;
  }
  const handler = handlers[op];
  let response: WireResponse;
  try {
    response = await handler(request as WireRequest);
  } catch (err) {
    await errorReply(`handler error: ${(err as Error).message}`);
    return;
  }
  await reply(response);
}
