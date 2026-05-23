// Deferred-warning sink. Ported from src/warnings.go in the Go reference.
//
// fnclaude accumulates non-fatal warnings issued during setup and flushes
// them to stderr AFTER claude exits. Warnings printed before claude launches
// scroll off-screen too fast to read; flushing on exit shows them in the
// user's shell where they have time to actually be seen.
//
// Fatal errors that prevent launch entirely (e.g. claude binary not on PATH)
// should still print directly to stderr and exit non-zero — those don't
// need deferring because there's no claude session about to drown them out.

import process from 'node:process';

const warnings: string[] = [];

/**
 * Queue a non-fatal warning. Accepts a pre-formatted message (callers do
 * their own templating); printed verbatim on flush.
 */
export function warn(msg: string): void {
  warnings.push(msg);
}

/**
 * Print all queued warnings to stderr in order, then clear the queue.
 * Called from `run()` after claude exits. Returns the number of warnings
 * that were flushed (useful for tests).
 */
export function flushWarnings(stream: NodeJS.WriteStream = process.stderr): number {
  const n = warnings.length;
  for (const w of warnings) {
    stream.write(`${w}\n`);
  }
  warnings.length = 0;
  return n;
}

/**
 * Test helper: return a snapshot of the current queue without flushing.
 */
export function pendingWarnings(): readonly string[] {
  return [...warnings];
}

/**
 * Test helper: clear the queue without emitting anything.
 */
export function clearWarnings(): void {
  warnings.length = 0;
}
