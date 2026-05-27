// Parse user-typed repo references into structured RepoRef values.
// Ported from src/repo_ref.go.
//
// Supported input forms (with optional "+workspace" suffix on any of them):
//
//   <name>                                    → { name }
//   <name>@<owner>                            → { name, owner }
//   <owner>/<name>                            → { owner, name }
//   gh:<owner>/<name>                         → { owner, name, host: "github.com" }
//   https://<host>/<owner>/<name>[.git]       → { host, owner, name }
//   git@<host>:<owner>/<name>[.git]           → { host, owner, name }
//   ssh://[user@]<host>/<owner>/<name>[.git]  → { host, owner, name }
//
// Inputs starting with `/` or `~/` are NOT repo refs (they're paths); the
// caller short-circuits before this function.
//
// Returns undefined when the input is empty or otherwise unparseable. The
// Go version returns (RepoRef, error); the TS port branches on undefined
// instead, which matches the rest of the CLI's "no exceptions for
// user-input validation" style.

export interface RepoRef {
  /**
   * Host is the resolved hostname (e.g. "github.com"). Empty when the user
   * didn't include one (bare name, owner/name, name@owner). Callers default
   * to "github.com" when empty (see `effectiveHost`).
   */
  readonly host: string;

  /**
   * Owner is the repo's owner/org. Empty when the user typed only a bare
   * name; the resolver fills it by searching the user's orgs.
   */
  readonly owner: string;

  /** Repo name. Always populated after a successful parse. */
  readonly name: string;

  /**
   * Workspace is the "+workspace" suffix when present. Maps to claude's
   * --worktree flag and the plugin's worktreeTemplate.
   */
  readonly workspace: string;

  /** Original raw input, retained for error messages. */
  readonly original: string;

  /** True when owner was supplied explicitly (no org search needed). */
  readonly hasResolvedOwner: boolean;

  /** Host if set, else "github.com". */
  readonly effectiveHost: string;
}

const URL_RE =
  /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?)([^:/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SCP_RE = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export function parseRepoRef(input: string): RepoRef | undefined {
  if (input === '') return undefined;

  // Split off workspace suffix first.
  let body = input;
  let workspace = '';
  const plusIdx = body.indexOf('+');
  if (plusIdx >= 0) {
    workspace = body.slice(plusIdx + 1);
    body = body.slice(0, plusIdx);
    if (workspace === '') return undefined; // trailing `+` with no workspace
  }

  // URL forms.
  // RegExp.exec returns null for "no match" — third-party API shape, kept
  // verbatim rather than coerced.
  const urlMatch = URL_RE.exec(body);
  if (urlMatch !== null) {
    return finalise({
      host: urlMatch[1]!,
      owner: urlMatch[2]!,
      name: urlMatch[3]!,
      workspace,
      original: input,
    });
  }
  const scpMatch = SCP_RE.exec(body);
  if (scpMatch !== null) {
    return finalise({
      host: scpMatch[1]!,
      owner: scpMatch[2]!,
      name: scpMatch[3]!,
      workspace,
      original: input,
    });
  }

  // gh:owner/name shorthand.
  if (body.startsWith('gh:')) {
    const rest = body.slice(3);
    const slashIdx = rest.indexOf('/');
    if (slashIdx > 0 && slashIdx < rest.length - 1) {
      const owner = rest.slice(0, slashIdx);
      const name = rest.slice(slashIdx + 1);
      if (containsAny(owner, '/@:') || containsAny(name, '/@:')) return undefined;
      return finalise({ host: 'github.com', owner, name, workspace, original: input });
    }
    return undefined;
  }

  // owner/name (single slash, no scheme).
  const slashIdx = body.indexOf('/');
  if (slashIdx > 0) {
    // Reject multiple slashes (ambiguous).
    if (body.indexOf('/', slashIdx + 1) >= 0) return undefined;
    const owner = body.slice(0, slashIdx);
    const name = body.slice(slashIdx + 1);
    if (containsAny(owner, '@:') || containsAny(name, '@:')) return undefined;
    if (owner === '' || name === '') return undefined;
    return finalise({ host: '', owner, name, workspace, original: input });
  }

  // name@owner.
  const atIdx = body.indexOf('@');
  if (atIdx > 0) {
    const name = body.slice(0, atIdx);
    const owner = body.slice(atIdx + 1);
    if (containsAny(owner, '@:/') || containsAny(name, '@:/')) return undefined;
    if (owner === '' || name === '') return undefined;
    return finalise({ host: '', owner, name, workspace, original: input });
  }

  // Bare name. Defense-in-depth: reject anything that looks like a special
  // form we already had a chance to match.
  if (containsAny(body, '/@:')) return undefined;
  return finalise({ host: '', owner: '', name: body, workspace, original: input });
}

interface RepoRefCore {
  host: string;
  owner: string;
  name: string;
  workspace: string;
  original: string;
}

function finalise(core: RepoRefCore): RepoRef {
  return {
    ...core,
    hasResolvedOwner: core.owner !== '',
    effectiveHost: core.host === '' ? 'github.com' : core.host,
  };
}

function containsAny(s: string, chars: string): boolean {
  for (const c of chars) {
    if (s.includes(c)) return true;
  }
  return false;
}
