/**
 * Port contracts — the seams DI substitutes in tests (design.di-architecture §5).
 *
 * Behavioral contracts only; each concrete node adapter lives in its own
 * `node-*.ts` beside this file, and the `Symbol.dispose` teardown adapters in
 * `disposal.ts`. The execve tail (`IProcessImageReplacer`) is a contract with
 * no registered implementation — it replaces the process image and so runs
 * outside every container, after disposal (doctrine 5).
 */

import type { WhichFn } from '../mcp/handlers/clipboard-backends';

/** A read-only view of the filesystem; the one seam a hermetic config test substitutes. */
export interface IFileSystem {
  /** Whether `path` names an existing regular file. */
  isFile(path: string): boolean;

  /** The file's UTF-8 contents; rejects when the file cannot be read. */
  readText(path: string): Promise<string>;
}

/** The wall clock, as a value a fixed-time fake can stand in for. */
export interface IClock {
  /** Milliseconds since the Unix epoch, like `Date.now()`. */
  now(): number;
}

/** The process environment, read once and frozen so `HOME` and friends resolve to one value. */
export interface IEnvironment {
  /** The user's home directory. */
  readonly home: string;

  /** One environment variable, or `undefined` when unset. */
  get(name: string): string | undefined;
}

/** Options for a pseudo-terminal spawn; the caller owns the {@link Bun.Terminal} it tees through. */
export interface PtySpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly terminal: Bun.Terminal;
}

/** Options for a stdio-inherited spawn. */
export interface InheritSpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

/** Spawns the claude child, either under a pseudo-terminal or inheriting the parent's stdio. */
export interface IProcessSpawner {
  /** Spawn `command` attached to `options.terminal`. */
  spawnPty(command: readonly string[], options: PtySpawnOptions): Bun.Subprocess;

  /** Spawn `command` with the parent's stdin/stdout/stderr inherited. */
  spawnInherit(command: readonly string[], options: InheritSpawnOptions): Bun.Subprocess;
}

/**
 * Replaces the current process image with `argv[0]` (an absolute path, no PATH
 * search) — the handoff/relaunch execve tail. Never registered: it runs after
 * container disposal, outside every root (doctrine 5).
 */
export interface IProcessImageReplacer {
  /** Returns `false` only when execve is unavailable or failed; on success it never returns. */
  replace(argv: readonly string[], env: Record<string, string | undefined>): false;
}

/** Locates an executable on `PATH`; a frozen function-shaped seam (value door). */
export type IWhich = WhichFn;
