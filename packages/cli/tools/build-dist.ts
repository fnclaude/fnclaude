// Build the lowered, publishable bundle behind bin/fnc.js's installed path.
//
// Stage every `src/**/*.ts` through the ttsc/Go engine, bundle the staged emit into
// dist/main.js with runtime deps external, assert the bundle carries no un-lowered
// `typefor(`, and only then write the dist/.lowered sentinel — the marker bin/fnc.js
// forks on and the one thing a stray `tsc` emit can never produce.
//
// A cross-process build lock serializes concurrent builders: many `fnc` processes (or
// test spawns) starting at once on a stale dist would otherwise each rm/rebuild dist and
// corrupt each other's output. `--if-stale` additionally skips the build when dist is
// already newer than every source file, so the test tier and the dev shim can call this
// unconditionally and pay only an mtime scan on the warm path.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stagedPath, stageLowering } from './ttsc-build.ts';

const dir = join(import.meta.dir, '..');
const dist = join(dir, 'dist');
const distMain = join(dist, 'main.js');
const sentinel = join(dist, '.lowered');
const lockPath = join(dir, '.cache', 'build-dist.lock');

/** The newest mtime under a directory tree, or 0 when it is absent. */
function newestMtime(root: string): number {
  let newest = 0;
  for (const rel of new Bun.Glob('**/*').scanSync({ cwd: root })) {
    const stat = statSync(join(root, rel));
    if (stat.isFile() && stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  }
  return newest;
}

/** Whether dist/.lowered is newer than every source file — i.e. no rebuild is needed. */
function isDistFresh(): boolean {
  const sentinelMtime = existsSync(sentinel) ? statSync(sentinel).mtimeMs : 0;
  return sentinelMtime > 0 && newestMtime(join(dir, 'src')) <= sentinelMtime;
}

/** Runtime specifiers kept external — the whole `@rhombus-std` family plus the CLI's own deps. */
function externalSpecifiers(): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const runtime = Object.keys({ ...manifest.dependencies });
  const rhombusStd = ['@rhombus-std/di', '@rhombus-std/di.core', '@rhombus-std/di.extras', '@rhombus-std/primitives', '@rhombus-std/primitives.extras', '@rhombus-std/transforms'];
  return [...new Set([...runtime, ...rhombusStd])];
}

/** Stages, bundles, verifies no `typefor(` survived, and writes the sentinel last. */
async function buildDist(): Promise<void> {
  const stageDir = await stageLowering({ dir, ttscProject: 'tsconfig.ttsc.json', stageOut: '.ttsc-out', roots: ['src'] });

  rmSync(dist, { recursive: true, force: true });
  const bundled = await Bun.build({
    entrypoints: [stagedPath(stageDir, 'src/main.ts')],
    outdir: dist,
    target: 'node',
    format: 'esm',
    sourcemap: 'linked',
    external: externalSpecifiers(),
  });
  if (!bundled.success) {
    for (const log of bundled.logs) {
      console.error(log);
    }
    throw new Error('build-dist: bundle failed');
  }

  const survivors = (readFileSync(distMain, 'utf8').match(/typefor\(/g) ?? []).length;
  if (survivors > 0) {
    throw new Error(`build-dist: ${survivors} un-lowered typefor( survived in dist/main.js — the sugar did not lower`);
  }
  if (!existsSync(distMain)) {
    throw new Error('build-dist: dist/main.js missing after bundle');
  }

  // The sentinel is written LAST, so a partial or bare-tsc dist is never treated as lowered.
  writeFileSync(sentinel, `lowered ${new Date().toISOString()}\n`);
  // stderr, not stdout: bin/fnc.js runs this inline on a stale dev dist with stdio
  // inherited, so anything on stdout would corrupt a launch's own stdout (e.g. the
  // FNC_INTERNAL_DUMP_ARGV JSON the argv-preflight e2e reads back).
  console.error('build-dist: wrote dist/main.js + dist/.lowered (0 typefor survivors)');
}

/**
 * Runs `buildDist` under an exclusive on-disk lock, serializing concurrent builders.
 *
 * When another builder holds the lock: an `--if-stale` caller returns as soon as that
 * builder publishes a fresh sentinel (no second build), while a forced caller waits for
 * the lock and then rebuilds. A lock older than the cold-build ceiling is treated as
 * abandoned and broken, so a crashed builder never wedges the tree.
 */
async function withBuildLock(ifStale: boolean): Promise<void> {
  mkdirSync(join(dir, '.cache'), { recursive: true });
  const staleLockMs = 300_000;
  while (true) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (ifStale && isDistFresh()) {
        return;
      }
      const heldFor = existsSync(lockPath) ? Date.now() - statSync(lockPath).mtimeMs : Number.POSITIVE_INFINITY;
      if (heldFor > staleLockMs) {
        rmSync(lockPath, { force: true });
      }
      await Bun.sleep(200);
      continue;
    }
    try {
      writeFileSync(fd, `pid ${process.pid} @ ${new Date().toISOString()}\n`);
      if (ifStale && isDistFresh()) {
        return;
      }
      await buildDist();
      return;
    } finally {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
}

const ifStale = process.argv.includes('--if-stale');
// Warm fast-path: skip the lock entirely when nothing changed.
if (!(ifStale && isDistFresh())) {
  await withBuildLock(ifStale);
}
