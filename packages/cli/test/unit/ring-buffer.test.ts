/**
 * Unit coverage for the 64 KB ring buffer that tees Bun.Terminal PTY
 * output for §9.2's cross-cwd detection regex.
 *
 * Contract (per design.md §4):
 *   - Fixed capacity, default 64 * 1024 bytes
 *   - push(chunk) writes bytes; wraps on overflow, overwriting oldest
 *   - snapshot() returns chronological bytes (oldest → newest)
 *   - Chunks larger than capacity keep only the trailing `capacity` bytes
 *   - Zero-length pushes are no-ops
 *   - size reports the current valid byte count, ≤ capacity
 */

import { describe, expect, test } from 'bun:test';

import { RingBuffer } from '../../src/launch/ring-buffer.ts';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function rangeBytes(start: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (start + i) & 0xff;
  return out;
}

describe('RingBuffer', () => {
  test('empty → snapshot returns empty Uint8Array, size 0', () => {
    const rb = new RingBuffer();
    const snap = rb.snapshot();
    expect(snap).toBeInstanceOf(Uint8Array);
    expect(snap.length).toBe(0);
    expect(rb.size).toBe(0);
  });

  test('push under capacity → snapshot returns exact bytes in order', () => {
    const rb = new RingBuffer(16);
    rb.push(bytes(1, 2, 3, 4, 5));
    expect(rb.size).toBe(5);
    expect(rb.snapshot()).toEqual(bytes(1, 2, 3, 4, 5));
  });

  test('push exactly at capacity → snapshot returns all of it', () => {
    const rb = new RingBuffer(8);
    rb.push(bytes(10, 11, 12, 13, 14, 15, 16, 17));
    expect(rb.size).toBe(8);
    expect(rb.snapshot()).toEqual(bytes(10, 11, 12, 13, 14, 15, 16, 17));
  });

  test('push beyond capacity (70 KB into 64 KB) → snapshot returns last 64 KB', () => {
    const cap = 64 * 1024;
    const rb = new RingBuffer(cap);
    const total = 70 * 1024;
    // Build a payload where byte i = i mod 256, then push in 1 KB chunks
    // so we exercise the wrap path multiple times.
    const chunkSize = 1024;
    for (let i = 0; i < total; i += chunkSize) {
      rb.push(rangeBytes(i, chunkSize));
    }
    expect(rb.size).toBe(cap);
    const snap = rb.snapshot();
    expect(snap.length).toBe(cap);
    // Expected = bytes from (total - cap) to (total - 1)
    const expected = rangeBytes(total - cap, cap);
    expect(snap).toEqual(expected);
  });

  test('multiple small pushes wrapping → snapshot reconstructs chronological order', () => {
    const rb = new RingBuffer(5);
    rb.push(bytes(1, 2, 3));
    rb.push(bytes(4, 5));
    expect(rb.snapshot()).toEqual(bytes(1, 2, 3, 4, 5));
    // Next push wraps: 1 → overwritten by 6, oldest is now 2.
    rb.push(bytes(6));
    expect(rb.snapshot()).toEqual(bytes(2, 3, 4, 5, 6));
    rb.push(bytes(7, 8));
    expect(rb.snapshot()).toEqual(bytes(4, 5, 6, 7, 8));
    // Push that re-wraps past the end of the underlying array.
    rb.push(bytes(9, 10, 11));
    expect(rb.snapshot()).toEqual(bytes(7, 8, 9, 10, 11));
  });

  test('single chunk larger than capacity → snapshot is the last `capacity` bytes', () => {
    const rb = new RingBuffer(4);
    rb.push(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9));
    expect(rb.size).toBe(4);
    expect(rb.snapshot()).toEqual(bytes(6, 7, 8, 9));
  });

  test('oversize chunk after partial fill → still only last `capacity` bytes', () => {
    const rb = new RingBuffer(4);
    rb.push(bytes(100, 101));
    rb.push(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9));
    expect(rb.size).toBe(4);
    expect(rb.snapshot()).toEqual(bytes(6, 7, 8, 9));
  });

  test('zero-length push → no-op', () => {
    const rb = new RingBuffer(8);
    rb.push(bytes(1, 2));
    rb.push(new Uint8Array(0));
    expect(rb.size).toBe(2);
    expect(rb.snapshot()).toEqual(bytes(1, 2));
    // Empty push on empty buffer.
    const rb2 = new RingBuffer(8);
    rb2.push(new Uint8Array(0));
    expect(rb2.size).toBe(0);
    expect(rb2.snapshot()).toEqual(new Uint8Array(0));
  });

  test('default capacity is 64 KB', () => {
    const rb = new RingBuffer();
    // Push 65 KB; size must cap at 64 * 1024.
    const big = new Uint8Array(65 * 1024);
    big.fill(0xab);
    rb.push(big);
    expect(rb.size).toBe(64 * 1024);
  });

  test('snapshot returns a fresh copy, not a live view', () => {
    const rb = new RingBuffer(8);
    rb.push(bytes(1, 2, 3, 4));
    const snap = rb.snapshot();
    // Mutating the snapshot must not affect the buffer.
    snap[0] = 99;
    expect(rb.snapshot()).toEqual(bytes(1, 2, 3, 4));
    // And subsequent pushes must not silently rewrite the prior snapshot.
    rb.push(bytes(5));
    expect(snap).toEqual(bytes(99, 2, 3, 4));
  });
});
