#!/usr/bin/env node
// Umbrella shim: delegates to `@rhombus.rocks/fnclaude`'s bin, which owns the
// Node→Bun preflight + FNC_ARGS_JSON re-exec. The shim pattern is
// deliberate — npm's `bin` field pointing into a dependency is
// undefined behavior, but a thin wrapper that requires the dep is
// documented and portable.
//
// Why the cli owns the preflight: users who `npm i -g @rhombus.rocks/fnclaude`
// standalone (without the umbrella) used to skip the shim entirely and
// silently degrade under Node. Collapsing the preflight into the cli
// makes that path work too. See `packages/cli/bin/fnc.js`.
//
// What stays here: the umbrella package's `--version` reporting. The
// umbrella's version is distinct from the cli's — users install
// `fnclaude@X.Y.Z` and expect that `X.Y.Z` to be what `fnc --version`
// prints. Delegating straight to cli's bin would surface cli's own
// version instead (which is what shipped through 2.0.0 and confused
// users).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  const here = dirname(selfPath);
  const pkg = JSON.parse(
    readFileSync(join(here, '..', 'package.json'), 'utf8'),
  );
  const req = createRequire(import.meta.url);
  let suffix = '';
  try {
    const cli = req('@rhombus.rocks/fnclaude/package.json');
    suffix = ` (cli ${cli.version})`;
  } catch {
    // Nested install is missing or broken — degrade to bare umbrella
    // version rather than failing. The full `fnc <args>` invocation
    // will surface the real install problem; `--version` shouldn't
    // crash on the way to that diagnosis.
  }
  process.stdout.write(`${pkg.name} ${pkg.version}${suffix}\n`);
  process.exit(0);
}

// Everything else: hand off to cli's bin. Its preflight handles the
// Node→Bun re-exec and FNC_ARGS_JSON serialisation itself.
await import('@rhombus.rocks/fnclaude/bin/fnc.js');
