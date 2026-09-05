// Build the lowered dist/ once before any test spawns bin/fnc.js.
//
// The e2e and unit tiers spawn the shim, whose dev path rebuilds dist/ on a cold checkout
// — a 41–72 s ttsc/Go host compile. Run concurrently from many spawned fnc processes, that
// blows each test's timeout and the spawn exits non-zero. Building once up front (via the
// bunfig preload) makes every spawn hit the shim's warm mtime fast-path with no rebuild.
//
// `build-dist.ts --if-stale` is idempotent and lock-guarded, so the module-level promise
// here only dedupes the call within a single `bun test` process — a warm run pays one mtime
// scan, a cold run pays one build for the whole suite.

import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..', '..');
let built: Promise<void> | undefined;

/** Ensures dist/ is built and fresh, at most once per test process. */
export function ensureDist(): Promise<void> {
  built ??= runBuild();
  return built;
}

async function runBuild(): Promise<void> {
  const proc = Bun.spawn(['bun', join(pkgDir, 'tools', 'build-dist.ts'), '--if-stale'], {
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`ensure-dist: build-dist.ts --if-stale failed (exit ${exitCode})`);
  }
}
