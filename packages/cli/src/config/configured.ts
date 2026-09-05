/**
 * Which config keys are already set — the input to the interview's skip rules.
 *
 * "Already configured" has to mean "present in the file", not "has a
 * non-default value": a user who deliberately set `auto.tmux = "never"` chose
 * the default, and re-asking them because their answer matched the
 * recommendation would be the wizard second-guessing them.
 *
 * Both files are read, because the interview writes to both: fnc's own config
 * holds `noopDir`, `auto.*` and `claude.*`, while the `repos.*` answers belong
 * to the shared file that fngit and the plugin also read.
 */

import { extname } from 'node:path';

import { type XdgEnv, findConfigFile, fncConfigDir, sharedConfigDir } from './paths';

/** Every leaf path in a document, dotted: `{auto:{tmux:'x'}}` → `auto.tmux`. */
export function leafPaths(doc: unknown, prefix = ''): string[] {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (k === '$schema') continue;
    const path = prefix === '' ? k : `${prefix}.${k}`;
    out.push(path);
    // Recurse into plain objects only. An array is a VALUE (defaultArgs,
    // additionalSrcDirs), so its indices are not settings.
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...leafPaths(v, path));
    }
  }
  return out;
}

async function parseIfPresent(dir: string): Promise<unknown> {
  const path = findConfigFile(dir);
  if (path === null) return null;
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return null;
  }
  const confbox = await import('confbox');
  try {
    switch (extname(path)) {
      case '.json':
        return confbox.parseJSON(text);
      case '.jsonc':
        return confbox.parseJSONC(text);
      case '.toml':
        return confbox.parseTOML(text);
      case '.yaml':
      case '.yml':
        return confbox.parseYAML(text);
      default:
        return null;
    }
  } catch {
    // An unparseable file configures nothing, so every question is asked —
    // which is the right outcome: the user gets to set the values again.
    return null;
  }
}

/**
 * Dotted paths present in either config file. `repos.*` keys come from the
 * shared file and keep their `repos.` prefix, matching the question targets.
 */
export async function configuredPaths(env: XdgEnv): Promise<Set<string>> {
  const [fnc, shared] = await Promise.all([
    parseIfPresent(fncConfigDir(env)),
    parseIfPresent(sharedConfigDir(env)),
  ]);
  const out = new Set<string>();
  for (const p of leafPaths(fnc)) out.add(p);
  for (const p of leafPaths(shared)) out.add(p);
  return out;
}
