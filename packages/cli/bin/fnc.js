#!/usr/bin/env node
//
// Node→Bun preflight. Bun 1.3.14 still strips the literal `--` sentinel from
// `process.argv` (see specs/decisions.md), which would corrupt `fnc -- <prompt>`
// invocations. Running this shim under Node first preserves the unstripped
// argv long enough to stuff it into FNC_ARGS_JSON, then re-execs under Bun
// where main reads back from the env var instead of process.argv.
//
// When this file is invoked directly under Bun (e.g. `bun bin/fnc.js`, or
// via the `#!/usr/bin/env bun` future state), `typeof Bun !== 'undefined'`
// short-circuits the preflight and we jump straight to the entry fork.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof Bun === 'undefined') {
  const { spawnSync } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const argvJson = JSON.stringify(process.argv.slice(2));
  const result = spawnSync('bun', [self], {
    stdio: 'inherit',
    env: { ...process.env, FNC_ARGS_JSON: argvJson },
  });
  if (result.error) {
    const err = result.error;
    const isMissingBun = /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT';
    if (isMissingBun) {
      process.stderr.write(
        'fnc: Bun runtime not found on PATH.\n' +
          '  fnclaude requires Bun (Node alone is not supported).\n' +
          '  Install: https://bun.sh — `curl -fsSL https://bun.sh/install | bash`\n',
      );
    } else {
      process.stderr.write(`fnc: failed to re-exec under bun (${err.message})\n`);
    }
    process.exit(127);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    // Unreachable on Unix; defensive return for Windows where kill-self doesn't terminate.
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// ── entry fork (running under Bun) ───────────────────────────────────────────
//
// A published install ships only the lowered `dist/` (its `files` excludes `src/`);
// a dev checkout has `src/` and rebuilds `dist/` on demand. The fork keys off the
// `dist/.lowered` sentinel, which only tools/build-dist.ts writes — a stray `tsc`
// emit carries no sentinel and is treated as stale, so an un-lowered bundle is never
// imported.

const binDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(binDir, '..');
const distMain = join(pkgDir, 'dist', 'main.js');
const distLowered = join(pkgDir, 'dist', '.lowered');
const srcMain = join(pkgDir, 'src', 'main.ts');

/** The newest mtime under a directory tree, or 0 when it is absent. */
function newestMtime(dir) {
  let newest = 0;
  const glob = new Bun.Glob('**/*');
  for (const rel of glob.scanSync({ cwd: dir })) {
    const stat = statSync(join(dir, rel));
    if (stat.isFile() && stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  }
  return newest;
}

/**
 * Rebuilds `dist/` when any source file is newer than the sentinel.
 *
 * The mtime check is a warm fast-path that avoids spawning a builder on every launch.
 * On a stale dist it delegates to `build-dist.ts --if-stale`, whose on-disk lock keeps
 * several `fnc` processes starting at once from racing two rm/rebuilds — the loser waits
 * for the winner's sentinel instead of building a second time.
 */
function ensureFreshDist() {
  const sentinelMtime = existsSync(distLowered) ? statSync(distLowered).mtimeMs : 0;
  if (newestMtime(join(pkgDir, 'src')) <= sentinelMtime) {
    return;
  }
  const built = Bun.spawnSync(['bun', join(pkgDir, 'tools', 'build-dist.ts'), '--if-stale'], { stdio: ['inherit', 'inherit', 'inherit'] });
  if (built.exitCode !== 0) {
    process.stderr.write('fnc: dist rebuild failed\n');
    process.exit(built.exitCode ?? 1);
  }
}

// `src/` presence is the discriminator: a dev checkout has it (and rebuilds on
// demand), a published install ships only the lowered `dist/`.
if (existsSync(srcMain)) {
  ensureFreshDist(); // dev: rebuild iff any src file is newer than the sentinel
  await import(distMain);
} else if (existsSync(distLowered) && existsSync(distMain)) {
  await import(distMain); // installed: pre-lowered bundle, no transform host
} else {
  process.stderr.write('fnc: dist/.lowered missing and no src/ present — reinstall @rhombus.rocks/fnclaude\n');
  process.exit(1);
}
