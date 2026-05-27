// Preflight for the cli `fnc` bin shim — decide whether to proceed,
// re-exec under Bun, or hard-error out with a directive message.
//
// The cli relies on Bun-only globals (`Bun.spawn`, `Bun.TOML.parse`,
// `Bun.which`, `process.execve`). When the bin is invoked under Node
// (typically because `npm i -g @fnclaude/cli` puts it on PATH and the
// user runs `fnc`), those Bun calls fail silently — `Bun.which` returns
// `undefined`, `Bun.TOML.parse` throws "Bun is not defined", etc. The
// cli then degrades into a "claude not found" / config-broken state
// that LOOKS like a normal failure but is actually a runtime mismatch.
//
// This preflight runs first and either re-execs under Bun (if `bun` is
// on PATH) or prints a directive error and exits non-zero — never the
// silent-degradation path.
//
// Extracted from the shim itself to keep it unit-testable: the decision
// function takes injected seams (typeof-Bun probe + PATH lookup) and
// returns a discriminated union; the shim handles the dispatch.

import { spawnSync } from 'node:child_process';

/**
 * @typedef {{ kind: 'run' }
 *         | { kind: 'reexec', bun: string }
 *         | { kind: 'error', message: string }
 * } PreflightDecision
 */

/**
 * Decide what the shim should do.
 *
 * @param {{ hasBun: boolean, lookupBun: () => string | null }} seams
 * @returns {PreflightDecision}
 */
export function decide({ hasBun, lookupBun }) {
  if (hasBun) return { kind: 'run' };
  const bun = lookupBun();
  if (bun !== null) return { kind: 'reexec', bun };
  return {
    kind: 'error',
    message:
      'fnclaude: this CLI requires Bun (https://bun.sh) to run.\n' +
      '  The shim was invoked under Node, but the CLI depends on Bun-only\n' +
      '  globals (Bun.spawn, Bun.TOML.parse, process.execve). Install Bun\n' +
      '  and re-run `fnc`, or invoke the script via `bun ...` directly.',
  };
}

/**
 * Default PATH lookup for `bun`. Returns the literal string `'bun'` on
 * success (the OS will resolve it via PATH at spawn time), or null when
 * `bun` is not reachable.
 *
 * Implementation note: `spawnSync('bun', ['--version'])` is the simplest
 * cross-platform probe. ENOENT comes back as `result.error.code`, and a
 * present-but-broken bun returns non-zero status. Both are treated as
 * "not usable."
 *
 * @returns {string | null}
 */
export function defaultLookupBun() {
  const r = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  if (r.error) return null;
  if (r.status !== 0) return null;
  return 'bun';
}
