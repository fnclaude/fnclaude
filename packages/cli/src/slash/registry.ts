/**
 * fnc-native slash-command framework.
 *
 * A submitted renderer line starting with `//` (double slash) is an
 * fnc-native command: fnc intercepts it and NEVER forwards it to claude. A
 * single `/` is unchanged — it passes straight through to claude (`/compact`,
 * `/model`, …). The renderer only detects the `//` prefix and hands the raw
 * line to the cli; THIS module owns resolution + dispatch.
 *
 * Resolution (locked design):
 *   - The token after `//`, up to the first space, is matched as a PREFIX
 *     against the union of every command's `name` and its `aliases`.
 *   - Resolution is at the COMMAND level. Aliases of the SAME command never
 *     conflict — `//re` prefix-matches both name `restart` and alias `reload`,
 *     but they belong to one command → unique → runs.
 *   - Matches spanning TWO OR MORE distinct commands → ambiguous: the caller
 *     surfaces the candidates, executes nothing, forwards nothing.
 *   - Zero matches → unknown command; nothing runs, nothing is forwarded.
 *   - Text after the first space is the argument string handed to the handler.
 *
 * Adding a command is one registry entry — the framework is generic;
 * `//restart` is simply the first registration.
 */

import type { HandoffTrigger } from '../handoff/trigger';
import { type LivePermissionModeReader, restartInPlace } from '../restart/restart-core';

/**
 * Everything a slash handler needs from the host at dispatch time. The host
 * (renderer-mount) builds this once and binds it into the dispatch closure;
 * per-invocation it fills in `args` (and the live `sessionId`).
 */
export interface SlashContext {
  /** The argument string: everything after the first space in the `//` line. */
  args: string;
  /**
   * claude's current session id (from the `system`/`init` event the renderer
   * ingested), or `null` when it isn't known yet. Commands that need it (e.g.
   * restart) report a friendly message rather than acting on a null id.
   */
  sessionId: string | null;
  /** fnc's resolved launch cwd — the first positional in a relaunch argv. */
  launchCWD: string;
  /** The user's original argv as fnc saw it at startup (post-readArgv). */
  origArgs: readonly string[];
  /** Shared handoff trigger; restart/handoff commands stash + fire it. */
  trigger: HandoffTrigger;
  /** Optional live permission-mode reader for restart's auto-capture. */
  livePermissionModeReader?: LivePermissionModeReader;
}

/** Feedback surfaced to the user (rendered as a toast in the status line). */
export interface SlashResult {
  /** Whether the command succeeded. */
  ok: boolean;
  /** One-line message shown to the user. */
  message: string;
}

/** A registered fnc-native command. */
export interface SlashCommand {
  /** Primary name (the canonical token, e.g. `restart`). */
  name: string;
  /** Alternate tokens that resolve to this same command (e.g. `reload`). */
  aliases: string[];
  /** One-line description for help/listing surfaces. */
  description: string;
  /** Run the command. May be async (restart fires a handoff, then returns). */
  handler(ctx: SlashContext): Promise<SlashResult> | SlashResult;
}

/** The `//restart` command (alias `//reload`) — registry entry #1. */
export const restartCommand: SlashCommand = {
  name: 'restart',
  aliases: ['reload'],
  description: 'Restart this session in place, resuming the same conversation.',
  handler(ctx: SlashContext): SlashResult {
    if (ctx.sessionId === null) {
      return {
        ok: false,
        message: 'restart unavailable: session id not known yet — wait for the session to start.',
      };
    }
    const result = restartInPlace({
      sessionId: ctx.sessionId,
      launchCWD: ctx.launchCWD,
      origArgs: ctx.origArgs,
      trigger: ctx.trigger,
      ...(ctx.livePermissionModeReader !== undefined
        ? { livePermissionModeReader: ctx.livePermissionModeReader }
        : {}),
    });
    if (!result.ok) {
      return { ok: false, message: `restart failed: ${result.reason.replace(/-/g, ' ')}.` };
    }
    return { ok: true, message: 'restarting…' };
  },
};

/** The command registry. Order is display order; `restart` is entry #1. */
export const REGISTRY: readonly SlashCommand[] = [restartCommand];

/** Outcome of resolving a `//` token against a command set. */
export type ResolveResult =
  | { kind: 'unique'; command: SlashCommand }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

/**
 * Resolve `token` (the run after `//`, without arguments) against `commands`
 * by prefix. A command matches when `token` is a prefix of ANY of its
 * name/aliases; the result collapses to the COMMAND level so a token that
 * matches several aliases of one command still resolves uniquely. Exposed
 * (over the default {@link resolve}) so the resolution rules are unit-testable
 * against fixture commands without needing real registrations.
 */
export function resolveIn(token: string, commands: readonly SlashCommand[]): ResolveResult {
  if (token === '') return { kind: 'none' };
  const matched: SlashCommand[] = [];
  for (const cmd of commands) {
    const names = [cmd.name, ...cmd.aliases];
    if (names.some((n) => n.startsWith(token))) matched.push(cmd);
  }
  if (matched.length === 0) return { kind: 'none' };
  if (matched.length === 1) return { kind: 'unique', command: matched[0]! };
  return { kind: 'ambiguous', candidates: matched.map((c) => c.name) };
}

/** Resolve `token` against the live {@link REGISTRY}. */
export function resolve(token: string): ResolveResult {
  return resolveIn(token, REGISTRY);
}

/**
 * Split a raw `//` line into its command token and argument string. Strips the
 * leading `//`, takes the run up to the first whitespace as the token, and
 * everything after the first whitespace (trimmed of the single separating
 * space) as the args. A bare `//` yields an empty token.
 */
export function parseSlashLine(rawLine: string): { token: string; args: string } {
  const body = rawLine.startsWith('//') ? rawLine.slice(2) : rawLine;
  const spaceIdx = body.search(/\s/);
  if (spaceIdx < 0) return { token: body, args: '' };
  return { token: body.slice(0, spaceIdx), args: body.slice(spaceIdx + 1) };
}

/**
 * End-to-end dispatch for a raw `//` line: parse → resolve → run, mapping the
 * ambiguous / unknown outcomes to feedback the renderer can toast. The host
 * supplies a {@link SlashContext} factory (bound to launchCWD/origArgs/trigger
 * once) that fills in the live `sessionId`; `dispatchSlashLine` completes it
 * with the parsed `args`.
 */
export async function dispatchSlashLine(
  rawLine: string,
  ctxBase: Omit<SlashContext, 'args'>,
): Promise<SlashResult> {
  const { token, args } = parseSlashLine(rawLine);
  const res = resolve(token);
  if (res.kind === 'none') {
    return { ok: false, message: `unknown fnc command: //${token}` };
  }
  if (res.kind === 'ambiguous') {
    return {
      ok: false,
      message: `ambiguous: //${token} → ${res.candidates.map((c) => `//${c}`).join(', ')}`,
    };
  }
  return res.command.handler({ ...ctxBase, args });
}
