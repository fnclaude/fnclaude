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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, defaultLookupBun } from './preflight.js';

const selfPath = fileURLToPath(import.meta.url);

// Short-circuit --version BEFORE the Bun preflight. Two reasons:
//   1. The umbrella package's version is distinct from the cli package's
//      — users install `fnclaude@X.Y.Z` and expect that `X.Y.Z` to be what
//      `fnc --version` prints. Delegating to cli's bin would surface
//      cli's own version instead (which is what shipped through 2.0.0
//      and confused users).
//   2. --version doesn't need Bun — it's pure file reads. Skipping the
//      preflight here means `fnc --version` works even on a stock Node
//      install with no Bun on PATH, which is friendlier when someone is
//      diagnosing a broken install.
//
// This duplicates cli's own --version handler, which is the tradeoff:
// cli's bin doesn't (and shouldn't) know about an umbrella above it, so
// the umbrella has to own the version surface.
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  const here = dirname(selfPath);
  const pkg = JSON.parse(
    readFileSync(join(here, '..', 'package.json'), 'utf8'),
  );
  const req = createRequire(import.meta.url);
  let suffix = '';
  try {
    const cli = req('@fnclaude/cli/package.json');
    const renderer = req('@fnclaude/renderer/package.json');
    suffix = ` (cli ${cli.version}, renderer ${renderer.version})`;
  } catch {
    // Nested install is missing or broken — degrade to bare umbrella
    // version rather than failing. The full `fnc <args>` invocation
    // will surface the real install problem; `--version` shouldn't
    // crash on the way to that diagnosis.
  }
  process.stdout.write(`${pkg.name} ${pkg.version}${suffix}\n`);
  process.exit(0);
}

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
