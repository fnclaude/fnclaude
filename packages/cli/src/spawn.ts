// Spawn a sibling fnclaude in a new terminal window. Ported from src/spawn.go
// (fnclaude/fnclaude Go reference).
//
// spawnSibling opens a new terminal window (via tmux or a user-configured
// launcher) and runs fnclaude there. It is "sibling, not child": the spawned
// argv is a terminal-emulator command that itself launches fnclaude, so the
// new session is unaffected when this process exits.
//
// The indirection via spawnFn lets tests inject a mock without launching
// real processes.

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import type { Config } from './config.js';
import { substitute } from './template.js';

// ── env cleaning ───────────────────────────────────────────────────────────

/**
 * Drop env vars that would mislead the new fnclaude session:
 *
 *  - FNC_SOCKET: points at *this* session's listener. The sibling must
 *    compute its own; leaking ours makes it dial back into us.
 *  - FNCLAUDE_HANDOFF: injected for *this* claude child; not the sibling's.
 *  - CLAUDE_CODE_SESSION_ID: scopes to this session only.
 *
 * Everything else (PATH, XDG_*, exec.env contributions) passes through so
 * the sibling inherits the same user environment.
 */
export function cleanEnvForSpawn(env: string[]): string[] {
  const drop = new Set(['FNC_SOCKET', 'FNCLAUDE_HANDOFF', 'CLAUDE_CODE_SESSION_ID']);
  const out: string[] = [];
  for (const e of env) {
    const eq = e.indexOf('=');
    const key = eq < 0 ? e : e.slice(0, eq);
    if (!drop.has(key)) out.push(e);
  }
  return out;
}

// ── selfPath ───────────────────────────────────────────────────────────────

/**
 * Return the absolute, symlink-resolved path to this fnclaude script,
 * suitable for `{bin}` substitution in a spawn-launcher template.
 *
 * Preference order mirrors prompts.ts (Unit 6):
 *  1. process.argv[1] — the CLI script path (anchors to the script, not the
 *     Bun interpreter).
 *  2. process.execPath — the Bun binary; fallback when argv[1] is absent.
 *
 * Symlinks are resolved so the spawned launcher gets the real path, not a
 * shim that might not be on the PATH inside the new window.
 */
export function selfPath(): string {
  const argv1 = process.argv.length > 1 ? process.argv[1] : undefined;
  let exe = argv1 !== undefined && argv1 !== '' ? argv1 : process.execPath;
  try {
    exe = realpathSync(exe);
  } catch {
    // symlink resolution failure is not fatal — use the unresolved path
  }
  return exe;
}

// ── autoDetectSpawnCommand ─────────────────────────────────────────────────

/**
 * Return a built-in launcher template when the host environment unambiguously
 * declares how to open a new window. Empty string means no match — caller
 * falls back to paste-flow.
 *
 * Only $TMUX is detected. Being inside tmux is an explicit declaration of the
 * windowing layer; "open a new tmux window in this session" is unambiguously
 * what the user wants. Earlier versions also sniffed $KITTY_WINDOW_ID,
 * $TERM_PROGRAM=WezTerm, $WT_SESSION, etc. — those were heuristic
 * conveniences that failed silently for any unlisted terminal. One
 * mechanism (auto.spawnCommand) surfaced in the paste-flow message is
 * strictly better than an allowlist that grows forever.
 */
export function autoDetectSpawnCommand(): string {
  if (process.env.TMUX) {
    return 'tmux new-window -d {bin} {dest} --name {name} @{summary}';
  }
  return '';
}

// ── buildSpawnArgv ─────────────────────────────────────────────────────────

/**
 * Tokenize tmpl on whitespace then substitute the four supported placeholders
 * within each token. No shell involvement: each whitespace-delimited token
 * becomes one argv entry verbatim, so a {dest} expanding to a path with
 * spaces remains a single argv entry.
 */
export function buildSpawnArgv(
  tmpl: string,
  bin: string,
  dest: string,
  name: string,
  summary: string,
): string[] {
  const vars: Record<string, string> = { bin, dest, name, summary };
  return tmpl.split(/\s+/).filter((t) => t.length > 0).map((t) => substitute(t, vars));
}

// ── SpawnFn type + spawnSibling ────────────────────────────────────────────

/**
 * The function type that actually starts the process. Tests inject a mock;
 * production uses the default (Bun.spawn detached).
 *
 * Returns true when a launcher was resolved and started; false when no
 * launcher is configured and no terminal could be auto-detected (caller
 * falls back to paste-flow). Throws on resolution/start failure.
 */
export type SpawnFn = (argv: string[], env: string[]) => void;

/**
 * Default SpawnFn: invoke argv[0] with argv[1:] via Bun.spawn, detached.
 * We release the handle immediately — the launcher (tmux, etc.) typically
 * returns in milliseconds after dispatching the new window; we don't care
 * about its exit code.
 */
function defaultSpawnFn(argv: string[], env: string[]): void {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error('spawn called with empty argv');
  // Bun.spawn: env is a Record<string,string> or string[]. We pass the
  // key=value array directly — Bun accepts it.
  const proc = Bun.spawn([cmd, ...args], {
    env: Object.fromEntries(
      env.map((e) => {
        const i = e.indexOf('=');
        return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)];
      }),
    ),
    stdin: null,
    stdout: null,
    stderr: null,
  });
  // Don't await — release and move on.
  void proc.exited.catch(() => undefined);
}

/**
 * spawnSibling launches a sibling fnclaude in a new window.
 *
 * Returns true when a launcher was resolved and started successfully; false
 * when no launcher is configured AND no terminal could be auto-detected
 * (caller falls back to paste-flow). Throws when a launcher was resolved but
 * failed to start.
 *
 * extraArgs is appended after the template-expanded portion, e.g. override
 * flags the caller wants to pass to the new session.
 */
export async function spawnSibling(
  cfg: Config,
  dest: string,
  name: string,
  summaryPath: string,
  extraArgs: string[],
  spawnFn: SpawnFn = defaultSpawnFn,
): Promise<boolean> {
  const bin = selfPath();

  let tmpl = cfg.auto.spawnCommand;
  if (!tmpl) {
    tmpl = autoDetectSpawnCommand();
  }
  if (!tmpl) {
    return false;
  }

  const argv = buildSpawnArgv(tmpl, bin, dest, name, summaryPath);
  if (argv.length === 0) {
    throw new Error(`spawn template produced empty argv: ${JSON.stringify(tmpl)}`);
  }
  const fullArgv = [...argv, ...extraArgs];

  const env = cleanEnvForSpawn(
    Object.entries(process.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`),
  );

  spawnFn(fullArgv, env);
  return true;
}
