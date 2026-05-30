/**
 * Pure inverse of `buildCloneUrl` (clone.ts): given a clone URL of the
 * form `https://<host>/<owner>/<name>.git`, recover host/owner/name.
 *
 * Used on the bootstrap path to derive the prompt text and the
 * `gh repo create <owner>/<name>` argument without reaching back into the
 * RepoRef. `buildCloneUrl` always emits the canonical `.git`-suffixed
 * HTTPS form, so this parser is the matching reader.
 */

export type ParsedCloneUrl = { host: string; owner: string; name: string };

export function parseCloneUrl(url: string): ParsedCloneUrl | null {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (m === null) return null;
  const [, host, owner, name] = m;
  if (host === undefined || owner === undefined || name === undefined) return null;
  if (host === '' || owner === '' || name === '') return null;
  return { host, owner, name };
}
