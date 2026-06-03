/**
 * Unit tests for the tiered context-size monitor (#170 part 2).
 *
 * The monitor watches the live session's context size against an
 * escalation LADDER of tiers (consider → plan → now → urgent) plus an
 * optional repeating tier, and injects EXACTLY ONE plain-text notice line
 * into the PTY at the highest crossed tier via the bracketed-paste submit
 * seam (NOT the slash formatter). A watermark tracks the highest tier
 * already noticed so mere growth doesn't re-fire; a drop (a compaction)
 * lowers the watermark to re-arm. These tests drive scripted token
 * sequences through the injected seams and assert: nothing below the first
 * tier, one notice at the highest crossed tier (a jump fires the top level
 * only, never the intermediate ones), the per-level body texts, the
 * repeat-tier arithmetic past the last finite tier, the watermark re-arm
 * after a drop, the null no-op, the legacy env/config single-tier mapping,
 * and that nothing flows back through the writer.
 */

import { describe, expect, test } from 'bun:test';

import { formatSlashCommand, type PtyWriter } from '../../src/mcp/handlers/inject-slash.ts';
import {
  COMPACT_FOLLOWUP_DELAY_MS,
  CONTEXT_NOTICE_THRESHOLD_ENV,
  DEFAULT_NOTICE_LADDER,
  type NoticeLevel,
  createCompactFollowUpGate,
  createContextMonitor,
  formatContextNotice,
  resolveContextNoticeLadder,
  startContextMonitor,
} from '../../src/usage/context-monitor.ts';

function spyWriter(): { write: PtyWriter; calls: string[] } {
  const calls: string[] = [];
  return { write: (p) => calls.push(p), calls };
}

/** Synchronous schedule seam so the separate CR write lands deterministically. */
const syncSchedule = (fn: () => void): void => fn();

/** The two writes injectSubmittedLine produces for a notice body. */
function noticeWrites(body: string): string[] {
  return [`\x1b[200~${body}\x1b[201~`, '\r'];
}

/** The default ladder used in most tests: 150k/200k/250k + repeat 50k urgent. */
const defaultLadder = DEFAULT_NOTICE_LADDER;

describe('formatContextNotice — per-level bodies', () => {
  test('consider body, tokens rounded to nearest k', () => {
    expect(formatContextNotice('consider', 150_000)).toBe(
      '<fnc-notice>[consider] context at 150k tokens — no rush yet; note where a clean compact point would be, finish queued prompts there, then call request_compact.</fnc-notice>',
    );
  });

  test('plan body', () => {
    expect(formatContextNotice('plan', 200_000)).toBe(
      '<fnc-notice>[plan] context at 200k tokens — plan your compact point now; work toward it, finish any queued prompts, then call request_compact.</fnc-notice>',
    );
  });

  test('now body', () => {
    expect(formatContextNotice('now', 250_000)).toBe(
      '<fnc-notice>[now] context at 250k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
    );
  });

  test('urgent body', () => {
    expect(formatContextNotice('urgent', 300_000)).toBe(
      '<fnc-notice>[urgent] context at 300k tokens — compaction is overdue; do not start new work, finish queued prompts only, and call request_compact immediately.</fnc-notice>',
    );
  });

  test('rounds to nearest thousand (204_600 → 205k)', () => {
    expect(formatContextNotice('plan', 204_600)).toContain('context at 205k tokens');
  });

  test('rounds down (201_400 → 201k)', () => {
    expect(formatContextNotice('plan', 201_400)).toContain('context at 201k tokens');
  });

  test('body carries NO terminator', () => {
    const body = formatContextNotice('now', 250_000);
    expect(body.includes('\r')).toBe(false);
    expect(body.includes('\n')).toBe(false);
  });

  test('is NOT a slash command', () => {
    const notice = formatContextNotice('plan', 200_000);
    expect(notice.startsWith('/')).toBe(false);
    expect(notice).not.toBe(formatSlashCommand('compact'));
  });
});

describe('createContextMonitor — tiered ladder + watermark', () => {
  test('NO notice while below the first tier', () => {
    const spy = spyWriter();
    const m = createContextMonitor({ ladder: defaultLadder, write: spy.write });

    expect(m.tick(50_000)).toBe(false);
    expect(m.tick(149_999)).toBe(false);
    expect(spy.calls).toEqual([]);
  });

  test('crossing the first tier fires exactly the consider notice', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    expect(m.tick(149_000)).toBe(false);
    expect(m.tick(150_500)).toBe(true); // rounds to 151k
    expect(spy.calls).toEqual(
      noticeWrites(
        '<fnc-notice>[consider] context at 151k tokens — no rush yet; note where a clean compact point would be, finish queued prompts there, then call request_compact.</fnc-notice>',
      ),
    );
  });

  test('a jump past several tiers fires only the HIGHEST crossed level', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    // 100k → 260k crosses consider+plan+now; only `now` fires, once.
    expect(m.tick(100_000)).toBe(false);
    expect(m.tick(260_000)).toBe(true);
    expect(spy.calls).toEqual(
      noticeWrites(
        '<fnc-notice>[now] context at 260k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
    );
  });

  test('climbing tier-by-tier fires each level in turn (one per crossing)', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    expect(m.tick(160_000)).toBe(true); // consider
    expect(m.tick(210_000)).toBe(true); // plan
    expect(m.tick(255_000)).toBe(true); // now
    expect(spy.calls).toEqual([
      ...noticeWrites(
        '<fnc-notice>[consider] context at 160k tokens — no rush yet; note where a clean compact point would be, finish queued prompts there, then call request_compact.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[plan] context at 210k tokens — plan your compact point now; work toward it, finish any queued prompts, then call request_compact.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[now] context at 255k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
    ]);
  });

  test('NO second notice on growth within the same tier band', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    expect(m.tick(160_000)).toBe(true); // consider
    expect(m.tick(170_000)).toBe(false); // still below plan tier
    expect(m.tick(199_000)).toBe(false);
    expect(spy.calls.length).toBe(2); // one notice = two writes
  });

  test('repeat tier fires urgent at each multiple past the last finite tier', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    // Climb to `now` (250k), then cross repeat points 300k and 350k.
    expect(m.tick(255_000)).toBe(true); // now
    expect(m.tick(305_000)).toBe(true); // first repeat → urgent (300k point)
    expect(m.tick(330_000)).toBe(false); // between repeat points, no fire
    expect(m.tick(360_000)).toBe(true); // second repeat → urgent (350k point)

    expect(spy.calls).toEqual([
      ...noticeWrites(
        '<fnc-notice>[now] context at 255k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[urgent] context at 305k tokens — compaction is overdue; do not start new work, finish queued prompts only, and call request_compact immediately.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[urgent] context at 360k tokens — compaction is overdue; do not start new work, finish queued prompts only, and call request_compact immediately.</fnc-notice>',
      ),
    ]);
  });

  test('a jump past two repeat points fires urgent only once', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    expect(m.tick(255_000)).toBe(true); // now
    // 255k → 360k jumps both 300k and 350k repeat points; one urgent fires.
    expect(m.tick(360_000)).toBe(true);
    expect(spy.calls).toEqual([
      ...noticeWrites(
        '<fnc-notice>[now] context at 255k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[urgent] context at 360k tokens — compaction is overdue; do not start new work, finish queued prompts only, and call request_compact immediately.</fnc-notice>',
      ),
    ]);
  });

  test('watermark re-arms after a compaction drop, re-fires on the next crossing', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    // (a) climb to `now`.
    expect(m.tick(260_000)).toBe(true); // now
    // (b) more growth, same band → silent.
    expect(m.tick(280_000)).toBe(false);
    // (c) compaction drops below all tiers → no notice, watermark resets.
    expect(m.tick(40_000)).toBe(false);
    // (d) climb back, still below first tier → silent.
    expect(m.tick(149_000)).toBe(false);
    // (e) cross the first tier AGAIN → consider fires.
    expect(m.tick(150_000)).toBe(true);

    expect(spy.calls).toEqual([
      ...noticeWrites(
        '<fnc-notice>[now] context at 260k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[consider] context at 150k tokens — no rush yet; note where a clean compact point would be, finish queued prompts there, then call request_compact.</fnc-notice>',
      ),
    ]);
  });

  test('partial drop lowers the watermark only to the new highest tier', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    // climb to `now` (250k watermark).
    expect(m.tick(260_000)).toBe(true);
    // drop to between plan and now (e.g. 210k): watermark lowers to plan.
    expect(m.tick(210_000)).toBe(false);
    // climb back across `now` → now fires again.
    expect(m.tick(260_000)).toBe(true);
    expect(spy.calls).toEqual([
      ...noticeWrites(
        '<fnc-notice>[now] context at 260k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[now] context at 260k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
    ]);
  });

  test('first tick of a fat resumed session fires the single highest applicable level', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    // Resume straight into 270k: one `now`, not consider+plan+now.
    expect(m.tick(270_000)).toBe(true);
    expect(spy.calls).toEqual(
      noticeWrites(
        '<fnc-notice>[now] context at 270k tokens — find a stopping point as soon as possible, clear queued prompts, and call request_compact.</fnc-notice>',
      ),
    );
  });

  test('null reading is a no-op and does NOT move the watermark', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: defaultLadder,
      write: spy.write,
      schedule: syncSchedule,
    });

    expect(m.tick(260_000)).toBe(true); // now, watermark = 250k
    expect(m.tick(null)).toBe(false); // no-op, no re-arm
    expect(m.tick(null)).toBe(false);
    expect(m.tick(280_000)).toBe(false); // still latched at now band
    expect(spy.calls.length).toBe(2);
  });

  test('null before any crossing is a no-op', () => {
    const spy = spyWriter();
    const m = createContextMonitor({ ladder: defaultLadder, write: spy.write });
    expect(m.tick(null)).toBe(false);
    expect(m.tick(null)).toBe(false);
    expect(spy.calls).toEqual([]);
  });

  test('writer side effects are not captured back into the monitor', () => {
    const observed: string[] = [];
    const m = createContextMonitor({
      ladder: defaultLadder,
      schedule: syncSchedule,
      write: (p) => {
        observed.push(p);
      },
    });

    const result = m.tick(260_000);
    expect(result).toBe(true);
    expect(observed.length).toBe(2);
    expect(observed[0]).toContain('<fnc-notice>');
    expect(observed[1]).toBe('\r');
  });

  test('empty ladder (no tiers, no repeat) never fires', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: { tiers: [] },
      write: spy.write,
      schedule: syncSchedule,
    });
    expect(m.tick(500_000)).toBe(false);
    expect(m.tick(1_000_000)).toBe(false);
    expect(spy.calls).toEqual([]);
  });

  test('repeat with no finite tiers uses n*every as repeat points', () => {
    const spy = spyWriter();
    const m = createContextMonitor({
      ladder: { tiers: [], repeat: { every: 100_000, level: 'urgent' } },
      write: spy.write,
      schedule: syncSchedule,
    });
    expect(m.tick(50_000)).toBe(false); // below 100k
    expect(m.tick(120_000)).toBe(true); // crosses 100k repeat point
    expect(m.tick(150_000)).toBe(false); // between points
    expect(m.tick(210_000)).toBe(true); // crosses 200k repeat point
    expect(spy.calls).toEqual([
      ...noticeWrites(
        '<fnc-notice>[urgent] context at 120k tokens — compaction is overdue; do not start new work, finish queued prompts only, and call request_compact immediately.</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>[urgent] context at 210k tokens — compaction is overdue; do not start new work, finish queued prompts only, and call request_compact immediately.</fnc-notice>',
      ),
    ]);
  });
});

describe('resolveContextNoticeLadder — precedence + legacy', () => {
  test('no config, no env → built-in default ladder', () => {
    const ladder = resolveContextNoticeLadder({
      configLadder: undefined,
      configThreshold: undefined,
      env: {},
    });
    expect(ladder).toEqual(DEFAULT_NOTICE_LADDER);
  });

  test('legacy config notice_threshold → single-tier `now` ladder, no repeat', () => {
    const ladder = resolveContextNoticeLadder({
      configLadder: undefined,
      configThreshold: 120_000,
      env: {},
    });
    expect(ladder).toEqual({ tiers: [{ at: 120_000, level: 'now' }] });
  });

  test('env override beats both config ladder and legacy threshold', () => {
    const ladder = resolveContextNoticeLadder({
      configLadder: { tiers: [{ at: 10_000, level: 'consider' }] },
      configThreshold: 120_000,
      env: { [CONTEXT_NOTICE_THRESHOLD_ENV]: '80000' },
    });
    expect(ladder).toEqual({ tiers: [{ at: 80_000, level: 'now' }] });
  });

  test('config ladder beats legacy threshold when both present', () => {
    const cfg = { tiers: [{ at: 90_000, level: 'consider' as NoticeLevel }] };
    const ladder = resolveContextNoticeLadder({
      configLadder: cfg,
      configThreshold: 120_000,
      env: {},
    });
    expect(ladder).toEqual(cfg);
  });

  test('non-positive / non-numeric env degrades to next precedence', () => {
    const ladder = resolveContextNoticeLadder({
      configLadder: undefined,
      configThreshold: undefined,
      env: { [CONTEXT_NOTICE_THRESHOLD_ENV]: 'nope' },
    });
    expect(ladder).toEqual(DEFAULT_NOTICE_LADDER);
  });
});

describe('startContextMonitor — polling integration over injected seams', () => {
  test('polls the reader on each interval and fires the tier on crossing', () => {
    const spy = spyWriter();

    const sequence: Array<number | null> = [null, 50_000, 149_000, 160_000, 170_000, 199_000];
    let idx = 0;

    let cb: (() => void) | null = null;
    let cleared = false;
    const fakeSetInterval = ((fn: () => void) => {
      cb = fn;
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const origClear = globalThis.clearInterval;
    globalThis.clearInterval = (() => {
      cleared = true;
    }) as unknown as typeof clearInterval;

    try {
      const running = startContextMonitor({
        launchCWD: '/tmp/x',
        ladder: defaultLadder,
        write: spy.write,
        intervalMs: 10,
        schedule: syncSchedule,
        setIntervalFn: fakeSetInterval,
        readContextTokens: () => {
          const v = sequence[idx] ?? null;
          idx += 1;
          return v;
        },
      });

      expect(cb).not.toBeNull();
      for (let i = 0; i < sequence.length; i += 1) cb?.();

      // Exactly one notice, at the 160k consider crossing.
      expect(spy.calls).toEqual(
        noticeWrites(
          '<fnc-notice>[consider] context at 160k tokens — no rush yet; note where a clean compact point would be, finish queued prompts there, then call request_compact.</fnc-notice>',
        ),
      );
      expect(cleared).toBe(false);
    } finally {
      globalThis.clearInterval = origClear;
    }
  });
});

describe('createCompactFollowUpGate — fixed timer (no JSONL growth dependency)', () => {
  function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
    const calls: number[] = [];
    return {
      calls,
      sleep: (ms: number) => {
        calls.push(ms);
        return Promise.resolve();
      },
    };
  }

  test('does NOT resolve until sleep(delayMs) has been awaited', async () => {
    let release!: () => void;
    let slept: number | null = null;
    const gate = createCompactFollowUpGate({
      sleep: (ms: number) => {
        slept = ms;
        return new Promise<void>((res) => (release = res));
      },
    });

    let resolved = false;
    const p = gate().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(slept).toBe(COMPACT_FOLLOWUP_DELAY_MS);
    expect(resolved).toBe(false);

    release();
    await p;
    expect(resolved).toBe(true);
  });

  test('uses COMPACT_FOLLOWUP_DELAY_MS by default', async () => {
    const fake = fakeSleep();
    const gate = createCompactFollowUpGate({ sleep: fake.sleep });
    await gate();
    expect(fake.calls).toEqual([COMPACT_FOLLOWUP_DELAY_MS]);
  });

  test('honors a custom delayMs', async () => {
    const fake = fakeSleep();
    const gate = createCompactFollowUpGate({ sleep: fake.sleep, delayMs: 1234 });
    await gate();
    expect(fake.calls).toEqual([1234]);
  });

  test('default delay constant is 10s', () => {
    expect(COMPACT_FOLLOWUP_DELAY_MS).toBe(10_000);
  });
});
