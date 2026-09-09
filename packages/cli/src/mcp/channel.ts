/**
 * fnc as a Claude Code CHANNEL — the server→session push path.
 *
 * A channel is an MCP server that emits `notifications/claude/channel`
 * whenever it likes, rather than only answering tool calls. The event reaches
 * the model wrapped in a `<channel source="…">` tag, so it is structurally
 * distinct from a user turn — which is what makes this the right shape for
 * anything fnc needs to tell a running session about.
 *
 * Two halves, and both are required:
 *
 *   - THIS file, which declares the capability (see {@link CHANNEL_CAPABILITY},
 *     folded into the `initialize` result) and writes the notifications.
 *   - The launcher naming fnc in a channel flag. Being present in
 *     `--mcp-config` is NOT enough: Claude Code registers a channel listener
 *     only for servers named on the command line. See `channel-flags.ts`.
 *
 * Delivery is fire-and-forget and unacknowledged. Claude Code drops events
 * silently when the server was not registered as a channel — no error comes
 * back — so a caller that needs to know it landed has to ask the session to
 * say so through a tool.
 */

/**
 * The `initialize` capability whose mere presence registers the listener.
 *
 * Always `{}`; the value carries nothing. It lives under `experimental`
 * because channels are a research preview.
 */
export const CHANNEL_CAPABILITY = { 'claude/channel': {} } as const;

/** The `--mcp-config` key fnc registers itself under, and its channel entry. */
export const CHANNEL_SERVER_NAME = 'fnclaude';

/** The JSON-RPC notification method Claude Code listens for. */
const CHANNEL_METHOD = 'notifications/claude/channel';

/**
 * Meta keys must be bare identifiers — Claude Code turns each into an
 * attribute on the `<channel>` tag and SILENTLY DROPS any key containing a
 * hyphen or other punctuation. Dropping them here instead means a caller's
 * typo is visible in fnc's own tests rather than as a missing attribute in a
 * transcript nobody is reading.
 */
const IDENTIFIER = /^[A-Za-z0-9_]+$/;

export interface ChannelMessage {
  /** The event body, delivered as the `<channel>` tag's contents. */
  content: string;
  /** Routing context; each entry becomes an attribute on the tag. */
  meta?: Record<string, string>;
}

/** Writes one line of newline-delimited JSON to the transport. */
export type ChannelWriter = (line: string) => void;

/**
 * Serialize one channel notification.
 *
 * Separate from {@link pushChannelMessage} so tests can assert the exact wire
 * bytes without a writer, and so the shape stays checkable as the research
 * preview's contract moves.
 */
export function formatChannelNotification(message: ChannelMessage): string {
  const meta = pickIdentifierKeys(message.meta ?? {});
  const params: Record<string, unknown> = { content: message.content };
  if (Object.keys(meta).length > 0) params.meta = meta;
  return JSON.stringify({ jsonrpc: '2.0', method: CHANNEL_METHOD, params });
}

/** Push one channel event into the session. Returns nothing: nobody acks. */
export function pushChannelMessage(write: ChannelWriter, message: ChannelMessage): void {
  write(`${formatChannelNotification(message)}\n`);
}

function pickIdentifierKeys(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (IDENTIFIER.test(key)) out[key] = value;
  }
  return out;
}
