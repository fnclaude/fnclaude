/**
 * Regression: the prompt fragments must ship in the published npm tarball.
 *
 * `resolvePromptsDir` (src/prompts/dir.ts) looks for fragments at
 * <exe-dir>/../prompts in the npm layout. Those fragments live in the repo
 * at packages/cli/prompts/, but they only reach consumers if "prompts" is in
 * package.json's `files` allowlist — otherwise npm strips the directory and a
 * published `fnc` degrades to an empty PromptSet (the noop-router system
 * prompt is silently never injected; specs.md §12.1).
 *
 * The bug only manifests through npm's packing, so the faithful repro asks
 * npm itself what it would publish, via `npm pack --dry-run --json`, and
 * asserts the fragments are present.
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const SKIP_WINDOWS = process.platform === 'win32';
const CLI_ROOT = resolve(__dirname, '..', '..');

interface PackEntry {
  path: string;
}

async function publishedFiles(): Promise<string[]> {
  const proc = Bun.spawn(['npm', 'pack', '--dry-run', '--json'], {
    cwd: CLI_ROOT,
    env: { ...process.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as Array<{ files: PackEntry[] }>;
  return parsed[0].files.map((f) => f.path);
}

describe.skipIf(SKIP_WINDOWS)('published tarball ships prompt fragments', () => {
  test('the prompts directory is included in `npm pack`', async () => {
    const files = await publishedFiles();
    const promptFiles = files.filter((p) => p.startsWith('prompts/'));
    expect(promptFiles).not.toEqual([]);
  });

  test('the noop-router fragment specifically ships', async () => {
    const files = await publishedFiles();
    expect(files).toContain('prompts/noop-router.md');
  });
});
