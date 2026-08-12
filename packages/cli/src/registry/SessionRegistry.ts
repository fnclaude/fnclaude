/**
 * Coordination-registry store: the per-session writer and the live-entry
 * reader.
 *
 * Machine-global, file-based, NO daemon, NO locks. Every session owns one
 * JSON file at `<registry dir>/<session-id>.json`; the session's own fnc
 * process is that file's ONLY writer, so there is nothing to lock — updates
 * go write-temp-then-rename, which the kernel makes atomic, and readers
 * always see a complete document. Dead sessions (crashes, SIGKILL) leave
 * stale files behind; readers detect them via pid+starttime liveness and
 * unlink them lazily (GC on read). See docs/decisions.md.
 *
 * Every write is best-effort: the registry is an advisory communication
 * channel, so an fs failure here must never break a launch or an MCP tool
 * call — errors are swallowed and the write skipped.
 */

import * as nodeFs from 'node:fs';
import { basename } from 'node:path';

import { normalizeKey } from './key-overlap';
import { isOwnerLive, readStarttime as readProcStarttime, type LivenessDeps } from './liveness';
import type { ClaimMode, RegistryClaim, RegistryEntry, RegistrySession } from './RegistryEntry';
import { registryFilePath } from './registry-path';

/** fs seam for the registry — injectable so unit tests never touch disk. */
export interface IRegistryFs {
  mkdir(dir: string): void;
  writeFile(path: string, content: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  readFile(path: string): string;
  readdir(dir: string): string[];
}

const realFs: IRegistryFs = {
  mkdir(dir: string): void {
    nodeFs.mkdirSync(dir, { recursive: true });
  },
  writeFile(path: string, content: string): void {
    nodeFs.writeFileSync(path, content);
  },
  rename(from: string, to: string): void {
    nodeFs.renameSync(from, to);
  },
  unlink(path: string): void {
    nodeFs.unlinkSync(path);
  },
  readFile(path: string): string {
    return nodeFs.readFileSync(path, 'utf8');
  },
  readdir(dir: string): string[] {
    return nodeFs.readdirSync(dir);
  },
};

export interface SessionRegistryArgs {
  /** The registry directory (computeRegistryDir). */
  dir: string;
  session: RegistrySession;
  /** The registering process — fnc's own pid (its lifetime IS the session's). */
  ownerPid: number;
  cwd: string;
  /** Injectable for tests; defaults to the real fs. */
  fs?: IRegistryFs;
  /** Injectable for tests; defaults to the /proc/<pid>/stat reader. */
  readStarttime?: (pid: number) => string | null;
  /** Injectable for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export class SessionRegistry {
  readonly #dir: string;
  readonly #filePath: string;
  readonly #session: RegistrySession;
  readonly #ownerPid: number;
  readonly #cwd: string;
  readonly #fs: IRegistryFs;
  readonly #readStarttime: (pid: number) => string | null;
  readonly #now: () => Date;
  #entry: RegistryEntry | null = null;

  constructor(args: SessionRegistryArgs) {
    this.#dir = args.dir;
    this.#filePath = registryFilePath(args.dir, args.session.id);
    this.#session = args.session;
    this.#ownerPid = args.ownerPid;
    this.#cwd = args.cwd;
    this.#fs = args.fs ?? realFs;
    this.#readStarttime = args.readStarttime ?? readProcStarttime;
    this.#now = args.now ?? ((): Date => new Date());
  }

  /** The registry directory this session registers into. */
  get dir(): string {
    return this.#dir;
  }

  /** This session's registry file path. */
  get filePath(): string {
    return this.#filePath;
  }

  /** The registry session identity (id + name). */
  get session(): RegistrySession {
    return this.#session;
  }

  /**
   * Write the initial entry: identity, owner pid+starttime, cwd, and the
   * implicit exclusive cwd claim. Idempotent; never throws (best-effort —
   * an advisory registry must not break launches).
   */
  register(): void {
    if (this.#entry) {
      return;
    }
    this.#entry = {
      session: this.#session,
      owner: { pid: this.#ownerPid, starttime: this.#readStarttime(this.#ownerPid) },
      cwd: this.#cwd,
      startedAt: this.#now().toISOString(),
      claims: [{ key: normalizeKey(this.#cwd), mode: 'exclusive', implicit: 'cwd' }],
    };
    this.#write();
  }

  /**
   * Upsert a claim (by normalized key) into the own entry and rewrite the
   * file. Registers lazily if register() hasn't run yet. Returns the stored
   * claim.
   */
  claim(args: { key: string; mode: ClaimMode; note?: string }): RegistryClaim {
    if (!this.#entry) {
      this.register();
    }
    const stored: RegistryClaim = {
      key: normalizeKey(args.key),
      mode: args.mode,
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    const claims = this.#entry!.claims;
    const existing = claims.findIndex((c) => c.key === stored.key);
    if (existing >= 0) {
      claims[existing] = stored;
    } else {
      claims.push(stored);
    }
    this.#write();
    return stored;
  }

  /**
   * Remove the claim matching the normalized key and rewrite. Returns
   * whether a claim was actually removed.
   */
  release(args: { key: string }): boolean {
    if (!this.#entry) {
      return false;
    }
    const key = normalizeKey(args.key);
    const claims = this.#entry.claims;
    const idx = claims.findIndex((c) => c.key === key);
    if (idx < 0) {
      return false;
    }
    claims.splice(idx, 1);
    this.#write();
    return true;
  }

  /**
   * Best-effort unlink of the own file on exit — but ONLY while the file
   * still belongs to this process. On a restart handoff the replacement fnc
   * re-registers the SAME session id with its own pid before the old
   * process finishes exiting; blindly unlinking here would destroy the
   * replacement's registration, so ownership (owner.pid) is checked first.
   */
  unregister(): void {
    if (!this.#entry) {
      return;
    }
    try {
      const onDisk = JSON.parse(this.#fs.readFile(this.#filePath)) as RegistryEntry;
      if (onDisk.owner.pid !== this.#ownerPid) {
        return;
      }
    } catch {
      // Unreadable or already gone — fall through to the unlink attempt.
    }
    try {
      this.#fs.unlink(this.#filePath);
    } catch {
      // Already gone — fine.
    }
    this.#entry = null;
  }

  /** Write-temp-then-rename; the rename is what makes the update atomic. */
  #write(): void {
    try {
      this.#fs.mkdir(this.#dir);
      const tmpPath = `${this.#filePath}.tmp-${this.#ownerPid}`;
      this.#fs.writeFile(tmpPath, `${JSON.stringify(this.#entry, null, 2)}\n`);
      this.#fs.rename(tmpPath, this.#filePath);
    } catch {
      // Best-effort — an advisory registry must never break the session.
    }
  }
}

export interface ReadLiveEntriesArgs {
  dir: string;
  /** Injectable for tests; defaults to the real fs. */
  fs?: IRegistryFs;
  /** Injectable for tests; defaults to the pid+starttime probe. */
  isLive?: (owner: RegistryEntry['owner'], deps?: LivenessDeps) => boolean;
}

function isEntryShaped(value: unknown): value is RegistryEntry {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<RegistryEntry>;
  return (
    typeof entry.session?.id === 'string'
    && typeof entry.owner?.pid === 'number'
    && typeof entry.cwd === 'string'
    && Array.isArray(entry.claims)
  );
}

/**
 * Read every live entry in the registry dir. Dead entries (pid gone, or
 * starttime mismatch = pid reuse) are skipped AND unlinked — the lazy GC
 * that keeps the daemon-less registry from accumulating stale files.
 * Malformed files are skipped; a missing dir reads as empty.
 */
export function readLiveEntries(args: ReadLiveEntriesArgs): RegistryEntry[] {
  const fs = args.fs ?? realFs;
  const isLive = args.isLive ?? isOwnerLive;

  let names: string[];
  try {
    names = fs.readdir(args.dir);
  } catch {
    return [];
  }

  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const path = `${args.dir}/${basename(name)}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFile(path));
    } catch {
      continue;
    }
    if (!isEntryShaped(parsed)) {
      continue;
    }
    if (!isLive(parsed.owner)) {
      // TOCTOU guard before the unlink: between our read and this point,
      // the SAME session id may have re-registered (user resumes a
      // SIGKILLed session; a fresh fnc renames its live registration into
      // the identical path). Unlinking by path would then delete the LIVE
      // entry — and since a session only rewrites its file on
      // register/claim/release, the victim stays invisible with no
      // self-heal. Re-read and only unlink while the owner still matches
      // the dead owner we decided on; a re-registered, unreadable, or
      // already-GC'd file is left alone.
      try {
        const recheck: unknown = JSON.parse(fs.readFile(path));
        if (
          isEntryShaped(recheck)
          && recheck.owner.pid === parsed.owner.pid
          && recheck.owner.starttime === parsed.owner.starttime
        ) {
          fs.unlink(path);
        }
      } catch {
        // Gone (another reader GC'd it first) or rewritten mid-read —
        // either way, not ours to GC this scan.
      }
      continue;
    }
    entries.push(parsed);
  }
  return entries;
}

/**
 * Extract the session name from the assembled claude argv — the `--name`
 * value in either `--name value` or `--name=value` form (fnc's own flag,
 * present when the user passed it or auto-naming injected it). Null when
 * unnamed.
 */
export function sessionNameFromArgs(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok.startsWith('--name=')) {
      return tok.slice('--name='.length);
    }
    if (tok === '--name' && i + 1 < args.length) {
      return args[i + 1]!;
    }
  }
  return null;
}
