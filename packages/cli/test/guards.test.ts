// Architecture guards (design.di-architecture §7): grep-level invariants the DI
// adoption depends on, enforced in the unit tier so they cost no transform.
//
// These read source as text — they import nothing from `@rhombus-std`, so plain
// `bun test` stays sugar-free and transform-free (doctrine 4). Each guard is one
// confinement rule; the placeholders hold the shape for the roots the later PRs add.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findForkedStdCopies, findLockfileAbsolutePaths } from '../tools/check-vendor-install.ts';

const cliRoot = join(import.meta.dir, '..');

/** Every `.ts` under `src/` paired with its `src/`-relative path. */
function sourceFiles(): { rel: string; text: string }[] {
  const srcDir = join(cliRoot, 'src');
  const files: { rel: string; text: string }[] = [];
  for (const rel of new Glob('**/*.ts').scanSync({ cwd: srcDir })) {
    files.push({ rel, text: readFileSync(join(srcDir, rel), 'utf8') });
  }
  return files;
}

/** Whether a `src/`-relative path is a composition root (may name the engine). */
function isEntryRoot(rel: string): boolean {
  return rel.startsWith('entry/');
}

/** Whether a `src/`-relative path is a registration file (may hold sugar). */
function isRegisterFile(rel: string): boolean {
  return rel === 'register.ts' || rel.endsWith('/register.ts');
}

describe('sugar confinement (doctrine 4 + 11)', () => {
  test('the di engine (Builder) is imported only in src/entry/*', () => {
    const offenders = sourceFiles()
      .filter((file) => /from ['"]@rhombus-std\/di['"]/.test(file.text))
      .map((file) => file.rel)
      .filter((rel) => !isEntryRoot(rel));
    expect(offenders).toEqual([]);
  });

  test('the di.extras sugar faces are imported only in entry roots and register files', () => {
    const offenders = sourceFiles()
      .filter((file) => /from ['"]@rhombus-std\/di\.extras['"]/.test(file.text))
      .map((file) => file.rel)
      .filter((rel) => !isEntryRoot(rel) && !isRegisterFile(rel));
    expect(offenders).toEqual([]);
  });

  test('typefor<> is never written in fnclaude source (the sugar lowers it)', () => {
    const offenders = sourceFiles()
      .filter((file) => /\btypefor\s*[<(]/.test(file.text))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});

describe('config confinement (placeholder — tightens to the plan root when it lands)', () => {
  test('loadConfig is called only from known sites', () => {
    // The plan root owns config loading (entry/plan.ts, before the chain opens —
    // doctrine 7); the dispatcher no longer touches it. `config/load.ts` is the
    // definition site.
    const allowed = new Set(['config/load.ts', 'entry/plan.ts']);
    const callers = sourceFiles()
      .filter((file) => /\bloadConfig\s*\(/.test(file.text))
      .map((file) => file.rel)
      .filter((rel) => !allowed.has(rel));
    expect(callers).toEqual([]);
  });
});

describe('vendored @rhombus-std install invariants (§8 step 5)', () => {
  test('every vendored package resolves to one physical copy under vendor/', () => {
    // A second physical copy of any @rhombus-std package forks the Type intern table
    // silently (primitives has no self-guard, §7); a std bump or a version-range edit in
    // one vendored package.json is what would break the workspace dedup and fork it here.
    expect(findForkedStdCopies(cliRoot)).toEqual([]);
  });

  test('the lockfile carries no absolute paths, so the install stays portable', () => {
    expect(findLockfileAbsolutePaths(join(cliRoot, '..', '..', 'bun.lock'))).toEqual([]);
  });
});

describe('overlay/matrix parity (design.di-architecture §5)', () => {
  test('the run root has three overlays, each exercised by the composition matrix', () => {
    // The run root's conditional overlays: the MCP tool cluster + listener
    // (plan.mcpEnabled), the PTY ring + context monitor (plan.useTerminal), and the
    // OOBE handlers (oobe present). Their conditions are correlated — useTerminal ⊆
    // mcpEnabled, oobe needs mcpEnabled, win32 ⇒ !mcpEnabled — so the reachable set is
    // the four enumerated variants (§5), not the 2**3 power set.
    const register = readFileSync(join(cliRoot, 'src', 'launch', 'register.ts'), 'utf8');
    const overlayCount = (
      register.match(/if \((?:plan\.mcpEnabled|plan\.useTerminal|oobe !== undefined)\)/g) ?? []
    ).length;
    expect(overlayCount).toBe(3);

    // The matrix builds one real run container per variant via registerRunServices.
    const matrix = readFileSync(join(cliRoot, 'test', 'composition', 'run.ctest.ts'), 'utf8');
    const variantCount = (matrix.match(/registerRunServices\(\s*m,/g) ?? []).length;
    expect(variantCount).toBe(4);
  });
});
