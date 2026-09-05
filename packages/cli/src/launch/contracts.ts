/**
 * Launch-composition contracts (design.di-architecture §3, §4).
 *
 * Behavioral seams only — every concrete impl lives in a leaf-adjacent module and
 * keeps its deps-object factory signature. `LaunchInputs` is the frozen argv/env
 * product a plan is built from; `LaunchPlan` is the deep-frozen, ref-free value the
 * plan root emits and the run root later consumes (doctrine 2).
 */

import type { FnConfig } from '../config/load';
import type { XdgEnv } from '../config/paths';
import type { FindClaudeResult } from '../launch/find-claude';
import type { FngitResult } from '../repo/fngit';
import type { OwnSessionPlan } from '../usage/own-session';
import type { ResolveResult } from '../repo/resolve-input';
import type { Worktree } from '../worktree/intercept';

/** The frozen argv/env snapshot a launch plan is composed from (§3, testability). */
export interface LaunchInputs {
  /** Raw argv after intake (the `--`-preserving env round-trip). */
  readonly argv: readonly string[];
  /** The shell's working directory the launch was invoked from. */
  readonly shellCwd: string;
  /** The user's home directory. */
  readonly home: string;
  /** The XDG config/state env the config + path formulas read. */
  readonly xdg: XdgEnv;
  /** A snapshot of the process environment, frozen so every phase reads one value. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The host platform, an input so the win32/POSIX branch is testable. */
  readonly platform: NodeJS.Platform;
  /** The launcher process id, for the socket-path formula. */
  readonly pid: number;
  /** The bun runtime path that will exec the MCP subprocess (`process.execPath`). */
  readonly execPath: string;
  /** The fnc bin script path (`process.argv[1]`, or `''` when unknown). */
  readonly binPath: string;
  /** Whether stdin is a TTY, an input so the terminal branch is testable. */
  readonly stdinIsTTY: boolean;
  /** Whether stdout is a TTY, an input so the terminal branch is testable. */
  readonly stdoutIsTTY: boolean;
}

/**
 * The deep-frozen, ref-free launch plan: everything the run root needs, as plain
 * data that outlives the plan container's disposal (doctrine 2).
 */
export interface LaunchPlan {
  /** The resolved launch directory claude is spawned in. */
  readonly launchCWD: string;
  /** The fully assembled claude argv, spawn-ready. */
  readonly claudeArgv: readonly string[];
  /** Whether the noop fallback directory was used (no positional given). */
  readonly usedNoopFallback: boolean;
  /** The composed child environment for the claude spawn. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The whole loaded config record, carried whole so per-field drift is impossible. */
  readonly config: FnConfig;
  /** The XDG env, threaded as one frozen value. */
  readonly xdg: XdgEnv;
  /** The plan-phase warnings, drained for the run root to re-queue and flush. */
  readonly warnings: readonly string[];
  /** Whether claude is spawned under a pseudo-terminal (POSIX + TTY). */
  readonly useTerminal: boolean;
  /** Whether the self-MCP listener is enabled (non-win32). */
  readonly mcpEnabled: boolean;
  /** The AF_UNIX socket path, when the listener is enabled. */
  readonly socketPath?: string;
  /** This session's own JSONL id when known up front, else `null`. */
  readonly sessionID: string | null;
  /** Whether this is the `ultracode` effort launch (prompt slot is `/effort ultracode`). */
  readonly isUltracode: boolean;
  /** The user prompt to submit as a follow-up after an ultracode boot, or `''`. */
  readonly ultracodeSeedPrompt: string;
  /** Whether this is the bare `fnc install` wizard launch. */
  readonly isOobeLaunch: boolean;
  /** The located claude binary; a missing binary aborts in the run root, not the plan. */
  readonly claudeBin: FindClaudeResult;
  /** The original argv, for the restart/relaunch tails. */
  readonly origArgs: readonly string[];
}

/** What the run container carries out before disposal (doctrine 2); the run root fills it in PR-4. */
export interface SessionOutcome {
  readonly exitCode: number;
  readonly handoff?: readonly string[];
  readonly ringSnapshot: string;
  readonly warnings: readonly string[];
}

/** A terminal launch error: a preformatted stderr line and the exit code to leave with. */
export class LaunchAbort extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'LaunchAbort';
    this.code = code;
  }
}

/** The plan-phase warning sink, drained into `plan.warnings` before the plan freezes. */
export interface IWarningBuffer {
  /** Queue one warning. */
  add(msg: string): void;
  /** Return the queued warnings and empty the sink. */
  drain(): readonly string[];
}

/** fngit as an object seam, so an optional dependency reads as `IFngitRunner | undefined`. */
export interface IFngitRunner {
  /** Run fngit with `args`, resolving its result. */
  run(args: readonly string[]): Promise<FngitResult>;
}

/** Arguments the cwd resolver needs per launch (fngit is injected, not passed). */
export interface ResolveCwdArgs {
  readonly input: string | null;
  readonly shellCwd: string;
  readonly home: string;
  readonly noopDir: string;
  readonly onProgress?: (line: string) => void;
}

/** Resolves the first positional to a launch directory (phase: cwd resolution). */
export interface ICwdResolver {
  /** Decide the launch directory, or an error, for `args.input`. */
  resolve(args: ResolveCwdArgs): Promise<ResolveResult>;
}

/** Lists a repo's worktrees, or `null` when the directory is not a git repo. */
export interface IWorktreeLister {
  /** The worktrees in `cwd`, or `null`. */
  list(cwd: string): Worktree[] | null;
}

/** Arguments the worktree intercept needs per launch. */
export interface WorktreeInterceptArgs {
  readonly worktreeSet: boolean;
  readonly worktreeArg: string;
  readonly launchCwd: string;
  readonly passthrough: readonly string[];
}

/** The `-w` worktree intercept phase, possibly swapping cwd to an existing worktree. */
export interface IWorktreeIntercept {
  /** Apply the intercept, returning the (possibly swapped) cwd, passthrough and warnings. */
  apply(args: WorktreeInterceptArgs): {
    launchCwd: string;
    passthrough: string[];
    worktreeMatched: boolean;
    warnings: string[];
  };
}

/** Generates a session name from the prompt body (phase: auto-name). */
export interface IAutoNamer {
  /** The sanitized name to inject for `promptBody`, using `env` to pick SDK vs `claude -p`. */
  generate(promptBody: string, env: Readonly<Record<string, string | undefined>>): Promise<string>;
}

/** Arguments the fragment loader needs per launch. */
export interface FragmentLoadArgs {
  readonly usedNoopFallback: boolean;
  readonly claudeArgs: readonly string[];
  readonly oobe: boolean;
  readonly xdg: XdgEnv;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly binPath: string;
  readonly shellCwd: string;
}

/** Loads `--append-system-prompt` fragment content (phase: fragment injection). */
export interface IFragmentLoader {
  /** The joined fragment content to inject (or `null`), plus any load warnings. */
  load(args: FragmentLoadArgs): { content: string | null; warnings: string[] };
}

/** Plans this session's own-JSONL id and any `--session-id` injection (phase: session-id mint). */
export interface ISessionIdMinter {
  /** Decide the id/injection for `claudeArgs` (mints a fresh UUID for a fresh session). */
  plan(claudeArgs: readonly string[]): OwnSessionPlan;
}

/** Arguments the env composer needs per launch. */
export interface ComposeEnvArgs {
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly execEnv: Record<string, string> | undefined;
  readonly handoff: string | undefined;
  readonly socket: string | undefined;
}

/** Composes the claude child environment (phase: env compose). */
export interface IEnvComposer {
  /** The composed child env: process env, then exec.env, then handoff, then socket. */
  compose(args: ComposeEnvArgs): Record<string, string>;
}

/** Arguments the socket-path computer needs per launch. */
export interface SocketPathArgs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
}

/** Computes the AF_UNIX socket path (phase: socket path). */
export interface ISocketPathComputer {
  /** The socket path under the runtime base for `args.pid`. */
  compute(args: SocketPathArgs): string;
}

/** Locates the claude binary on PATH (phase: claude location). */
export interface IClaudeLocator {
  /** The located binary, or an error result, for `pathEnv`. */
  locate(pathEnv: string): FindClaudeResult;
}

/** Arguments the noop seeder needs per launch. */
export interface NoopSeedArgs {
  readonly noopDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly binPath: string;
  readonly shellCwd: string;
}

/** Creates and seeds the noop fallback directory (phase: noop seeding). */
export interface INoopSeeder {
  /** Create `args.noopDir` and seed its handoff template, best-effort. */
  seed(args: NoopSeedArgs): Promise<void>;
}

/** The plan orchestrator: assembles a frozen {@link LaunchPlan} from injected phase services. */
export interface IPlanner {
  /** Run every plan phase in order and emit the deep-frozen, ref-free plan. */
  plan(): Promise<LaunchPlan>;
}

/** `fnc install -y` flags a mini-root runs against; the install runner wraps the leaf. */
export interface IInstallRunner {
  /** Apply the non-interactive install and resolve its exit code. */
  run(): Promise<number>;
}

/** Deep-freeze `value` and every plain object/array it transitively owns, then return it. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
