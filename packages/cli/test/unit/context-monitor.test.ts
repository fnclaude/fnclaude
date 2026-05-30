/**
 * Unit tests for the context-size monitor (#170 part 2).
 *
 * The monitor watches the live session's context size and, the FIRST time
 * it crosses a threshold, injects EXACTLY ONE plain-text notice line into
 * the PTY via the raw write seam (NOT the slash formatter), then latches
 * off for the rest of the session. These tests drive a scripted sequence
 * of token counts (below → crossing → above) through the injected seams
 * and assert: no notice below, exactly one notice at the crossing with the
 * correct `<fnc-notice>…Nk…</fnc-notice>` format and rounded N, no second
 * notice on further growth, the configurable threshold fires earlier, and
 * nothing is captured back through the writer.
 */

import { describe, expect, test } from 'bun:test';

import { formatSlashCommand, type PtyWriter } from '../../src/mcp/handlers/inject-slash.ts';
import {
  CONTEXT_NOTICE_THRESHOLD_ENV,
  DEFAULT_CONTEXT_NOTICE_THRESHOLD,
  createCompactAcceptGate,
  createContextMonitor,
  formatContextNotice,
  resolveContextNoticeThreshold,
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

describe('formatContextNotice', () => {
  test('rounds tokens to the nearest k and wraps in <fnc-notice> — BODY only, no terminator', () => {
    expect(formatContextNotice(200_000)).toBe(
      '<fnc-notice>context at 200k tokens — call request_compact at the next clean stopping point</fnc-notice>',
    );
  });

  test('rounds to nearest thousand (204_600 → 205k)', () => {
    expect(formatContextNotice(204_600)).toContain('context at 205k tokens');
  });

  test('rounds down (201_400 → 201k)', () => {
    expect(formatContextNotice(201_400)).toContain('context at 201k tokens');
  });

  test('body carries NO terminator — submit comes from the separate CR write', () => {
    // The notice body must contain neither a CR nor an LF; injectSubmittedLine
    // supplies the Return keypress as a SEPARATE bare-CR write.
    const body = formatContextNotice(200_000);
    expect(body.includes('\r')).toBe(false);
    expect(body.includes('\n')).toBe(false);

    // The monitor submits it via the two-write contract: body, then CR.
    const spy = spyWriter();
    const m = createContextMonitor({ threshold: 200_000, write: spy.write, schedule: syncSchedule });
    m.tick(200_000);
    expect(spy.calls).toEqual([`\x1b[200~${body}\x1b[201~`, '\r']);
  });

  test('is NOT a slash command — never matches the slash formatter', () => {
    const notice = formatContextNotice(200_000);
    expect(notice.startsWith('/')).toBe(false);
    // And it is distinct from anything formatSlashCommand would produce.
    expect(notice).not.toBe(formatSlashCommand('compact'));
  });
});

describe('createContextMonitor — single-notice latch', () => {
  test('NO notice while below threshold', () => {
    const spy = spyWriter();
    const m = createContextMonitor({ threshold: 200_000, write: spy.write });

    expect(m.tick(50_000)).toBe(false);
    expect(m.tick(150_000)).toBe(false);
    expect(m.tick(199_999)).toBe(false);
    expect(spy.calls).toEqual([]);
    expect(m.hasFired()).toBe(false);
  });

  test('EXACTLY ONE notice fires at the crossing with correct rounded N', () => {
    const spy = spyWriter();
    const m = createContextMonitor({ threshold: 200_000, write: spy.write, schedule: syncSchedule });

    // Below → below → crossing.
    expect(m.tick(50_000)).toBe(false);
    expect(m.tick(199_000)).toBe(false);
    const fired = m.tick(201_400); // crosses; rounds to 201k
    expect(fired).toBe(true);

    expect(spy.calls).toEqual(
      noticeWrites(
        '<fnc-notice>context at 201k tokens — call request_compact at the next clean stopping point</fnc-notice>',
      ),
    );
    expect(m.hasFired()).toBe(true);
  });

  test('NO second notice on further growth (latched off)', () => {
    const spy = spyWriter();
    const m = createContextMonitor({ threshold: 200_000, write: spy.write, schedule: syncSchedule });

    expect(m.tick(205_000)).toBe(true);
    // Keep growing — must stay silent.
    expect(m.tick(260_000)).toBe(false);
    expect(m.tick(300_000)).toBe(false);
    expect(m.tick(999_000)).toBe(false);

    // One notice = exactly the two writes (body + CR), no more.
    expect(spy.calls.length).toBe(2);
  });

  test('null reading is a no-op (no assistant turn / unreadable JSONL)', () => {
    const spy = spyWriter();
    const m = createContextMonitor({ threshold: 200_000, write: spy.write, schedule: syncSchedule });

    expect(m.tick(null)).toBe(false);
    expect(m.tick(null)).toBe(false);
    expect(spy.calls).toEqual([]);
    expect(m.hasFired()).toBe(false);
  });

  test('writer side effects are not captured back into the monitor', () => {
    // A writer that "emits output" the model must never receive. The
    // monitor must ignore everything beyond handing bytes to the writer:
    // tick returns a plain boolean, nothing resembling captured output.
    const observed: string[] = [];
    const m = createContextMonitor({
      threshold: 200_000,
      schedule: syncSchedule,
      write: (p) => {
        observed.push(p);
        // simulate the TUI emitting a result that must NOT flow back
      },
    });

    const result = m.tick(210_000);
    expect(result).toBe(true);
    // Two writes: bracketed-paste body, then the separate CR.
    expect(observed.length).toBe(2);
    expect(observed[0]).toContain('<fnc-notice>');
    expect(observed[1]).toBe('\r');
  });
});

describe('resolveContextNoticeThreshold — default + configurable', () => {
  test('no config, no env → built-in default', () => {
    expect(resolveContextNoticeThreshold({ configThreshold: undefined, env: {} })).toBe(
      DEFAULT_CONTEXT_NOTICE_THRESHOLD,
    );
  });

  test('config value wins over default', () => {
    expect(resolveContextNoticeThreshold({ configThreshold: 120_000, env: {} })).toBe(120_000);
  });

  test('env override wins over config', () => {
    expect(
      resolveContextNoticeThreshold({
        configThreshold: 120_000,
        env: { [CONTEXT_NOTICE_THRESHOLD_ENV]: '80000' },
      }),
    ).toBe(80_000);
  });

  test('non-positive / non-numeric config degrades to default', () => {
    expect(resolveContextNoticeThreshold({ configThreshold: 0, env: {} })).toBe(
      DEFAULT_CONTEXT_NOTICE_THRESHOLD,
    );
    expect(resolveContextNoticeThreshold({ configThreshold: Number.NaN, env: {} })).toBe(
      DEFAULT_CONTEXT_NOTICE_THRESHOLD,
    );
  });
});

describe('configurable threshold fires earlier', () => {
  test('a lower configured threshold fires at a smaller context size', () => {
    const spy = spyWriter();
    const threshold = resolveContextNoticeThreshold({ configThreshold: 100_000, env: {} });
    const m = createContextMonitor({ threshold, write: spy.write, schedule: syncSchedule });

    // 120k would NOT cross the 200k default, but crosses the 100k config.
    expect(m.tick(90_000)).toBe(false);
    expect(m.tick(120_000)).toBe(true);
    expect(spy.calls).toEqual(
      noticeWrites(
        '<fnc-notice>context at 120k tokens — call request_compact at the next clean stopping point</fnc-notice>',
      ),
    );
  });
});

describe('startContextMonitor — polling integration over injected seams', () => {
  test('polls the reader on each interval, fires once at crossing, then stops polling', () => {
    const spy = spyWriter();

    // Scripted sequence of context reads, one per interval tick.
    const sequence: Array<number | null> = [null, 50_000, 199_000, 205_000, 260_000, 300_000];
    let idx = 0;

    // Fake setInterval that hands us the callback; we drive ticks manually.
    let cb: (() => void) | null = null;
    let cleared = false;
    const fakeSetInterval = ((fn: () => void) => {
      cb = fn;
      // Return an object with unref so the production unref() branch is safe.
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    // clearInterval is global; monitor calls it on the returned handle.
    const origClear = globalThis.clearInterval;
    globalThis.clearInterval = (() => {
      cleared = true;
    }) as unknown as typeof clearInterval;

    try {
      const running = startContextMonitor({
        launchCWD: '/tmp/x',
        threshold: 200_000,
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
      // Drive the poll callback once per scripted read.
      for (let i = 0; i < sequence.length; i += 1) cb?.();

      // Exactly one notice, at the 205_000 crossing — submitted as two writes.
      expect(spy.calls).toEqual(
        noticeWrites(
          '<fnc-notice>context at 205k tokens — call request_compact at the next clean stopping point</fnc-notice>',
        ),
      );
      expect(running.monitor.hasFired()).toBe(true);
      // Latched: clearInterval was invoked once the notice fired.
      expect(cleared).toBe(true);
    } finally {
      globalThis.clearInterval = origClear;
    }
  });
});

describe('createCompactAcceptGate — JSONL-growth signal with timeout fallback', () => {
  /** Fake monotonic clock + a sleep that advances it; no real timers. */
  function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  test('resolves as soon as the session JSONL grows past the baseline', async () => {
    const clock = fakeClock();
    // Baseline read is 100; it grows to 150 on the second poll.
    const sizes = [100, 100, 150, 999];
    let i = 0;
    const reads: number[] = [];
    const gate = createCompactAcceptGate({
      launchCWD: '/tmp/x',
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 200,
      timeoutMs: 10_000,
      readJsonlSize: () => {
        const v = sizes[i] ?? 999;
        i += 1;
        reads.push(v);
        return v;
      },
    });

    await gate();
    // Reads: baseline(100), poll1(100 — no growth), poll2(150 — growth → resolve).
    expect(reads.slice(0, 3)).toEqual([100, 100, 150]);
    // Resolved on growth, well before the 10s timeout.
    expect(clock.now()).toBeLessThan(10_000);
  });

  test('resolves on timeout when the size never grows (no hang)', async () => {
    const clock = fakeClock();
    const gate = createCompactAcceptGate({
      launchCWD: '/tmp/x',
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 200,
      timeoutMs: 1000,
      readJsonlSize: () => 100, // never grows
    });

    await gate(); // must resolve, not hang
    // The fake clock advanced to (or past) the deadline via the polling sleeps.
    expect(clock.now()).toBeGreaterThanOrEqual(1000);
  });

  test('growth strictly above baseline is required — equal size keeps polling to timeout', async () => {
    const clock = fakeClock();
    const gate = createCompactAcceptGate({
      launchCWD: '/tmp/x',
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 500,
      timeoutMs: 1000,
      readJsonlSize: () => 42, // baseline == every poll; never strictly grows
    });

    await gate();
    expect(clock.now()).toBeGreaterThanOrEqual(1000);
  });
});
