// Shared ttsc/Go lowering helpers for the dist and composition builds.
//
// The transform runs in two passes (design.di-architecture §7): a per-file STAGE
// lowers every source file in isolation through `@ttsc/unplugin/bun` (which spawns
// the one Go host discovered from the `*.extras` devDeps), then a plugin-free BUNDLE
// folds the staged emit into a single file with `@rhombus-std/*` external. Lowering
// commutes with bundling, so the bundle is what a no-sugar author would have written.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the Go toolchain for the transform host to ttsc's own bundled SDK.
 *
 * ttsc resolves `@ttsc/<platform>/bin/go` when `TTSC_GO_BINARY` is unset, so contributor
 * setup needs no system Go. Every cache — ttsc's plugin cache, Go's build/module/scratch
 * caches, and GOPATH — defaults to one repo-local directory rather than under `$HOME`, so a
 * HOME-isolated test never triggers a cold host compile under its throwaway HOME. The object
 * caches are content-keyed, so a single per-checkout location is safe across every worktree
 * and session, and an explicit environment value always wins. Ambient `GOROOT`/`GOBIN` are
 * cleared so the bundled binary uses its own built-in root.
 */
export function ttscEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  env.GOTOOLCHAIN = 'local';
  const cacheHome = join(import.meta.dir, '..', '.cache', 'ttsc');
  function repoLocal(name: string, subdir: string): string {
    const dir = process.env[name] ?? join(cacheHome, subdir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  env.GOTMPDIR = repoLocal('GOTMPDIR', 'gotmp');
  env.TTSC_CACHE_DIR = repoLocal('TTSC_CACHE_DIR', 'plugins');
  env.GOCACHE = repoLocal('GOCACHE', 'go-build');
  env.GOMODCACHE = repoLocal('GOMODCACHE', 'gomodcache');
  env.GOPATH = repoLocal('GOPATH', 'gopath');
  delete env.GOROOT;
  env.GOBIN = '';
  return env;
}

/** Loads the `@ttsc/unplugin/bun` adapter bound to a lowering tsconfig. */
export async function ttscBunPlugin(dir: string, ttscProject: string): Promise<Bun.BunPlugin> {
  Object.assign(process.env, ttscEnv());
  const adapter = Bun.resolveSync('@ttsc/unplugin/bun', dir);
  const makePlugin = (await import(adapter)).default as (options: { project: string }) => Bun.BunPlugin;
  return makePlugin({ project: join(dir, ttscProject) });
}

export interface StageOptions {
  /** The package root the tsconfig and sources are resolved from. */
  readonly dir: string;
  /** The lowering tsconfig (relative to `dir`). */
  readonly ttscProject: string;
  /** The stage output directory (relative to `dir`). */
  readonly stageOut: string;
  /** Glob roots (relative to `dir`) whose `**\/*.ts` files are staged. */
  readonly roots: string[];
}

/**
 * Lowers every `.ts` under `roots` into `stageOut`, each file its own entrypoint with
 * all imports external, and returns the absolute stage directory.
 */
export async function stageLowering(options: StageOptions): Promise<string> {
  const { dir, ttscProject, stageOut, roots } = options;
  const stageDir = join(dir, stageOut);
  rmSync(stageDir, { recursive: true, force: true });
  const entrypoints: string[] = [];
  for (const root of roots) {
    const abs = join(dir, root);
    for (const path of new Bun.Glob('**/*.ts').scanSync({ cwd: abs, absolute: true })) {
      if (!path.endsWith('.d.ts')) {
        entrypoints.push(path);
      }
    }
  }
  const staged = await Bun.build({
    entrypoints,
    outdir: stageDir,
    root: dir,
    target: 'node',
    format: 'esm',
    external: ['*'],
    plugins: [await ttscBunPlugin(dir, ttscProject)],
  });
  if (!staged.success) {
    for (const log of staged.logs) {
      console.error(log);
    }
    throw new Error(`ttsc lowering stage failed (${ttscProject})`);
  }
  return stageDir;
}

/** The staged file a `dir`-relative source path lowered into. */
export function stagedPath(stageDir: string, dirRelativeSource: string): string {
  return join(stageDir, dirRelativeSource.replace(/\.ts$/, '.js'));
}
