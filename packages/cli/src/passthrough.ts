// Passthrough-slice inspection helpers — the small predicates that ask
// "does this argv list already contain <flag>?". Shared between the
// argParser (which builds the slice) and the downstream pipeline stages
// (argv.ts, worktree.ts) that decide whether to inject more.
//
// Lives in its own module to break the import cycle that would otherwise
// arise: argParser.ts imports the predicates → argv.ts imports them too
// → worktree.ts needs nameInPassthrough → if it imported from argParser.ts
// that would close the loop (argParser → argv → worktree → argParser).
// With every consumer importing from here, the cycle disappears.

/**
 * True when any token is `--setting-sources` or starts with `--setting-sources=`.
 */
export function settingSourcesInPassthrough(passthrough: readonly string[]): boolean {
  return passthrough.some(
    (t) => t === '--setting-sources' || t.startsWith('--setting-sources='),
  );
}

/**
 * True when the exact token appears, or any `token=<anything>` form.
 */
export function tokenInPassthrough(passthrough: readonly string[], long: string): boolean {
  const prefix = `${long}=`;
  return passthrough.some((t) => t === long || t.startsWith(prefix));
}

/**
 * True when --name or -n (bare or =value) appears anywhere in passthrough.
 */
export function nameInPassthrough(passthrough: readonly string[]): boolean {
  return passthrough.some(
    (t) => t === '--name' || t === '-n' || t.startsWith('--name=') || t.startsWith('-n='),
  );
}
