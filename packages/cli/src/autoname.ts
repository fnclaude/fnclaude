// Port of src/autoname.go from the Go reference implementation.
//
// shouldAutoName — predicate for automatic --name injection.
// generateName  — Anthropic API call (or claude CLI fallback) to produce a
//                 short kebab-case session label from the initial prompt.

import Anthropic from '@anthropic-ai/sdk';
import type { NameConfig } from './config.js';

// ── predicates ──────────────────────────────────────────────────────────────

/**
 * shouldAutoName returns true when the passthrough slice meets all conditions
 * for automatic --name injection:
 *
 *   - contains "--" followed by at least one non-empty token
 *   - does NOT already contain --name / -n / --name=* / -n=*
 *   - does NOT contain -p / --print
 *   - does NOT contain -r / --resume / -r=* / --resume=*
 *   - does NOT contain -c / --continue
 *   - does NOT contain --from-pr / --from-pr=* / -P / -P=*
 */
export function shouldAutoName(passthrough: readonly string[]): boolean {
  // Find "--" and verify at least one non-empty token follows.
  const sepIdx = passthrough.indexOf('--');
  if (sepIdx < 0) return false;

  const hasPrompt = passthrough.slice(sepIdx + 1).some((t) => t !== '');
  if (!hasPrompt) return false;

  // Check for disqualifying tokens.
  for (const t of passthrough) {
    if (
      t === '--name' ||
      t === '-n' ||
      t.startsWith('--name=') ||
      t.startsWith('-n=')
    )
      return false;
    if (t === '-p' || t === '--print') return false;
    if (
      t === '-r' ||
      t === '--resume' ||
      t.startsWith('-r=') ||
      t.startsWith('--resume=')
    )
      return false;
    if (t === '-c' || t === '--continue') return false;
    if (
      t === '--from-pr' ||
      t.startsWith('--from-pr=') ||
      t === '-P' ||
      t.startsWith('-P=')
    )
      return false;
  }
  return true;
}

/**
 * extractPrompt returns the first non-empty token after "--" in passthrough.
 * Returns "" if not found.
 */
export function extractPrompt(passthrough: readonly string[]): string {
  const sepIdx = passthrough.indexOf('--');
  if (sepIdx < 0) return '';
  for (const t of passthrough.slice(sepIdx + 1)) {
    if (t !== '') return t;
  }
  return '';
}

// ── stop-words + heuristic fallback ────────────────────────────────────────

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'of',
  'for',
  'to',
  'in',
  'on',
  'at',
  'with',
  'this',
  'that',
  'please',
  'can',
  'could',
  'would',
  'should',
]);

/**
 * heuristicName derives a session name from a prompt without any LLM call.
 * Takes up to 3 non-stop-word, alphanumeric tokens joined with "-".
 */
export function heuristicName(prompt: string): string {
  const words = prompt.toLowerCase().split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    const clean = w.replace(/[^a-z0-9]/g, '');
    if (clean !== '') kept.push(clean);
    if (kept.length === 3) break;
  }
  return kept.length === 0 ? 'session' : kept.join('-');
}

// ── slug sanitization ───────────────────────────────────────────────────────

const RE_NON_SLUG = /[^a-z0-9-]+/g;
const RE_MULTI_DASH = /-{2,}/g;
const RE_WHITESPACE = /\s+/g;

/**
 * sanitizeSlug cleans raw LLM output into a valid kebab slug (up to 3 dash-
 * separated segments). Returns "" when nothing survives sanitization.
 */
export function sanitizeSlug(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(RE_WHITESPACE, '-');
  s = s.replace(RE_NON_SLUG, '');
  s = s.replace(RE_MULTI_DASH, '-');
  s = s.replace(/^-+|-+$/g, '');
  // Take first 3 dash-segments.
  const parts = s.split('-');
  s = parts.slice(0, 3).join('-');
  // Trim again in case joining re-introduced edge dashes.
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

// ── LLM client abstraction ──────────────────────────────────────────────────

export const NAME_SYSTEM_PROMPT =
  "Generate a 1-3 word lowercase hyphen-separated label for this user's request. " +
  'Output ONLY the label — no punctuation, no quotes, no explanation, no leading ' +
  "'Label:'. Examples: 'fix-login-bug', 'add-dark-mode', 'refactor-auth'.";

/**
 * LlmClientFn is the injectable seam for the LLM call. Tests can swap in a
 * fake without touching the Anthropic SDK.
 */
export type LlmClientFn = (
  model: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>;

/**
 * defaultLlmClient returns an LlmClientFn backed by the real Anthropic API.
 */
export function defaultLlmClient(apiKey: string): LlmClientFn {
  return async (model, prompt, signal) => {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create(
      {
        model,
        max_tokens: 30,
        system: NAME_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal },
    );
    for (const blk of msg.content) {
      if (blk.type === 'text') return blk.text;
    }
    throw new Error('no text block in response');
  };
}

/**
 * claudeCliFn shells out to `claude -p --model <model> <combined-prompt>`.
 * Used as fallback when ANTHROPIC_API_KEY is absent.
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  signal: AbortSignal,
) => Promise<string>;

// Production spawn implementation using Bun.spawn.
export const defaultSpawnFn: SpawnFn = async (cmd, args, signal) => {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Kill on abort.
  signal.addEventListener('abort', () => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  });

  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  const exitCode = proc.exitCode;
  if (exitCode !== 0) {
    throw new Error(`claude exited with code ${exitCode}`);
  }
  return stdout;
};

export function claudeCliFn(model: string, spawnFn: SpawnFn = defaultSpawnFn): LlmClientFn {
  return async (_model, prompt, signal) => {
    const combined = `${NAME_SYSTEM_PROMPT}\n\nUser request: ${prompt}`;
    return spawnFn('claude', ['-p', '--model', model, combined], signal);
  };
}

// ── generateName ────────────────────────────────────────────────────────────

/**
 * generateName produces a session name for the given prompt.
 *
 * llmFn may be omitted; it is selected automatically:
 *   - defaultLlmClient when apiKey is non-empty
 *   - claudeCliFn otherwise (falls back to the user's existing auth)
 *
 * On any error the function falls back to heuristicName silently.
 */
export async function generateName(
  prompt: string,
  cfg: NameConfig,
  apiKey: string,
  llmFn?: LlmClientFn,
): Promise<string> {
  let usingCLI = false;
  if (!llmFn) {
    if (apiKey) {
      llmFn = defaultLlmClient(apiKey);
    } else {
      llmFn = claudeCliFn(cfg.model);
      usingCLI = true;
    }
  }

  // cfg.timeout is in milliseconds (NameConfig stores ms).
  let timeoutMs = cfg.timeout;
  if (timeoutMs <= 0) {
    // claude -p cold-start is multi-second; give the CLI path more room.
    timeoutMs = usingCLI ? 15_000 : 3_000;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const raw = await llmFn(cfg.model, prompt, controller.signal);
    const name = sanitizeSlug(raw);
    return name !== '' ? name : heuristicName(prompt);
  } catch {
    return heuristicName(prompt);
  } finally {
    clearTimeout(timer);
  }
}
