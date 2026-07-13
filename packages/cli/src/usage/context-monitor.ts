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
 * A {@link NoticeLadder} is a list of finite {@link NoticeTier}s (each
 * `{ at, level }`, absolute token counts) plus an optional repeating tier
 * (`{ every, level }`). Levels are a closed enum (consider → plan → now →
 * urgent), each mapping to a fixed notice body. Config supplies a
 * {@link NoticeLadderSpec} whose thresholds may be absolute OR percentages of
 * the derived auto-compact point (`"94%"`, #332); {@link resolveLadderSpec}
 * collapses a spec to a numeric ladder per tick. The built-in default
 * ({@link DEFAULT_NOTICE_LADDER}) is the percentage ladder 76/82/88/94% +
 * a 2.5% repeat, which self-adjusts to each model's/surface's auto-compact
 * point (≈ 710k/766k/822k/878k on a default 1M `cli` session).
 *
 * ── What it reads ────────────────────────────────────────────────────
 * The token source is the shared session-usage reader
 * (`computeSessionUsage`): the latest assistant turn's `context.tokens`.
 * The monitor does NOT re-parse the JSONL — it consumes that module's API
 * through an injected `readContextTokens` seam. The monitor polls on a
 * fixed interval and reacts to growth.
 *
 * ── What it writes ───────────────────────────────────────────────────
 * The notice is a PLAIN TEXT line, NOT a slash command. It routes through
 * the tagged control-injection seam (#299) as `sendControl('notice', body)`,
 * so it carries the structural `notice` marker the renderer filter (#288)
 * keys off and — in PTY mode — defers around any line the user is mid-typing
 * instead of splicing into it. The body is
 * `<fnc-notice>[level] context at Nk tokens — …</fnc-notice>`, where N is the
 * current size rounded to the nearest thousand. There is NO output capture —
 * fire-and-forget.
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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { PtyWriter } from '../mcp/handlers/inject-slash';
import { type SendControl, createPtyControlSeam } from '../mcp/handlers/send-control';
import { encodeCWDForProjects } from '../launch/live-permission-reader';
import { deriveAutoCompactThreshold, resolvePctToTokens } from './autocompact-threshold';
import { computeSessionUsage } from './session-usage';

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

// ── Ladder SPEC (config-level, percentage-aware) ─────────────────────────────
// A tier/repeat threshold is EITHER an absolute token count (a bare integer in
// config, back-compat) OR a percentage of the derived auto-compact threshold
// (`"94%"`, #332). The SPEC carries that choice; {@link resolveLadderSpec}
// collapses it into a concrete numeric {@link NoticeLadder} for the state
// machine, recomputed whenever the active model/surface/env (hence the derived
// threshold) changes. A numeric {@link NoticeLadder} is itself a valid spec
// (its `at`/`every` are the `number` arm), so absolute-only ladders flow
// through both representations unchanged.

/** A percentage threshold: `pct`% of the derived auto-compact point (100% = wall). */
export interface PctThreshold {
  pct: number;
}

/** True iff `v` is a {@link PctThreshold} marker. */
export function isPctThreshold(v: unknown): v is PctThreshold {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { pct?: unknown }).pct === 'number' &&
    Number.isFinite((v as { pct: number }).pct)
  );
}

/** A finite tier whose threshold may be absolute tokens or a percentage. */
export interface NoticeTierSpec {
  at: number | PctThreshold;
  level: NoticeLevel;
}

/** A repeating tier whose spacing may be absolute tokens or a percentage. */
export interface NoticeRepeatSpec {
  every: number | PctThreshold;
  level: NoticeLevel;
}

/** The config-level ladder: tiers + optional repeat, each possibly a percentage. */
export interface NoticeLadderSpec {
  tiers: NoticeTierSpec[];
  repeat?: NoticeRepeatSpec;
}

/**
 * Built-in default ladder used when nothing is configured. Expressed as
 * PERCENTAGES of the derived auto-compact threshold (#332): the same config
 * self-adjusts to the correct absolute token counts across models and
 * surfaces. On a default 1M `cli` session (100% = 934,000) these resolve to
 * ≈ 710k/766k/822k/878k with a ≈ 23k repeat; on a 500k `local-agent` surface
 * (100% = 467,000) they resolve to roughly half that — no re-tuning.
 */
export const DEFAULT_NOTICE_LADDER: NoticeLadderSpec = {
  tiers: [
    { at: { pct: 76 }, level: 'consider' },
    { at: { pct: 82 }, level: 'plan' },
    { at: { pct: 88 }, level: 'now' },
    { at: { pct: 94 }, level: 'urgent' },
  ],
  repeat: { every: { pct: 2.5 }, level: 'urgent' },
};

/**
 * Collapse a {@link NoticeLadderSpec} into a concrete numeric
 * {@link NoticeLadder} against a derived auto-compact `threshold` (100%).
 * Absolute thresholds pass through unchanged. Percentage thresholds resolve
 * to `round(pct/100 * threshold)` — NOT clamped above 100%. When `threshold`
 * is `null` (the active model, hence the window, isn't known yet) percentage
 * entries are DROPPED (the monitor stays silent about them until the first
 * assistant turn names the model); absolute entries still resolve.
 */
export function resolveLadderSpec(spec: NoticeLadderSpec, threshold: number | null): NoticeLadder {
  const tiers: NoticeTier[] = [];
  for (const t of spec.tiers) {
    const at = resolveThresholdValue(t.at, threshold);
    if (at === null) continue;
    tiers.push({ at, level: t.level });
  }

  let repeat: NoticeRepeat | undefined;
  if (spec.repeat !== undefined) {
    const every = resolveThresholdValue(spec.repeat.every, threshold);
    if (every !== null) repeat = { every, level: spec.repeat.level };
  }

  return repeat === undefined ? { tiers } : { tiers, repeat };
}

/** Resolve one absolute-or-percent value; `null` when a percent can't resolve yet. */
function resolveThresholdValue(v: number | PctThreshold, threshold: number | null): number | null {
  if (typeof v === 'number') return v;
  if (threshold === null) return null;
  return resolvePctToTokens(v.pct, threshold);
}

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
 * trailing terminator — the body is emitted through `sendControl('notice', …)`,
 * which (in PTY mode) submits it as a bracketed-paste body + a SEPARATE CR,
 * the form that actually dispatches in claude's bracketed-paste-enabled TUI.
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
  configLadder: NoticeLadderSpec | undefined;
  configThreshold: number | undefined;
  env?: Record<string, string | undefined>;
}): NoticeLadderSpec {
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
   *
   * `ladderOverride`, when supplied, is used for THIS tick instead of the
   * ladder bound at construction — the seam {@link startContextMonitor} uses
   * to feed a freshly-resolved numeric ladder each tick (percentage tiers are
   * re-resolved against the current derived auto-compact threshold, #332). The
   * watermark persists across ticks regardless of which ladder was used.
   */
  tick: (tokens: number | null, ladderOverride?: NoticeLadder) => boolean;
  /** True once at least one notice has been fired (watermark above 0). */
  hasFired: () => boolean;
}

export interface CreateContextMonitorArgs {
  /** The escalation ladder. */
  ladder: NoticeLadder;
  /**
   * The tagged control-injection seam the notice routes through (#299). When
   * supplied, notices fire as `sendControl('notice', body)` so they carry the
   * structural marker and, in PTY mode, never splice into in-flight user input.
   * When omitted, the monitor builds a bare {@link createPtyControlSeam} from
   * `write` — preserving the pre-#299 direct-to-PTY behavior (used by unit
   * tests that assert the raw bytes).
   */
  sendControl?: SendControl;
  /** Raw PTY-write sink — only used to build the fallback seam when `sendControl` is absent. */
  write?: PtyWriter;
  /**
   * Timer seam threaded into the fallback seam's separate CR write. Defaults
   * (inside the primitive) to {@link setTimeout}. Tests pass a synchronous
   * `(fn) => fn()` so the two writes land deterministically. Ignored when
   * `sendControl` is supplied.
   */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the fallback seam's CR write. Ignored when `sendControl` is supplied. */
  enterDelayMs?: number;
}

/**
 * Build a context monitor with its ladder + control seam bound. Pure state
 * machine over `tick`; no IO, no timers — those live in
 * {@link startContextMonitor}. The notice is emitted through the tagged
 * {@link SendControl} seam (#299) so it carries the structural `notice` marker
 * and, in PTY mode, defers around in-flight user input rather than splicing
 * into a partially-typed line.
 */
export function createContextMonitor(args: CreateContextMonitorArgs): ContextMonitor {
  const { ladder } = args;
  const send: SendControl =
    args.sendControl ??
    createPtyControlSeam({
      write: args.write ?? (() => {}),
      schedule: args.schedule,
      enterDelayMs: args.enterDelayMs,
    }).sendControl;
  // Watermark = the highest ladder point already noticed. 0 = none.
  let watermark = 0;

  return {
    tick: (tokens: number | null, ladderOverride?: NoticeLadder): boolean => {
      // A null reading (no assistant turn yet / unreadable JSONL) is a no-op —
      // it must NOT move the watermark. A non-positive reading is treated the
      // same: a transient `0` (a synthetic / interrupted assistant record whose
      // usage is all zeros — issue #283) must never re-arm the watermark the
      // way a real /compact drop would, or the next real turn re-crosses the
      // same rung and fires a duplicate notice.
      if (tokens === null || tokens <= 0) {
        return false;
      }

      const activeLadder = ladderOverride ?? ladder;
      const point = highestCrossedPoint(activeLadder, tokens);
      const currentPoint = point?.at ?? 0;

      if (currentPoint > watermark) {
        // Crossed a new rung — fire ONE notice for that point's level.
        watermark = currentPoint;
        // point is non-null here (currentPoint > 0).
        send('notice', formatContextNotice(point!.level, tokens));
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

/** A `*.jsonl` regular file under the project dir + its mtime, for pinning. */
interface SessionCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * List `*.jsonl` regular files (with mtimes) under
 * `~/.claude/projects/<encoded-cwd>/`. Returns `[]` on any miss (no project
 * dir, unreadable dir). Unreadable individual entries are skipped.
 */
function listSessionJsonls(launchCWD: string): SessionCandidate[] {
  const dir = join(resolveHome(), '.claude', 'projects', encodeCWDForProjects(launchCWD));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: SessionCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      out.push({ path: p, mtimeMs: st.mtimeMs });
    } catch {
      // skip unreadable entry
    }
  }
  return out;
}

/**
 * One context reading: the latest assistant turn's context-token count AND
 * the model that produced it. The model is needed to derive the auto-compact
 * threshold percentage tiers resolve against (#332). Either field is `null`
 * when unavailable (no assistant turn yet, unreadable/foreign file).
 */
export interface ContextReading {
  tokens: number | null;
  model: string | null;
}

/** The "nothing to read" reading — a no-op for the monitor's tick. */
const NO_READING: ContextReading = { tokens: null, model: null };

/**
 * Build a context reader pinned to THIS monitor's own session JSONL.
 *
 * ── Why pinning, not newest-mtime ────────────────────────────────────────
 * The parent doesn't statically know the live session UUID (claude mints it
 * at runtime) and the session JSONL is created lazily — AFTER fnclaude spawns
 * claude. The previous reader re-picked the most-recently-modified `*.jsonl`
 * under the cwd's project dir on EVERY tick. That mtime race misreads
 * whenever more than one session file exists for the cwd:
 *   - A brand-new session whose own file doesn't exist yet reads a previous
 *     fat file and fires a notice immediately.
 *   - Two concurrent sessions in the same cwd flap between each other's
 *     files; reading the sibling's lower count re-arms the watermark, so the
 *     next tick's fatter file re-fires the same rung — unbounded machine-gun
 *     notices citing the OTHER session's token curve.
 *
 * ── The pin ──────────────────────────────────────────────────────────────
 * Because claude creates our jsonl after we spawn it (and a resume forks a
 * NEW file rather than reusing one), every jsonl already present at
 * monitor-start time is foreign by definition. We snapshot that set lazily on
 * the FIRST call as the BASELINE. (Lazy vs eager doesn't matter — both happen
 * within ms of claude spawn, before claude can write its file.) While
 * unpinned, each call re-lists the dir and considers only files NOT in the
 * baseline; if there are none we return `null` (the monitor stays silent —
 * this is what fixes the brand-new-session false fire). Once a candidate
 * appears we PIN to the one with the OLDEST mtime (ours was born first; a
 * sibling launched later in the same cwd is younger) and only ever read that
 * path thereafter. The pin is sticky for the monitor's lifetime.
 *
 * If the pinned file disappears (read throws ENOENT) we unpin and return
 * `null`; the next call rescans. The baseline is NOT mutated on unpin, so a
 * file that was foreign at start stays excluded forever.
 *
 * ── Residual race ────────────────────────────────────────────────────────
 * If two sessions start near-simultaneously in one cwd — both born after each
 * other's baseline snapshot — a monitor can pin the wrong (younger sibling's)
 * file. But because the pin is STICKY, the worst case is bounded: at most one
 * notice per rung, citing a STABLE file — not today's unbounded flapping
 * between two files.
 */
export function createPinnedContextReader(
  resolveOwnSessionFile?: () => string | null,
): (launchCWD: string) => ContextReading {
  let baseline: Set<string> | null = null; // basenames present at first call
  let pinnedPath: string | null = null;

  function readReading(path: string): ContextReading {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return NO_READING; // ENOENT / unreadable — caller decides whether to unpin
    }
    const ctx = computeSessionUsage(raw).context;
    return { tokens: ctx?.tokens ?? null, model: ctx?.model ?? null };
  }

  return (launchCWD: string): ContextReading => {
    if (pinnedPath !== null) {
      let raw: string;
      try {
        raw = readFileSync(pinnedPath, 'utf8');
      } catch {
        // Pinned file vanished — unpin and let the next tick re-resolve.
        pinnedPath = null;
        return NO_READING;
      }
      const ctx = computeSessionUsage(raw).context;
      return { tokens: ctx?.tokens ?? null, model: ctx?.model ?? null };
    }

    // ── Identity path (no guessing) ──────────────────────────────────────
    // When the caller can name THIS session's own JSONL (claude spawned with a
    // known `--session-id`, or the file discovered via a pre-spawn snapshot
    // diff), pin to that exact file and never look at any sibling. This is
    // what closes the cross-session race: a second session in the same cwd no
    // longer mis-pins the first session's (fatter) file and cites its token
    // curve. Until the own file is known/exists, stay silent (null) — better
    // no notice than a notice about another session's context.
    if (resolveOwnSessionFile !== undefined) {
      const own = resolveOwnSessionFile();
      if (own === null || own === '') return NO_READING;
      const dir = join(resolveHome(), '.claude', 'projects', encodeCWDForProjects(launchCWD));
      const path = join(dir, own);
      pinnedPath = path;
      return readReading(path);
    }

    // ── Legacy heuristic path (no identity available) ────────────────────
    // Used when the caller can't name its own session file. Pins the oldest
    // post-baseline candidate, which is racy when two sessions start near-
    // simultaneously in one cwd (see the class doc's "Residual race").
    // Production reaches this path for the session shapes whose id isn't
    // knowable up front — `--continue`, `--fork-session`, and a bare
    // `--resume` picker — where `planOwnSession` returns no id. Fresh /
    // `--resume <uuid>` / user-supplied `--session-id` sessions supply a
    // resolver above and never get here. Closing the `--continue` residual
    // race (e.g. via pre-spawn snapshot-diff discovery) is a follow-up.
    const candidates = listSessionJsonls(launchCWD);

    if (baseline === null) {
      // First call: everything already on disk is foreign.
      baseline = new Set(candidates.map((c) => basename(c.path)));
    }

    const fresh = candidates.filter((c) => !baseline!.has(basename(c.path)));
    if (fresh.length === 0) return NO_READING;

    // Pin to the oldest-mtime fresh candidate — ours was born first.
    let oldest = fresh[0]!;
    for (const c of fresh) {
      if (c.mtimeMs < oldest.mtimeMs) oldest = c;
    }
    pinnedPath = oldest.path;
    return readReading(pinnedPath);
  };
}

/** Default delay (ms) before a compact follow_up submits. See {@link createCompactFollowUpGate}. */
export const COMPACT_FOLLOWUP_DELAY_MS = 60_000;

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
 * detect an unobservable "accepted" edge, we just wait a fixed 60s window —
 * comfortably long enough that compaction is in progress. No disk reads, no
 * poll loop, no false positives.
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
  /**
   * Effective ladder SPEC (post {@link resolveContextNoticeLadder}). May carry
   * percentage tiers (#332); they're re-resolved to absolute token counts each
   * tick against the derived auto-compact threshold for the CURRENT model. A
   * numeric {@link NoticeLadder} is a valid spec (absolute-only) and flows
   * through unchanged.
   */
  ladder: NoticeLadderSpec;
  /**
   * The tagged control-injection seam notices route through (#299). Supplied in
   * production (PTY or renderer) so notices carry the structural marker and
   * defer around in-flight input. When omitted, the fallback `write` seam is
   * used (legacy direct-to-PTY behavior; unit tests assert raw bytes).
   */
  sendControl?: SendControl;
  /** Raw PTY-write sink — only used to build the fallback seam when `sendControl` is absent. */
  write?: PtyWriter;
  /** Poll interval in ms. Defaults to 4000. */
  intervalMs?: number;
  /**
   * Full context reader seam: returns the latest turn's token count AND model
   * (the model drives the derived auto-compact threshold for percentage tiers,
   * #332). Defaults to a fresh {@link createPinnedContextReader}. Takes
   * precedence over {@link readContextTokens} when both are supplied.
   */
  readContext?: (launchCWD: string) => ContextReading;
  /**
   * Legacy tokens-only reader seam (back-compat for tests that don't care about
   * the model). Wrapped as a {@link ContextReading} with `model: null`, so
   * percentage tiers can't resolve through it — use it only with absolute
   * ladders. Ignored when {@link readContext} is supplied.
   */
  readContextTokens?: (launchCWD: string) => number | null;
  /**
   * Derive the auto-compact threshold (100% for percentage tiers) from the
   * active model. Defaults to {@link deriveAutoCompactThreshold} over
   * `process.env`. Production supplies one bound to the claude child's env
   * (childEnv) so surface/window overrides are honored. Returns `null` when the
   * threshold can't be derived (percentage tiers then stay dormant that tick).
   */
  deriveThreshold?: (model: string) => number | null;
  /**
   * Resolver for THIS session's own JSONL basename (e.g. `<session-id>.jsonl`),
   * threaded into the default {@link createPinnedContextReader}. Returns the
   * basename once known, else `null` (monitor stays silent until then). Supply
   * this in production so the reader pins by identity instead of guessing
   * oldest-mtime — the fix for the cross-session mis-pin. Ignored when
   * `readContextTokens` is injected directly.
   */
  ownSessionFile?: () => string | null;
  /** Timer seam — defaults to global `setInterval`. */
  setIntervalFn?: typeof setInterval;
  /**
   * Schedule seam threaded into the fallback seam's separate CR write. Defaults
   * (inside the primitive) to {@link setTimeout}. Ignored when `sendControl` is
   * supplied.
   */
  schedule?: (fn: () => void, ms: number) => void;
  /** Gap before the fallback seam's CR write. Ignored when `sendControl` is supplied. */
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
  const spec = args.ladder;
  // Resolve the reader: full {tokens, model} seam wins; else adapt a legacy
  // tokens-only seam (model unknown → percentage tiers dormant); else the
  // default pinned on-disk reader.
  const read: (launchCWD: string) => ContextReading =
    args.readContext ??
    (args.readContextTokens !== undefined
      ? (cwd: string): ContextReading => ({ tokens: args.readContextTokens!(cwd), model: null })
      : createPinnedContextReader(args.ownSessionFile));
  const deriveThreshold =
    args.deriveThreshold ?? ((model: string): number | null => deriveAutoCompactThreshold({ model, env: process.env }));
  const setIntervalImpl = args.setIntervalFn ?? setInterval;

  const monitor = createContextMonitor({
    // Construction fallback ladder (absolute-only view of the spec); the tick
    // loop always feeds a freshly-resolved override, so this is just a safe
    // base for any tick that somehow arrives without one.
    ladder: resolveLadderSpec(spec, null),
    ...(args.sendControl !== undefined ? { sendControl: args.sendControl } : {}),
    ...(args.write !== undefined ? { write: args.write } : {}),
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
    const reading = read(args.launchCWD);
    // Recompute the derived threshold for the CURRENT model each tick, then
    // resolve the spec's percentage tiers against it (#332). Absolute tiers are
    // unaffected. Model unknown → percentage tiers stay dormant this tick.
    const threshold = reading.model !== null ? deriveThreshold(reading.model) : null;
    const resolved = resolveLadderSpec(spec, threshold);
    monitor.tick(reading.tokens, resolved); // watermark re-arm: keep polling so it can fire again
  }, intervalMs);
  // Don't let the poll timer keep the event loop alive on its own; the
  // live claude subprocess owns process lifetime.
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }

  return { stop, monitor };
}
