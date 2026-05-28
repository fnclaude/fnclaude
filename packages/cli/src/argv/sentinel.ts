/**
 * `--` sentinel helpers over the parsed passthrough array.
 *
 * After parseArgs has done its work, the prompt body (if any) lives as
 * a suffix of `passthrough` starting at the first literal `--` token.
 * Pre-sentinel tokens are flags + flag values destined for claude;
 * post-sentinel tokens are the user's prompt body, also passed to claude
 * but as positional prompt input rather than flag content.
 *
 * The split matters for downstream phases:
 *   - the auto-name code path (§5.2) feeds promptBody() to the naming LLM
 *   - the prompt-fragment splicer (§5.5) inserts --append-system-prompt
 *     BEFORE the sentinel so claude doesn't treat the flag-pair as more
 *     prompt content (regression class: PR #117 in the Go-port era)
 *
 * Only the FIRST `--` is the sentinel; any subsequent `--` is prompt
 * content. This matches conventional Unix arg-parsing semantics.
 */

const SENTINEL = '--';

export function findPromptSentinel(passthrough: readonly string[]): number {
  return passthrough.indexOf(SENTINEL);
}

export function hasPromptBody(passthrough: readonly string[]): boolean {
  const idx = findPromptSentinel(passthrough);
  return idx >= 0 && idx < passthrough.length - 1;
}

export function promptBody(passthrough: readonly string[]): string[] {
  const idx = findPromptSentinel(passthrough);
  if (idx < 0) return [];
  return passthrough.slice(idx + 1);
}

export function preSentinelArgs(passthrough: readonly string[]): string[] {
  const idx = findPromptSentinel(passthrough);
  if (idx < 0) return [...passthrough];
  return passthrough.slice(0, idx);
}

/**
 * Insert `flags` into `args` such that they land BEFORE the first `--`
 * sentinel (if any), otherwise at the end. Returns a fresh array.
 *
 * Centralises the pattern previously open-coded in `injectFragments` —
 * post-sentinel tokens are prompt body, so flag pairs (e.g. `--name foo`
 * / `--mcp-config <json>`) appended naively after `--` would be read by
 * claude as positional prompt content. Every site that appends a flag
 * pair to a passthrough that may contain `--` goes through this helper.
 *
 * The `flags` rest param is variadic to match the natural shape of
 * `[FLAG, value]` pairs — call sites read like `insertFlagsBeforeSentinel(out, '--name', name)`.
 */
export function insertFlagsBeforeSentinel(
  args: readonly string[],
  ...flags: readonly string[]
): string[] {
  const out = [...args];
  if (flags.length === 0) return out;
  const idx = findPromptSentinel(out);
  if (idx < 0) {
    out.push(...flags);
    return out;
  }
  out.splice(idx, 0, ...flags);
  return out;
}
