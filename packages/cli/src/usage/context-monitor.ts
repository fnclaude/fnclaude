/**
 * Context-size monitor (#170 part 2).
 *
 * Watches the live session's context size as it grows turn-over-turn and,
 * the FIRST time it crosses a configurable threshold, injects EXACTLY ONE
 * plain-text notice line into the running claude TUI suggesting a
 * compaction. The model can then call `fnc_request_compact` (#170 part 1,
 * shipping separately) at a clean stopping point.
 *
 * ── What it reads ────────────────────────────────────────────────────
 * The token source is the shared session-usage reader
 * (`readSessionUsage` / `computeSessionUsage`): the latest assistant
 * turn's `context.tokens`. The monitor does NOT re-parse the JSONL — it
 * consumes that module's API through an injected `readContextTokens` seam.
 * A "turn boundary" in pty mode is observed as the JSONL gaining a new
 * assistant record, which moves `context.tokens`; the monitor polls on a
 * fixed interval and reacts to growth.
 *
 * ── What it writes ───────────────────────────────────────────────────
 * The notice is a PLAIN TEXT line, NOT a slash command, so it routes
 * through the raw PTY-write seam (the same `PtyWriter` the slash-injection
 * keystone wraps over `Bun.Terminal.write`) — NOT through
 * `formatSlashCommand`. The payload is:
 *
 *   <fnc-notice>context at Nk tokens — call request_compact at the next clean stopping point</fnc-notice>\r
 *
 * where N is the current context size rounded to the nearest thousand.
 * The trailing `\r` submits it as a typed line, exactly like the slash
 * keystone. There is NO output capture — fire-and-forget, identical to
 * the keystone's contract.
 *
 * ── Single-notice latch ──────────────────────────────────────────────
 * Once the notice fires, the monitor latches OFF for the rest of the
 * session: no second notice is ever issued, even as context keeps
 * growing. The latch is the whole point — a re-issued notice every turn
 * would be noise.
 *
 * ── Testability ──────────────────────────────────────────────────────
 * Both seams (`readContextTokens`, `write`) are injected, so the monitor
 * is unit-testable without a real `~/.claude` or a live terminal: drive
 * it with `tick()` over a scripted sequence of token counts and assert
 * the writes. The on-disk polling wrapper (`startContextMonitor`) binds
 * the real reader + interval timer and is wired into main.ts §9.0.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PtyWriter } from '../mcp/handlers/inject-slash.ts';
import { encodeCWDForProjects } from '../launch/live-permission-reader.ts';
import { computeSessionUsage } from './session-usage.ts';

import { readFileSync } from 'node:fs';

/** Built-in default threshold (tokens) when nothing else is configured. */
export const DEFAULT_CONTEXT_NOTICE_THRESHOLD = 200_000;

/** Env var that overrides both config and the built-in default. */
export const CONTEXT_NOTICE_THRESHOLD_ENV = 'FNC_CONTEXT_NOTICE_THRESHOLD';

/**
 * Resolve the effective threshold. Precedence: env override (if a
 * positive finite number) → config value (if a positive finite number) →
 * built-in default. Mirrors the env-over-config pattern other launcher
 * settings use.
 */
export function resolveContextNoticeThreshold(args: {
  configThreshold: number | undefined;
  env?: Record<string, string | undefined>;
}): number {
  const env = args.env ?? process.env;
  const raw = env[CONTEXT_NOTICE_THRESHOLD_ENV];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const cfg = args.configThreshold;
  if (cfg !== undefined && Number.isFinite(cfg) && cfg > 0) return cfg;
  return DEFAULT_CONTEXT_NOTICE_THRESHOLD;
}

/**
 * Format the one-shot notice payload for a given context-token count.
 * N is rounded to the nearest thousand and rendered as `Nk`. The trailing
 * `\r` submits the line, matching the slash keystone's Enter semantics.
 */
export function formatContextNotice(tokens: number): string {
  const k = Math.round(tokens / 1000);
  return `<fnc-notice>context at ${k}k tokens — call request_compact at the next clean stopping point</fnc-notice>\r`;
}

export interface ContextMonitor {
  /**
   * Evaluate one observed context-token count. Returns `true` iff this
   * tick fired the notice (crossed the threshold for the first time).
   * After a fire, the monitor is latched and all further ticks return
   * `false` regardless of token count. A `null` reading (no assistant
   * turn yet / unreadable JSONL) is a no-op.
   */
  tick: (tokens: number | null) => boolean;
  /** True once the notice has been fired. */
  hasFired: () => boolean;
}

export interface CreateContextMonitorArgs {
  /** Threshold in tokens. Crossing `>= threshold` fires the notice. */
  threshold: number;
  /** Raw PTY-write sink — the same seam the slash keystone wraps. */
  write: PtyWriter;
}

/**
 * Build a context monitor with its threshold + PTY writer bound. Pure
 * state machine over `tick`; no IO, no timers — those live in
 * {@link startContextMonitor}.
 */
export function createContextMonitor(args: CreateContextMonitorArgs): ContextMonitor {
  const { threshold, write } = args;
  let fired = false;

  return {
    tick: (tokens: number | null): boolean => {
      if (fired) return false;
      if (tokens === null) return false;
      if (tokens < threshold) return false;
      fired = true;
      write(formatContextNotice(tokens));
      return true;
    },
    hasFired: () => fired,
  };
}

/**
 * On-disk default context reader. The parent doesn't statically know the
 * live session UUID (claude mints it at runtime), so this discovers the
 * active session JSONL itself: the most-recently-modified `*.jsonl` under
 * `~/.claude/projects/<encoded-cwd>/`, fed through `computeSessionUsage`.
 * Returns the latest context-token count, or `null` on any miss
 * (no project dir, no jsonl, no assistant turn, unreadable file).
 */
export function readActiveContextTokens(launchCWD: string): number | null {
  const dir = join(resolveHome(), '.claude', 'projects', encodeCWDForProjects(launchCWD));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let newestPath: string | null = null;
  let newestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      const m = st.mtimeMs;
      if (m > newestMtime) {
        newestMtime = m;
        newestPath = p;
      }
    } catch {
      // skip unreadable entry
    }
  }
  if (newestPath === null) return null;

  let raw: string;
  try {
    raw = readFileSync(newestPath, 'utf8');
  } catch {
    return null;
  }
  return computeSessionUsage(raw).context?.tokens ?? null;
}

function resolveHome(): string {
  const fromEnv = process.env.HOME;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return homedir();
  } catch {
    return '';
  }
}

export interface StartContextMonitorArgs {
  /** Launch cwd — resolves the encoded `~/.claude/projects/<cwd>` dir. */
  launchCWD: string;
  /** Effective threshold (post {@link resolveContextNoticeThreshold}). */
  threshold: number;
  /** Raw PTY-write sink (`Bun.Terminal.write` wrapper in production). */
  write: PtyWriter;
  /** Poll interval in ms. Defaults to 4000. */
  intervalMs?: number;
  /**
   * Context reader seam. Defaults to {@link readActiveContextTokens},
   * which discovers + reads the live session JSONL. Injectable so tests
   * can drive a scripted sequence without a real `~/.claude`. Returns the
   * latest context-token count, or `null`.
   */
  readContextTokens?: (launchCWD: string) => number | null;
  /** Timer seam — defaults to global `setInterval`. */
  setIntervalFn?: typeof setInterval;
}

export interface RunningContextMonitor {
  /** Stop polling. Idempotent. */
  stop: () => void;
  /** The underlying state machine (for diagnostics / tests). */
  monitor: ContextMonitor;
}

/**
 * Start the polling monitor against the live session JSONL. Polls every
 * `intervalMs`, reads the current context size via the session-usage
 * reader, and fires the one-shot notice through `write` on first crossing.
 * Once fired (or once `stop()` is called) the interval is cleared so the
 * monitor goes quiet for the rest of the session.
 */
export function startContextMonitor(args: StartContextMonitorArgs): RunningContextMonitor {
  const intervalMs = args.intervalMs ?? 4000;
  const read = args.readContextTokens ?? readActiveContextTokens;
  const setIntervalImpl = args.setIntervalFn ?? setInterval;

  const monitor = createContextMonitor({ threshold: args.threshold, write: args.write });

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setIntervalImpl(() => {
    const tokens = read(args.launchCWD);
    if (monitor.tick(tokens)) stop(); // latch off after firing
  }, intervalMs);
  // Don't let the poll timer keep the event loop alive on its own; the
  // live claude subprocess owns process lifetime.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }

  return { stop, monitor };
}
