// The two invariants the vendored `@rhombus-std` install must hold, checked as text
// against the installed `node_modules` and the committed lockfile (design.di-architecture
// §8 step 5). Both protect the `Type` intern table: a second physical copy of any package
// forks identity silently (`primitives` has no self-guard, §7), and an absolute path in the
// lockfile makes the install machine-specific and non-portable.
//
// This imports nothing from `@rhombus-std`, so the unit-tier guard that runs it stays
// transform-free (doctrine 4). Both functions return the offenders rather than throwing, so
// a caller phrases its own assertion.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** A vendored package that resolved to more than its single physical copy under `vendor/`. */
export interface ForkedStdCopy {
  /** The `vendor/` directory name (equals the package's last name segment). */
  readonly name: string;
  /** Every distinct physical directory an installed `@rhombus-std/<name>` resolved to. */
  readonly realpaths: string[];
}

/** The vendored package names, read from the committed `vendor/` tree. */
function listVendoredNames(cliRoot: string): string[] {
  return readdirSync(join(cliRoot, 'vendor'));
}

/** Every `node_modules/@rhombus-std` directory an installed copy of a vendored package can sit in. */
function stdContainers(cliRoot: string, names: Iterable<string>): string[] {
  const containers = [
    join(cliRoot, '..', '..', 'node_modules', '@rhombus-std'),
    join(cliRoot, 'node_modules', '@rhombus-std'),
  ];
  for (const name of names) {
    containers.push(join(cliRoot, 'vendor', name, 'node_modules', '@rhombus-std'));
  }
  return containers;
}

/**
 * The vendored packages whose installed copies fork — resolving to any physical directory
 * other than their single `vendor/<name>`.
 *
 * A healthy hoisted install symlinks every `@rhombus-std/<name>` occurrence (the CLI's own
 * and each vendored package's transitive siblings) back to `vendor/<name>`, so every
 * occurrence shares one realpath; a version-range edit or a std bump that breaks the dedup
 * materializes a second real directory, which shows up here.
 */
export function findForkedStdCopies(cliRoot: string): ForkedStdCopy[] {
  const names = listVendoredNames(cliRoot);
  const containers = stdContainers(cliRoot, names);
  const forked: ForkedStdCopy[] = [];
  for (const name of names) {
    const canonical = realpathSync(join(cliRoot, 'vendor', name));
    const seen = new Set<string>();
    for (const container of containers) {
      const occurrence = join(container, name);
      if (existsSync(occurrence)) {
        seen.add(realpathSync(occurrence));
      }
    }
    seen.delete(canonical);
    if (seen.size) {
      forked.push({ name, realpaths: [canonical, ...seen] });
    }
  }
  return forked;
}

/** Whether a lockfile specifier names an absolute filesystem location rather than a portable one. */
function isAbsoluteSpecifier(value: string): boolean {
  if (value.startsWith('/')) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  if (value.startsWith('file:')) {
    const path = value.slice('file:'.length);
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  }
  return false;
}

/** The absolute-path specifiers in a bun lockfile — empty when the lockfile is portable. */
export function findLockfileAbsolutePaths(lockfilePath: string): string[] {
  const text = readFileSync(lockfilePath, 'utf8');
  const strings = Iterator.from(text.matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((match) => match[1]!);
  return [...new Set(strings.filter(isAbsoluteSpecifier))];
}
