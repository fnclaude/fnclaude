/**
 * Thin Bun.spawn wrappers around the `gh` CLI calls we need at the
 * resolver boundary:
 *
 *   - `gh api <path> --jq <jq>` — used for owner lookups.
 *   - `gh repo clone <url> <dest>` — used to materialize needs-clone refs.
 *
 * These spawn real processes; orchestration logic stays in
 * `owner-lookup.ts` / `clone-exec.ts` and is unit-testable via the
 * injected `GhApiCall` / `GhCloneCall` callbacks. Production wiring in
 * `main.ts` plugs these runners into those orchestrators.
 *
 * On any spawn failure (gh missing, auth missing, network), we surface a
 * structured error rather than throwing — the caller decides whether to
 * keep walking the candidate list or fail the whole resolution.
 */

import type { GhApiResult } from './owner-lookup.ts';
import type { GhCloneResult } from './clone-exec.ts';

const GH_API_PATH_JQ: Record<string, string> = {
  user: '.login',
  '/user/orgs': '.[].login',
};

export async function runGhApi(path: string): Promise<GhApiResult> {
  const jq = GH_API_PATH_JQ[path];
  const args = jq !== undefined ? ['api', path, '--jq', jq] : ['api', path];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['gh', ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: -1, error: `failed to spawn gh: ${msg}` };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return { ok: false, status: exitCode, error: stderr.trim() };
  }
  return { ok: true, body: stdout };
}

export async function runGhClone(url: string, destination: string): Promise<GhCloneResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['gh', 'repo', 'clone', url, destination], {
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to spawn gh: ${msg}` };
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return { ok: false, error: `gh exited ${exitCode}` };
  }
  return { ok: true };
}
