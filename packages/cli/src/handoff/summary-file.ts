/**
 * Handoff summary content file — pure write.
 *
 * `fnc_switch_project` and `fnc_spawn_session` write the markdown
 * summary that the destination session auto-loads (via `@<path>` in the
 * relaunch argv) to a fresh file on disk. The path formula:
 *
 *   <base>/fnclaude-handoff-content-<16hex>.md
 *
 * `<base>` resolves from `$XDG_RUNTIME_DIR` if set (Linux/systemd
 * tmpfs, mode 700, cleared on logout — restrictive by default so other
 * users on the box can't read the content). Otherwise `os.tmpdir()`
 * (the OS-native fallback: macOS launchd / Windows per-user TEMP both
 * already have restrictive ACLs). See design.md §14.
 *
 * The file itself is written with mode 0600 — same belt-and-suspenders
 * the Go canonical uses, since the surrounding tmpfs already restricts
 * access. Handoff summaries can contain conversation context, tool
 * results, etc.
 *
 * `<16hex>` is 8 bytes of crypto-random hex. PID + nanosecond is
 * NOT used as the primary form here (Go's fallback path) — Node's
 * `crypto.randomBytes` doesn't fail on a healthy system, so a tighter
 * always-random shape stays adequate without the extra branch.
 *
 * The base-dir resolver and random-hex source are both injected for
 * tests. Production callers use the defaults (`defaultBaseDir`,
 * `defaultRandomHex`).
 *
 * Design: docs/design.mcp.md §4.2, docs/design.md §14.
 */

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Resolve the base directory for handoff content files. */
export type BaseDirResolver = () => string;

/** Generate 16 hex characters (8 bytes of entropy) for the filename token. */
export type RandomHexFn = () => string;

export interface WriteSummaryFileArgs {
  summary: string;
  baseDir?: BaseDirResolver;
  randomHex?: RandomHexFn;
}

export interface WriteSummaryFileResult {
  path: string;
}

/**
 * Write `summary` to `<base>/fnclaude-handoff-content-<16hex>.md` with
 * mode 0600 and return the resolved path. Throws if the write fails —
 * the caller (switch handler) surfaces that as an `action: 'error'`
 * response.
 */
export async function writeSummaryFile(
  args: WriteSummaryFileArgs,
): Promise<WriteSummaryFileResult> {
  const baseDir = (args.baseDir ?? defaultBaseDir)();
  const hex = (args.randomHex ?? defaultRandomHex)();
  const path = join(baseDir, `fnclaude-handoff-content-${hex}.md`);
  await writeFile(path, args.summary, { mode: 0o600 });
  return { path };
}

/**
 * Default base dir: `$XDG_RUNTIME_DIR` if set, else `os.tmpdir()`.
 * Mirrors Go canonical's `handoffBaseDir`.
 */
export const defaultBaseDir: BaseDirResolver = () => {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg !== undefined && xdg !== '') {
    return xdg;
  }
  return tmpdir();
};

/**
 * Default random-hex source: 8 bytes of crypto entropy → 16 hex chars.
 * Matches Go canonical's `rand.Read(make([]byte, 8))` + `hex.EncodeToString`.
 */
export const defaultRandomHex: RandomHexFn = () => randomBytes(8).toString('hex');
