/**
 * Unit tests for the context-size monitor (#170 part 2).
 *
 * The monitor watches the live session's context size and, when it crosses
 * a threshold, injects EXACTLY ONE plain-text notice line into the PTY via
 * the raw write seam (NOT the slash formatter), then latches off so mere
 * growth doesn't re-fire — but re-arms after a compaction drops context
 * below the threshold. These tests drive a scripted sequence of token
 * counts (below → crossing → above → drop → crossing) through the injected
 * seams and assert: no notice below, exactly one notice at the crossing
 * with the correct `<fnc-notice>…Nk…</fnc-notice>` format and rounded N, no
 * second notice on further growth, a second notice after a drop + recross,
 * the configurable threshold fires earlier, and nothing is captured back
 * through the writer.
 */

import { describe, expect, test } from 'bun:test';

import { formatSlashCommand, type PtyWriter } from '../../src/mcp/handlers/inject-slash.ts';
import {
  COMPACT_FOLLOWUP_DELAY_MS,
  CONTEXT_NOTICE_THRESHOLD_ENV,
  DEFAULT_CONTEXT_NOTICE_THRESHOLD,
  createCompactFollowUpGate,
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
      '<fnc-notice>context at 200k tokens — at the next clean stopping point, finish any queued prompts, then call request_compact</fnc-notice>',
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
        '<fnc-notice>context at 201k tokens — at the next clean stopping point, finish any queued prompts, then call request_compact</fnc-notice>',
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

  test('re-arms after a compaction drop and fires a SECOND time on the next crossing', () => {
    const spy = spyWriter();
    const m = createContextMonitor({ threshold: 200_000, write: spy.write, schedule: syncSchedule });

    // (a) crosses → fires.
    expect(m.tick(205_000)).toBe(true);
    // (b) keeps growing above threshold → no re-fire on mere growth.
    expect(m.tick(260_000)).toBe(false);
    // (c) drops below threshold (compaction) → no notice, but re-arms.
    expect(m.tick(50_000)).toBe(false);
    // (d) climbs back, still below → no notice.
    expect(m.tick(199_000)).toBe(false);
    // (e) crosses AGAIN → fires a SECOND time.
    expect(m.tick(205_000)).toBe(true);

    // Exactly two notices = four writes (body + CR each).
    expect(spy.calls).toEqual([
      ...noticeWrites(
        '<fnc-notice>context at 205k tokens — at the next clean stopping point, finish any queued prompts, then call request_compact</fnc-notice>',
      ),
      ...noticeWrites(
        '<fnc-notice>context at 205k tokens — at the next clean stopping point, finish any queued prompts, then call request_compact</fnc-notice>',
      ),
    ]);
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
        '<fnc-notice>context at 120k tokens — at the next clean stopping point, finish any queued prompts, then call request_compact</fnc-notice>',
      ),
    );
  });
});

describe('startContextMonitor — polling integration over injected seams', () => {
  test('polls the reader on each interval and fires once at crossing', () => {
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
          '<fnc-notice>context at 205k tokens — at the next clean stopping point, finish any queued prompts, then call request_compact</fnc-notice>',
        ),
      );
      expect(running.monitor.hasFired()).toBe(true);
      // Polling does NOT stop on fire (the latch re-arms after a drop), so
      // clearInterval is only called by an explicit stop() — never here.
      expect(cleared).toBe(false);
    } finally {
      globalThis.clearInterval = origClear;
    }
  });
});

describe('createCompactFollowUpGate — fixed timer (no JSONL growth dependency)', () => {
  /** A fake sleep that records its argument and resolves on the next microtask. */
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

    // Sleep was started but not yet released: the gate must still be pending.
    await Promise.resolve();
    expect(slept).toBe(COMPACT_FOLLOWUP_DELAY_MS);
    expect(resolved).toBe(false);

    // Release the sleep; only now may the gate resolve.
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

  test('does NOT read the JSONL at all (no growth dependency)', async () => {
    const fake = fakeSleep();
    // No readJsonlSize / launchCWD seam exists anymore: the gate is a pure
    // timer. If it tried to touch disk it would need a cwd; it does not.
    const gate = createCompactFollowUpGate({ sleep: fake.sleep });
    await gate();
    // Exactly one sleep, no polling loop.
    expect(fake.calls.length).toBe(1);
  });

  test('default delay constant is 10s', () => {
    expect(COMPACT_FOLLOWUP_DELAY_MS).toBe(10_000);
  });
});
