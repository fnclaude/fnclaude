/**
 * Own-child message receiver — the no-hold write surface into this
 * subprocess's own session.
 *
 * `fnc mcp` is a direct, persistent child of the claude session that
 * spawned it, so a post it makes to that session's inbox socket
 * (`CLAUDE_CODE_MESSAGING_SOCKET`) is verified own-child and delivered
 * with no hold — even under `bypassPermissions`, where a peer post is held
 * for approval. This module listens on a sibling control socket and relays
 * each `{content, from?}` line it receives into the inbox on the caller's
 * behalf, answering one `{ok, reply?, error?}` line per connection. The
 * two-axis delivery/identity model this rests on:
 * specs/reverse-engineering/claude-code-cross-session-inbox-socket.md.
 *
 * PROTOTYPE: any same-uid local process can reach the control socket,
 * which bypasses the peer/hold protection. A real feature needs an auth
 * token on the control socket.
 */

import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';

import { startMcpListener, type McpListener } from './listener';

/** How long to keep the inbox connection open for a reply the inbox does not promise. */
const INBOX_REPLY_WINDOW_MS = 600;

const DEFAULT_FROM = 'fnc-relay';

export interface StartMessageReceiverArgs {
  /** This session's inbox socket — `CLAUDE_CODE_MESSAGING_SOCKET`. */
  inboxPath: string;
  /** This session's inbox token — `CLAUDE_CODE_MESSAGING_TOKEN`; optional on Linux/macOS. */
  inboxToken?: string;
}

/** The control socket for the session whose inbox is `inboxPath`: `<runtime-dir>/fnc-receiver-<session-pid>.sock`. */
export function computeReceiverPath(inboxPath: string): string {
  return `${dirname(dirname(inboxPath))}/fnc-receiver-${basename(inboxPath, '.sock')}.sock`;
}

export async function startMessageReceiver(args: StartMessageReceiverArgs): Promise<McpListener> {
  return startMcpListener({
    socketPath: computeReceiverPath(args.inboxPath),
    onConnection({ socket, handlers }) {
      let buffered = '';
      handlers.data = (_socket, chunk) => {
        buffered += chunk.toString('utf8');
        const nl = buffered.indexOf('\n');
        if (nl === -1) {
          return;
        }
        // One message per connection: ignore anything after the first line.
        handlers.data = undefined;
        void relayIntoInbox(args, buffered.slice(0, nl)).then((ack) => {
          socket.write(JSON.stringify(ack) + '\n');
          socket.end();
        });
      };
    },
  });
}

async function relayIntoInbox(
  args: StartMessageReceiverArgs,
  line: string,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  let request: { content?: unknown; from?: unknown };
  try {
    request = JSON.parse(line) as { content?: unknown; from?: unknown };
  } catch (err) {
    return { ok: false, error: `malformed JSON: ${(err as Error).message}` };
  }
  if (typeof request.content !== 'string' || !request.content) {
    return { ok: false, error: 'content must be a non-empty string' };
  }
  const from = typeof request.from === 'string' && request.from ? request.from : DEFAULT_FROM;
  try {
    return { ok: true, reply: await postOwnChild(args, request.content, from) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Posts one user message into the inbox as this process, resolving with whatever the inbox wrote back. */
function postOwnChild(args: StartMessageReceiverArgs, content: string, from: string): Promise<string> {
  const lines: string[] = [];
  if (args.inboxToken) {
    lines.push(JSON.stringify({ type: 'auth', token: args.inboxToken }));
  }
  lines.push(
    JSON.stringify({
      msgV: 1,
      msg_id: randomUUID(),
      type: 'user',
      message: { role: 'user', content },
      priority: 'next',
      from,
    }),
  );
  const payload = lines.join('\n') + '\n';

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let reply = '';
    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(reply);
    };
    const settleReject = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };
    Bun.connect({
      unix: args.inboxPath,
      socket: {
        open(socket) {
          socket.write(payload);
          setTimeout(() => {
            // Settle BEFORE closing — Bun fires `close` synchronously from `end()`.
            settleResolve();
            try {
              socket.end();
            } catch {
              // already closed by the inbox
            }
          }, INBOX_REPLY_WINDOW_MS);
        },
        data(_socket, chunk) {
          reply += chunk.toString('utf8');
        },
        error(_socket, err) {
          settleReject(new Error(`inbox socket error (${args.inboxPath}): ${err.message}`));
        },
        close() {
          settleResolve();
        },
      },
    }).catch((err: unknown) => {
      settleReject(new Error(`inbox connect failed (${args.inboxPath}): ${(err as Error).message}`));
    });
  });
}
