/**
 * Cross-org bare-name owner resolution (design.md §17).
 *
 * Given a bare repo name with no owner, ask the gh CLI:
 *   1. `gh api user` → authenticated user's login
 *   2. `gh api /user/orgs` → comma/newline-separated org logins
 *   3. For each candidate (user first, then orgs in API order),
 *      `gh api repos/<owner>/<name>` → 200 means that owner has it.
 * All candidates are checked; exactly one match wins. If more than one
 * owner has a repo by this name, the result is 'ambiguous' (listing every
 * matching owner) so the caller can ask the user to disambiguate rather
 * than silently picking the first.
 *
 * The gh subprocess is injected as `ghApi` so unit tests can stub it
 * without spawning anything. The real spawner lives in `gh-runner.ts`.
 *
 * Failures:
 *   - `gh api user` errors AND we have no other candidates → 'gh-failed'.
 *   - `gh api /user/orgs` errors → continue with user-only candidates.
 *   - No candidate's repo exists → 'not-found'.
 *   - More than one candidate has the repo → 'ambiguous'.
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
  | { ok: false; reason: 'gh-failed' | 'not-found' }
  | { ok: false; reason: 'ambiguous'; owners: string[] };

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

  const matches: string[] = [];
  for (const owner of candidates) {
    const r = await args.ghApi(`repos/${owner}/${args.name}`);
    if (r.ok) matches.push(owner);
  }

  if (matches.length === 0) return { ok: false, reason: 'not-found' };
  if (matches.length === 1) return { ok: true, owner: matches[0]! };
  return { ok: false, reason: 'ambiguous', owners: matches };
}

/**
 * Map a failed owner lookup to the stderr message shown to the user.
 * Pure so the call-site surfacing (main.ts `needs-owner-lookup` branch)
 * is testable without spawning gh. The `ambiguous` case lists every
 * matching owner and tells the user how to disambiguate.
 */
export function formatOwnerLookupError(
  result: Extract<FindOwnerResult, { ok: false }>,
  name: string,
): string {
  switch (result.reason) {
    case 'gh-failed':
      return `fnclaude: bare name "${name}" — gh CLI lookup failed (not authenticated? no network?). Try \`gh auth login\` or pass owner explicitly (\`${name}@<owner>\` or \`<owner>/${name}\`).`;
    case 'ambiguous': {
      const owners = result.owners.map((o) => `${o}/${name}`).join(', ');
      return `fnclaude: ambiguous bare name "${name}" — found under multiple owners: ${owners}. Disambiguate by passing the owner explicitly (\`${name}@<owner>\` or \`<owner>/${name}\`).`;
    }
    case 'not-found':
      return `fnclaude: no repo named "${name}" found under your gh user or any of your orgs.`;
  }
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
