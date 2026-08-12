/**
 * Session-coordination MCP handlers (#350): fnc_sessions / fnc_claim /
 * fnc_release / fnc_ask / fnc_await.
 *
 * All five compose the same two primitives: the SessionRegistry writer
 * (this session's own entry — the only file this process ever writes) and
 * a live-entries reader over the registry dir (every session's file,
 * dead ones skipped + lazily GC'd). The registry is ADVISORY — these
 * handlers surface conflicts and stakeholders; they never block anything.
 *
 * fnc_await is the one long-running handler: it polls "does any OTHER
 * live session hold an overlapping claim?" via fs.watch on the registry
 * dir plus a ~2s interval fallback (fs.watch is best-effort per platform),
 * resolving when the answer turns no or the timeout lapses. The parent
 * dispatcher floats each connection's handler chain, so a parked await
 * never blocks sibling tool calls. Its wire-call timeout is raised to
 * outlast the 540s poll cap (see dispatch.ts CALL_TIMEOUT_OVERRIDES).
 */

import { watch as fsWatch } from 'node:fs';

import { keysOverlap } from '../../registry/key-overlap';
import type { ClaimMode, RegistryClaim, RegistryEntry } from '../../registry/RegistryEntry';
import { readLiveEntries, SessionRegistry } from '../../registry/SessionRegistry';
import type { ParentDispatchHandler } from '../parent-dispatch';
import type { WireRequest, WireResponse } from '../wire';

/** Default + cap for fnc_await's timeoutSeconds — stays under MCP tool-call timeouts. */
export const AWAIT_TIMEOUT_CAP_SECONDS = 540;
/** Interval fallback for the await poll, in case fs.watch misses events. */
const AWAIT_POLL_INTERVAL_MS = 2000;

const CLAIM_MODES: readonly ClaimMode[] = ['using', 'exclusive'];

/** One other-session row in a conflicts / stakeholders / holders list. */
interface StakeholderRow {
  session: RegistryEntry['session'];
  pid: number;
  cwd: string;
  claims: RegistryClaim[];
}

export interface CreateCoordinationHandlersArgs {
  /** This session's own registry entry writer. */
  registry: SessionRegistry;
  /** Injectable for tests; defaults to readLiveEntries over registry.dir. */
  listLive?: () => RegistryEntry[];
  /**
   * Injectable dir watcher for fnc_await; defaults to fs.watch. Returns the
   * cleanup function. A watcher that can't start returns a no-op cleanup —
   * the interval fallback still covers the poll.
   */
  watchDir?: (dir: string, onChange: () => void) => () => void;
  /** Injectable for tests; defaults to ~2s. */
  awaitIntervalMs?: number;
}

export interface CoordinationHandlers {
  sessions: ParentDispatchHandler;
  claim: ParentDispatchHandler;
  release: ParentDispatchHandler;
  ask: ParentDispatchHandler;
  await: ParentDispatchHandler;
}

function defaultWatchDir(dir: string, onChange: () => void): () => void {
  try {
    const watcher = fsWatch(dir, onChange);
    return (): void => {
      watcher.close();
    };
  } catch {
    return (): void => {};
  }
}

function stringField(req: WireRequest, field: string): string | null {
  const value = req[field];
  if (typeof value !== 'string' || !value) {
    return null;
  }
  return value;
}

/**
 * Build the five coordination handlers, sharing one registry + reader.
 * The returned record spreads straight into createParentDispatcher's
 * handlers (keys match the wire ops).
 */
export function createCoordinationHandlers(
  args: CreateCoordinationHandlersArgs,
): CoordinationHandlers {
  const { registry } = args;
  const listLive = args.listLive ?? ((): RegistryEntry[] => readLiveEntries({ dir: registry.dir }));
  const watchDir = args.watchDir ?? defaultWatchDir;
  const awaitIntervalMs = args.awaitIntervalMs ?? AWAIT_POLL_INTERVAL_MS;

  /** Other live sessions whose claims overlap `key`, with just those claims. */
  function overlappingHolders(key: string): StakeholderRow[] {
    const rows: StakeholderRow[] = [];
    for (const entry of listLive()) {
      if (entry.session.id === registry.session.id) {
        continue;
      }
      const overlapping = entry.claims.filter((c) => keysOverlap(c.key, key));
      if (overlapping.length) {
        rows.push({
          session: entry.session,
          pid: entry.owner.pid,
          cwd: entry.cwd,
          claims: overlapping,
        });
      }
    }
    return rows;
  }

  const sessions: ParentDispatchHandler = async (_req): Promise<WireResponse> => {
    return {
      action: 'sessions',
      sessions: listLive().map((entry) => ({
        session: entry.session,
        pid: entry.owner.pid,
        cwd: entry.cwd,
        started_at: entry.startedAt,
        claims: entry.claims,
        self: entry.session.id === registry.session.id,
      })),
    };
  };

  const claim: ParentDispatchHandler = async (req): Promise<WireResponse> => {
    const key = stringField(req, 'key');
    if (key === null) {
      return { action: 'error', error: 'fnc_claim requires a non-empty string key.' };
    }
    const mode = req.mode;
    if (typeof mode !== 'string' || !CLAIM_MODES.includes(mode as ClaimMode)) {
      return {
        action: 'error',
        error: `fnc_claim mode must be "using" or "exclusive" (got ${JSON.stringify(mode)}).`,
      };
    }
    const note = typeof req.note === 'string' && req.note ? req.note : undefined;
    const stored = registry.claim({
      key,
      mode: mode as ClaimMode,
      ...(note !== undefined ? { note } : {}),
    });
    return {
      action: 'claimed',
      claim: stored,
      conflicts: overlappingHolders(stored.key),
    };
  };

  const release: ParentDispatchHandler = async (req): Promise<WireResponse> => {
    const key = stringField(req, 'key');
    if (key === null) {
      return { action: 'error', error: 'fnc_release requires a non-empty string key.' };
    }
    return { action: 'released', removed: registry.release({ key }) };
  };

  const ask: ParentDispatchHandler = async (req): Promise<WireResponse> => {
    const key = stringField(req, 'key');
    if (key === null) {
      return { action: 'error', error: 'fnc_ask requires a non-empty string key.' };
    }
    return { action: 'stakeholders', key, stakeholders: overlappingHolders(key) };
  };

  const awaitRelease: ParentDispatchHandler = async (req, ctx): Promise<WireResponse> => {
    const key = stringField(req, 'key');
    if (key === null) {
      return { action: 'error', error: 'fnc_await requires a non-empty string key.' };
    }
    const requested = req.timeoutSeconds;
    const timeoutSeconds =
      typeof requested === 'number' && requested > 0
        ? Math.min(requested, AWAIT_TIMEOUT_CAP_SECONDS)
        : AWAIT_TIMEOUT_CAP_SECONDS;

    // Client-disconnect abort (dispatch ctx): when the subprocess's
    // connection is already gone, don't arm a poll nobody will read.
    const signal = ctx?.signal;
    if (signal?.aborted) {
      return { action: 'await', released: false, aborted: true, timeout_seconds: timeoutSeconds };
    }

    if (!overlappingHolders(key).length) {
      return { action: 'await', released: true, timeout_seconds: timeoutSeconds };
    }

    return new Promise<WireResponse>((resolve) => {
      let settled = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unwatch: (() => void) | undefined;

      const onAbort = (): void => {
        // The connection died mid-poll — settle now so the interval +
        // fs.watch stop, instead of polling out the rest of the cap
        // against a dead socket. The reply write is a no-op downstream.
        finish({
          action: 'await',
          released: false,
          aborted: true,
          timeout_seconds: timeoutSeconds,
        });
      };

      const finish = (response: WireResponse): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (interval !== undefined) {
          clearInterval(interval);
        }
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        unwatch?.();
        signal?.removeEventListener('abort', onAbort);
        resolve(response);
      };

      const check = (): void => {
        if (settled) {
          return;
        }
        if (!overlappingHolders(key).length) {
          finish({ action: 'await', released: true, timeout_seconds: timeoutSeconds });
        }
      };

      unwatch = watchDir(registry.dir, check);
      interval = setInterval(check, awaitIntervalMs);
      timer = setTimeout(() => {
        finish({
          action: 'await',
          released: false,
          holders: overlappingHolders(key),
          timeout_seconds: timeoutSeconds,
        });
      }, timeoutSeconds * 1000);
      signal?.addEventListener('abort', onAbort, { once: true });

      // A holder may have vanished between the pre-check and the watcher
      // arming — close that window with one immediate re-check.
      check();
    });
  };

  return { sessions, claim, release, ask, await: awaitRelease };
}
