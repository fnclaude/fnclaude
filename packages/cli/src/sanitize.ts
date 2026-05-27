// Path/branch-name sanitization. Ported from src/sanitize.go in the Go
// reference implementation.
//
// sanitizeName produces a slug safe for both filesystem path components
// and git ref names: collapses anything outside [A-Za-z0-9._/-] to '-',
// dedupes hyphen and slash runs, strips leading [-.] and trailing [-/].
// '/' is allowed so git-style nested refs (feat/foo, team/x/y/z) pass
// through and produce nested worktree paths.
//
// Returns undefined when:
//   - the input is empty
//   - the input starts with '/' (would escape the configured path prefix)
//   - the result reduces to empty after sanitization
//   - the result contains a ".." substring (git ref-format rule; also
//     blocks foo/../bar style path escape)
//
// Caller decides whether to reject, fall back, or pass the original
// through with a warning.

const RE_PATH_SAFE_BAD = /[^A-Za-z0-9._/-]+/g;
const RE_DASH_RUN = /-{2,}/g;
const RE_SLASH_RUN = /\/{2,}/g;

export function sanitizeName(s: string): string | undefined {
  if (s === '') return undefined;
  if (s.startsWith('/')) return undefined;

  let out = s.replace(RE_PATH_SAFE_BAD, '-');
  out = out.replace(RE_DASH_RUN, '-');
  out = out.replace(RE_SLASH_RUN, '/');
  out = trimLeftAny(out, '-.');
  out = trimRightAny(out, '-/');

  if (out === '') return undefined;
  if (out.includes('..')) return undefined;
  return out;
}

function trimLeftAny(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i]!)) i++;
  return s.slice(i);
}

function trimRightAny(s: string, chars: string): string {
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1]!)) i--;
  return s.slice(0, i);
}

// sanitizeNamesInPassthrough scans args for --name/--name=VAL/-n/-n=VAL and
// rewrites VAL to a path-safe form when it contains unsafe chars. Returns
// the modified slice plus one warning message per affected occurrence.
//
// Values that reduce to empty after sanitization are left untouched; we
// only warn. This preserves the user's literal input so claude (or a
// downstream hook) can surface the real error rather than fnclaude
// silently substituting a synthetic name.

export interface SanitizeNamesResult {
  readonly args: string[];
  readonly warnings: string[];
}

export function sanitizeNamesInPassthrough(p: readonly string[]): SanitizeNamesResult {
  const out = [...p];
  const warnings: string[] = [];

  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;
    if ((t === '--name' || t === '-n') && i + 1 < out.length) {
      const val = out[i + 1]!;
      const decision = decideSanitize(val);
      if (decision.warning !== undefined) warnings.push(decision.warning);
      if (decision.replace) out[i + 1] = decision.cleaned;
      i++; // skip the value slot
      continue;
    }
    if (t.startsWith('--name=')) {
      const val = t.slice('--name='.length);
      const decision = decideSanitize(val);
      if (decision.warning !== undefined) warnings.push(decision.warning);
      if (decision.replace) out[i] = `--name=${decision.cleaned}`;
      continue;
    }
    if (t.startsWith('-n=')) {
      const val = t.slice('-n='.length);
      const decision = decideSanitize(val);
      if (decision.warning !== undefined) warnings.push(decision.warning);
      if (decision.replace) out[i] = `-n=${decision.cleaned}`;
      continue;
    }
  }
  return { args: out, warnings };
}

interface SanitizeDecision {
  cleaned: string;
  warning: string | undefined;
  replace: boolean;
}

function decideSanitize(val: string): SanitizeDecision {
  const cleaned = sanitizeName(val);
  if (cleaned === undefined) {
    return {
      cleaned: val,
      warning: `fnclaude: --name ${JSON.stringify(val)} has no path-safe characters; passing through unchanged`,
      replace: false,
    };
  }
  if (cleaned === val) {
    return { cleaned: '', warning: undefined, replace: false };
  }
  return {
    cleaned,
    warning: `fnclaude: --name ${JSON.stringify(val)} sanitized to ${JSON.stringify(cleaned)} (illegal path/branch chars)`,
    replace: true,
  };
}
