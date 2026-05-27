// Port of run() + main() from src/main.go (Go reference).
//
// The integration layer. Composes the already-ported modules into the
// fnclaude orchestration loop:
//
//   1. Parse argv (with --help / --version / `mcp` subcommand short-circuits)
//   2. Resolve user-typed cwd into an absolute path (path + repo lookups)
//   3. Apply -w worktree intercept (may swap cwd to an existing worktree)
//   4. Auto-name if the invocation qualifies (--, prompt, no --name, etc.)
//   5. Sanitize any --name / -n values to a path-safe slug
//   6. Build the claude argv (extra-dirs, self-MCP, auto-tmux, prompts)
//   7. Spawn claude under a PTY with the AF_UNIX socket listener active
//   8. On exit:
//        - If the listener fired (auto-handoff): silentRelaunchHandoff
//        - Else if claude printed a cross-cwd marker: silentRelaunch
//        - Else: propagate claude's exit code

import { homedir } from 'node:os';
import process from 'node:process';
import { isAbsolute, join } from 'node:path';
import {
  defaultLlmClient,
  claudeCliFn,
  extractPrompt,
  generateName,
  shouldAutoName,
  type LlmClientFn,
} from './autoname.js';
import { parseArgs } from './argParser.js';
import {
  brandResolved,
  withPassthroughUpdate,
  withResolved,
  type InterceptedArgs,
  type ResolvedArgs,
} from './args.js';
import { buildArgv } from './argv.js';
import { loadConfig, type Config } from './config.js';
import { handoffSocketPath, type HandoffSpec } from './handoff.js';
import { helpText, version, wantsHelp, wantsVersion } from './help.js';
import { loadHostAliases } from './hostAliases.js';
import { expandTildePath } from './paths.js';
import { loadPrompts, type PromptSet } from './prompts.js';
import { detectCrossCwd, runWithPTY } from './pty.js';
import { loadRepoSettings } from './repoSettings.js';
import { Resolve, type RepoSettings, type ResolveDeps } from './resolver.js';
import { sanitizeNamesInPassthrough } from './sanitize.js';
import { runMCPServer } from './mcp/client.js';
import { seedNoop } from './noop.js';
import { silentRelaunch, silentRelaunchHandoff } from './silentRelaunch.js';
import { applyWorktreeIntercept, type GitRunner } from './worktree.js';
import { flushWarnings } from './warnings.js';
import { errorMessage } from './errors.js';

/**
 * `RunIO` — process-shaped seams. Streams, paths, the launch environment,
 * and the external behaviour the pipeline depends on (claude binary
 * lookup, PTY runner, relaunch, MCP dispatcher, noop seeder, autoname
 * LLM call). Plus the *inner* dependency seams of the pipeline modules
 * themselves — `gitRunner` (consumed by applyWorktreeIntercept) and
 * `resolveDeps` (consumed by Resolve) — surfaced here so tests can swap
 * the I/O each module does without a wrapper layer of outer functions.
 *
 * Earlier shape had both outer (`RunDeps.applyWorktreeIntercept`) and
 * inner (`applyWorktreeIntercept`'s `GitRunner` parameter) seams for the
 * same boundary. Collapsed to the inner seam only — the outer one was
 * dead weight in production (the function never varies) and in tests it
 * just wrapped the inner seam with two extra lines of closure plumbing.
 */
export interface RunIO {
  /** Source argv (typically `process.argv.slice(2)`). */
  argv?: readonly string[];
  /** Stream where the help/version/error text is written. */
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** User's home directory. */
  home?: string;
  /** Shell cwd at startup. */
  cwd?: string;

  /** PATH lookup for the claude binary; returns undefined when not found. */
  lookupClaude?: (name: string) => string | undefined;
  /** Override the run-with-pty step. */
  runWithPTY?: typeof runWithPTY;
  /** Override the silent-relaunch step (cross-cwd resume). */
  silentRelaunch?: typeof silentRelaunch;
  /** Override the silent-relaunch-handoff step. */
  silentRelaunchHandoff?: typeof silentRelaunchHandoff;
  /** Override runMCPServer (the `mcp` subcommand dispatcher). */
  runMCPServer?: typeof runMCPServer;
  /** Override seedNoop (best-effort dir seeder). */
  seedNoop?: typeof seedNoop;
  /** Override generateName for auto-name (skip the LLM call). */
  generateName?: typeof generateName;

  /**
   * GitRunner for applyWorktreeIntercept. Tests that want to drive a
   * fake `git worktree list` reply pass one here; production uses the
   * module's `defaultGitRunner`.
   */
  gitRunner?: GitRunner;

  /**
   * Resolver I/O seams (path-exists check, gh CLI, clone). Tests pass a
   * stub set so the resolver runs without touching the network or
   * filesystem; production uses `productionDeps()` from resolver.ts.
   */
  resolveDeps?: ResolveDeps;
}

/**
 * `RunConfig` — pre-loaded data the pipeline reads. When a field is
 * supplied here, the corresponding loader (loadConfig / loadPrompts /
 * loadRepoSettings / loadHostAliases) is skipped and the supplied value
 * is used directly. Tests build a hermetic config payload up-front; in
 * production every field is omitted and the loaders run for real.
 *
 * These were previously expressed as `loadConfig: typeof loadConfig`
 * function seams in the unified `RunDeps`. The 1:1 thin-wrapper pattern
 * was double-injection — in production they have zero variance, and in
 * tests they were always loader stubs that returned a fixed payload.
 * Storing the payload directly removes a layer of function plumbing.
 */
export interface RunConfig {
  /** Pre-loaded config. Omit to call `loadConfig()`. */
  config?: Config;
  /** Pre-loaded prompts. Omit to call `loadPrompts()`. */
  prompts?: PromptSet;
  /** Pre-loaded repo settings. Omit to call `loadRepoSettings(home, cwd)`. */
  repoSettings?: RepoSettings;
  /** Pre-loaded host aliases. Omit to call `loadHostAliases(home)`. */
  hostAliases?: Record<string, string>;
}

/**
 * Top-level deps for `run()` — two named groups (`io` and `data`),
 * each optional, each with optional fields. Tests typically populate
 * only the fields they care about. Production omits everything (passes
 * `{}` or nothing) and lets every default kick in.
 */
export interface RunDeps {
  /** Process-shaped seams (streams, env, external behaviours). */
  io?: RunIO;
  /** Pre-loaded data payloads (skips the corresponding loaders). */
  data?: RunConfig;
}

function lookupClaudeFromPath(name: string): string | undefined {
  // Bun's PATH lookup: Bun.which() returns null when not found. Coerce to
  // undefined to keep the absent-value sentinel consistent with the rest of
  // the codebase.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunWhich = (globalThis as any).Bun?.which;
  if (typeof bunWhich === 'function') {
    return bunWhich(name) ?? undefined;
  }
  // Fallback: walk PATH ourselves. Avoid `which` shell-out — synchronous and
  // brittle. Use spawnSync('which', [name]) only if Bun.which is unavailable
  // and we're not on Windows.
  return undefined;
}

/**
 * The main run loop. Returns the integer exit code that the caller should
 * pass to `process.exit`. Never calls `process.exit` itself — that's left
 * to `main()` so tests can introspect the return value.
 *
 * On the silent-relaunch paths (cross-cwd resume or auto-handoff), the
 * silentRelaunch* implementations replace the process image on POSIX and
 * therefore never return. On any failure mode of the relaunch, we fall
 * through to returning claude's exit code, mirroring Go's behavior.
 */
export async function run(deps: RunDeps = {}): Promise<number> {
  const io = deps.io ?? {};
  const data = deps.data ?? {};

  const argv = io.argv ?? process.argv.slice(2);
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const home = io.home ?? process.env.HOME ?? homedir();
  const shellCWD = io.cwd ?? process.cwd();
  const lookupClaude = io.lookupClaude ?? lookupClaudeFromPath;
  const runPTY = io.runWithPTY ?? runWithPTY;
  const relaunch = io.silentRelaunch ?? silentRelaunch;
  const relaunchHandoff = io.silentRelaunchHandoff ?? silentRelaunchHandoff;
  const seedNoopFn = io.seedNoop ?? seedNoop;
  const generateNameFn = io.generateName ?? generateName;
  const runMCPServerFn = io.runMCPServer ?? runMCPServer;

  // Defer-flush warnings on exit, AFTER claude has finished and the user is
  // back at their shell. The silent-relaunch path uses execve which skips
  // this defer; that's intentional — the relaunched fnclaude will re-emit
  // any warnings that still apply.
  //
  // Loaders (loadConfig / loadRepoSettings / loadHostAliases / loadPrompts)
  // and other setup steps return their warnings; we accumulate them in this
  // local list and drain it via flushWarnings at the deferred-flush point.
  // No module-global sink — keeps tests hermetic.
  const warnings: string[] = [];
  let flushed = false;
  const flushOnce = (): void => {
    if (flushed) return;
    flushed = true;
    flushWarnings(warnings, stderr);
  };

  try {
    // ── --help / --version short-circuits (mirror Go's run()). ────────────
    if (wantsHelp(argv)) {
      stdout.write(helpText);
      return 0;
    }
    if (wantsVersion(argv)) {
      stdout.write(`fnclaude ${version}\n`);
      return 0;
    }

    // ── `fnclaude mcp` subcommand dispatch. ──────────────────────────────
    if (argv.length >= 1 && argv[0] === 'mcp') {
      let noop = false;
      for (const a of argv.slice(1)) {
        if (a === '--noop') noop = true;
      }
      return await runMCPServerFn({
        noop,
        stdin: process.stdin,
        stdout: process.stdout,
        socketPath: process.env.FNC_SOCKET ?? '',
      });
    }

    // ── Parse fnclaude's own argv. ────────────────────────────────────────
    let parsed;
    try {
      parsed = parseArgs(argv, home);
    } catch (err) {
      stderr.write(`${errorMessage(err)}\n`);
      return 1;
    }

    // ── Seed the noop dir iff fallback was used. ─────────────────────────
    if (parsed.usedNoopFallback) {
      try {
        await seedNoopFn(parsed.cwd);
      } catch (err) {
        warnings.push(`fnclaude: noop seed failed: ${errorMessage(err)}`);
      }
    }

    // ── Config: pre-loaded or freshly loaded from disk. ──────────────────
    let cfg: Config;
    if (data.config !== undefined) {
      cfg = data.config;
    } else {
      const loaded = loadConfig();
      cfg = loaded.config;
      warnings.push(...loaded.warnings);
    }

    // ── Repo-reference resolver (path-or-repo two-lookup). ───────────────
    //
    // Produces a `ResolvedArgs` either way — the resolver path overwrites
    // cwd (and possibly worktreeSet/worktreeArg), the tilde-only path
    // expands cwd, and the absolute-path / noop-fallback path stamps the
    // existing fields straight through.
    let resolved: ResolvedArgs;
    if (
      !parsed.usedNoopFallback &&
      parsed.cwd !== '' &&
      !isAbsolute(parsed.cwd) &&
      !parsed.cwd.startsWith('~')
    ) {
      let rs: RepoSettings;
      if (data.repoSettings !== undefined) {
        rs = data.repoSettings;
      } else {
        const loaded = loadRepoSettings(home, shellCWD);
        rs = loaded.settings;
        warnings.push(...loaded.warnings);
      }
      let aliases: Record<string, string>;
      if (data.hostAliases !== undefined) {
        aliases = data.hostAliases;
      } else {
        const loaded = loadHostAliases(home);
        aliases = loaded.aliases;
        warnings.push(...loaded.warnings);
      }
      let result;
      try {
        // Resolver's inner deps (path-exists, gh CLI, clone): use the
        // injected ones in tests, fall back to productionDeps in real
        // runs. Passing `undefined` lets Resolve default-construct
        // productionDeps() itself.
        result = await (io.resolveDeps
          ? Resolve(
              {
                input: parsed.cwd,
                cwd: shellCWD,
                home,
                settings: rs,
                hostAliases: aliases,
              },
              io.resolveDeps,
            )
          : Resolve({
              input: parsed.cwd,
              cwd: shellCWD,
              home,
              settings: rs,
              hostAliases: aliases,
            }));
      } catch (err) {
        stderr.write(`${errorMessage(err)}\n`);
        return 1;
      }
      // If the user's reference had a +workspace suffix AND they didn't
      // pass -w explicitly, propagate the workspace to the intercept
      // layer.
      const promoteWorkspace = !!result.workspace && !parsed.worktreeSet;
      resolved = withResolved(parsed, {
        cwd: result.path,
        ...(promoteWorkspace
          ? { worktreeSet: true, worktreeArg: result.workspace! }
          : {}),
      });
    } else if (parsed.cwd.startsWith('~')) {
      // Tilde-expand absolute-shaped inputs that didn't go through the
      // resolver (resolver expands tildes for its short-circuit path, but
      // it isn't called for tilde-prefixed inputs here).
      resolved = withResolved(parsed, { cwd: expandTildePath(parsed.cwd) });
    } else {
      resolved = brandResolved(parsed);
    }

    // ── -w / --worktree intercept. ───────────────────────────────────────
    //
    // GitRunner is the inner seam — production uses the module's default
    // (synchronous `git -C <dir> ...`); tests inject a stub that yields
    // the fake `git worktree list --porcelain` shape they want.
    const intercepted = io.gitRunner
      ? applyWorktreeIntercept(resolved, shellCWD, io.gitRunner)
      : applyWorktreeIntercept(resolved, shellCWD);

    // ── Resolve the launch cwd relative to shell cwd. ────────────────────
    const launchCWD = isAbsolute(intercepted.cwd)
      ? intercepted.cwd
      : join(shellCWD, intercepted.cwd);

    // ── Auto-name if qualifying. ──────────────────────────────────────────
    let named: InterceptedArgs = intercepted;
    if (shouldAutoName(named.passthrough)) {
      const prompt = extractPrompt(named.passthrough);
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      const llmFn: LlmClientFn = apiKey
        ? defaultLlmClient(apiKey)
        : claudeCliFn(cfg.name.model);
      const name = await generateNameFn(prompt, cfg.name, apiKey, llmFn);
      named = withPassthroughUpdate(named, {
        passthrough: ['--name', name, ...named.passthrough],
      });
    }

    // ── Sanitize any --name / -n value to a path-safe slug. ──────────────
    const sanitizeResult = sanitizeNamesInPassthrough(named.passthrough);
    warnings.push(...sanitizeResult.warnings);
    const sanitized = withPassthroughUpdate(named, {
      passthrough: sanitizeResult.args,
    });

    // ── Build the claude argv. ───────────────────────────────────────────
    let prompts: PromptSet;
    if (data.prompts !== undefined) {
      prompts = data.prompts;
    } else {
      const loaded = loadPrompts();
      prompts = loaded.prompts;
      warnings.push(...loaded.warnings);
    }

    const claudeArgv = buildArgv(sanitized, shellCWD, cfg, prompts);

    // ── Verify claude is on PATH before starting the PTY. ────────────────
    if (lookupClaude('claude') === undefined) {
      stderr.write(`fnclaude: claude not found in PATH\n`);
      return 1;
    }

    // ── Build the auto-handoff spec. ─────────────────────────────────────
    const hspec: HandoffSpec = {
      mode: cfg.auto.handoff,
      socketPath: handoffSocketPath(process.pid),
      originalArgs: [...argv],
    };

    const { exitCode, tail, handoffArgv } = await runPTY({
      claudeArgv,
      launchCWD,
      cfg,
      handoff: hspec,
    });

    // ── Auto-handoff fires first. ────────────────────────────────────────
    if (handoffArgv !== undefined && handoffArgv.length > 0) {
      // Flush deferred warnings before relaunch since execve replaces the
      // process image (the deferred flush below would be skipped).
      flushOnce();
      relaunchHandoff(handoffArgv);
      // If we get here, execve failed; fall through to cross-cwd detection
      // (won't match in practice) and return claude's exit code.
    }

    // ── Cross-cwd redirect detection. ────────────────────────────────────
    if (tail !== undefined) {
      const hit = detectCrossCwd(tail);
      if (hit !== undefined) {
        flushOnce();
        relaunch(argv, hit.dest, hit.uuid);
        // Same fallthrough as above.
      }
    }

    return exitCode;
  } finally {
    flushOnce();
  }
}

/**
 * Process entry point. Invokes `run()` and exits with its return code.
 * Tests should call `run()` directly so they can introspect the value.
 */
export async function main(): Promise<void> {
  let code: number;
  try {
    code = await run();
  } catch (err) {
    process.stderr.write(`fnclaude: fatal: ${errorMessage(err)}\n`);
    code = 1;
  }
  process.exit(code);
}
