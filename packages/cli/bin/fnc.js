#!/usr/bin/env node
// @fnclaude/cli entry point — owns the Node→Bun preflight and re-execs
// itself under Bun when needed.
//
// Why Node-shebang for a Bun cli: when `npm i -g @fnclaude/cli` puts
// `fnc` on PATH, the user's shell invokes it under whichever runtime npm
// happened to link against — typically Node, since npm itself runs under
// Node. We must therefore be loadable under Node, do our own runtime
// check, and re-exec under Bun ourselves. This shim used to live in the
// umbrella package (`fnclaude`), which meant standalone installs of
// `@fnclaude/cli` skipped it and silently degraded (and, on the Bun
// side, hit the `--`-stripping bug). Owning the preflight here is the
// single source of truth.
//
// Module resolution: dist/main.js is what npm-installed users execute;
// local devs running from source use Bun's TS support to import
// src/main.ts directly. We attempt dist first and fall back to src so
// both workflows are first-class without a separate dev shim.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decide, defaultLookupBun } from './preflight.js';

const selfPath = fileURLToPath(import.meta.url);
const here = dirname(selfPath);

// Short-circuit --version BEFORE the Bun preflight. Reading package.json
// is pure Node-stdlib work and doesn't need Bun — friendlier when
// someone is diagnosing a broken install without Bun on PATH.
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  const pkg = JSON.parse(
    readFileSync(join(here, '..', 'package.json'), 'utf8'),
  );
  process.stdout.write(`fnclaude ${pkg.version}\n`);
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
  // Argv-via-env: Bun strips the first `--` from a script's argv,
  // regardless of where it appears (script invocation, `bun --`, `bun
  // run`, shebang). Confirmed empirically. So passing the user's args
  // as Bun-script argv would silently mangle `fnc -- "prompt"` into
  // `fnc "prompt"` — the cli then treats the prompt as a cwd
  // positional, the resolver fires, and 8 GitHub orgs 404 in series
  // before the user gets a misleading "could not resolve" error. We
  // sidestep by serialising the user's args into FNC_ARGS_JSON; main()
  // reads from there when present (and deletes the env var to avoid
  // leaking to its own children).
  const r = spawnSync(decision.bun, [selfPath], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FNC_ARGS_JSON: JSON.stringify(argv),
    },
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

// decision.kind === 'run' — we're already under Bun. Import main() and
// dispatch.
const distMain = resolve(here, '..', 'dist', 'main.js');
const srcMain = resolve(here, '..', 'src', 'main.ts');
const target = existsSync(distMain) ? distMain : srcMain;
const { main } = await import(pathToFileURL(target).href);

main();
