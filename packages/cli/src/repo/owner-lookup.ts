/**
 * Cross-org bare-name owner resolution (design.md §17).
 *
 * Given a bare repo name with no owner, ask the gh CLI:
 *   1. `gh api user` → authenticated user's login
 *   2. `gh api /user/orgs` → comma/newline-separated org logins
 *   3. For each candidate (user first, then orgs in API order),
 *      `gh api repos/<owner>/<name>` → 200 means we found it.
 * First match wins.
 *
 * The gh subprocess is injected as `ghApi` so unit tests can stub it
 * without spawning anything. The real spawner lives in `gh-runner.ts`.
 *
 * Failures:
 *   - `gh api user` errors AND we have no other candidates → 'gh-failed'.
 *   - `gh api /user/orgs` errors → continue with user-only candidates.
 *   - No candidate's repo exists → 'not-found'.
 */

export type GhApiResult =
  | { ok: true; body: string }
  | { ok: false; status: number; error: string };

export type GhApiCall = (path: string) => Promise<GhApiResult>;

export interface FindOwnerArgs {
  name: string;
  ghApi: GhApiCall;
}

export type FindOwnerResult =
  | { ok: true; owner: string }
  | { ok: false; reason: 'gh-failed' | 'not-found' };

export async function findOwner(args: FindOwnerArgs): Promise<FindOwnerResult> {
  const candidates: string[] = [];

  const userR = await args.ghApi('user');
  if (userR.ok) {
    const login = parseLoginBody(userR.body);
    if (login !== '') candidates.push(login);
  }

  const orgsR = await args.ghApi('/user/orgs');
  if (orgsR.ok) {
    candidates.push(...parseOrgsBody(orgsR.body));
  }

  if (candidates.length === 0) return { ok: false, reason: 'gh-failed' };

  for (const owner of candidates) {
    const r = await args.ghApi(`repos/${owner}/${args.name}`);
    if (r.ok) return { ok: true, owner };
  }

  return { ok: false, reason: 'not-found' };
}

function parseLoginBody(body: string): string {
  // `gh api user --jq .login` returns the login as a single line (with
  // trailing newline). We don't pass --jq here, but the gh-runner uses it,
  // so the body is the bare login. Be defensive about whitespace.
  return body.trim();
}

function parseOrgsBody(body: string): string[] {
  return body
    .split('\n')
    .map((s) => s.replace(/\r$/, '').trim())
    .filter((s) => s !== '');
}
