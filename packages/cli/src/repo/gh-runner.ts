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
import { NOT_FOUND_SIGNATURES } from './clone-failure.ts';

/**
 * Lines matching GitHub's "repo not found" signature are withheld from the
 * LIVE stderr echo so the benign bootstrap-a-new-repo path doesn't lead with
 * a scary GraphQL error. They're still captured for failure classification.
 *
 * Uses the SAME signatures as clone-failure.ts's classifier so the two stay
 * in sync.
 */
export function isNotFoundNoiseLine(line: string): boolean {
  return NOT_FOUND_SIGNATURES.some((re) => re.test(line));
}

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
      // Pipe (not inherit) so we can both show gh's output live AND keep a
      // copy to classify the failure (repo-not-found → offer bootstrap).
      stderr: 'pipe',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to spawn gh: ${msg}`, stderr: '' };
  }
  // Tee stderr: echo gh's progress/errors live so the user still sees them,
  // while accumulating the full text for failure classification. The tee is
  // line-buffered so we can WITHHOLD repo-not-found lines from the LIVE echo
  // (the benign bootstrap path shouldn't lead with a scary GraphQL error) —
  // those lines still land in `captured` for the classifier downstream.
  let captured = '';
  let pending = '';
  const decoder = new TextDecoder();
  const reader = proc.stderr.getReader();
  const echoLine = (line: string): void => {
    if (!isNotFoundNoiseLine(line)) process.stderr.write(line);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const text = decoder.decode(value, { stream: true });
    captured += text;
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf('\n')) !== -1) {
      echoLine(pending.slice(0, nl + 1));
      pending = pending.slice(nl + 1);
    }
  }
  captured += decoder.decode();
  // Flush any trailing partial line (also filtered).
  if (pending.length > 0) echoLine(pending);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return { ok: false, error: `gh exited ${exitCode}`, stderr: captured };
  }
  return { ok: true };
}

/**
 * `gh repo create <owner>/<name> --private` — creates an EMPTY private
 * remote (no --source/--push, since the freshly-bootstrapped local repo has
 * no commits yet and origin already points at the eventual URL).
 */
export async function runGhRepoCreate(
  owner: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['gh', 'repo', 'create', `${owner}/${name}`, '--private'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to spawn gh: ${msg}` };
  }
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return { ok: false, error: stderr.trim() || `gh exited ${exitCode}` };
  }
  return { ok: true };
}
