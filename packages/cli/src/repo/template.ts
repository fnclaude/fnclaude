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
