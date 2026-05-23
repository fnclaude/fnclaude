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
import { buildArgv } from './argv.js';
import { loadConfig } from './config.js';
import { handoffSocketPath, type HandoffSpec } from './handoff.js';
import { helpText, version, wantsHelp, wantsVersion } from './help.js';
import { loadHostAliases } from './hostAliases.js';
import { expandTildePath } from './paths.js';
import { loadPrompts } from './prompts.js';
import { detectCrossCwd, runWithPTY } from './pty.js';
import { loadRepoSettings } from './repoSettings.js';
import { Resolve } from './resolver.js';
import { sanitizeNamesInPassthrough } from './sanitize.js';
import { runMCPServer } from './mcp/client.js';
import { seedNoop } from './noop.js';
import { silentRelaunch, silentRelaunchHandoff } from './silentRelaunch.js';
import { applyWorktreeIntercept } from './worktree.js';
import { flushWarnings, warn } from './warnings.js';

/**
 * Pluggable seam set used by `run()`. Tests substitute in-memory implementations
 * to drive the orchestration without launching real subprocesses, dialing
 * real sockets, or touching the real filesystem.
 *
 * The default values (when the caller omits a field) resolve to the
 * production implementations imported above. Mirrors the Go `run()`'s
 * package-level `runMCPServerFn` / `gitRunner` indirections, expanded so the
 * full integration is testable without monkey-patching.
 */
export interface RunDeps {
  /** Source argv (typically `process.argv.slice(2)`). */
  argv?: readonly string[];
  /** Stream where the help/version/error text is written. */
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  /** User's home directory. */
  home?: string;
  /** Shell cwd at startup. */
  cwd?: string;
  /** PATH lookup for the claude binary; returns null when not found. */
  lookupClaude?: (name: string) => string | null;
  /** Override the run-with-pty step. */
  runWithPTY?: typeof runWithPTY;
  /** Override the silent-relaunch step (cross-cwd resume). */
  silentRelaunch?: typeof silentRelaunch;
  /** Override the silent-relaunch-handoff step. */
  silentRelaunchHandoff?: typeof silentRelaunchHandoff;
  /** Override seedNoop (best-effort dir seeder). */
  seedNoop?: typeof seedNoop;
  /** Override generateName for auto-name (skip the LLM call). */
  generateName?: typeof generateName;
  /** Override loadPrompts (skip disk lookup). */
  loadPrompts?: typeof loadPrompts;
  /** Override loadConfig (use a fixed config). */
  loadConfig?: typeof loadConfig;
  /** Override loadRepoSettings (skip the four-tier settings.json merge). */
  loadRepoSettings?: typeof loadRepoSettings;
  /** Override loadHostAliases. */
  loadHostAliases?: typeof loadHostAliases;
  /** Override Resolve. */
  resolve?: typeof Resolve;
  /** Override applyWorktreeIntercept. */
  applyWorktreeIntercept?: typeof applyWorktreeIntercept;
  /** Override runMCPServer (the `mcp` subcommand dispatcher). */
  runMCPServer?: typeof runMCPServer;
}

function lookupClaudeFromPath(name: string): string | null {
  // Bun's PATH lookup: Bun.which() returns null when not found.
  // Falls back to a synchronous probe via process.env.PATH if needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunWhich = (globalThis as any).Bun?.which;
  if (typeof bunWhich === 'function') {
    return bunWhich(name);
  }
  // Fallback: walk PATH ourselves. Avoid `which` shell-out — synchronous and
  // brittle. Use spawnSync('which', [name]) only if Bun.which is unavailable
  // and we're not on Windows.
  return null;
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
  const argv = deps.argv ?? process.argv.slice(2);
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const home = deps.home ?? process.env.HOME ?? homedir();
  const shellCWD = deps.cwd ?? process.cwd();
  const lookupClaude = deps.lookupClaude ?? lookupClaudeFromPath;
  const runPTY = deps.runWithPTY ?? runWithPTY;
  const relaunch = deps.silentRelaunch ?? silentRelaunch;
  const relaunchHandoff = deps.silentRelaunchHandoff ?? silentRelaunchHandoff;
  const seedNoopFn = deps.seedNoop ?? seedNoop;
  const generateNameFn = deps.generateName ?? generateName;
  const loadPromptsFn = deps.loadPrompts ?? loadPrompts;
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const loadRepoSettingsFn = deps.loadRepoSettings ?? loadRepoSettings;
  const loadHostAliasesFn = deps.loadHostAliases ?? loadHostAliases;
  const resolveFn = deps.resolve ?? Resolve;
  const applyWorktreeInterceptFn = deps.applyWorktreeIntercept ?? applyWorktreeIntercept;
  const runMCPServerFn = deps.runMCPServer ?? runMCPServer;

  // Defer-flush warnings on exit, AFTER claude has finished and the user is
  // back at their shell. The silent-relaunch path uses execve which skips
  // this defer; that's intentional — the relaunched fnclaude will re-emit
  // any warnings that still apply.
  let flushed = false;
  const flushOnce = (): void => {
    if (flushed) return;
    flushed = true;
    flushWarnings(stderr);
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
    let a;
    try {
      a = parseArgs(argv, home);
    } catch (err) {
      stderr.write(`${(err as Error).message}\n`);
      return 1;
    }

    // ── Seed the noop dir iff fallback was used. ─────────────────────────
    if (a.usedNoopFallback) {
      try {
        await seedNoopFn(a.cwd);
      } catch (err) {
        warn(`fnclaude: noop seed failed: ${(err as Error).message}`);
      }
    }

    const cfg = loadConfigFn();

    // ── Repo-reference resolver (path-or-repo two-lookup). ───────────────
    if (
      !a.usedNoopFallback &&
      a.cwd !== '' &&
      !isAbsolute(a.cwd) &&
      !a.cwd.startsWith('~')
    ) {
      const rs = loadRepoSettingsFn(home, shellCWD);
      const aliases = loadHostAliasesFn(home);
      try {
        const result = await resolveFn({
          input: a.cwd,
          cwd: shellCWD,
          home,
          settings: rs,
          hostAliases: aliases,
        });
        a.cwd = result.path;
        // If the user's reference had a +workspace suffix AND they didn't
        // pass -w explicitly, propagate the workspace to the intercept
        // layer.
        if (result.workspace !== undefined && result.workspace !== '' && !a.worktreeSet) {
          a.worktreeSet = true;
          a.worktreeArg = result.workspace;
        }
      } catch (err) {
        stderr.write(`${(err as Error).message}\n`);
        return 1;
      }
    } else if (a.cwd.startsWith('~')) {
      // Tilde-expand absolute-shaped inputs that didn't go through the
      // resolver (resolver expands tildes for its short-circuit path, but
      // it isn't called for tilde-prefixed inputs here).
      a.cwd = expandTildePath(a.cwd);
    }

    // ── -w / --worktree intercept. ───────────────────────────────────────
    applyWorktreeInterceptFn(a, shellCWD);

    // ── Resolve the launch cwd relative to shell cwd. ────────────────────
    const launchCWD = isAbsolute(a.cwd) ? a.cwd : join(shellCWD, a.cwd);

    // ── Auto-name if qualifying. ──────────────────────────────────────────
    if (shouldAutoName(a.passthrough)) {
      const prompt = extractPrompt(a.passthrough);
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      let llmFn: LlmClientFn | undefined;
      if (apiKey !== '') llmFn = defaultLlmClient(apiKey);
      else llmFn = claudeCliFn(cfg.name.model);
      const name = await generateNameFn(prompt, cfg.name, apiKey, llmFn);
      a.passthrough = ['--name', name, ...a.passthrough];
    }

    // ── Sanitize any --name / -n value to a path-safe slug. ──────────────
    {
      const { args: sanitized, warnings } = sanitizeNamesInPassthrough(a.passthrough);
      a.passthrough = sanitized;
      for (const w of warnings) warn(w);
    }

    // ── Build the claude argv. ───────────────────────────────────────────
    const promptsResult = loadPromptsFn();
    for (const w of promptsResult.warnings) warn(w);

    const claudeArgv = buildArgv(a, shellCWD, cfg, promptsResult.prompts);

    // ── Verify claude is on PATH before starting the PTY. ────────────────
    if (lookupClaude('claude') === null) {
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
    if (handoffArgv !== null && handoffArgv.length > 0) {
      // Flush deferred warnings before relaunch since execve replaces the
      // process image (the deferred flush below would be skipped).
      flushOnce();
      relaunchHandoff(handoffArgv);
      // If we get here, execve failed; fall through to cross-cwd detection
      // (won't match in practice) and return claude's exit code.
    }

    // ── Cross-cwd redirect detection. ────────────────────────────────────
    if (tail !== null) {
      const hit = detectCrossCwd(tail);
      if (hit !== null) {
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
    process.stderr.write(`fnclaude: fatal: ${(err as Error).message}\n`);
    code = 1;
  }
  process.exit(code);
}
