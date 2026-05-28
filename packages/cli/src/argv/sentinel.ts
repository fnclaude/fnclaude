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
