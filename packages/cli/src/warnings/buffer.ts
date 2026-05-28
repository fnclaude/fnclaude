// Deferred-flush warning buffer (design.md §27).
//
// Non-fatal warnings issued during the launch sequence (config-parse,
// fragment-load, name-sanitization, etc.) shouldn't be written to stderr
// as they happen — claude's TUI takes over the terminal moments later and
// scrolls them off-screen before the user sees them. Instead, accumulate
// them here and flush once claude has exited, so they land in the user's
// shell where they have time to read them.
//
// Terminal errors that exit non-zero (bad argv, missing claude binary,
// clone failure, etc.) bypass this buffer and write directly to stderr —
// those aren't warnings, they're the reason the launch is aborting, and
// the user needs to see them immediately.

export interface WarningBuffer {
  /** Queue a warning. Trailing newline is added on flush if absent. */
  add(msg: string): void;
  /**
   * Write every queued warning to the given stream, one per line, then
   * drain the buffer. Subsequent `flush` calls without new `add`s are
   * no-ops. Idempotent on an empty queue.
   */
  flush(stream: NodeJS.WritableStream): void;
}

export function createWarningBuffer(): WarningBuffer {
  const queue: string[] = [];
  return {
    add(msg: string): void {
      queue.push(msg);
    },
    flush(stream: NodeJS.WritableStream): void {
      while (queue.length > 0) {
        const msg = queue.shift()!;
        stream.write(msg.endsWith('\n') ? msg : `${msg}\n`);
      }
    },
  };
}
