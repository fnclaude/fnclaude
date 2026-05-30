/**
 * Thin Bun.spawn wrapper around the local `git` calls the bootstrap path
 * needs: initialize a fresh repo in <dir> and point its origin at <url>.
 *
 * Like gh-runner.ts, this spawns a real process; the orchestration
 * (bootstrap.ts) injects it as `gitInit` and is unit-testable with a fake.
 */

async function runGit(
  dir: string,
  args: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['git', '-C', dir, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to spawn git: ${msg}` };
  }
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return { ok: false, error: stderr.trim() || `git exited ${exitCode}` };
  }
  return { ok: true };
}

export async function runGitInit(
  dir: string,
  url: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const init = await runGit(dir, ['init']);
  if (!init.ok) return init;
  return runGit(dir, ['remote', 'add', 'origin', url]);
}
