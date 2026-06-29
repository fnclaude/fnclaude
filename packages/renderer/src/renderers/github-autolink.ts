/**
 * Tokenize GitHub autolink forms in a plain-text run, mirroring GitHub's
 * documented autolink behavior. Operates on TEXT only — callers must never
 * feed it codespan / code-block content, since GitHub doesn't autolink inside
 * code.
 *
 * Recognized forms:
 *   - `@username`              → https://github.com/username
 *   - `@org/team`             → https://github.com/orgs/<org>/teams/<team>
 *   - `#123` / `GH-123`        → <repo>/issues/<n>     (needs repo context)
 *   - `owner/repo#123`         → owner/repo/issues/<n> (explicit; no context)
 *   - bare 7–40 lc hex SHA     → <repo>/commit/<sha>   (needs repo context)
 *   - `owner/repo@<sha>`       → owner/repo/commit/<sha> (explicit; no context)
 *
 * Username rules: 1–39 chars, alphanumeric or single non-leading/-trailing,
 * non-consecutive hyphens — enforced by `USER` below. The `@` must sit at a
 * word boundary so emails (`foo@bar.com`) never match. Forms that need repo
 * context but have none are emitted as plain text (left un-linked).
 *
 * Output is a flat list of segments covering the whole input; a segment with a
 * `url` is a link (its `text` is the display form GitHub shows — e.g. a SHA is
 * shortened to 7 chars), and a segment without one is literal text.
 */

export interface GithubRepo {
  owner: string;
  name: string;
}

export interface AutolinkSegment {
  /** Display text (link label or literal run). */
  text: string;
  /** Target URL when this segment is a link; absent for literal text. */
  url?: string;
}

// 1–39 chars: an alnum lead, then up to 38 more alnum-or-single-hyphen chars
// where every hyphen must be followed by an alnum (no trailing/consecutive).
const USER = "[A-Za-z\\d](?:[A-Za-z\\d]|-(?=[A-Za-z\\d])){0,38}";
const OWNER = "[A-Za-z\\d][A-Za-z\\d-]*";
const REPO = "[A-Za-z\\d._-]+";
const TEAM = "[A-Za-z\\d][A-Za-z\\d_-]*";
const SHA = "[0-9a-f]{7,40}";

// Order matters: alternation is leftmost-first at each position, so the
// explicit cross-repo forms precede the bare `@`/`#`/SHA forms, and the
// `@org/team` form precedes `@user`.
const RE = new RegExp(
  [
    `(?<![\\w/.])(?<ci_owner>${OWNER})\\/(?<ci_repo>${REPO})#(?<ci_num>\\d+)\\b`,
    `(?<![\\w/.])(?<cc_owner>${OWNER})\\/(?<cc_repo>${REPO})@(?<cc_sha>${SHA})\\b`,
    `(?<!\\w)@(?<t_org>${USER})\\/(?<t_team>${TEAM})`,
    `(?<!\\w)@(?<user>${USER})\\b`,
    "(?<!\\w)[Gg][Hh]-(?<gh_num>\\d+)\\b",
    "(?<!\\w)#(?<i_num>\\d+)\\b",
    `(?<![\\w])(?<sha>${SHA})(?![\\w])`,
  ].join("|"),
  "g",
);

interface Resolved {
  url: string;
  display: string;
}

function resolveMatch(m: RegExpExecArray, repo?: GithubRepo): Resolved | null {
  const g = m.groups;
  if (g === undefined) return null;
  if (g.ci_num !== undefined) {
    return {
      url: `https://github.com/${g.ci_owner}/${g.ci_repo}/issues/${g.ci_num}`,
      display: `${g.ci_owner}/${g.ci_repo}#${g.ci_num}`,
    };
  }
  if (g.cc_sha !== undefined) {
    return {
      url: `https://github.com/${g.cc_owner}/${g.cc_repo}/commit/${g.cc_sha}`,
      display: `${g.cc_owner}/${g.cc_repo}@${g.cc_sha.slice(0, 7)}`,
    };
  }
  if (g.t_team !== undefined) {
    return {
      url: `https://github.com/orgs/${g.t_org}/teams/${g.t_team}`,
      display: `@${g.t_org}/${g.t_team}`,
    };
  }
  if (g.user !== undefined) {
    return { url: `https://github.com/${g.user}`, display: `@${g.user}` };
  }
  if (g.gh_num !== undefined) {
    if (repo === undefined) return null;
    return {
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${g.gh_num}`,
      display: m[0],
    };
  }
  if (g.i_num !== undefined) {
    if (repo === undefined) return null;
    return {
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${g.i_num}`,
      display: `#${g.i_num}`,
    };
  }
  if (g.sha !== undefined) {
    if (repo === undefined) return null;
    return {
      url: `https://github.com/${repo.owner}/${repo.name}/commit/${g.sha}`,
      display: g.sha.slice(0, 7),
    };
  }
  return null;
}

/** Split `text` into literal + link segments per GitHub's autolink rules. */
export function tokenizeGithubAutolinks(text: string, repo?: GithubRepo): AutolinkSegment[] {
  const segments: AutolinkSegment[] = [];
  let lastIndex = 0;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null = RE.exec(text);
  while (m !== null) {
    const start = m.index;
    const matched = m[0];
    if (matched === "") {
      // Defensive: a zero-width match would loop forever.
      RE.lastIndex += 1;
      m = RE.exec(text);
      continue;
    }
    if (start > lastIndex) segments.push({ text: text.slice(lastIndex, start) });
    const res = resolveMatch(m, repo);
    if (res !== null) segments.push({ text: res.display, url: res.url });
    else segments.push({ text: matched });
    lastIndex = start + matched.length;
    m = RE.exec(text);
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  if (segments.length === 0) segments.push({ text });
  return segments;
}
