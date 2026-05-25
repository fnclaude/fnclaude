// Port of buildArgv + the helpers it composes (src/main.go, lines 745–858 in
// the Go reference). Constructs the final argv slice that fnclaude execs
// claude with.
//
// Layered behaviours, in order:
//   1. Per-extra-dir flag injection: --add-dir <dir>, --mcp-config <dir>/.mcp.json
//      when present, --settings <dir>/.claude/settings.json when present and
//      --setting-sources isn't already in passthrough.
//   2. Self-MCP injection: an inline --mcp-config <json> pointing at the
//      current fnclaude binary so the spawned claude can call our
//      fnc_restart / fnc_switch_project / fnc_copy_to_clipboard tools.
//      Gated on interactive sessions only.
//   3. Auto-tmux injection: --tmux when auto.tmux="worktree", a new
//      worktree is being created (worktreeSet && !worktreeMatched), and
//      neither --tmux nor --no-tmux is already in play.
//   4. System-prompt fragment injection: --append-system-prompt <merged-text>
//      composed by selectFragments + withAppendedSystemPrompts.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { InterceptedArgs } from './args.js';
import {
  nameInPassthrough as _nameInPassthrough,
  settingSourcesInPassthrough,
  tokenInPassthrough,
} from './passthrough.js';
import type { Config } from './config.js';
import { resolveSelfPath } from './paths.js';
import { isInteractiveSession, selectFragments, type PromptSet } from './prompts.js';

// Re-export the passthrough inspection helpers from their canonical home so
// callers can reach them via "./argv.js" — mirrors the Go reference where
// they sit next to buildArgv. The single-source-of-truth implementation
// stays in passthrough.ts.
export { settingSourcesInPassthrough, tokenInPassthrough };

// ── MCP self-injection ─────────────────────────────────────────────────────

/**
 * mcpConfigEntry mirrors the Go struct of the same name; one server entry
 * inside the --mcp-config JSON object.
 */
interface McpConfigEntry {
  command: string;
  args: string[];
}

/**
 * buildFnclaudeMCPConfigJSON returns the inline JSON string to pass as
 * --mcp-config so claude launches `fnclaude mcp` (or `fnclaude mcp --noop`)
 * as its MCP server subprocess. Returns null on any error — same defensive
 * pattern as Go's findPromptsDir symlink-resolution fallback: log nothing,
 * let the session launch without the MCP server rather than failing.
 *
 * Path resolution: prefer argv[1] (the CLI script) over execPath (the bun
 * interpreter) so the spawned `fnclaude mcp` runs the same CLI logic as
 * the launching process. Symlinks are followed (so a ~/.local/bin/fnc-dev
 * → repo/bin/fnclaude symlink resolves to the real binary path).
 */
export function buildFnclaudeMCPConfigJSON(noop: boolean): string | null {
  const exe = resolveSelfPath();

  const args = ['mcp'];
  if (noop) args.push('--noop');

  const cfg: { mcpServers: Record<string, McpConfigEntry> } = {
    mcpServers: {
      fnclaude: { command: exe, args },
    },
  };

  try {
    return JSON.stringify(cfg);
  } catch {
    return null;
  }
}

// ── system-prompt fragment merge ───────────────────────────────────────────

/**
 * withAppendedSystemPrompts returns a copy of `passthrough` with the given
 * `fragments` merged into a single --append-system-prompt value. Fragments
 * are joined with a blank-line separator. If `passthrough` already contains
 * a --append-system-prompt (either space-form or =form), the fragments are
 * appended to that existing value. Empty fragments are dropped. Returns
 * `passthrough` unchanged when no non-empty fragments remain.
 *
 * Never mutates the input slice.
 */
export function withAppendedSystemPrompts(
  passthrough: readonly string[],
  fragments: readonly string[],
): string[] {
  const clean = fragments.filter((f) => f !== '');
  if (clean.length === 0) return [...passthrough];

  const joined = clean.join('\n\n');
  for (let i = 0; i < passthrough.length; i++) {
    const t = passthrough[i] as string;
    if (t === '--append-system-prompt' && i + 1 < passthrough.length) {
      const out = [...passthrough];
      out[i + 1] = `${passthrough[i + 1] as string}\n\n${joined}`;
      return out;
    }
    if (t.startsWith('--append-system-prompt=')) {
      const existing = t.slice('--append-system-prompt='.length);
      const out = [...passthrough];
      out[i] = `--append-system-prompt=${existing}\n\n${joined}`;
      return out;
    }
  }
  return [...passthrough, '--append-system-prompt', joined];
}

// ── buildArgv ──────────────────────────────────────────────────────────────

/**
 * buildArgv constructs the argv slice to exec claude with, given the
 * fnclaude args at their final pipeline stage (`InterceptedArgs` — the
 * intercept must have run so `worktreeMatched` is meaningful), the user's
 * shell cwd (used to resolve relative extra-dir paths), the loaded config,
 * and the set of prompt fragments loaded from the install dir.
 *
 * Accepting `InterceptedArgs` makes the ordering invariant a compile-time
 * check: passing a `ParsedArgs` or `ResolvedArgs` is a type error,
 * preventing the auto-tmux gate from reading a stale `worktreeMatched`
 * value the parse stage couldn't know.
 *
 * `shellCWD` is the process working directory at fnclaude startup —
 * normally `process.cwd()`. It's threaded through (rather than reached for
 * directly) so tests can pin it without `chdir`-ing.
 */
export function buildArgv(
  a: InterceptedArgs,
  shellCWD: string,
  cfg: Config,
  prompts: PromptSet,
): string[] {
  const suppressSettings = settingSourcesInPassthrough(a.passthrough);

  const argv: string[] = ['claude'];

  // 1. Inject --add-dir (+ optional --mcp-config / --settings) per extra dir.
  for (const raw of a.extraDirs) {
    const d = isAbsolute(raw) ? raw : join(shellCWD, raw);
    argv.push('--add-dir', d);

    const mcpConfig = join(d, '.mcp.json');
    if (existsSync(mcpConfig)) {
      argv.push('--mcp-config', mcpConfig);
    }

    if (!suppressSettings) {
      const settings = join(d, '.claude', 'settings.json');
      if (existsSync(settings)) {
        argv.push('--settings', settings);
      }
    }
  }

  // 2. Inject the fnclaude self-MCP config (interactive sessions only).
  if (isInteractiveSession(a.passthrough)) {
    const configJSON = buildFnclaudeMCPConfigJSON(a.usedNoopFallback);
    if (configJSON !== null) {
      argv.push('--mcp-config', configJSON);
    }
  }

  // 3. Auto-inject --tmux per auto.tmux config.
  //
  // claude requires --worktree to be present when --tmux is used. The only
  // auto mode compatible with that constraint is "worktree", which fires
  // when the user is already creating a new worktree themselves:
  //
  //   "worktree" — inject --tmux when the user passed -w / --worktree for
  //                a NEW worktree (worktreeSet && !worktreeMatched).
  //                --worktree is already in passthrough; claude's
  //                constraint is satisfied without fnclaude having to
  //                generate worktrees itself.
  //   "never"    — no-op.
  //
  // fnclaude never auto-creates worktrees — that's always user-initiated.
  if (
    cfg.auto.tmux === 'worktree' &&
    !tokenInPassthrough(a.passthrough, '--tmux') &&
    !a.noTmux &&
    a.worktreeSet &&
    !a.worktreeMatched
  ) {
    argv.push('--tmux');
  }

  // 4. System-prompt fragments.
  const fragments = selectFragments(prompts, a.passthrough, a.usedNoopFallback);
  argv.push(...withAppendedSystemPrompts(a.passthrough, fragments));

  return argv;
}

// Re-export so callers that already import nameInPassthrough from argv.ts
// (parity with the Go file layout) don't have to reach into passthrough.
export const nameInPassthrough = _nameInPassthrough;
