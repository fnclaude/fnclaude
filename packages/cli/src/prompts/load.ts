/**
 * Load prompt fragments from disk and inject them into the claude
 * passthrough as `--append-system-prompt <combined>` (or merge into an
 * existing one).
 *
 * Mirrors Go canonical src/prompts.go for the load + compose + inject
 * pipeline. Selection logic (which fragments to load) lives in
 * select.ts; this file just performs the IO + merge.
 *
 * Per specs.md §12:
 *   - Fragments joined with double newline (`\n\n`)
 *   - Missing fragment: deferred warning, skip, continue with others
 *   - If --append-system-prompt is already in passthrough, append to its
 *     value (don't replace) so user-provided content is preserved
 *
 * promptsDir is passed in — the resolver (caller) handles the directory
 * search order ($FNC_PROMPTS_DIR → <exe-dir>/prompts → FHS share path).
 *
 * overridesDir, when given, takes precedence PER FRAGMENT: a file of the same
 * name in the user's `rhombus.rocks/fnclaude/prompts/` replaces the packaged
 * one, and the fragments they haven't overridden still come from the package
 * (see prompts/overrides.ts).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { insertFlagsBeforeSentinel } from '../argv/sentinel';
import { resolveFragmentPath } from './overrides';

export interface LoadFragmentsResult {
  content: string;
  warnings: string[];
}

export function loadFragments(
  names: readonly string[],
  promptsDir: string,
  overridesDir: string | null = null,
): LoadFragmentsResult {
  const pieces: string[] = [];
  const warnings: string[] = [];

  for (const name of names) {
    const path = resolveFragmentPath(name, promptsDir, overridesDir);
    if (path === null) {
      warnings.push(`fnclaude: prompt fragment ${name} missing from ${promptsDir}`);
      continue;
    }
    try {
      pieces.push(readFileSync(path, 'utf8'));
    } catch {
      warnings.push(`fnclaude: prompt fragment ${name} could not be read from ${path}`);
    }
  }

  return { content: pieces.join('\n\n'), warnings };
}

const FLAG = '--append-system-prompt';
const FLAG_EQ = `${FLAG}=`;

export function injectFragments(
  passthrough: readonly string[],
  content: string,
): string[] {
  if (content === '') return [...passthrough];

  const out = [...passthrough];

  // Find LAST occurrence of --append-system-prompt (in either form).
  // Later one wins anyway in claude's parser, so we merge into it.
  let lastFlagIdx = -1;
  let lastFlagValIdx = -1; // -1 means inline (=val form)
  for (let i = 0; i < out.length; i++) {
    if (out[i] === FLAG) {
      lastFlagIdx = i;
      lastFlagValIdx = i + 1; // value is the next token
    } else if (out[i]!.startsWith(FLAG_EQ)) {
      lastFlagIdx = i;
      lastFlagValIdx = -1;
    }
  }

  if (lastFlagIdx >= 0) {
    if (lastFlagValIdx === -1) {
      // Inline form: --append-system-prompt=VAL
      const tok = out[lastFlagIdx]!;
      const existing = tok.slice(FLAG_EQ.length);
      out[lastFlagIdx] = `${FLAG_EQ}${existing}\n\n${content}`;
    } else if (lastFlagValIdx < out.length) {
      out[lastFlagValIdx] = `${out[lastFlagValIdx]}\n\n${content}`;
    } else {
      // Bare --append-system-prompt at the end with no value: append.
      out.push(content);
    }
    return out;
  }

  // No existing flag — insert before `--` if present, else push at end.
  return insertFlagsBeforeSentinel(out, FLAG, content);
}
