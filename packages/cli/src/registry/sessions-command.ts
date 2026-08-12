/**
 * `fnc sessions` — human-readable dump of the live coordination-registry
 * entries (#350). The CLI counterpart of the fnc_sessions MCP tool: same
 * reader (readLiveEntries, with its lazy GC of dead entries), different
 * surface — a terminal listing for the human instead of JSON for the model.
 *
 * Dispatch matches the `mcp` subcommand shape: recognized ONLY at argv[0],
 * checked in main.ts before the general parseArgs (so "sessions" is never
 * misread as a repo reference).
 */

import { homedir } from 'node:os';

import type { RegistryEntry } from './RegistryEntry';
import { readLiveEntries } from './SessionRegistry';
import { computeRegistryDir } from './registry-path';

const SUBCOMMAND = 'sessions';

export function isSessionsSubcommand(args: readonly string[]): boolean {
  return args.length > 0 && args[0] === SUBCOMMAND;
}

/** Pure formatter — exposed for unit tests. */
export function formatSessions(entries: readonly RegistryEntry[]): string {
  if (!entries.length) {
    return 'No live fnclaude sessions.\n';
  }
  const lines: string[] = [
    `${entries.length} live fnclaude session${entries.length === 1 ? '' : 's'}:`,
    '',
  ];
  for (const entry of entries) {
    const name = entry.session.name ?? '(unnamed)';
    lines.push(`${name}  (${entry.session.id.slice(0, 8)})  pid ${entry.owner.pid}  ${entry.cwd}`);
    for (const claim of entry.claims) {
      const implicit = claim.implicit !== undefined ? `  [${claim.implicit}]` : '';
      const note = claim.note !== undefined ? `  — ${claim.note}` : '';
      lines.push(`  ${claim.mode.padEnd(9)}  ${claim.key}${implicit}${note}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Entry point for `fnc sessions`. Reads the registry dir, filters to live
 * entries (GC'ing dead ones as a side effect of the read), prints the
 * listing. Returns the process exit code.
 */
export function runSessionsCommand(): number {
  const dir = computeRegistryDir({
    env: process.env,
    platform: process.platform,
    home: homedir(),
  });
  process.stdout.write(formatSessions(readLiveEntries({ dir })));
  return 0;
}
