/**
 * Shared PTY scaffolding — RingBuffer, cross-cwd detection regex,
 * reconstructArgv helper, ensureCWD safety wrapper, and the platform-
 * dispatching `runWithPTY` entry point.
 *
 * Ported from src/pty_run.go in the Go reference (fnclaude@fnrhombus).
 *
 * Platform-specific spawn lives in:
 *   - src/pty/unix.ts    — node-pty under POSIX
 *   - src/pty/windows.ts — direct child_process.spawn, no PTY (stub)
 */

import { mkdir, rmdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import type { Config } from './config.js';
import type { HandoffSpec } from './handoff.js';
import { isFlag, isMagicWord, preserveArgs, splitLeadingMagic } from './args/preserve.js';

// ── RingBuffer ─────────────────────────────────────────────────────────────

/**
 * Capacity of the PTY output tail kept for the post-exit cross-cwd scan.
 *
 * Sized to comfortably hold the cross-cwd message plus all the screen-cleanup
 * escapes claude emits while tearing down its TUI on exit. An earlier 4 KB
 * value was just big enough for the original captured fixture but failed in
 * the wild when claude 2.1.143 emitted more trailing cleanup before exit —
 * the message rotated out of the tail and the intercept silently failed.
 */
export const RING_BUFFER_SIZE = 64 * 1024;

/**
 * Fixed-capacity circular byte buffer. Writes that overflow the capacity
 * discard the oldest data. Only the most recent `cap` bytes are kept, which
 * is all we need for post-exit pattern scanning.
 *
 * Implementation note: backed by a Node Buffer (vs Uint8Array) so the
 * outbound `bytes()` slice is already in the form that node:net /
 * RegExp.exec(buffer.toString('utf8' | 'binary')) callers expect.
 */
export class RingBuffer {
  private readonly buf: Buffer;
  readonly cap: number;
  private pos = 0;
  private full = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.cap = capacity;
    this.buf = Buffer.alloc(capacity);
  }

  /** Append data, dropping oldest bytes when full. */
  write(p: Buffer | Uint8Array | string): void {
    const data = typeof p === 'string' ? Buffer.from(p) : Buffer.from(p);
    if (data.length === 0) return;
    // For oversize writes (> cap) skip ahead — the prefix we'd write would
    // be immediately overwritten by the suffix. Land on a clean state where
    // pos = 0, full = true, and we copy the trailing `cap` bytes in one go.
    let src = 0;
    if (data.length > this.cap) {
      src = data.length - this.cap;
      this.full = true;
      this.pos = 0;
    }
    // Copy in up to two chunks: from src to end-of-buf, then wrapped around
    // from start-of-buf for the remainder. `Buffer.copy` is a memcpy under
    // the hood — substantially cheaper than the per-byte assignment loop
    // this replaces, for the same final buffer state.
    while (src < data.length) {
      const writable = Math.min(data.length - src, this.cap - this.pos);
      data.copy(this.buf, this.pos, src, src + writable);
      src += writable;
      this.pos = (this.pos + writable) % this.cap;
      if (this.pos === 0) this.full = true;
    }
  }

  /** Return ring contents in chronological order (oldest first). */
  bytes(): Buffer {
    if (!this.full) {
      return Buffer.from(this.buf.subarray(0, this.pos));
    }
    return Buffer.concat([
      this.buf.subarray(this.pos),
      this.buf.subarray(0, this.pos),
    ]);
  }
}

// ── cross-cwd detection ────────────────────────────────────────────────────

/**
 * Matches the cd-and-resume line claude prints when the selected session
 * belongs to a different directory. SOURCE OF TRUTH — keep byte-for-byte
 * identical to src/pty_run.go's `crossCwdRe`.
 *
 * We can't anchor on the "This conversation is from a different directory."
 * preamble: claude's TUI emits cursor-right escapes (e.g. `\x1b[1C`) between
 * words instead of literal spaces, so that sentence is never plain-text in
 * the PTY stream. The "To resume, run:" line, by contrast, is rendered as
 * plain ASCII with real spaces, as is the `cd <path> && claude --resume <uuid>`
 * command — both anchors survive the TUI rendering intact.
 *
 * The `[\s\S]*?` between anchors swallows whatever ANSI / CR / cursor-move
 * goo appears between the two lines (varies by terminal width and TUI
 * layout — observed: `\x1b[K\r\x1b[1C\x1b[1B`).
 */
export const crossCwdRe =
  /To resume, run:[\s\S]*?cd (\S+) && claude --resume ([0-9a-fA-F-]{36})/g;

export interface CrossCwdMatch {
  dest: string;
  uuid: string;
}

/**
 * Scan `tail` for the cross-cwd redirect message. Returns null when no
 * match is found OR when the captured `dest` fails safety validation.
 * When multiple matches appear (unlikely but defensive), the LAST match
 * wins.
 *
 * Security note: the `dest` capture flows into `silentRelaunch` and
 * becomes the cwd for the relaunched process. The PTY stream is not a
 * trusted channel — a hostile MCP tool (or any subprocess that prints to
 * claude's terminal) can emit a fake "To resume, run: cd /tmp/evil &&
 * claude --resume <uuid>" line and steer the parent into relaunching in
 * an attacker-controlled directory. We refuse to act on a dest unless
 * it's an absolute path that survives canonicalisation unchanged and
 * contains no null bytes / `..` segments.
 */
export function detectCrossCwd(tail: Buffer): CrossCwdMatch | null {
  // Decode as Latin-1 so every byte maps to a code unit; the regex matches
  // ASCII anchors so the multi-byte representation of any non-ASCII bytes
  // never participates in a match. This is the JS equivalent of Go's
  // []byte-scanning behavior.
  const s = tail.toString('latin1');
  // matchAll iterates from a fresh internal cursor each call — no
  // module-level `lastIndex` to reset. The exported `crossCwdRe` stays
  // `g`-flagged (matchAll requires it) but is only ever consumed as an
  // anchor for tests / the source-of-truth comparison.
  let last: RegExpMatchArray | null = null;
  for (const m of s.matchAll(crossCwdRe)) {
    last = m;
  }
  if (last === null) return null;
  const dest = last[1]!;
  if (!isSafeDest(dest)) return null;
  return { dest, uuid: last[2]! };
}

/**
 * Reject `dest` values that shouldn't be honored as relaunch cwds:
 *  - contains a null byte
 *  - is not an absolute path (a relative dest would resolve against
 *    whatever the current cwd happens to be — non-obvious to a user
 *    reading the relaunch and easy to abuse)
 *  - contains a `..` segment delimited by `/` (path traversal)
 *  - doesn't round-trip through `path.resolve` (catches `/foo/./bar`,
 *    trailing slashes, and any other non-canonical form a peer might
 *    cook up to slip past parent-segment detection)
 *
 * On Windows we'd also want backslash handling; the cross-cwd-resume
 * flow is POSIX-only by design (the Windows PTY stub disables it) so
 * this validator targets POSIX paths.
 */
function isSafeDest(dest: string): boolean {
  if (dest.includes('\x00')) return false;
  if (!isAbsolute(dest)) return false;
  if (dest.split('/').includes('..')) return false;
  if (resolvePath(dest) !== dest) return false;
  return true;
}

// ── reconstructArgv ────────────────────────────────────────────────────────

/**
 * Build the new fnclaude argument list when silently relaunching after a
 * cross-cwd session resume.
 *
 * `origArgs` is `process.argv.slice(2)` from the original invocation.
 * `dest` is the destination directory extracted from claude's message;
 * `uuid` is the session id to resume.
 *
 * Algorithm (delegated to preserveArgs): keep leading magic words, strip
 * positional path tokens, keep everything from the first flag onward (no
 * denylist — cross-cwd resume preserves all flags).
 *
 * Result: preserved_magic + [dest] + ["--resume", uuid] + rest.
 *
 * Note: if the original argv already contained --resume / -r / --continue /
 * -c, the picker wouldn't have been shown, the cross-cwd pattern wouldn't
 * have been emitted, and this function wouldn't be called. No special-case
 * is needed for those flags.
 */
export function reconstructArgv(
  origArgs: readonly string[],
  dest: string,
  uuid: string,
): string[] {
  const preserved = preserveArgs(origArgs, null, null);
  const { magic, rest } = splitLeadingMagic(preserved);
  return [...magic, dest, '--resume', uuid, ...rest];
}

// Re-export magic helpers so callers can do everything via the pty module.
export { isFlag, isMagicWord, splitLeadingMagic };

// ── clearScreen ────────────────────────────────────────────────────────────

/**
 * Write the ANSI escape sequence that clears the screen and moves the
 * cursor to the top-left. Called before relaunching to hide the brief
 * flicker of the "different directory" message that already scrolled to
 * the terminal before we detected it.
 */
export function clearScreen(out: NodeJS.WriteStream = process.stdout): void {
  out.write('\x1b[2J\x1b[H');
}

// ── ensureCWD ──────────────────────────────────────────────────────────────

export interface EnsureCWDHandle {
  /**
   * Best-effort tear-down of any directory tree fabricated by ensureCWD.
   * Walks back through the dirs we created (deepest first). A dir that
   * was already removed by something else is treated as success
   * (postcondition already satisfied). A dir that's unexpectedly
   * non-empty surfaces as a thrown error.
   */
  cleanup(): Promise<void>;
}

/**
 * Guarantee `dir` exists at the moment of process spawn.
 *
 * Motivation: when fnclaude resumes a session whose stored cwd no longer
 * exists on disk, the kernel returns ENOENT during exec — but Node /
 * Bun formats that against the binary path ("ENOENT … spawn …"), which
 * falsely blames the claude binary. The fix is to ensure the cwd exists
 * before spawn. When it doesn't, we fabricate the full tree, then
 * IMMEDIATELY unwind it after the child has been spawned — once claude
 * has chdir'd into the dir its kernel cwd is held by inode reference and
 * the path on disk is no longer needed.
 *
 * If the path exists but isn't a directory, ensureCWD rejects without
 * touching the filesystem. If the path doesn't exist and an ancestor is
 * a file, ensureCWD likewise rejects without touching the filesystem.
 */
export async function ensureCWD(dir: string): Promise<EnsureCWDHandle> {
  let info: Stats | null = null;
  try {
    info = await stat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (info !== null) {
    if (!info.isDirectory()) {
      throw new Error(`session cwd ${dir} exists but is not a directory`);
    }
    return { cleanup: async () => undefined };
  }

  // Walk up to find the deepest pre-existing ancestor, recording every
  // missing level shallowest-first. We mkdir each level explicitly (rather
  // than calling mkdir({recursive: true})) so cleanup only touches dirs
  // we actually created.
  const missing: string[] = [];
  let p = dir;
  for (;;) {
    missing.unshift(p);
    const parent = dirname(p);
    if (parent === p) {
      throw new Error(`session cwd ${dir} does not exist and has no existing ancestor`);
    }
    let parentInfo: Stats | null = null;
    try {
      parentInfo = await stat(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (parentInfo !== null) {
      if (!parentInfo.isDirectory()) {
        throw new Error(
          `session cwd ${dir} cannot be created: ancestor ${parent} is not a directory`,
        );
      }
      break;
    }
    p = parent;
  }

  const created: string[] = []; // shallowest-first; cleanup reverses
  for (const level of missing) {
    try {
      await mkdir(level, { mode: 0o755 });
    } catch (err) {
      // Roll back what we already created so we leave the filesystem
      // exactly as we found it.
      for (let i = created.length - 1; i >= 0; i--) {
        try {
          await rmdir(created[i]!);
        } catch {
          // best-effort
        }
      }
      throw new Error(
        `session cwd ${dir} does not exist and could not be created: ${(err as Error).message}`,
      );
    }
    created.push(level);
  }

  return {
    cleanup: async () => {
      for (let i = created.length - 1; i >= 0; i--) {
        const level = created[i]!;
        try {
          // rmdir() — non-recursive — so a non-empty dir surfaces as an
          // error rather than nuking unexpected content.
          await rmdir(level);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') continue; // already gone — fine
          throw new Error(`could not clean up auto-created ${level}: ${(err as Error).message}`);
        }
      }
    },
  };
}

// ── runWithPTY ─────────────────────────────────────────────────────────────

/**
 * Result returned by `runWithPTY`. `tail` is the ring buffer contents at
 * the moment the child exited; `handoffArgv` is populated only when the
 * socket listener fired `triggered()` and stashed a relaunch argv.
 *
 * On Windows the tail is null (no PTY, no ring buffer, cross-cwd-resume
 * is a no-op).
 */
export interface RunResult {
  exitCode: number;
  tail: Buffer | null;
  handoffArgv: string[] | null;
}

export interface RunOptions {
  /**
   * argv to invoke. claudeArgv[0] is conventionally the program name and
   * is ignored by the spawn; claudeArgv.slice(1) is passed as positional
   * args to the child.
   */
  claudeArgv: string[];
  launchCWD: string;
  cfg: Config;
  /** Null disables handoff (no env injection, no listener). */
  handoff: HandoffSpec | null;
}

/**
 * Spawn claude under a PTY (POSIX) or with inherited stdio (Windows),
 * starting the AF_UNIX listener first when `handoff` is set so the socket
 * is ready the moment the child starts.
 *
 * The implementation lives in pty/unix.ts or pty/windows.ts; this is the
 * dispatcher.
 */
export async function runWithPTY(opts: RunOptions): Promise<RunResult> {
  if (process.platform === 'win32') {
    const mod = await import('./pty/windows.js');
    return mod.runWithPTY(opts);
  }
  const mod = await import('./pty/unix.js');
  return mod.runWithPTY(opts);
}
