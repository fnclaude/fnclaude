/**
 * The channel flags fnc adds to claude's argv.
 *
 * fnc always names ITSELF as a channel, because its own MCP server is the one
 * server every fnc session already has and the only one it can push through.
 * Which flag carries that entry is the whole subtlety:
 *
 *   `--channels <entry>`
 *       The production flag. During the research preview it accepts only
 *       PLUGINS from an Anthropic-curated allowlist, so `server:fnclaude` on
 *       this flag does not register — claude starts normally and its startup
 *       notice says why. fnc passes it regardless, so that the day fnc ships
 *       as an allowlisted plugin the entry is already there.
 *
 *   `--dangerously-load-development-channels <entry>`
 *       Bypasses that allowlist, per entry, after a confirmation prompt. This
 *       is what actually registers fnc today — and it is why it is gated to a
 *       {@link isDevEnvironment} checkout. An installed copy must never arm an
 *       allowlist bypass on a user's machine.
 *
 * The bypass does NOT extend to `--channels` entries, so an entry that needs
 * it must appear on the development flag itself, not merely alongside it.
 *
 * Neither flag appears in `claude --help` while channels are in preview; both
 * work anyway.
 */

import { CHANNEL_SERVER_NAME } from './channel';

/** fnc's own entry. `server:` is the form for a bare `--mcp-config` server. */
export const FNC_CHANNEL_ENTRY = `server:${CHANNEL_SERVER_NAME}`;

export const CHANNELS_FLAG = '--channels';
export const DEV_CHANNELS_FLAG = '--dangerously-load-development-channels';

export interface ChannelFlagsArgs {
  /** True in a source checkout — see {@link isDevEnvironment}. */
  dev: boolean;
  /** Extra `--channels` entries from config, e.g. `plugin:foo@bar`. */
  additional?: readonly string[];
  /**
   * Extra development-flag entries from config. Ignored entirely outside a dev
   * environment: a setting cannot talk an installed copy into the bypass.
   */
  development?: readonly string[];
}

/**
 * Build the channel flag tokens, or `[]` when there is nothing to name.
 *
 * fnc's own entry lands on the development flag in a dev environment and on
 * `--channels` otherwise — never both, since the entry only needs to be named
 * once and the development flag is the stronger claim.
 */
export function buildChannelFlags(args: ChannelFlagsArgs): string[] {
  // fnc's entry belongs to exactly one flag; a config that also lists it must
  // not get it named twice, which claude would read as two registrations.
  const additional = withoutFnc(dedupe(args.additional ?? []));
  const development = args.dev ? withoutFnc(dedupe(args.development ?? [])) : [];

  const productionEntries = args.dev ? additional : [FNC_CHANNEL_ENTRY, ...additional];
  const developmentEntries = args.dev ? [FNC_CHANNEL_ENTRY, ...development] : [];

  const out: string[] = [];
  if (productionEntries.length > 0) out.push(CHANNELS_FLAG, ...productionEntries);
  if (developmentEntries.length > 0) out.push(DEV_CHANNELS_FLAG, ...developmentEntries);
  return out;
}

function withoutFnc(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry !== FNC_CHANNEL_ENTRY);
}

function dedupe(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}
