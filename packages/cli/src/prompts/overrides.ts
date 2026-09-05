/**
 * User overrides for fnc's packaged system prompts.
 *
 * Any file dropped in `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/prompts/`
 * replaces the packaged fragment of the SAME NAME. There is no copy step and
 * no merge: presence is the whole mechanism (owner's call, 2026-09-04 —
 * "override-only, no automatic copy"). An empty override directory, or none at
 * all, changes nothing.
 *
 * `fnc install` creates the directory containing only a `README.txt`. Plain
 * text, not markdown, deliberately: this is a file people meet in a file
 * manager or an `ls`, where a `.md` reads as a repository's front page rather
 * than as a note to the person browsing.
 *
 * "System prompt" is the term used throughout the user-facing text, because
 * that is what the fragments are to Claude Code — the phrase "prompt fragment"
 * is internal vocabulary.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fragment names fnc ships and therefore names in the README. Kept in the same
 * order the README lists them, which is roughly the order a user meets them.
 */
export const PACKAGED_FRAGMENT_NAMES = [
  'noop-router.md',
  'project-switch.md',
  'spawn.md',
  'restart.md',
  'budget.md',
  'one-shot.md',
  'agent-pitfall.md',
  'oobe.md',
] as const;

/**
 * The README that seeds the override directory. Takes the packaged directory
 * so the text can point at the actual files to copy from — a path the user
 * cannot otherwise guess, since it lives inside an npm install.
 */
export function overridesReadme(packagedDir: string | null): string {
  const seedLine =
    packagedDir === null
      ? "fnc could not locate its packaged prompts directory when this file was\nwritten. It normally sits next to fnc's own install, in a 'prompts'\ndirectory; `fnc --version` names the install."
      : `The packaged originals are in:\n\n  ${packagedDir}\n\nCopy one from there to start from what fnc ships, rather than a blank file.`;

  return `fnc system prompt overrides
===========================

Any file you put in this directory replaces fnc's packaged SYSTEM PROMPT of
the same name. fnc loads yours instead; nothing is merged, and nothing here is
ever overwritten by an update.

${seedLine}

Delete your copy to go back to the packaged one.

Recognised names
----------------

${PACKAGED_FRAGMENT_NAMES.map((n) => `  ${n}`).join('\n')}

A file whose name is not in that list is ignored — fnc only looks for the
names it knows.
`;
}

export interface EnsureOverridesDirArgs {
  /** `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/prompts`. */
  dir: string;
  /** The packaged prompts directory, for the README's "copy from" line. */
  packagedDir: string | null;
}

/**
 * Create the override directory and seed its README. Never clobbers: an
 * existing README is left exactly as the user left it, because they may have
 * annotated it. Returns whether the README was written.
 */
export function ensureOverridesDir(args: EnsureOverridesDirArgs): boolean {
  mkdirSync(args.dir, { recursive: true });
  const readmePath = join(args.dir, 'README.txt');
  try {
    if (statSync(readmePath).isFile()) return false;
  } catch {
    // Missing — fall through and write it.
  }
  writeFileSync(readmePath, overridesReadme(args.packagedDir), 'utf8');
  return true;
}

/**
 * Resolve one fragment name to the file that should be read: the user's
 * override when it exists, else the packaged copy. Returns null when neither
 * exists, which the loader reports as a missing fragment exactly as before.
 */
export function resolveFragmentPath(
  name: string,
  packagedDir: string,
  overridesDir: string | null,
): string | null {
  if (overridesDir !== null) {
    const candidate = join(overridesDir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not overridden — fall through to the packaged copy.
    }
  }
  const packaged = join(packagedDir, name);
  try {
    return statSync(packaged).isFile() ? packaged : null;
  } catch {
    return null;
  }
}
