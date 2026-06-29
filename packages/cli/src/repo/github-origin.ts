/**
 * Resolve the launch cwd's `origin` remote to a GitHub owner/repo so the
 * renderer can autolink `@mentions`, `#refs`, and commit SHAs the way GitHub
 * does. ONLY github.com remotes resolve — any other host (or no origin)
 * yields `null`, and refs stay plain text.
 *
 * Two URL shapes are recognized, matching what `git remote get-url origin`
 * emits for a GitHub clone:
 *   - SCP/SSH:  git@github.com:owner/repo(.git)
 *   - HTTPS:    https://github.com/owner/repo(.git)
 * The optional `ssh://git@github.com/owner/repo(.git)` form is also accepted.
 */

export interface GithubRepo {
  owner: string;
  name: string;
}

const SCP_RE = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/;
const HTTPS_RE = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/;
const SSH_RE = /^ssh:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/;

/**
 * Pure parse: a clone URL → `{ owner, name }`, or `null` when it is not a
 * github.com remote.
 */
export function parseGithubOrigin(url: string): GithubRepo | null {
  const trimmed = url.trim();
  for (const re of [SCP_RE, HTTPS_RE, SSH_RE]) {
    const m = re.exec(trimmed);
    if (m === null) continue;
    const owner = m[1];
    const name = m[2];
    if (owner === undefined || name === undefined || owner === '' || name === '') {
      return null;
    }
    return { owner, name };
  }
  return null;
}

/** Reads `origin`'s URL for a working dir, or `null` if it can't be read. */
export type OriginUrlReader = (cwd: string) => Promise<string | null>;

/**
 * Default reader: `git -C <cwd> remote get-url origin`. A missing origin,
 * non-git dir, or absent `git` all degrade to `null` (no autolinking).
 */
const defaultReader: OriginUrlReader = async (cwd) => {
  try {
    const proc = Bun.spawn(['git', '-C', cwd, 'remote', 'get-url', 'origin'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
};

/**
 * Resolve the GitHub owner/repo backing `cwd`'s origin remote, or `null` for
 * a non-github / non-git cwd. The reader is injectable for tests.
 */
export async function resolveGithubRepo(
  cwd: string,
  read: OriginUrlReader = defaultReader,
): Promise<GithubRepo | null> {
  const url = await read(cwd);
  if (url === null) return null;
  return parseGithubOrigin(url);
}
