/**
 * Unit tests for owner liveness in the coordination registry.
 *
 * An entry's owner is live iff the pid is alive AND the recorded starttime
 * (field 22 of /proc/<pid>/stat, captured at registration) matches the
 * pid's CURRENT starttime — the starttime match is what guards against pid
 * reuse: a recycled pid gets a fresh starttime, so a stale entry whose pid
 * was recycled reads as dead, not as a phantom live session.
 */

import { describe, expect, test } from 'bun:test';

import { isOwnerLive, parseStarttime } from '../../src/registry/liveness';

// A realistic /proc/<pid>/stat line. Field 22 (1-indexed) is starttime.
// comm is "(tmux: server)" — spaces AND parens inside, the classic parser trap.
const STAT_LINE =
  '4242 (tmux: server) S 1 4242 4242 0 -1 4194560 2586 275 0 0 5 11 0 0 20 0 1 0 987654 12345678 900 18446744073709551615 1 1 0 0 0 0 0 3670020 1247 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0';

describe('parseStarttime', () => {
  test('extracts field 22 with a space-and-paren comm', () => {
    expect(parseStarttime(STAT_LINE)).toBe('987654');
  });

  test('extracts field 22 with a plain comm', () => {
    const line =
      '1 (init) S 0 1 1 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 33 100 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0';
    expect(parseStarttime(line)).toBe('33');
  });

  test('returns null on garbage', () => {
    expect(parseStarttime('not a stat line')).toBeNull();
  });

  test('returns null on empty input', () => {
    expect(parseStarttime('')).toBeNull();
  });
});

describe('isOwnerLive', () => {
  test('dead pid → dead, regardless of starttime', () => {
    expect(
      isOwnerLive(
        { pid: 4242, starttime: '987654' },
        { pidAlive: () => false, readStarttime: () => '987654' },
      ),
    ).toBe(false);
  });

  test('alive pid + matching starttime → live', () => {
    expect(
      isOwnerLive(
        { pid: 4242, starttime: '987654' },
        { pidAlive: () => true, readStarttime: () => '987654' },
      ),
    ).toBe(true);
  });

  test('alive pid + starttime MISMATCH → dead (pid reuse)', () => {
    expect(
      isOwnerLive(
        { pid: 4242, starttime: '987654' },
        { pidAlive: () => true, readStarttime: () => '111111' },
      ),
    ).toBe(false);
  });

  test('recorded starttime null (unavailable at registration) → falls back to pid-aliveness', () => {
    expect(
      isOwnerLive(
        { pid: 4242, starttime: null },
        { pidAlive: () => true, readStarttime: () => '987654' },
      ),
    ).toBe(true);
  });

  test('current starttime unreadable but pid alive → falls back to pid-aliveness', () => {
    expect(
      isOwnerLive(
        { pid: 4242, starttime: '987654' },
        { pidAlive: () => true, readStarttime: () => null },
      ),
    ).toBe(true);
  });
});
