// Build and run the composition-test tier (design.di-architecture §5/§7).
//
// The `.ctest.ts` files are authored in the registration dialect, so they cannot run
// under plain `bun test`. This lowers `src/**` and `test/composition/**` through the
// ttsc engine (the same program the dist build uses), bundles each `.ctest.ts` with
// `bun:test` and `@rhombus-std/*` external into `.composition-out/`, and hands the
// lowered suite to `bun test`.

import { readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stagedPath, stageLowering } from './ttsc-build.ts';

const dir = join(import.meta.dir, '..');
const compositionDir = join(dir, 'test', 'composition');
const outDir = join(dir, '.composition-out');

/** Runtime specifiers kept external, plus `bun:test` (the runner provides it). */
function externalSpecifiers(): string[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const runtime = Object.keys({ ...manifest.dependencies });
  const rhombusStd = ['@rhombus-std/di', '@rhombus-std/di.core', '@rhombus-std/di.extras', '@rhombus-std/primitives', '@rhombus-std/primitives.extras', '@rhombus-std/transforms'];
  return [...new Set(['bun:test', ...runtime, ...rhombusStd])];
}

const ctests = [...new Bun.Glob('**/*.ctest.ts').scanSync({ cwd: compositionDir, absolute: true })];
if (ctests.length === 0) {
  throw new Error('build-composition: no *.ctest.ts under test/composition');
}

const stageDir = await stageLowering({
  dir,
  ttscProject: 'tsconfig.ttsc.tests.json',
  stageOut: '.ttsc-out-tests',
  roots: ['src', 'test/composition'],
});

rmSync(outDir, { recursive: true, force: true });
const bundled = await Bun.build({
  entrypoints: ctests.map((path) => stagedPath(stageDir, relative(dir, path))),
  outdir: outDir,
  target: 'bun',
  format: 'esm',
  // `bun test` only picks up files whose name carries `.test`/`.spec`; the source
  // suffix is `.ctest`, so append `.test` to the lowered output.
  naming: '[dir]/[name].test.[ext]',
  external: externalSpecifiers(),
});
if (!bundled.success) {
  for (const log of bundled.logs) {
    console.error(log);
  }
  throw new Error('build-composition: bundle failed');
}

const survivors = bundled.outputs
  .filter((output) => output.path.endsWith('.js'))
  .reduce((total, output) => total + (readFileSync(output.path, 'utf8').match(/typefor\(/g) ?? []).length, 0);
if (survivors > 0) {
  throw new Error(`build-composition: ${survivors} un-lowered typefor( survived — the sugar did not lower`);
}

const run = Bun.spawnSync(['bun', 'test', outDir], { cwd: dir, stdio: ['inherit', 'inherit', 'inherit'] });
process.exit(run.exitCode ?? 1);
