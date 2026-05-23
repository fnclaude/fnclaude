// Generic `{placeholder}` template substitution. Ported from src/spawn.go
// (buildSpawnArgv's inline logic) with a factored-out substitute helper.
//
// Placeholder vocabulary: any `{key}` in the template string is replaced with
// the corresponding value from vars. Missing keys are left verbatim — no
// error — so callers can safely pass a template that uses only a subset of
// available placeholders.
//
// Unterminated `{` (no matching `}`) is passed through literally, matching
// the Go reference's behaviour.

/**
 * substitute replaces every `{key}` occurrence in tpl with the corresponding
 * value from vars. Keys absent from vars are left as-is (`{key}` verbatim).
 */
export function substitute(tpl: string, vars: Record<string, string>): string {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i]!;
    if (c !== '{') {
      out += c;
      i++;
      continue;
    }
    // Find the matching '}'
    const end = tpl.indexOf('}', i + 1);
    if (end < 0) {
      // Unterminated '{' — pass through literally.
      out += c;
      i++;
      continue;
    }
    const key = tpl.slice(i + 1, end);
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      out += vars[key]!;
    } else {
      // Unknown placeholder — leave verbatim.
      out += tpl.slice(i, end + 1);
    }
    i = end + 1;
  }
  return out;
}
