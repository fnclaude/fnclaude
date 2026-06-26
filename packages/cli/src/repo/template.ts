/**
 * Template substitution for cloneTemplate values (and any future templates
 * fnclaude reads from repoSettings). Placeholder vocabulary aligns with
 * the claude-code-worktree-paths plugin so users learn one templating
 * language across both tools.
 *
 * Ports Go canonical's template.go. fnclaude only uses cloneTemplate,
 * which is computed BEFORE a clone exists — placeholders like {repo-dir},
 * {clone-path}, {input}, {cwd} aren't meaningful here and are rejected
 * via the unknown-placeholder error.
 *
 * Lazy resolvers: {host-short} defers the LUT lookup error until the
 * placeholder is actually referenced. Templates that don't use it don't
 * need the LUT populated.
 */

export interface TemplateResolveOk {
  ok: true;
  value: string;
}

export interface TemplateResolveErr {
  ok: false;
  error: string;
}

export type TemplateResolveResult = TemplateResolveOk | TemplateResolveErr;

export type TemplateVars = Record<string, () => TemplateResolveResult>;

export function applyTemplate(tpl: string, vars: TemplateVars): TemplateResolveResult {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i]!;
    if (c !== '{') {
      out += c;
      i++;
      continue;
    }
    const closeIdx = tpl.indexOf('}', i + 1);
    if (closeIdx < 0) {
      // Unterminated `{` — pass through literally; the user's template is
      // malformed and an error here would be confusing.
      out += c;
      i++;
      continue;
    }
    const name = tpl.slice(i + 1, closeIdx);
    const resolver = vars[name];
    if (!resolver) {
      return { ok: false, error: `unknown placeholder {${name}} in template ${JSON.stringify(tpl)}` };
    }
    const r = resolver();
    if (!r.ok) return r;
    out += r.value;
    i = closeIdx + 1;
  }
  return { ok: true, value: out };
}

/**
 * fnclaude's documented default worktree-suffix separator. Worktree dirs sit
 * beside their clone as `<clone><MARKER><workspace>` (e.g. `repo@owner+feat`),
 * which matches the `<name>@<owner>+<workspace>` input grammar `parseRepoRef`
 * accepts and the cross-tool `claude-code-worktree-paths` plugin. Used only
 * when a user hasn't configured a `worktreeTemplate` (or it doesn't suffix the
 * `cloneTemplate`), so worktree siblings can be told apart from real clones
 * without baking any single user's layout into the resolution logic.
 */
export const DEFAULT_WORKTREE_MARKER = '+';

/**
 * Derive the literal separator that a worktree directory inserts between a
 * clone path and its workspace name, given the user's `cloneTemplate` and
 * `worktreeTemplate` (both from `repoSettings`). This is what lets
 * `findLocalClones` distinguish a worktree sibling from a second clone in the
 * same parent directory without assuming any one user's convention.
 *
 * The marker is the literal text a `worktreeTemplate` appends to the
 * `cloneTemplate` before its first remaining placeholder — e.g. with
 * cloneTemplate `~/src/{repo}@{owner}` and worktreeTemplate
 * `~/src/{repo}@{owner}+{input}`, the marker is `+`; with `...--wt--{input}`
 * it's `--wt--`.
 *
 * Falls back to {@link DEFAULT_WORKTREE_MARKER} when no marker can be derived:
 * the worktreeTemplate is unset, doesn't share the cloneTemplate prefix (its
 * worktrees live elsewhere, so no same-dir disambiguation is needed and the
 * harmless default applies), or appends a placeholder with no separating
 * literal. GitHub owner names can't contain `+`/`-wt-`-style markers anyway, so
 * a marker can never reject a legitimate clone.
 */
export function deriveWorktreeMarker(cloneTemplate: string, worktreeTemplate: string): string {
  if (cloneTemplate === '' || worktreeTemplate === '') return DEFAULT_WORKTREE_MARKER;
  if (!worktreeTemplate.startsWith(cloneTemplate)) return DEFAULT_WORKTREE_MARKER;
  const remainder = worktreeTemplate.slice(cloneTemplate.length);
  const braceIdx = remainder.indexOf('{');
  const marker = braceIdx >= 0 ? remainder.slice(0, braceIdx) : remainder;
  return marker !== '' ? marker : DEFAULT_WORKTREE_MARKER;
}

/**
 * Build the placeholder map for cloneTemplate expansion given the resolved
 * repo coordinates. Lazy resolvers (host-short) let templates that don't
 * reference them skip LUT lookups.
 */
export function cloneTemplateVars(
  repo: string,
  owner: string,
  host: string,
  hostAliases: Record<string, string>,
): TemplateVars {
  const dotIdx = host.indexOf('.');
  const hostPlain = dotIdx >= 0 ? host.slice(0, dotIdx) : host;

  return {
    repo: () => ({ ok: true, value: repo }),
    owner: () => ({ ok: true, value: owner }),
    host: () => ({ ok: true, value: host }),
    'host-plain': () => ({ ok: true, value: hostPlain }),
    'host-short': () => {
      const alias = hostAliases[host];
      if (alias === undefined) {
        return {
          ok: false,
          error: `host ${JSON.stringify(host)} has no entry in hostAliases LUT; add one to ~/.claude/settings.json's hostShortAliases block`,
        };
      }
      return { ok: true, value: alias };
    },
  };
}
