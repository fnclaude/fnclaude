/**
 * Parse user-typed repo references into structured RepoRef values.
 *
 * Ports Go canonical `parseRepoRef` (src/repo_ref.go) and friends:
 * everything is pure-string transformation. No filesystem, no network,
 * no gh CLI. The existence-on-GitHub check and the on-disk clone
 * happen later in the orchestrator (§3.4 follow-up).
 *
 * Supported input forms (with optional "+workspace" suffix on any of them):
 *
 *   <name>                                    → ref{name}
 *   <name>@<owner>                            → ref{name, owner}
 *   <owner>/<name>                            → ref{owner, name}
 *   gh:<owner>/<name>                         → ref{owner, name, host="github.com"}
 *   https://<host>/<owner>/<name>[.git]       → ref{host, owner, name}
 *   http://...                                → same
 *   git@<host>:<owner>/<name>[.git]           → ref{host, owner, name}
 *   ssh://[user@]<host>/<owner>/<name>[.git]  → ref{host, owner, name}
 *
 * Inputs starting with `/`, `~/`, or bare `~` are NOT repo refs — the
 * caller short-circuits before this function.
 */

export interface RepoRef {
  host: string;
  owner: string;
  name: string;
  workspace: string;
  original: string;
}

export interface ParseRepoRefOk {
  ok: true;
  ref: RepoRef;
}

export interface ParseRepoRefErr {
  ok: false;
  error: string;
}

export type ParseRepoRefResult = ParseRepoRefOk | ParseRepoRefErr;

const URL_RE = /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?)([^:/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SCP_RE = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

function makeRef(original: string): RepoRef {
  return { host: '', owner: '', name: '', workspace: '', original };
}

export function parseRepoRef(input: string): ParseRepoRefResult {
  if (input === '') {
    return { ok: false, error: 'empty repo reference' };
  }
  const ref = makeRef(input);

  // Split off workspace suffix first.
  let body = input;
  const plusIdx = body.indexOf('+');
  if (plusIdx >= 0) {
    ref.workspace = body.slice(plusIdx + 1);
    body = body.slice(0, plusIdx);
    if (ref.workspace === '') {
      return { ok: false, error: `empty workspace after \`+\` in ${JSON.stringify(input)}` };
    }
  }

  // URL forms.
  const urlMatch = URL_RE.exec(body);
  if (urlMatch) {
    ref.host = urlMatch[1]!;
    ref.owner = urlMatch[2]!;
    ref.name = urlMatch[3]!;
    return { ok: true, ref };
  }
  const scpMatch = SCP_RE.exec(body);
  if (scpMatch) {
    ref.host = scpMatch[1]!;
    ref.owner = scpMatch[2]!;
    ref.name = scpMatch[3]!;
    return { ok: true, ref };
  }

  // gh:owner/name shorthand.
  if (body.startsWith('gh:')) {
    const rest = body.slice(3);
    const slashIdx = rest.indexOf('/');
    if (slashIdx > 0 && slashIdx < rest.length - 1) {
      const owner = rest.slice(0, slashIdx);
      const name = rest.slice(slashIdx + 1);
      if (/[/@:]/.test(owner) || /[/@:]/.test(name)) {
        return { ok: false, error: `invalid gh: form: ${JSON.stringify(input)}` };
      }
      ref.host = 'github.com';
      ref.owner = owner;
      ref.name = name;
      return { ok: true, ref };
    }
    return { ok: false, error: `gh: form requires owner/name, got ${JSON.stringify(input)}` };
  }

  // owner/name (single slash, no scheme).
  const slashIdx = body.indexOf('/');
  if (slashIdx > 0) {
    if (body.indexOf('/', slashIdx + 1) >= 0) {
      return { ok: false, error: `ambiguous form ${JSON.stringify(input)} (multiple slashes)` };
    }
    const owner = body.slice(0, slashIdx);
    const name = body.slice(slashIdx + 1);
    if (/[@:]/.test(owner) || /[@:]/.test(name) || owner === '' || name === '') {
      return { ok: false, error: `invalid owner/name form: ${JSON.stringify(input)}` };
    }
    ref.owner = owner;
    ref.name = name;
    return { ok: true, ref };
  }

  // name@owner (Tom local-convention).
  const atIdx = body.indexOf('@');
  if (atIdx > 0) {
    const name = body.slice(0, atIdx);
    const owner = body.slice(atIdx + 1);
    if (/[@:/]/.test(owner) || /[@:/]/.test(name) || owner === '' || name === '') {
      return { ok: false, error: `invalid name@owner form: ${JSON.stringify(input)}` };
    }
    ref.name = name;
    ref.owner = owner;
    return { ok: true, ref };
  }

  // Bare name — but reject if it contains URL-like special chars (defense
  // in depth, the above branches should have caught these).
  if (/[/@:]/.test(body)) {
    return { ok: false, error: `unparseable repo reference: ${JSON.stringify(input)}` };
  }
  ref.name = body;
  return { ok: true, ref };
}

export function hasResolvedOwner(ref: RepoRef): boolean {
  return ref.owner !== '';
}

export function effectiveHost(ref: RepoRef): string {
  return ref.host !== '' ? ref.host : 'github.com';
}
