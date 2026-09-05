/**
 * Guards that every vendored `@rhombus-std` package ships the built artifact its exports map
 * points at, plus the sibling `.d.ts` the ttsc checker resolves types through.
 *
 * The regression: an unanchored "dist" ignore in packages/cli/.gitignore once matched the
 * vendored dist trees too, so a fresh checkout (CI) had the sources but not the built
 * bundles. The ttsc lowering checker then failed with "Cannot find module '@rhombus-std/di'"
 * for every importer — invisible locally, where the uncommitted dist happened to exist. This
 * asserts the artifacts are present so a cold checkout fails here, in the cheap unit tier,
 * rather than only in a multi-minute CI build.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(__dirname, '..', '..');
const VENDOR = join(CLI_ROOT, 'vendor');

interface VendoredArtifact {
  name: string;
  mainPath: string;
  typesPath: string;
}

/** Each vendored package that declares a main entry, paired with that file and its .d.ts sibling. */
function vendoredArtifacts(): VendoredArtifact[] {
  const artifacts: VendoredArtifact[] = [];
  for (const name of readdirSync(VENDOR)) {
    const manifestPath = join(VENDOR, name, 'package.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    const main = JSON.parse(readFileSync(manifestPath, 'utf8')).main as string | undefined;
    if (main === undefined) {
      continue; // e.g. transforms ships ttsc.mjs, not a dist bundle
    }
    const mainPath = join(VENDOR, name, main);
    artifacts.push({ name, mainPath, typesPath: mainPath.replace(/\.js$/, '.d.ts') });
  }
  return artifacts;
}

describe('vendored @rhombus-std artifacts', () => {
  const artifacts = vendoredArtifacts();

  test('there are vendored packages with a built main', () => {
    expect(artifacts.length).toBeGreaterThan(0);
  });

  test.each(artifacts)('$name ships its built bundle and types', ({ mainPath, typesPath }) => {
    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(typesPath)).toBe(true);
  });
});
