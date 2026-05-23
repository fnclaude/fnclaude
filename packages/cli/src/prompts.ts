// System-prompt fragment loading. Ported from src/prompts.go.
//
// PromptSet holds the five fragments fnclaude can inject into a claude
// launch via --append-system-prompt. Each field is the literal text of one
// .md file from the install dir, trimmed of trailing whitespace.
//
// An empty string means the file was missing — callers MUST skip injection
// rather than appending an empty fragment. loadPrompts returns deferred
// warnings the caller can surface to the user after session setup.
//
// The Go reference is sync (it uses `os.ReadFile` directly). The TS port is
// async to fit Bun/Node idioms; CLI startup is already async-friendly so
// awaiting `loadPrompts()` adds no observable delay.

import { realpathSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

export interface PromptSet {
  readonly agentPitfall: string;
  readonly projectSwitch: string;
  readonly spawn: string;
  readonly restart: string;
  readonly noopRouter: string;
}

const EMPTY_PROMPT_SET: PromptSet = {
  agentPitfall: '',
  projectSwitch: '',
  spawn: '',
  restart: '',
  noopRouter: '',
};

const PROMPT_FILE_NAMES: Record<keyof PromptSet, string> = {
  agentPitfall: 'agent-pitfall.md',
  projectSwitch: 'project-switch.md',
  spawn: 'spawn.md',
  restart: 'restart.md',
  noopRouter: 'noop-router.md',
};

export interface LoadPromptsResult {
  readonly prompts: PromptSet;
  readonly warnings: string[];
}

/**
 * Locate the prompts install dir and read each known fragment. Search order:
 *  1. `$FNC_PROMPTS_DIR` (test/override hook).
 *  2. `<exe-dir>/prompts/` — dev workflow.
 *  3. `<exe-dir>/../share/fnclaude/prompts/` — FHS/AUR install layout.
 *
 * Symlinks in the exe path are resolved before the search.
 *
 * When the dir is missing entirely (typical for a registry install without
 * the data files), a clear actionable warning is queued and the returned
 * PromptSet is empty — no fragments will be injected but the session still
 * launches.
 */
export function loadPrompts(): LoadPromptsResult {
  const warnings: string[] = [];
  const { dir, error } = findPromptsDir();
  if (dir === null) {
    warnings.push(formatMissingDirWarning(error ?? 'unknown error'));
    return { prompts: EMPTY_PROMPT_SET, warnings };
  }

  const prompts: Record<keyof PromptSet, string> = {
    agentPitfall: '',
    projectSwitch: '',
    spawn: '',
    restart: '',
    noopRouter: '',
  };
  for (const key of Object.keys(PROMPT_FILE_NAMES) as (keyof PromptSet)[]) {
    const fileName = PROMPT_FILE_NAMES[key];
    const { content, warning } = readPromptFileSync(dir, fileName);
    prompts[key] = content;
    if (warning !== null) warnings.push(warning);
  }
  return { prompts, warnings };
}

export interface FindPromptsDirResult {
  readonly dir: string | null;
  readonly error: string | null;
}

export function findPromptsDir(): FindPromptsDirResult {
  const envDir = process.env.FNC_PROMPTS_DIR;
  if (envDir !== undefined && envDir !== '') {
    try {
      statSync(envDir);
      return { dir: envDir, error: null };
    } catch (err) {
      return {
        dir: null,
        error: `FNC_PROMPTS_DIR=${JSON.stringify(envDir)} does not exist: ${errorMessage(err)}`,
      };
    }
  }

  // Prefer argv[1] (the CLI script) over execPath (the interpreter) so the
  // search anchors to the script's neighbours, not bun's bin dir.
  const argv1 = process.argv.length > 1 ? process.argv[1] : undefined;
  let exe = argv1 !== undefined && argv1 !== '' ? argv1 : process.execPath;

  try {
    exe = realpathSync(exe);
  } catch {
    // Fall back to unresolved path; symlink resolution failure isn't fatal.
  }
  const exeDir = dirname(exe);

  const candidates = [
    join(exeDir, 'prompts'),
    join(exeDir, '..', 'share', 'fnclaude', 'prompts'),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) {
        return { dir: c, error: null };
      }
    } catch {
      // continue to next candidate
    }
  }
  return {
    dir: null,
    error: `prompts directory not found alongside fnclaude binary (searched: ${candidates.join(', ')})`,
  };
}

export interface ReadPromptFileResult {
  readonly content: string;
  readonly warning: string | null;
}

/**
 * Async variant for callers that want non-blocking I/O. Returns the trimmed
 * file content, or empty string + warning on read failure.
 */
export async function readPromptFile(
  dir: string,
  name: string,
): Promise<ReadPromptFileResult> {
  const path = join(dir, name);
  try {
    await stat(path); // surface ENOENT before reading
    const data = await readFile(path, 'utf8');
    return { content: trimTrailingWhitespace(data), warning: null };
  } catch (err) {
    return {
      content: '',
      warning: formatMissingFileWarning(path, name, errorMessage(err)),
    };
  }
}

/**
 * Sync variant used by `loadPrompts`. The Go reference is fully sync at
 * startup; we mirror that here so the function as a whole can stay sync and
 * the warnings are available immediately to the caller.
 */
export function readPromptFileSync(dir: string, name: string): ReadPromptFileResult {
  const path = join(dir, name);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return {
      content: trimTrailingWhitespace(readFileSync(path, 'utf8')),
      warning: null,
    };
  } catch (err) {
    return {
      content: '',
      warning: formatMissingFileWarning(path, name, errorMessage(err)),
    };
  }
}

/**
 * isInteractiveSession reports whether the passthrough flags indicate an
 * interactive session (vs. a -p / --print one-shot run). Drives the
 * fragment-injection gate in selectFragments and the self-MCP injection
 * gate in buildArgv — neither is useful for non-interactive runs.
 */
export function isInteractiveSession(passthrough: readonly string[]): boolean {
  return !passthrough.some((t) => t === '-p' || t === '--print');
}

/**
 * selectFragments returns the prompt fragments to inject for this session,
 * in stable order. Empty strings (missing files) are dropped.
 *
 *   - All interactive sessions (non -p/--print) get agent-pitfall + spawn
 *     (sibling-session capability applies whether the user is in noop
 *     routing the conversation or in a project doing focused work).
 *   - Noop fallback sessions also get noop-router (the router instructions
 *     that replaced the embedded noop CLAUDE.md).
 *   - Non-noop sessions also get project-switch + restart (capability hints
 *     so the user can request a switch to another repo or restart the
 *     current session at any time).
 *
 * -p/--print sessions get nothing — agent spawning, project-switching,
 * sibling spawning, and restart don't apply to one-shot non-interactive runs.
 */
export function selectFragments(
  ps: PromptSet,
  passthrough: readonly string[],
  usedNoopFallback: boolean,
): string[] {
  if (!isInteractiveSession(passthrough)) return [];
  const frags: string[] = [];
  if (ps.agentPitfall !== '') frags.push(ps.agentPitfall);
  if (ps.spawn !== '') frags.push(ps.spawn);
  if (usedNoopFallback) {
    if (ps.noopRouter !== '') frags.push(ps.noopRouter);
  } else {
    if (ps.projectSwitch !== '') frags.push(ps.projectSwitch);
    if (ps.restart !== '') frags.push(ps.restart);
  }
  return frags;
}

function trimTrailingWhitespace(s: string): string {
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    // \n, \r, space, tab
    if (c !== 0x0a && c !== 0x0d && c !== 0x20 && c !== 0x09) break;
    i--;
  }
  return s.slice(0, i);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatMissingFileWarning(path: string, name: string, err: string): string {
  return (
    `fnclaude: prompt fragment ${path} missing or unreadable: ${err} — ` +
    `the ${JSON.stringify(name)} system-prompt fragment will be skipped this session. ` +
    `If you're seeing this on a fresh install, your prompts/ directory ` +
    `may be incomplete; reinstall fnclaude or point FNC_PROMPTS_DIR at ` +
    `a complete prompts/ checkout.`
  );
}

function formatMissingDirWarning(err: string): string {
  return (
    `fnclaude: ${err} — no system-prompt fragments will be injected for this session.\n` +
    `  This usually means fnclaude was installed without its sibling prompts/\n` +
    `  directory (e.g. via \`go install\`, which doesn't ship data files). To fix:\n` +
    `    • Install via the AUR package, or download a release archive (which\n` +
    `      ships prompts/ alongside the binary).\n` +
    `    • Or set FNC_PROMPTS_DIR to a local prompts/ checkout, e.g. point it\n` +
    `      at the prompts/ dir in a clone of the fnclaude repo.`
  );
}
