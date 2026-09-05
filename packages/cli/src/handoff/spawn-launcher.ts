/**
 * §8.3 — spawn-launcher decision + dispatch for `fnc_spawn_session`.
 *
 * Decision order (per design.mcp.md §4.3):
 *
 *   1. `auto.spawnCommand` from config — tokenize on whitespace,
 *      substitute `{bin}` / `{dest}` / `{name}` / `{summary}` per token.
 *   2. `$TMUX` in env — use the built-in
 *      `tmux new-window -d {bin} {dest} --name {name} @{summary}`
 *      template. Being inside tmux is an explicit declaration that
 *      tmux is the windowing layer.
 *   3. Nothing — caller falls back to paste-flow.
 *
 * Earlier ports also sniffed `$KITTY_WINDOW_ID`, `$TERM_PROGRAM=WezTerm`,
 * and `$WT_SESSION`. Those allowlist heuristics grew indefinitely and
 * silently failed for everyone else. The `auto.spawnCommand` config
 * knob is strictly better: one surface, every terminal.
 *
 * Ports Go canonical's `spawnSiblingImpl` + `autoDetectSpawnCommand` +
 * `buildSpawnArgv` from `fnclaude/src/spawn.go`. Substitution
 * is per-token after whitespace splitting — a `{dest}` expanding to a
 * path with spaces stays one argv entry, no shell involvement.
 *
 * Pure module: no I/O, no env reads, no Bun.spawn calls of its own.
 * The caller supplies env, fncBin, the spawn function, and the
 * autoSpawnCommand config value. Tests inject everything.
 */

const TMUX_TEMPLATE = 'tmux new-window -d {bin} {dest} --name {name} @{summary}';

/**
 * Minimal spawn surface the launcher exercises. The real shape is a
 * thin adapter over `Bun.spawn` in production (see {@link defaultSpawn}).
 */
export interface SpawnFn {
  (
    argv: readonly string[],
    opts: { env: Record<string, string> },
  ): { unref?: () => void };
}

export interface ChooseAndSpawnArgs {
  /** `cfg.auto.spawnCommand` — empty string means "not configured". */
  autoSpawnCommand: string;
  /** Env to consult for `$TMUX` auto-detection. */
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Cleaned env to pass through to the spawn (already scrubbed of session vars). */
  spawnEnv: Record<string, string>;
  /** Absolute fnclaude binary path for `{bin}` substitution. */
  fncBin: string;
  /** `{dest}` substitution — destination project ref / path. */
  dest: string;
  /** `{name}` substitution — session label. */
  name: string;
  /** `{summary}` substitution — absolute path to the written summary file. */
  summary: string;
  /** Override extras to append after the templated argv (override flags from applyOverrides). */
  extraArgs: readonly string[];
  /** Injected spawn fn (production: {@link defaultSpawn}). */
  spawn: SpawnFn;
}

export type ChooseAndSpawnResult =
  | { ok: true }
  /** No launcher resolved — caller falls back to paste-flow. `command` is the
   *  rendered relaunch command for the user to paste. */
  | { ok: false; command: string };

/**
 * Pick a launcher and dispatch. Returns `{ ok: true }` on a clean
 * `spawn()` call; returns `{ ok: false, command }` when neither
 * `autoSpawnCommand` nor `$TMUX` resolved a template.
 *
 * Throws only when a launcher WAS resolved but `spawn` itself threw —
 * matches Go canonical's `(false, err)` shape (caller surfaces the
 * error response). Empty-argv-from-template is also an error.
 */
export function chooseAndSpawn(args: ChooseAndSpawnArgs): ChooseAndSpawnResult {
  const tmpl = pickTemplate(args.autoSpawnCommand, args.env);
  if (tmpl === '') {
    return { ok: false, command: renderSpawnCommand(args) };
  }

  const argv = buildSpawnArgv(tmpl, args.fncBin, args.dest, args.name, args.summary);
  if (argv.length === 0) {
    throw new Error(`spawn template produced empty argv: ${JSON.stringify(tmpl)}`);
  }
  const fullArgv = [...argv, ...args.extraArgs];

  const proc = args.spawn(fullArgv, { env: args.spawnEnv });
  // Detach so the launcher (tmux, kitty @, etc.) can outlive the parent.
  // tmux's `-d` already does the daemonization; unref is best-effort
  // belt-and-braces for spawners that wait by default.
  try {
    proc.unref?.();
  } catch {
    // ignore — process already detached
  }
  return { ok: true };
}

/**
 * Decide which launcher template to use:
 *
 *   - Non-empty `autoSpawnCommand` wins.
 *   - `$TMUX` non-empty → built-in tmux template.
 *   - Otherwise empty string (caller falls back to paste-flow).
 */
function pickTemplate(
  autoSpawnCommand: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  if (autoSpawnCommand !== '') return autoSpawnCommand;
  const tmux = env.TMUX;
  if (typeof tmux === 'string' && tmux !== '') return TMUX_TEMPLATE;
  return '';
}

/**
 * Whitespace-tokenize `tmpl`, then per-token substitute the four
 * placeholders. No shell involvement — each token becomes one argv
 * entry verbatim. A `{dest}` expanding to a path with spaces stays
 * one argv entry.
 */
export function buildSpawnArgv(
  tmpl: string,
  bin: string,
  dest: string,
  name: string,
  summary: string,
): string[] {
  // .split(/\s+/) leaves a leading "" when tmpl starts with whitespace;
  // filter empties to match Go's strings.Fields behavior.
  const tokens = tmpl.split(/\s+/).filter((t) => t !== '');
  const out: string[] = [];
  for (const t of tokens) {
    out.push(
      t
        .replaceAll('{bin}', bin)
        .replaceAll('{dest}', dest)
        .replaceAll('{name}', name)
        .replaceAll('{summary}', summary),
    );
  }
  return out;
}

/**
 * Render the user-visible relaunch command for paste-flow Responses.
 * Mirrors Go canonical's `renderSpawnCommand`: `fnclaude <dest> --name
 * <name> @<summary> [extra args]`. Override values are controlled-
 * vocabulary strings (model aliases, effort levels, etc.); space-
 * joining them is shell-safe by construction.
 */
export function renderSpawnCommand(args: {
  dest: string;
  name: string;
  summary: string;
  extraArgs: readonly string[];
}): string {
  let cmd = `fnclaude ${args.dest} --name ${args.name} @${args.summary}`;
  if (args.extraArgs.length > 0) {
    cmd += ' ' + args.extraArgs.join(' ');
  }
  return cmd;
}

/**
 * Production spawn adapter. Thin wrapper over `Bun.spawn` — pipes nothing,
 * inherits no stdio (the spawned launcher is its own session under its
 * own terminal). Detached so the launcher outlives the parent fnclaude.
 */
export const defaultSpawn: SpawnFn = (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    env: opts.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return {
    unref(): void {
      proc.unref();
    },
  };
};
