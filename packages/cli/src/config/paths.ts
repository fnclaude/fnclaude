/**
 * Where the rhombus.rocks configuration lives.
 *
 * Layout (specs/rhombus-rocks-config.md § Locations):
 *
 *   $XDG_CONFIG_HOME/rhombus.rocks/config.json           shared with fngit + the plugin
 *   $XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.json  fnc's own
 *   $XDG_CONFIG_HOME/rhombus.rocks/fnclaude/prompts/     system-prompt overrides
 *   $XDG_CONFIG_HOME/rhombus.rocks/fnclaude/noop/        default starting directory
 *   $XDG_STATE_HOME/rhombus.rocks/fnclaude/              logs
 *
 * Readers accept whichever of `config.{json,jsonc,toml,yaml}` exists, first
 * match in that order; writers always write `config.json`. fnc reads only its
 * own file today — the shared file is fngit's to read, and fnc reaches repo
 * settings through the fngit CLI rather than parsing them itself.
 *
 * Pure path computation: nothing here creates a directory. `findConfigFile` is
 * the one function that touches the filesystem, and only to stat candidates.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

/** The brand directory name. One place, so a rename is one edit. */
export const BRAND_DIR = 'rhombus.rocks';

/** Config file basenames, in the order a reader tries them. */
export const CONFIG_BASENAMES = [
  'config.json',
  'config.jsonc',
  'config.toml',
  'config.yaml',
] as const;

export interface XdgEnv {
  home: string;
  xdgConfigHome: string | undefined;
  xdgStateHome?: string | undefined;
}

function isSet(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

function configHome(env: XdgEnv): string {
  return isSet(env.xdgConfigHome) ? env.xdgConfigHome : join(env.home, '.config');
}

function stateHome(env: XdgEnv): string {
  return isSet(env.xdgStateHome) ? env.xdgStateHome : join(env.home, '.local', 'state');
}

/** `$XDG_CONFIG_HOME/rhombus.rocks` — the shared config directory. */
export function sharedConfigDir(env: XdgEnv): string {
  return join(configHome(env), BRAND_DIR);
}

/** `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude` — fnc's config directory. */
export function fncConfigDir(env: XdgEnv): string {
  return join(sharedConfigDir(env), 'fnclaude');
}

/** Where a writer writes: `<fncConfigDir>/config.json`, always JSON. */
export function fncConfigWritePath(env: XdgEnv): string {
  return join(fncConfigDir(env), 'config.json');
}

/** `<fncConfigDir>/prompts` — user overrides for packaged system prompts. */
export function promptOverridesDir(env: XdgEnv): string {
  return join(fncConfigDir(env), 'prompts');
}

/** `<fncConfigDir>/noop` — the default starting directory (`noopDir` overrides). */
export function defaultNoopDir(env: XdgEnv): string {
  return join(fncConfigDir(env), 'noop');
}

/** `$XDG_STATE_HOME/rhombus.rocks/fnclaude` — where session logs are written. */
export function fncStateDir(env: XdgEnv): string {
  return join(stateHome(env), BRAND_DIR, 'fnclaude');
}

/**
 * The pre-restructure fnc config: `$XDG_CONFIG_HOME/fnclaude/config.toml`.
 * Read once, when no new-location file exists, and migrated. Never written.
 */
export function legacyFncConfigPath(env: XdgEnv): string {
  return join(configHome(env), 'fnclaude', 'config.toml');
}

/** The pre-restructure noop directory, for the migration's `noopDir` default. */
export function legacyNoopDir(env: XdgEnv): string {
  return join(configHome(env), 'fnclaude', 'noop');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * First existing `config.{json,jsonc,toml,yaml}` in `dir`, or null. Order is
 * fixed by {@link CONFIG_BASENAMES} so two files in one directory resolve
 * deterministically rather than by readdir order.
 */
export function findConfigFile(dir: string): string | null {
  for (const base of CONFIG_BASENAMES) {
    const candidate = join(dir, base);
    if (isFile(candidate)) return candidate;
  }
  return null;
}
