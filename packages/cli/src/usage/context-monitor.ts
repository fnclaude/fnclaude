/**
 * Tiered context-size monitor (#170 part 2).
 *
 * Watches the live session's context size as it grows turn-over-turn and,
 * each time it crosses a new rung of an escalation LADDER, injects EXACTLY
 * ONE plain-text notice line into the running claude TUI suggesting a
 * compaction. The model can then call `fnc_request_compact` (#170 part 1)
 * at a clean stopping point.
 *
 * ── The ladder ────────────────────────────────────────────────────────
 * A {@link NoticeLadder} is a sorted list of finite {@link NoticeTier}s
 * (each `{ at, level }`) plus an optional repeating tier
 * (`{ every, level }`). Levels are a closed enum (consider → plan → now →
 * urgent), each mapping to a fixed notice body. The built-in default
 * ({@link DEFAULT_NOTICE_LADDER}) is 150k consider / 200k plan / 250k now,
 * then every 50k past the last tier (300k, 350k, …) → urgent.
 *
 * ── What it reads ────────────────────────────────────────────────────
 * The token source is the shared session-usage reader
 * (`computeSessionUsage`): the latest assistant turn's `context.tokens`.
 * The monitor does NOT re-parse the JSONL — it consumes that module's API
 * through an injected `readContextTokens` seam. The monitor polls on a
 * fixed interval and reacts to growth.
 *
 * ── What it writes ───────────────────────────────────────────────────
 * The notice is a PLAIN TEXT line, NOT a slash command, so it routes
 * through the raw PTY-write seam (the same `PtyWriter` the slash-injection
 * keystone wraps over `Bun.Terminal.write`) — submitted via
 * {@link injectSubmittedLine} (bracketed-paste body + a separate CR). The
 * body is `<fnc-notice>[level] context at Nk tokens — …</fnc-notice>`,
 * where N is the current size rounded to the nearest thousand. There is NO
 * output capture — fire-and-forget.
 *
 * ── Watermark (generalizes the old single-threshold latch) ───────────
 * The monitor tracks a WATERMARK = the highest ladder point already
 * noticed. On each tick with tokens T:
 *   - Find the highest ladder point ≤ T (finite tiers plus repeat points
 *     `lastTier.at + n*every`, or `n*every` when there are no finite
 *     tiers).
 *   - If that point > watermark: fire ONE notice for that point's level
 *     and raise the watermark to it. (A jump from 100k to 260k fires one
 *     `now`, not consider+plan+now.)
 *   - If the highest point ≤ T is BELOW the watermark (context dropped,
 *     i.e. a compaction): lower the watermark to it (or none if T is below
 *     all points). This re-arms the tiers above the new reading.
 * A `null` reading is a no-op and must NOT move the watermark. The first
 * tick of a fat resumed session (watermark = none) fires the single
 * highest applicable level immediately.
 *
 * ── Config + precedence ──────────────────────────────────────────────
 * {@link resolveContextNoticeLadder} resolves the effective ladder. Order:
 *   1. `FNC_CONTEXT_NOTICE_THRESHOLD` env var (legacy top-precedence
 *      override) → single-tier `now` ladder, no repeat.
 *   2. The new `[[context.notice_tiers]]` / `[context.notice_repeat]`
 *      config (a {@link NoticeLadder}).
 *   3. Legacy `[context] notice_threshold` config → single-tier `now`
 *      ladder, no repeat.
 *   4. The built-in {@link DEFAULT_NOTICE_LADDER}.
 *
 * ── Testability ──────────────────────────────────────────────────────
 * Both seams (`readContextTokens`, `write`) are injected, so the monitor
 * is unit-testable without a real `~/.claude` or a live terminal.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { injectSubmittedLine, type PtyWriter } from '../mcp/handlers/inject-slash.ts';
import { encodeCWDForProjects } from '../launch/live-permission-reader.ts';
import { computeSessionUsage } from './session-usage.ts';

import { readFileSync } from 'node:fs';

/** The closed enum of escalation levels, low → high. */
export type NoticeLevel = 'consider' | 'plan' | 'now' | 'urgent';

const NOTICE_LEVELS: readonly NoticeLevel[] = ['consider', 'plan', 'now', 'urgent'];

/** True iff `v` is one of the four {@link NoticeLevel} strings. */
export function isNoticeLevel(v: unknown): v is NoticeLevel {
  return typeof v === 'string' && (NOTICE_LEVELS as readonly string[]).includes(v);
}

/** A single finite rung of the ladder: fire `level` once context crosses `at`. */
export interface NoticeTier {
  /** Token count at which this tier's notice fires. Positive finite. */
  at: number;
  /** Level whose body to inject when this tier is crossed. */
  level: NoticeLevel;
}

/**
 * A repeating tier past the last finite tier: fire `level` at every
 * `every`-token multiple beyond the highest finite tier (or, with no
 * finite tiers, at every `n*every`).
 */
export interface NoticeRepeat {
  /** Token spacing between repeat points. Positive finite. */
  every: number;
  /** Level whose body to inject at each repeat point. */
  level: NoticeLevel;
}

/**
 * The escalation ladder: finite tiers (assumed sorted ascending by `at`,
 * deduplicated) plus an optional repeating tier. An empty `tiers` array
 * with no `repeat` is a disabled monitor.
 */
export interface NoticeLadder {
  tiers: NoticeTier[];
  repeat?: NoticeRepeat;
}

/** Built-in default ladder used when nothing is configured. */
export const DEFAULT_NOTICE_LADDER: NoticeLadder = {
  tiers: [
    { at: 150_000, level: 'consider' },
    { at: 200_000, level: 'plan' },
    { at: 250_000, level: 'now' },
  ],
  repeat: { every: 50_000, level: 'urgent' },
};

/** Env var that overrides both config and the built-in default (legacy). */
export const CONTEXT_NOTICE_THRESHOLD_ENV = 'FNC_CONTEXT_NOTICE_THRESHOLD';

/** Per-level notice bodies. `k` is tokens rounded to the nearest thousand. */
const NOTICE_BODY: Record<NoticeLevel, (k: number) => string> = {
  consider: (k) =>
    `[consider] context at ${k}k tokens — no rush yet; note where a clean compact point would be, finish queued prompts there, then call request_compact.`,
  plan: (k) =>
    `[plan] context at ${k}k tokens — plan your compact point now; work toward it, finish any queued prompts, then call request_compact.`,
  now: (k) =>
    `[now] context at ${k}k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.`,
  urgent: (k) =>
    `[urgent] context at ${k}k tokens — compaction is overdue; do not start new work, finish queued prompts only, and call request_compact immediately.`,
};

/**
 * Format the notice payload BODY for a given level + context-token count.
 * N is rounded to the nearest thousand and rendered as `Nk`. There is NO
 * trailing terminator — the line is submitted via {@link injectSubmittedLine}
 * (bracketed-paste body + a SEPARATE CR), which is what actually dispatches
 * it in claude's bracketed-paste-enabled TUI.
 */
export function formatContextNotice(level: NoticeLevel, tokens: number): string {
  const k = Math.round(tokens / 1000);
  return `<fnc-notice>${NOTICE_BODY[level](k)}</fnc-notice>`;
}

/**
 * Resolve the effective ladder. Precedence (highest first):
 *   1. `FNC_CONTEXT_NOTICE_THRESHOLD` env var (legacy top-precedence
 *      override), as a positive finite number → single-tier `now` ladder.
 *   2. The new tier config (`configLadder`), when present.
 *   3. Legacy `[context] notice_threshold` config (`configThreshold`), as a
 *      positive finite number → single-tier `now` ladder.
 *   4. The built-in {@link DEFAULT_NOTICE_LADDER}.
 */
export function resolveContextNoticeLadder(args: {
  configLadder: NoticeLadder | undefined;
  configThreshold: number | undefined;
  env?: Record<string, string | undefined>;
}): NoticeLadder {
  const env = args.env ?? process.env;
  const raw = env[CONTEXT_NOTICE_THRESHOLD_ENV];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return { tiers: [{ at: n, level: 'now' }] };
  }
  if (args.configLadder !== undefined) return args.configLadder;
  const cfg = args.configThreshold;
  if (cfg !== undefined && Number.isFinite(cfg) && cfg > 0) {
    return { tiers: [{ at: cfg, level: 'now' }] };
  }
  return DEFAULT_NOTICE_LADDER;
}

/**
 * The highest ladder point ≤ `tokens`, or `null` if `tokens` is below
 * every point. A "point" is a finite tier's `at` OR a repeat point. Repeat
 * points are `base + n*every` (n ≥ 1) where `base` is the highest finite
 * tier's `at`, or `0` when there are no finite tiers (giving `n*every`).
 */
function highestCrossedPoint(
  ladder: NoticeLadder,
  tokens: number,
): { at: number; level: NoticeLevel } | null {
  let best: { at: number; level: NoticeLevel } | null = null;

  for (const tier of ladder.tiers) {
    if (tier.at <= tokens && (best === null || tier.at > best.at)) {
      best = { at: tier.at, level: tier.level };
    }
  }

  const repeat = ladder.repeat;
  if (repeat !== undefined && repeat.every > 0 && Number.isFinite(repeat.every)) {
    const lastTier = ladder.tiers.length > 0 ? Math.max(...ladder.tiers.map((t) => t.at)) : 0;
    if (tokens >= lastTier + repeat.every) {
      const n = Math.floor((tokens - lastTier) / repeat.every);
      const point = lastTier + n * repeat.every;
      if (best === null || point > best.at) best = { at: point, level: repeat.level };
    }
  }

  return best;
}

export interface ContextMonitor {
  /**
   * Evaluate one observed context-token count. Returns `true` iff this
   * tick fired a notice (crossed a new ladder rung above the watermark).
   * A jump past several rungs fires ONE notice for the highest crossed
   * level. A drop lowers the watermark (re-arm) without firing. A `null`
   * reading is a no-op and never moves the watermark.
   */
  tick: (tokens: number | null) => boolean;
  /** True once at least one notice has been fired (watermark above 0). */
  hasFired: () => boolean;
}

export interface CreateContextMonitorArgs {
  /** The escalation ladder. */
  ladder: NoticeLadder;
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
 * Build a context monitor with its ladder + PTY writer bound. Pure state
 * machine over `tick`; no IO, no timers — those live in
 * {@link startContextMonitor}. The notice is SUBMITTED via
 * {@link injectSubmittedLine} (bracketed-paste body + separate CR) so it is
 * actually dispatched in claude's bracketed-paste TUI rather than dropped
 * into the input box.
 */
export function createContextMonitor(args: CreateContextMonitorArgs): ContextMonitor {
  const { ladder, write, schedule, enterDelayMs } = args;
  // Watermark = the highest ladder point already noticed. 0 = none.
  let watermark = 0;

  return {
    tick: (tokens: number | null): boolean => {
      // A null reading (no assistant turn yet / unreadable JSONL) is a
      // no-op — it must NOT move the watermark.
      if (tokens === null) return false;

      const point = highestCrossedPoint(ladder, tokens);
      const currentPoint = point?.at ?? 0;

      if (currentPoint > watermark) {
        // Crossed a new rung — fire ONE notice for that point's level.
        watermark = currentPoint;
        // point is non-null here (currentPoint > 0).
        injectSubmittedLine(formatContextNotice(point!.level, tokens), {
          write,
          schedule,
          enterDelayMs,
        });
        return true;
      }

      if (currentPoint < watermark) {
        // Context dropped (a compaction): lower the watermark to re-arm the
        // tiers above the new reading. No notice fires on a drop.
        watermark = currentPoint;
      }

      return false;
    },
    hasFired: () => watermark > 0,
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
 * mints it at runtime — so the context reader locates the session file
 * this way.
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

/** Default delay (ms) before a compact follow_up submits. See {@link createCompactFollowUpGate}. */
export const COMPACT_FOLLOWUP_DELAY_MS = 10_000;

/** Seams for {@link createCompactFollowUpGate} — injectable for fake-clock unit tests. */
export interface CreateCompactFollowUpGateArgs {
  /** Delay before the follow-up submits. Defaults to {@link COMPACT_FOLLOWUP_DELAY_MS}. */
  delayMs?: number;
  /** Sleep seam. Defaults to a real `setTimeout`-backed promise. Tests inject a fake. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the DEFAULT gate for {@link createRequestCompactHandler}'s follow_up:
 * a `() => Promise<void>` that resolves after a FIXED DELAY.
 *
 * ── Why a fixed timer, not JSONL-growth detection ────────────────────────
 * The previous gate captured the session JSONL's byte-size the instant
 * `/compact` was injected, then polled for the file to grow past that
 * baseline — treating growth as "claude accepted the /compact prompt." But
 * the very next JSONL write IS the `/compact` command being recorded itself,
 * so the gate tripped within a few hundred ms and the follow_up fired BEFORE
 * compaction was actually underway. The growth signal measured the
 * /compact-echo, not the start of compaction — a false positive that landed
 * the follow_up "occasionally too soon."
 *
 * Compaction reliably takes a while. Landing the follow_up LATE is harmless
 * (the TUI queues it); landing it EARLY is the bug. So instead of trying to
 * detect an unobservable "accepted" edge, we just wait a fixed window long
 * enough that compaction is comfortably in progress. No disk reads, no poll
 * loop, no false positives.
 *
 * The delay is unit-tested with a fake `sleep` (see context-monitor.test.ts)
 * — no real timers, no `~/.claude` touched.
 */
export function createCompactFollowUpGate(
  args: CreateCompactFollowUpGateArgs = {},
): () => Promise<void> {
  const delayMs = args.delayMs ?? COMPACT_FOLLOWUP_DELAY_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (): Promise<void> => {
    await sleep(delayMs);
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
  /** Effective ladder (post {@link resolveContextNoticeLadder}). */
  ladder: NoticeLadder;
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
 * reader, and fires a notice through `write` on each new rung crossing.
 * Polling does NOT stop on fire — the watermark re-arms after a compaction
 * drops context, so the monitor keeps receiving ticks and can fire again
 * on the next crossing. Only an explicit `stop()` clears the interval.
 */
export function startContextMonitor(args: StartContextMonitorArgs): RunningContextMonitor {
  const intervalMs = args.intervalMs ?? 4000;
  const read = args.readContextTokens ?? readActiveContextTokens;
  const setIntervalImpl = args.setIntervalFn ?? setInterval;

  const monitor = createContextMonitor({
    ladder: args.ladder,
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
    monitor.tick(tokens); // watermark re-arm: keep polling so it can fire again
  }, intervalMs);
  // Don't let the poll timer keep the event loop alive on its own; the
  // live claude subprocess owns process lifetime.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }

  return { stop, monitor };
}
