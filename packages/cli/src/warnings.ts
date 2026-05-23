// Deferred-warning sink. Ported from src/warnings.go in the Go reference.
//
// fnclaude accumulates non-fatal warnings issued during setup and flushes
// them to stderr AFTER claude exits. Warnings printed before claude launches
// scroll off-screen too fast to read; flushing on exit shows them in the
// user's shell where they have time to actually be seen.
//
// There is no module-global queue here — every loader (loadConfig,
// loadRepoSettings, loadHostAliases, loadPrompts) returns its warnings
// alongside its result, and `main.ts` threads them into a single local
// list that `flushWarnings` drains at the deferred-flush point. The old
// global queue made test fixtures share state across files and forced
// callers to know about a sink module they otherwise didn't depend on;
// the explicit-thread shape is the fix.
//
// Fatal errors that prevent launch entirely (e.g. claude binary not on PATH)
// should still print directly to stderr and exit non-zero — those don't
// need deferring because there's no claude session about to drown them out.

import process from 'node:process';

/**
 * Print each warning to `stream` on its own line. Returns the number of
 * warnings written (useful for tests). Empty input is a no-op.
 */
export function flushWarnings(
  warnings: readonly string[],
  stream: NodeJS.WriteStream = process.stderr,
): number {
  for (const w of warnings) {
    stream.write(`${w}\n`);
  }
  return warnings.length;
}
