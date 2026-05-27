#!/usr/bin/env node
// Umbrella shim: delegates to @fnclaude/cli's bin. The shim pattern is
// deliberate — npm's `bin` field pointing into a dependency is undefined
// behavior, but a thin wrapper that requires the dep is documented and
// portable.
//
// Runtime preflight: the CLI uses Bun-only globals (`Bun.spawn`,
// `Bun.TOML.parse`, `Bun.which`, `process.execve`). The shebang is
// `#!/usr/bin/env node` because `npm i -g fnclaude` exposes us as a Node
// script regardless of whether the user has Bun installed — so we must
// be loadable by Node, not just by Bun. The preflight detects that
// mismatch and either re-execs under Bun (preserving stdio + exit code)
// or prints a directive error and exits non-zero. Either way, the user
// never sees a silently-degraded run where Bun.TOML.parse throws "Bun is
// not defined" and the CLI lies about not finding claude on PATH.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, defaultLookupBun } from './preflight.js';

const selfPath = fileURLToPath(import.meta.url);
const decision = decide({
  hasBun: typeof globalThis.Bun !== 'undefined',
  lookupBun: defaultLookupBun,
});

if (decision.kind === 'error') {
  process.stderr.write(`${decision.message}\n`);
  process.exit(1);
}

if (decision.kind === 'reexec') {
  // Re-launch ourselves under Bun. `spawnSync` with stdio:'inherit'
  // forwards streams transparently; we propagate the child's exit code
  // so the OS / parent process sees the same status it would have seen
  // had Bun been the launcher all along.
  //
  // Note: this is a process-tree round-trip (Node → Bun), not a true
  // execve replacement. We don't have execve in Node stdlib, and the
  // payoff of pulling in a native addon for one bootstrap step is
  // negative. Cost is one extra PID in the tree; signals propagate via
  // the inherited stdio.
  const r = spawnSync(decision.bun, [selfPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  if (r.error) {
    // ENOENT shouldn't reach here — lookupBun confirmed bun is reachable
    // — but if something else broke (EACCES, ETXTBSY), surface it
    // instead of swallowing.
    process.stderr.write(`fnclaude: failed to re-exec under bun: ${r.error.message}\n`);
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

// decision.kind === 'run' — we're already under Bun.
await import('@fnclaude/cli/bin/fnc.js');
