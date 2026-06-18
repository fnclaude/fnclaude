// Optional in-process renderer mount. When selected, fnc OWNS the claude
// spawn and hosts the @fnclaude/renderer Ink app in its OWN process instead
// of spawning claude under a Bun.Terminal PTY (design.renderer.md §2,
// spawn-args.md §(b)/§(c)). Instead of letting the renderer spawn a dumb
// `claude` of its own, fnc threads its full pipeline — resolved claudeBin,
// composed childEnv, launch cwd, CLAUDE-native args, and the initial prompt —
// into the renderer via an injected SpawnFn and MountOptions.
//
// The renderer is an OPTIONAL dependency: it may not be installed, and the
// sibling PR that lands the new `mountRenderer` signature (opts + close())
// may not have merged yet — so every path here is defensive. A missing/old
// renderer must degrade to the normal PTY launch, never crash, and an old
// mountRenderer that ignores opts / lacks close() must still mount cleanly.

// --- Structural contract types ------------------------------------------
//
// These mirror the renderer's exported shapes but are defined LOCALLY: the
// renderer side lands in a separate PR, so the cli must not depend on it
// exporting these. Structural typing means a real renderer satisfies them.

/** Low-level spawn result the renderer's SpawnFn returns. */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}

/**
 * The spawn seam the renderer accepts. The renderer passes its hard-coded
 * `["claude", ...REQUIRED_ARGS, ...extraArgs]` command; fnc's closure swaps
 * cmd[0] for the resolved claudeBin and bakes in env + piped stderr.
 */
export type SpawnFn = (cmd: string[], opts: { cwd?: string }) => SpawnResult;

/** Options fnc threads into `mountRenderer`. */
export interface MountOptions {
  /** Launch cwd for the claude child (fnc's resolved cwd, not process.cwd). */
  cwd?: string;
  /** CLAUDE-native args (model/effort/resume/append-system-prompt/self-MCP). */
  extraArgs?: string[];
  /** fnc-built spawn baking in claudeBin + childEnv + stderr:"pipe". */
  spawnFn?: SpawnFn;
  /** Delivered as the renderer's first sendUserTurn (prompt / ultracode seed). */
  initialPrompt?: string;
}

/**
 * Handle returned by the renderer's `mountRenderer`. `sendUserTurn`/`close`
 * are the NEW additions from the sibling refactor — an old renderer returns
 * only `waitUntilExit`/`unmount`, so callers MUST guard the new methods with
 * `typeof` before use.
 */
export interface RendererHandle {
  waitUntilExit(): Promise<void>;
  unmount(): void;
  sendUserTurn?(text: string): void;
  /** Resolves with claude's exit code once the child is reaped. */
  close?(): Promise<number>;
}

/** The shape we consume from `@fnclaude/renderer`. */
interface RendererModule {
  mountRenderer: (opts?: MountOptions) => RendererHandle;
}

/** Bun.spawn-compatible options for the low-level spawn the SpawnFn drives. */
interface SpawnProcOptions {
  cwd?: string;
  env: Record<string, string>;
  stdin: 'pipe';
  stdout: 'pipe';
  stderr: 'pipe';
}

/** Injectable low-level spawn (Bun.spawn in production; stubbed in tests). */
export type SpawnProc = (cmd: string[], opts: SpawnProcOptions) => SpawnResult;

/**
 * Renderer-mode selector. Driven by the `FNC_RENDERER` env var so it stays
 * non-invasive (no argv/config surface yet — a CLI flag can come later).
 * Truthy values are exactly "1" and "true" (case-insensitive); everything
 * else — unset, empty, "0", "false", "yes", arbitrary garbage — is off.
 */
export function shouldUseRenderer(env: Record<string, string | undefined>): boolean {
  const raw = env.FNC_RENDERER;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Args the renderer re-supplies itself (claude-process.ts REQUIRED_ARGS). */
const PRINT_FAMILY_FLAGS = new Set([
  '--print',
  '-p',
  '--verbose',
  '--input-format',
  '--output-format',
]);

/**
 * Derive the renderer's `extraArgs` from fnc's fully-assembled claudeArgs.
 *
 * Strips:
 *   - `--tmux` (PTY-only; the renderer has no PTY — spawn-args.md §A.2)
 *   - the `--print`/`--verbose`/`--input-format`/`--output-format` family
 *     and their stream-json values (the renderer prepends REQUIRED_ARGS)
 *   - the prompt-body `--` tail (the prompt rides as initialPrompt — verified
 *     live: a positional prompt is NOT read under `--input-format stream-json`)
 *
 * Keeps the self-MCP `--mcp-config`, `--model`/`--effort`/`--resume`/
 * `--append-system-prompt`, and any generic passthrough.
 *
 * Appends `--permission-mode bypassPermissions` (unless the user already set
 * a `--permission-mode`): in `--print` stream-json mode every gated tool is
 * silently auto-denied unless a mode is set, and we must NOT silently inherit
 * settings.json's defaultMode (permission-spike.md §"contamination trap").
 */
export function buildRendererArgs(claudeArgs: readonly string[]): string[] {
  const out: string[] = [];
  let userSetPermissionMode = false;
  for (let i = 0; i < claudeArgs.length; i++) {
    const tok = claudeArgs[i]!;
    if (tok === '--') break; // drop the prompt-body tail
    if (tok === '--tmux') continue;
    if (tok === '--permission-mode') {
      userSetPermissionMode = true;
      out.push(tok);
      continue;
    }
    if (PRINT_FAMILY_FLAGS.has(tok)) {
      // --input-format / --output-format carry a value; skip it too.
      if (tok === '--input-format' || tok === '--output-format') i++;
      continue;
    }
    out.push(tok);
  }
  if (!userSetPermissionMode) {
    out.push('--permission-mode', 'bypassPermissions');
  }
  return out;
}

/** Narrowing guard: did the dynamic import resolve a usable renderer? */
function hasMountRenderer(mod: unknown): mod is RendererModule {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    typeof (mod as { mountRenderer?: unknown }).mountRenderer === 'function'
  );
}

/**
 * Build the fnc SpawnFn closure. The renderer calls it with its hard-coded
 * `["claude", ...]` command; we swap cmd[0] for the resolved claudeBin and
 * delegate to the low-level spawnProc, which bakes in the composed childEnv
 * and PIPES stderr (NOT "inherit" — Ink owns the real TTY, so any claude
 * stderr byte on the inherited fd corrupts the render; spawn-args.md §b.2),
 * draining it to the fnc logger.
 */
function makeFncSpawn(deps: {
  claudeBin: string;
  childEnv: Record<string, string>;
  spawnProc: SpawnProc;
}): SpawnFn {
  return (cmd, { cwd }) => {
    const argv = [deps.claudeBin, ...cmd.slice(1)];
    return deps.spawnProc(argv, {
      ...(cwd !== undefined ? { cwd } : {}),
      env: deps.childEnv,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  };
}

export interface MaybeMountRendererArgs {
  env: Record<string, string | undefined>;
  /** fnc's resolved claude binary (findClaude), NOT the bare string "claude". */
  claudeBin: string;
  /** composeEnv output: FNC_SOCKET in, FNC_ARGS_JSON stripped. */
  childEnv: Record<string, string>;
  /** fnc's resolved launch cwd. */
  cwd: string;
  /** claudeArgs minus fnc-only/PTY-only/print-family (buildRendererArgs). */
  rendererArgs: string[];
  /**
   * Delivered as the renderer's first sendUserTurn. The prompt body for a
   * normal launch; `/effort ultracode` for an ultracode launch (spawn-args.md
   * §A.3 — claude intercepts `/effort` over the pipe).
   */
  initialPrompt?: string;
  /**
   * A SECOND user turn sent after mount (ultracode: the real seed prompt that
   * follows `/effort ultracode`). Only delivered when the handle exposes
   * `sendUserTurn` (the §7 refactor); an old handle silently drops it.
   */
  followUpPrompt?: string;
  /**
   * Injectable import seam (testability). Defaults to the real dynamic
   * import of the optional dependency. Returns the module namespace.
   */
  importRenderer?: () => Promise<unknown>;
  /** Low-level spawn seam. Defaults to a Bun.spawn-backed proc. */
  spawnProc?: SpawnProc;
  /** Diagnostic sink for the one-line degrade notice. Defaults to stderr. */
  warn?: (line: string) => void;
  /** Sink for drained claude stderr. Defaults to the degrade `warn`. */
  onStderr?: (line: string) => void;
  /** Process exit seam (testability). Defaults to process.exit. */
  exit?: (code: number) => never;
}

/** Production low-level spawn: Bun.spawn with piped stdio, draining stderr. */
function makeProdSpawnProc(onStderr: (line: string) => void): SpawnProc {
  return (cmd, opts) => {
    const proc = Bun.spawn(cmd, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: opts.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Drain claude's stderr to the logger — NEVER the TTY (Ink owns it).
    void (async () => {
      try {
        const text = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
        if (text.trim() !== '') onStderr(text.trimEnd());
      } catch {
        // best-effort — a stderr drain failure must not break the session
      }
    })();
    return {
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stdin: proc.stdin as WritableStream<Uint8Array>,
      exited: proc.exited,
      kill: () => proc.kill(),
    };
  };
}

/**
 * Decide and, if selected, mount the in-process renderer with fnc owning the
 * claude spawn.
 *
 * Returns true ONLY when the renderer was actually mounted (and has since
 * exited) — in which case the caller skips both launch-fork branches. When
 * the mounted handle exposes `close()`, this reaps claude's exit code and
 * calls `exit(code)` so fnc's status mirrors claude's. An old handle without
 * `close()` falls back to a clean `await waitUntilExit()` + return true (the
 * caller then exits 0, exactly as before this PR).
 *
 * Returns false in every other case (selector unset, import failed, module
 * lacks `mountRenderer`), so the caller falls through to the normal
 * PTY/inherit launch. A missing or pre-refactor renderer is never fatal.
 */
export async function maybeMountRenderer(args: MaybeMountRendererArgs): Promise<boolean> {
  const { env } = args;
  if (!shouldUseRenderer(env)) return false;

  const importRenderer = args.importRenderer ?? (() => import('@fnclaude/renderer'));
  const warn = args.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const onStderr = args.onStderr ?? warn;
  const exit = args.exit ?? ((code: number) => process.exit(code));
  const spawnProc = args.spawnProc ?? makeProdSpawnProc(onStderr);

  let mod: unknown;
  try {
    mod = await importRenderer();
  } catch {
    warn('fnc: renderer requested but @fnclaude/renderer is not installed; launching normally');
    return false;
  }

  if (!hasMountRenderer(mod)) {
    warn(
      'fnc: renderer requested but @fnclaude/renderer mountRenderer unavailable; launching normally',
    );
    return false;
  }

  // fnc owns the spawn: thread claudeBin + childEnv + cwd into the SpawnFn,
  // and the CLAUDE-native args + prompt into MountOptions.
  const spawnFn = makeFncSpawn({
    claudeBin: args.claudeBin,
    childEnv: args.childEnv,
    spawnProc,
  });

  const opts: MountOptions = {
    cwd: args.cwd,
    extraArgs: args.rendererArgs,
    spawnFn,
    ...(args.initialPrompt !== undefined && args.initialPrompt !== ''
      ? { initialPrompt: args.initialPrompt }
      : {}),
  };

  const handle = mod.mountRenderer(opts);

  // Ultracode delivers a second turn (the real seed prompt) after the
  // `/effort ultracode` initialPrompt. Only the §7 handle exposes
  // sendUserTurn — an old handle drops the follow-up rather than crashing.
  if (
    args.followUpPrompt !== undefined &&
    args.followUpPrompt !== '' &&
    typeof handle.sendUserTurn === 'function'
  ) {
    handle.sendUserTurn(args.followUpPrompt);
  }

  await handle.waitUntilExit();

  // The §7 refactor adds close() (reaps claude's exit code). An old handle
  // lacks it — degrade to a clean return (caller exits 0) rather than crash.
  if (typeof handle.close === 'function') {
    const code = await handle.close();
    exit(code);
  }
  return true;
}
