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
 * ── Re-arming latch ──────────────────────────────────────────────────
 * Once the notice fires, the monitor latches OFF so it does NOT re-issue
 * every turn as context keeps growing — that would be noise. But the
 * latch RE-ARMS once context drops back below the threshold (the model
 * called request_compact and compaction landed), so the next time context
 * crosses the threshold the notice fires again.
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

import { injectSubmittedLine, type PtyWriter } from '../mcp/handlers/inject-slash.ts';
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
 * Format the one-shot notice payload BODY for a given context-token count.
 * N is rounded to the nearest thousand and rendered as `Nk`. There is NO
 * trailing terminator — the line is submitted via {@link injectSubmittedLine}
 * (bracketed-paste body + a SEPARATE CR), which is what actually dispatches
 * it in claude's bracketed-paste-enabled TUI.
 */
export function formatContextNotice(tokens: number): string {
  const k = Math.round(tokens / 1000);
  return `<fnc-notice>context at ${k}k tokens — call request_compact at the next clean stopping point</fnc-notice>`;
}

export interface ContextMonitor {
  /**
   * Evaluate one observed context-token count. Returns `true` iff this
   * tick fired the notice (crossed the threshold). After a fire, the
   * monitor is latched and further at/above readings return `false`
   * (no re-fire on mere growth); a reading that DROPS below the threshold
   * (a compaction) re-arms the latch so the next crossing fires again. A
   * `null` reading (no assistant turn yet / unreadable JSONL) is a no-op
   * and never re-arms.
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
  /**
   * Timer seam threaded into {@link injectSubmittedLine} for the separate CR
   * write. Defaults (inside the primitive) to {@link setTimeout}. Tests pass
   * a synchronous `(fn) => fn()` so the two writes land deterministically.
   */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the CR write, threaded into {@link injectSubmittedLine}. */
  enterDelayMs?: number;
}

/**
 * Build a context monitor with its threshold + PTY writer bound. Pure
 * state machine over `tick`; no IO, no timers — those live in
 * {@link startContextMonitor}. The notice is SUBMITTED via
 * {@link injectSubmittedLine} (bracketed-paste body + separate CR) so it is
 * actually dispatched in claude's bracketed-paste TUI rather than dropped
 * into the input box.
 */
export function createContextMonitor(args: CreateContextMonitorArgs): ContextMonitor {
  const { threshold, write, schedule, enterDelayMs } = args;
  let fired = false;

  return {
    tick: (tokens: number | null): boolean => {
      // A null reading (no assistant turn yet / unreadable JSONL) is a
      // no-op — it must NOT re-arm a fired latch.
      if (tokens === null) return false;
      if (fired) {
        // Already fired: a drop below threshold (a compaction) re-arms the
        // latch so the next crossing fires again; staying at/above does not
        // re-fire.
        if (tokens < threshold) fired = false;
        return false;
      }
      if (tokens < threshold) return false;
      fired = true;
      injectSubmittedLine(formatContextNotice(tokens), { write, schedule, enterDelayMs });
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
  const newestPath = newestSessionJsonl(launchCWD);
  if (newestPath === null) return null;

  let raw: string;
  try {
    raw = readFileSync(newestPath, 'utf8');
  } catch {
    return null;
  }
  return computeSessionUsage(raw).context?.tokens ?? null;
}

/**
 * Discover the most-recently-modified `*.jsonl` under
 * `~/.claude/projects/<encoded-cwd>/`, or `null` on any miss (no project
 * dir, no jsonl). The live session UUID isn't statically known — claude
 * mints it at runtime — so both the context reader and the compact-accept
 * gate locate the session file this way.
 */
export function newestSessionJsonl(launchCWD: string): string | null {
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
  return newestPath;
}

/** Default size reader for {@link createCompactAcceptGate}: bytes of the newest session JSONL, or 0. */
function defaultReadJsonlSize(launchCWD: string): number {
  const path = newestSessionJsonl(launchCWD);
  if (path === null) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Seams for {@link createCompactAcceptGate} — all injectable for fake-clock unit tests. */
export interface CreateCompactAcceptGateArgs {
  /** Launch cwd — resolves the encoded `~/.claude/projects/<cwd>` dir. */
  launchCWD: string;
  /** Byte-size reader for the newest session JSONL. Defaults to a statSync-backed reader. */
  readJsonlSize?: (launchCWD: string) => number;
  /** Sleep seam. Defaults to a real `setTimeout`-backed promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Hard timeout (ms) — the gate ALWAYS resolves by this point. Defaults to 10000. */
  timeoutMs?: number;
  /** Poll interval (ms). Defaults to 200. */
  pollMs?: number;
}

/**
 * Build the DEFAULT accept gate for {@link createRequestCompactHandler}'s
 * follow_up: a `() => Promise<void>` that resolves once the live session
 * JSONL grows past a captured baseline (a proxy for "claude accepted the
 * /compact prompt and started writing the next records"), OR once a hard
 * timeout elapses — so it NEVER hangs.
 *
 * LIVE-VERIFY (the one item Tom checks live): whether JSONL byte-growth
 * actually marks "/compact accepted" vs "/compact COMPLETED". If growth only
 * appears after compaction finishes, the follow_up lands later than intended
 * (but still as its own gated turn — never back-to-back). The timeout
 * fallback bounds the worst case regardless.
 *
 * Growth-detection AND the timeout fallback are unit-tested with a fake clock
 * + fake reader (see context-monitor.test.ts) — no real `~/.claude` touched.
 */
export function createCompactAcceptGate(args: CreateCompactAcceptGateArgs): () => Promise<void> {
  const read = args.readJsonlSize ?? defaultReadJsonlSize;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = args.timeoutMs ?? 10_000;
  const pollMs = args.pollMs ?? 200;

  return async (): Promise<void> => {
    const baseline = read(args.launchCWD);
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(pollMs);
      if (read(args.launchCWD) > baseline) return; // accepted: session file grew
    }
    // Timeout fallback — never hang the follow_up.
  };
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
  /**
   * Schedule seam threaded into {@link injectSubmittedLine} for the notice's
   * separate CR write. Defaults (inside the primitive) to {@link setTimeout}.
   */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the notice's CR write, threaded into {@link injectSubmittedLine}. */
  enterDelayMs?: number;
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
 * reader, and fires the notice through `write` on each crossing. Polling
 * does NOT stop on fire — the latch re-arms after a compaction drops
 * context below the threshold, so the monitor keeps receiving ticks and
 * can fire again on the next crossing. Only an explicit `stop()` clears
 * the interval.
 */
export function startContextMonitor(args: StartContextMonitorArgs): RunningContextMonitor {
  const intervalMs = args.intervalMs ?? 4000;
  const read = args.readContextTokens ?? readActiveContextTokens;
  const setIntervalImpl = args.setIntervalFn ?? setInterval;

  const monitor = createContextMonitor({
    threshold: args.threshold,
    write: args.write,
    schedule: args.schedule,
    enterDelayMs: args.enterDelayMs,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setIntervalImpl(() => {
    const tokens = read(args.launchCWD);
    monitor.tick(tokens); // re-arming latch: keep polling so it can fire again
  }, intervalMs);
  // Don't let the poll timer keep the event loop alive on its own; the
  // live claude subprocess owns process lifetime.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }

  return { stop, monitor };
}
