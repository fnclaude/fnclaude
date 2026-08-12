/**
 * Key-overlap rule for the coordination registry.
 *
 * Claim keys are strings, usually absolute paths. Normalization strips
 * trailing slashes; `a` overlaps `b` iff `a === b`, or `b` starts with
 * `a + '/'`, or `a` starts with `b + '/'` — i.e. equality or directory
 * containment at a "/" boundary. `/a` vs `/ab` do NOT overlap (shared name
 * prefix, no boundary); `/a` vs `/a/b` do.
 *
 * Root `/` normalizes to the empty string, which makes the generic prefix
 * rule cover it: every absolute path starts with `'' + '/'`. Abstract
 * non-path keys (e.g. `git:stash:fnclaude`) fall out as exact-match-only,
 * since they never contain a "/"-boundary continuation in practice.
 */

export function normalizeKey(key: string): string {
  let end = key.length;
  while (end && key[end - 1] === '/') {
    end--;
  }
  return key.slice(0, end);
}

export function keysOverlap(a: string, b: string): boolean {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);
  if (na === nb) {
    return true;
  }
  return nb.startsWith(`${na}/`) || na.startsWith(`${nb}/`);
}
