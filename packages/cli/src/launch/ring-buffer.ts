/**
 * Fixed-capacity circular byte buffer for capturing the tail of the PTY
 * output stream. Used by §9.2 to scan claude's last screenful for the
 * cross-cwd resume hint after exit.
 *
 * Default capacity is 64 KB per design.md §4. Earlier Go versions used
 * 4 KB; the Go source bumped it after claude 2.1.143 emitted more
 * trailing cleanup and rotated the "To resume, run:" message out of the
 * 4 KB tail.
 *
 * Contract:
 *   - push(chunk): append bytes; when the buffer is full, wrap and
 *     overwrite the oldest bytes. A chunk larger than the capacity keeps
 *     only its trailing `capacity` bytes (the older prefix is dropped).
 *     Zero-length chunks are no-ops.
 *   - snapshot(): a fresh Uint8Array containing the current valid bytes
 *     in chronological order (oldest first). Mutating the snapshot does
 *     not affect the buffer; subsequent pushes do not mutate prior
 *     snapshots.
 *   - size: number of valid bytes currently held, 0 ≤ size ≤ capacity.
 */

const DEFAULT_CAPACITY = 64 * 1024;

export class RingBuffer {
  readonly capacity: number;
  private readonly buf: Uint8Array;
  /** Index of the oldest valid byte. Only meaningful when full. */
  private start = 0;
  /** Number of valid bytes currently held. */
  private len = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.buf = new Uint8Array(capacity);
  }

  get size(): number {
    return this.len;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0 || this.capacity === 0) return;

    // Chunk larger than capacity: drop its prefix, keep only the trailing
    // `capacity` bytes. Replaces the buffer wholesale — start resets.
    if (chunk.length >= this.capacity) {
      this.buf.set(chunk.subarray(chunk.length - this.capacity));
      this.start = 0;
      this.len = this.capacity;
      return;
    }

    // Compute the write position (one past the last valid byte, modulo
    // capacity). When the buffer is full, that's the same slot as `start`
    // — the oldest byte gets overwritten and `start` advances.
    const writePos = (this.start + this.len) % this.capacity;
    const tail = this.capacity - writePos;
    if (chunk.length <= tail) {
      this.buf.set(chunk, writePos);
    } else {
      // Two-segment copy: fill to end of array, then wrap to index 0.
      this.buf.set(chunk.subarray(0, tail), writePos);
      this.buf.set(chunk.subarray(tail), 0);
    }

    if (this.len + chunk.length <= this.capacity) {
      this.len += chunk.length;
    } else {
      // Overflow: bytes past capacity overwrite the oldest bytes; start
      // advances by the overflow amount.
      const overflow = this.len + chunk.length - this.capacity;
      this.start = (this.start + overflow) % this.capacity;
      this.len = this.capacity;
    }
  }

  snapshot(): Uint8Array {
    if (this.len === 0) return new Uint8Array(0);
    const out = new Uint8Array(this.len);
    // Either contiguous (start..start+len fits before capacity) or split
    // (head wraps past the end of the underlying array).
    const tail = this.capacity - this.start;
    if (this.len <= tail) {
      out.set(this.buf.subarray(this.start, this.start + this.len));
    } else {
      out.set(this.buf.subarray(this.start, this.capacity), 0);
      out.set(this.buf.subarray(0, this.len - tail), tail);
    }
    return out;
  }
}
