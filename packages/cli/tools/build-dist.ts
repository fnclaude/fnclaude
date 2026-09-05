// Build the lowered, publishable bundle behind bin/fnc.js's installed path.
//
// Stage every `src/**/*.ts` through the ttsc/Go engine, bundle the staged emit into
// dist/main.js with runtime deps external, assert the bundle carries no un-lowered
// `typefor(`, and only then write the dist/.lowered sentinel — the marker bin/fnc.js
// forks on and the one thing a stray `tsc` emit can never produce.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stagedPath, stageLowering } from './ttsc-build.ts';

const dir = join(import.meta.dir, '..');
const dist = join(dir, 'dist');
const distMain = join(dist, 'main.js');
const sentinel = join(dist, '.lowered');

/** Runtime specifiers kept external — the whole `@rhombus-std` family plus the CLI's own deps. */
function externalSpecifiers(): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const runtime = Object.keys({ ...manifest.dependencies });
  const rhombusStd = ['@rhombus-std/di', '@rhombus-std/di.core', '@rhombus-std/di.extras', '@rhombus-std/primitives', '@rhombus-std/primitives.extras', '@rhombus-std/transforms'];
  return [...new Set([...runtime, ...rhombusStd])];
}

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
console.log('build-dist: wrote dist/main.js + dist/.lowered (0 typefor survivors)');
