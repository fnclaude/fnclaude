/**
 * Pure-function pieces of auto-name (§5.2 / design.md §18):
 *   - shouldAutoName(parsed) — gating condition: does this invocation
 *     qualify for auto-naming?
 *   - sanitizeLLMOutput(s) — slug-clean an LLM's freeform response
 *   - heuristicName(prompt) — deterministic fallback when no LLM
 *
 * The LLM call itself (Anthropic SDK with ANTHROPIC_API_KEY, or `claude
 * -p` subprocess fallback) sits at the orchestrator layer; this module
 * provides the building blocks it relies on.
 *
 * Mirrors Go canonical src/autoname.go:1-253.
 */

import {
  findPromptSentinel,
  hasPromptBody,
  promptBody,
} from '../argv/sentinel.ts';
import type { ParsedArgsOk } from '../argv/parse.ts';

// ── shouldAutoName ──────────────────────────────────────────────────────────

const BLOCKERS_NO_VALUE = new Set([
  '-p',
  '--print',
  '-r',
  '--resume',
  '-c',
  '--continue',
  '--from-pr',
  '-P',
]);

// Token forms like `--name=foo`, `-n=foo`, `-r=abc`, `--resume=abc`,
// `--from-pr=123`, `-P=123`. Stored as prefixes to check via startsWith.
const BLOCKERS_EQUAL_PREFIX = [
  '--name=',
  '-n=',
  '--resume=',
  '-r=',
  '--from-pr=',
  '-P=',
];

// Two-token form (flag + separate value). When we see any of these, the
// next-token shape doesn't matter — the presence of the flag itself
// blocks auto-name.
const BLOCKERS_TWO_TOKEN = new Set(['--name', '-n']);

export function shouldAutoName(parsed: ParsedArgsOk): boolean {
  const pt = parsed.passthrough;
  const sentinelIdx = findPromptSentinel(pt);
  if (sentinelIdx < 0) return false;
  if (!hasPromptBody(pt, sentinelIdx)) return false;
  if (promptBody(pt, sentinelIdx).every((t) => t === '')) return false;

  // Scan up to the sentinel — only flags BEFORE `--` count.
  for (let i = 0; i < sentinelIdx; i++) {
    const tok = pt[i]!;
    if (BLOCKERS_NO_VALUE.has(tok)) return false;
    if (BLOCKERS_TWO_TOKEN.has(tok)) return false;
    for (const pre of BLOCKERS_EQUAL_PREFIX) {
      if (tok.startsWith(pre)) return false;
    }
  }
  return true;
}

// ── sanitizeLLMOutput ───────────────────────────────────────────────────────

const RE_WHITESPACE = /\s+/g;
const RE_NON_SLUG = /[^a-z0-9-]+/g;
const RE_MULTI_DASH = /-{2,}/g;

export function sanitizeLLMOutput(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(RE_WHITESPACE, '-');
  s = s.replace(RE_NON_SLUG, '');
  s = s.replace(RE_MULTI_DASH, '-');
  s = trimChar(s, '-');
  // Take first 3 segments
  const parts = s.split('-').filter((p) => p.length > 0).slice(0, 3);
  s = parts.join('-');
  return trimChar(s, '-');
}

function trimChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

// ── heuristicName ───────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the',
  'is', 'are', 'was', 'were',
  'do', 'does', 'did',
  'of', 'for', 'to', 'in', 'on', 'at', 'with',
  'this', 'that',
  'please', 'can', 'could', 'would', 'should',
]);

const RE_NON_ALNUM = /[^a-z0-9]/g;

export function heuristicName(prompt: string): string {
  const fields = prompt.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const kept: string[] = [];
  for (const word of fields) {
    if (STOP_WORDS.has(word)) continue;
    const stripped = word.replace(RE_NON_ALNUM, '');
    if (stripped === '') continue;
    kept.push(stripped);
    if (kept.length === 3) break;
  }
  if (kept.length === 0) return 'session';
  return kept.join('-');
}
