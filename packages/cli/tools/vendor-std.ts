// Regenerate the vendored `@rhombus-std` packages under `vendor/` from a local std
// checkout, until `@next` publishes for all six packages (design.di-architecture §8).
//
// Each package is vendored as an unpacked directory listed in the workspace, not a
// `file:` tarball: bun resolves a `file:` override only against an absolute path, which
// would write a machine-specific lockfile, whereas a workspace member resolves its
// transitive `@rhombus-std` siblings by version and keeps the lockfile portable and
// one-copy. `bun pm pack` still does the `workspace:^` → concrete-semver rewrite and
// captures the committed `dist/`, so the pipeline packs first, then unpacks.
//
// Three patches make the packed trees consumable outside the monorepo:
//
//   1. publishConfig merge — the runtime and authoring packages point `main`/`exports`
//      at `src/`, which their `files` field does not ship; the publish-time redirect to
//      `dist/bundle` has to be applied by hand since `bun pm pack` leaves publishConfig
//      untouched.
//   2. di's `dist/bundle/index.d.ts` repair — `dts-minify` emitted `0extends1` in the
//      `Builder` conditional-type guards, which does not parse; a `0 extends 1` rewrite
//      restores the chain every root typechecks against. Durable fix is upstream.
//   3. authoring-package declarations regenerated from shipped `src/` — the checkout's
//      committed `dist/bundle/*.d.ts` for `di.extras`/`primitives.extras` predates the
//      current sugar surface (it lacks members the transform host now emits, e.g.
//      `tryResolve`), so the lowering engine rejects it; re-emitting declarations from
//      the shipped source restores the full augmentation. Durable fix is upstream
//      rebuilding its dist at the pinned SHA.
//
// Run this only to refresh the committed `vendor/` trees; CI and every install consume
// them directly and never invoke it. Requires a resolvable dependency environment (it
// scratch-installs to re-emit declarations).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── constants ──────────────────────────────────────────────────────────────

/** The std checkout the packages are vendored from; override with FNC_STD_CHECKOUT. */
const STD_CHECKOUT = process.env.FNC_STD_CHECKOUT ?? '/home/tom/src/std@fnioc+IServiceManifest-repair';
/** The commit the vendored packages must be taken from. */
const STD_SHA = 'bd2074fa579e8452ec01e3d2fab29465801843cc';
/** Mirrors std's root override so the whole tree shares one type-primitive copy. */
const TOOLKIT_TYPES_PIN = '2.0.0';
/** The tsgo-flavoured TypeScript that carries the platform-native transform binary. */
const TYPESCRIPT_PIN = '7.0.2';

interface VendoredPackage {
  /** Directory under the std checkout the package is packed from. */
  readonly libDir: string;
  /** The workspace directory name under `vendor/` (its last path segment). */
  readonly name: string;
  /** Merge publishConfig's `main`/`exports` to the top level (its dist-only ship). */
  readonly mergePublishConfig: boolean;
  /** Rewrite di's broken conditional-type guards in the packed declaration. */
  readonly repairBuilderDts: boolean;
  /** Re-emit declarations from shipped src (its committed dist declaration is stale). */
  readonly regenerateDeclarations: boolean;
}

const PACKAGES: VendoredPackage[] = [
  { libDir: 'libraries/di', name: 'di', mergePublishConfig: true, repairBuilderDts: true, regenerateDeclarations: false },
  { libDir: 'libraries/di.core', name: 'di.core', mergePublishConfig: true, repairBuilderDts: false, regenerateDeclarations: false },
  { libDir: 'libraries/di.extras', name: 'di.extras', mergePublishConfig: true, repairBuilderDts: false, regenerateDeclarations: true },
  { libDir: 'libraries/primitives', name: 'primitives', mergePublishConfig: true, repairBuilderDts: false, regenerateDeclarations: false },
  { libDir: 'libraries/primitives.extras', name: 'primitives.extras', mergePublishConfig: true, repairBuilderDts: false, regenerateDeclarations: true },
  { libDir: 'transforms', name: 'transforms', mergePublishConfig: false, repairBuilderDts: false, regenerateDeclarations: false },
];

const CLI_DIR = join(import.meta.dir, '..');
const VENDOR_DIR = join(CLI_DIR, 'vendor');

// ── shell helpers ────────────────────────────────────────────────────────────

/** Runs a command, throwing its captured output on a non-zero exit. */
function run(cmd: string, args: string[], cwd?: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Counts non-overlapping occurrences of `needle` in a file. */
function countOccurrences(path: string, needle: string): number {
  return readFileSync(path, 'utf8').split(needle).length - 1;
}

// ── the pipeline ──────────────────────────────────────────────────────────────

/** Packs each library into `staging`, asserting the checkout stays clean, keyed by name. */
function packLibraries(staging: string): Map<string, string> {
  const tarballByName = new Map<string, string>();
  for (const pkg of PACKAGES) {
    const before = readdirSync(staging);
    run('bun', ['pm', 'pack', '--destination', staging], join(STD_CHECKOUT, pkg.libDir));
    const added = readdirSync(staging).filter((entry) => !before.includes(entry));
    if (added.length !== 1) {
      throw new Error(`${pkg.libDir}: expected one new tarball, got ${added.join(', ')}`);
    }
    tarballByName.set(pkg.name, added[0]!);
  }
  const dirty = run('git', ['-C', STD_CHECKOUT, 'status', '--porcelain']).trim();
  if (dirty !== '') {
    throw new Error(`std checkout dirty after pack:\n${dirty}`);
  }
  return tarballByName;
}

/** Merges publishConfig's `main`/`exports` to the top level and drops it. */
function mergePublishConfig(pkgDir: string): void {
  const path = join(pkgDir, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const publishConfig = manifest.publishConfig;
  if (publishConfig?.main) {
    manifest.main = publishConfig.main;
  }
  if (publishConfig?.exports) {
    manifest.exports = publishConfig.exports;
  }
  delete manifest.publishConfig;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Rewrites di's un-parseable `0extends1` conditional-type guards, asserting the count. */
function repairBuilderDts(pkgDir: string): void {
  const path = join(pkgDir, 'dist', 'bundle', 'index.d.ts');
  const before = countOccurrences(path, '0extends1');
  if (before === 0) {
    throw new Error(`${path}: expected the 0extends1 corruption, found none — is the checkout still at ${STD_SHA}?`);
  }
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('0extends1', '0 extends 1'));
  if (countOccurrences(path, '0extends1') !== 0) {
    throw new Error(`${path}: 0extends1 sites survived the repair`);
  }
  console.log(`  repaired di Builder guards: ${before} -> 0`);
}

/** Points an authoring package's declarations at a re-emitted tree under `dtsgen/`. */
function pointDeclarationsAtDtsgen(pkgDir: string): void {
  const path = join(pkgDir, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.types = './dtsgen/index.d.ts';
  const dot = manifest.exports?.['.'];
  if (dot && typeof dot === 'object') {
    manifest.exports['.'] = { types: './dtsgen/index.d.ts', ...dot };
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Re-emits declarations for the authoring packages from their shipped `src/`.
 *
 * The committed `dist` declarations are stale, so a scratch project installs the
 * finished `vendor/` trees (giving each authoring package its real dependency types)
 * and `tsc --emitDeclarationOnly` writes fresh declarations into each package's
 * `dtsgen/`, which its manifest then points at.
 */
function regenerateAuthoringDeclarations(): void {
  const scratch = mkdtempSync(join(tmpdir(), 'fnc-vendor-dtsgen-'));
  const dependencies: Record<string, string> = { typescript: TYPESCRIPT_PIN, '@rhombus-toolkit/types': TOOLKIT_TYPES_PIN };
  const overrides: Record<string, string> = { '@rhombus-toolkit/types': TOOLKIT_TYPES_PIN };
  for (const pkg of PACKAGES) {
    const name = readManifestName(join(VENDOR_DIR, pkg.name));
    const specifier = `file:${join(VENDOR_DIR, pkg.name)}`;
    dependencies[name] = specifier;
    overrides[name] = specifier;
  }
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify({ name: 'fnc-vendor-dtsgen', private: true, type: 'module', dependencies, overrides }, null, 2)}\n`);
  run('bun', ['install'], scratch);

  for (const pkg of PACKAGES) {
    if (!pkg.regenerateDeclarations) {
      continue;
    }
    const name = readManifestName(join(VENDOR_DIR, pkg.name));
    const installedSrc = join(scratch, 'node_modules', name, 'src');
    const dtsgen = join(VENDOR_DIR, pkg.name, 'dtsgen');
    rmSync(dtsgen, { recursive: true, force: true });
    emitDeclarations(scratch, installedSrc, dtsgen);
    if (!existsSync(join(dtsgen, 'index.d.ts'))) {
      throw new Error(`${name}: declaration re-emit produced no index.d.ts`);
    }
    pointDeclarationsAtDtsgen(join(VENDOR_DIR, pkg.name));
  }
  rmSync(scratch, { recursive: true, force: true });
}

/** Emits declaration-only output for one src tree, tolerating body-level errors. */
function emitDeclarations(projectDir: string, srcDir: string, outDir: string): void {
  const configPath = join(projectDir, `dtsgen-${Buffer.from(srcDir).toString('hex').slice(0, 8)}.json`);
  const config = {
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'Bundler',
      target: 'ES2022',
      lib: ['ES2022', 'ESNext.Disposable', 'DOM'],
      strict: false,
      skipLibCheck: true,
      declaration: true,
      emitDeclarationOnly: true,
      // Declaration emit only needs signatures, so unlowered-sugar body errors are
      // expected and this lets the declarations land regardless.
      noEmitOnError: false,
      isolatedModules: false,
      types: [] as string[],
      rootDir: srcDir,
      outDir,
    },
    include: [`${srcDir}/**/*.ts`],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  spawnSync('bun', ['x', 'tsc', '-p', configPath], { cwd: projectDir, encoding: 'utf8' });
}

/** Reads a package's name from its manifest. */
function readManifestName(pkgDir: string): string {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name;
}

function main(): void {
  const head = run('git', ['-C', STD_CHECKOUT, 'rev-parse', 'HEAD']).trim();
  if (head !== STD_SHA) {
    throw new Error(`std checkout is at ${head}, expected ${STD_SHA}`);
  }

  const staging = mkdtempSync(join(tmpdir(), 'fnc-vendor-staging-'));
  const extractRoot = mkdtempSync(join(tmpdir(), 'fnc-vendor-extract-'));
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });

  console.log(`Vendoring six @rhombus-std packages from ${STD_CHECKOUT} @ ${STD_SHA.slice(0, 8)}`);
  const tarballByName = packLibraries(staging);

  for (const pkg of PACKAGES) {
    const extractDir = join(extractRoot, pkg.name);
    mkdirSync(extractDir, { recursive: true });
    run('tar', ['xzf', join(staging, tarballByName.get(pkg.name)!), '-C', extractDir]);
    const pkgDir = join(extractDir, 'package');
    console.log(`Patching ${pkg.name}`);
    if (pkg.mergePublishConfig) {
      mergePublishConfig(pkgDir);
    }
    if (pkg.repairBuilderDts) {
      repairBuilderDts(pkgDir);
    }
    cpSync(pkgDir, join(VENDOR_DIR, pkg.name), { recursive: true });
  }

  console.log('Re-emitting authoring-package declarations from shipped src');
  regenerateAuthoringDeclarations();

  rmSync(staging, { recursive: true, force: true });
  rmSync(extractRoot, { recursive: true, force: true });
  console.log(`\nWrote ${PACKAGES.length} package trees to vendor/:`);
  for (const pkg of PACKAGES) {
    console.log(`  ${pkg.name}`);
  }
}

main();
