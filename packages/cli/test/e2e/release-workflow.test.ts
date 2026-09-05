/**
 * The publish path has three facts that are invisible to every other test and
 * expensive to get wrong, because the failure only shows up at publish time —
 * on `main`, after a release PR has already merged.
 *
 *   1. **The filename.** npm's trusted publisher is registered against
 *      `.github/workflows/release.yml` plus the `production` environment. A
 *      rename, or a publish step that drifts back into `ci.yml`, means the
 *      OIDC handshake authenticates nothing and the publish fails.
 *   2. **The environment.** The OIDC token only carries `production` if the
 *      job declares it. Dropping the line is a one-character change with the
 *      same failure mode as (1).
 *   3. **`id-token: write`.** Without it there is no OIDC token at all, and
 *      no `--provenance` attestation either.
 *
 * These are string assertions against the workflow YAML rather than a parse,
 * deliberately: the point is the literal text a maintainer would edit. The
 * ci.yml assertions strip comment lines first, so the comment there explaining
 * why publishing moved doesn't read as a publish step.
 *
 * Lives under packages/cli's test tree, not the repo root, because CI runs
 * tests through `moon run :test` — which only visits registered projects, and
 * a root-level `test/` directory is not one.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const RELEASE = resolve(ROOT, '.github', 'workflows', 'release.yml');
const CI = resolve(ROOT, '.github', 'workflows', 'ci.yml');

describe('the publish workflow', () => {
  test('is named release.yml — the trusted publisher is registered against it', () => {
    expect(existsSync(RELEASE)).toBe(true);
  });

  test('runs on push to main', () => {
    const body = readFileSync(RELEASE, 'utf8');
    expect(body).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
  });

  test('binds the production environment', () => {
    expect(readFileSync(RELEASE, 'utf8')).toContain('environment: production');
  });

  test('requests id-token: write for the OIDC handshake and provenance', () => {
    expect(readFileSync(RELEASE, 'utf8')).toContain('id-token: write');
  });

  test('publishes with provenance', () => {
    expect(readFileSync(RELEASE, 'utf8')).toContain('npm publish --provenance');
  });

  test('runs release-please, which is what produces the versions it publishes', () => {
    expect(readFileSync(RELEASE, 'utf8')).toContain('googleapis/release-please-action');
  });
});

describe('ci.yml', () => {
  const raw = readFileSync(CI, 'utf8');
  /** The workflow's actual directives, with comment-only lines removed. */
  const steps = raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  test('does NOT publish — a publish from here cannot authenticate', () => {
    expect(steps).not.toContain('npm publish');
  });

  test('does not run release-please either; that moved with the publish steps', () => {
    expect(steps).not.toContain('googleapis/release-please-action');
  });

  test('still carries the verify job that branch protection gates on', () => {
    expect(steps).toMatch(/^\s{2}verify:/m);
  });
});
