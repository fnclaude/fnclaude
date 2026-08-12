/**
 * Unit tests for the five session-coordination MCP handlers (#350):
 * fnc_sessions / fnc_claim / fnc_release / fnc_ask / fnc_await.
 *
 * The handlers compose the SessionRegistry writer (own entry, fake fs)
 * with an injected live-entries reader — no real registry dir, no real
 * /proc, no real fs.watch. The await handler gets injected watch +
 * interval seams so the long-poll runs in milliseconds here.
 */

import { describe, expect, test } from 'bun:test';

import { createCoordinationHandlers } from '../../src/mcp/handlers/coordination';
import type { RegistryEntry } from '../../src/registry/RegistryEntry';
import { SessionRegistry, type IRegistryFs } from '../../src/registry/SessionRegistry';
import type { WireRequest } from '../../src/mcp/wire';

const DIR = '/state/fnclaude/registry';
const OWN_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

function makeFakeFs(): { files: Map<string, string>; fs: IRegistryFs } {
  const files = new Map<string, string>();
  const fs: IRegistryFs = {
    mkdir(): void {},
    writeFile(path: string, content: string): void {
      files.set(path, content);
    },
    rename(from: string, to: string): void {
      const content = files.get(from);
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      files.delete(from);
      files.set(to, content);
    },
    unlink(path: string): void {
      files.delete(path);
    },
    readFile(path: string): string {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error('ENOENT');
      }
      return content;
    },
    readdir(): string[] {
      return [];
    },
  };
  return { files, fs };
}

function makeOtherEntry(overrides?: Partial<RegistryEntry>): RegistryEntry {
  return {
    session: { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'other-session' },
    owner: { pid: 200, starttime: '777' },
    cwd: '/home/u/src/other',
    startedAt: '2026-08-11T10:00:00.000Z',
    claims: [{ key: '/home/u/src/other', mode: 'exclusive', implicit: 'cwd' }],
    ...overrides,
  };
}

interface Harness {
  registry: SessionRegistry;
  live: RegistryEntry[];
  handlers: ReturnType<typeof createCoordinationHandlers>;
  watchCallbacks: (() => void)[];
  unwatch: { count: number };
}

function makeHarness(args?: { others?: RegistryEntry[]; awaitIntervalMs?: number }): Harness {
  const fake = makeFakeFs();
  const registry = new SessionRegistry({
    dir: DIR,
    session: { id: OWN_ID, name: 'my-session' },
    ownerPid: 100,
    cwd: '/home/u/src/proj',
    fs: fake.fs,
    readStarttime: () => '555',
    now: () => new Date('2026-08-11T12:00:00.000Z'),
  });
  registry.register();

  // Live view: own entry (parsed back from the fake fs) + injected others.
  const live: RegistryEntry[] = [];
  const listLive = (): RegistryEntry[] => {
    const ownRaw = fake.files.get(`${DIR}/${OWN_ID}.json`);
    const own = ownRaw !== undefined ? [JSON.parse(ownRaw) as RegistryEntry] : [];
    return [...own, ...live];
  };
  if (args?.others) {
    live.push(...args.others);
  }

  const watchCallbacks: (() => void)[] = [];
  const unwatch = { count: 0 };
  const handlers = createCoordinationHandlers({
    registry,
    listLive,
    watchDir: (_dir, onChange) => {
      watchCallbacks.push(onChange);
      return () => {
        unwatch.count++;
      };
    },
    awaitIntervalMs: args?.awaitIntervalMs ?? 5,
  });
  return { registry, live, handlers, watchCallbacks, unwatch };
}

function req(op: string, fields?: Record<string, unknown>): WireRequest {
  return { op, ...fields } as WireRequest;
}

describe('fnc_sessions handler', () => {
  test('returns every live entry including self, self flagged', async () => {
    const h = makeHarness({ others: [makeOtherEntry()] });
    const res = await h.handlers.sessions(req('sessions'));
    expect(res.action).toBe('sessions');
    const sessions = res.sessions as { session: { id: string }; self: boolean }[];
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.session.id === OWN_ID)?.self).toBe(true);
    expect(sessions.find((s) => s.session.id !== OWN_ID)?.self).toBe(false);
  });
});

describe('fnc_claim handler', () => {
  test('upserts the claim and returns overlapping claims held by OTHERS', async () => {
    const other = makeOtherEntry({
      claims: [
        { key: '/home/u/src/other', mode: 'exclusive', implicit: 'cwd' },
        { key: '/home/u/.cache/go-build', mode: 'using', note: 'compiling' },
      ],
    });
    const h = makeHarness({ others: [other] });
    const res = await h.handlers.claim(
      req('claim', { key: '/home/u/.cache/', mode: 'exclusive', note: 'remounting' }),
    );

    expect(res.action).toBe('claimed');
    expect(res.claim).toEqual({ key: '/home/u/.cache', mode: 'exclusive', note: 'remounting' });
    const conflicts = res.conflicts as {
      session: { name: string | null };
      claims: { key: string }[];
    }[];
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.session.name).toBe('other-session');
    expect(conflicts[0]!.claims).toEqual([
      { key: '/home/u/.cache/go-build', mode: 'using', note: 'compiling' },
    ]);
  });

  test('own claims never count as conflicts', async () => {
    const h = makeHarness();
    // Overlaps our own implicit cwd claim — but self is excluded.
    const res = await h.handlers.claim(req('claim', { key: '/home/u/src/proj/sub', mode: 'using' }));
    expect(res.action).toBe('claimed');
    expect(res.conflicts).toEqual([]);
  });

  test('missing key → error', async () => {
    const h = makeHarness();
    const res = await h.handlers.claim(req('claim', { mode: 'using' }));
    expect(res.action).toBe('error');
  });

  test('invalid mode → error', async () => {
    const h = makeHarness();
    const res = await h.handlers.claim(req('claim', { key: '/x', mode: 'locked' }));
    expect(res.action).toBe('error');
    expect(String(res.error)).toContain('mode');
  });
});

describe('fnc_release handler', () => {
  test('removes a held claim → removed: true', async () => {
    const h = makeHarness();
    await h.handlers.claim(req('claim', { key: '/shared/thing', mode: 'exclusive' }));
    const res = await h.handlers.release(req('release', { key: '/shared/thing' }));
    expect(res.action).toBe('released');
    expect(res.removed).toBe(true);
  });

  test('unheld key → removed: false', async () => {
    const h = makeHarness();
    const res = await h.handlers.release(req('release', { key: '/never' }));
    expect(res.removed).toBe(false);
  });

  test('missing key → error', async () => {
    const h = makeHarness();
    const res = await h.handlers.release(req('release'));
    expect(res.action).toBe('error');
  });
});

describe('fnc_ask handler', () => {
  test('lists other sessions whose claims (incl. implicit cwd) overlap the key', async () => {
    const h = makeHarness({ others: [makeOtherEntry()] });
    const res = await h.handlers.ask(req('ask', { key: '/home/u/src/other/deep/file' }));
    expect(res.action).toBe('stakeholders');
    const stakeholders = res.stakeholders as {
      session: { name: string | null };
      pid: number;
      cwd: string;
      claims: { implicit?: string }[];
    }[];
    expect(stakeholders).toHaveLength(1);
    expect(stakeholders[0]!.session.name).toBe('other-session');
    expect(stakeholders[0]!.pid).toBe(200);
    expect(stakeholders[0]!.claims[0]!.implicit).toBe('cwd');
  });

  test('self is never a stakeholder', async () => {
    const h = makeHarness();
    const res = await h.handlers.ask(req('ask', { key: '/home/u/src/proj' }));
    expect(res.stakeholders).toEqual([]);
  });

  test('non-overlapping key → empty stakeholder list', async () => {
    const h = makeHarness({ others: [makeOtherEntry()] });
    const res = await h.handlers.ask(req('ask', { key: '/somewhere/else' }));
    expect(res.stakeholders).toEqual([]);
  });

  test('missing key → error', async () => {
    const h = makeHarness();
    const res = await h.handlers.ask(req('ask'));
    expect(res.action).toBe('error');
  });
});

describe('fnc_await handler', () => {
  test('resolves immediately when no other session holds an overlapping claim', async () => {
    const h = makeHarness();
    const res = await h.handlers.await(req('await', { key: '/free/path' }));
    expect(res.action).toBe('await');
    expect(res.released).toBe(true);
  });

  test('resolves once the holder disappears (registry-dir change event)', async () => {
    const h = makeHarness({ others: [makeOtherEntry()] });
    const pending = h.handlers.await(req('await', { key: '/home/u/src/other', timeoutSeconds: 10 }));

    // Holder releases: live view empties, dir watcher fires.
    h.live.length = 0;
    for (const cb of h.watchCallbacks) {
      cb();
    }

    const res = await pending;
    expect(res.released).toBe(true);
  });

  test('resolves via the interval fallback when no watch event arrives', async () => {
    const h = makeHarness({ others: [makeOtherEntry()], awaitIntervalMs: 5 });
    const pending = h.handlers.await(req('await', { key: '/home/u/src/other', timeoutSeconds: 10 }));
    h.live.length = 0;
    // No watch callback fired — the ~5ms interval must pick it up.
    const res = await pending;
    expect(res.released).toBe(true);
  });

  test('timeout → { released: false, holders } instead of an error', async () => {
    const h = makeHarness({ others: [makeOtherEntry()], awaitIntervalMs: 5 });
    const res = await h.handlers.await(
      req('await', { key: '/home/u/src/other', timeoutSeconds: 0.02 }),
    );
    expect(res.action).toBe('await');
    expect(res.released).toBe(false);
    const holders = res.holders as { session: { name: string | null } }[];
    expect(holders).toHaveLength(1);
    expect(holders[0]!.session.name).toBe('other-session');
  });

  test('timeoutSeconds is capped at 540', async () => {
    const h = makeHarness();
    // Immediate release, but the parsed timeout must clamp — observable via
    // the response's timeout_seconds echo.
    const res = await h.handlers.await(req('await', { key: '/free', timeoutSeconds: 99999 }));
    expect(res.timeout_seconds).toBe(540);
  });

  test('missing key → error', async () => {
    const h = makeHarness();
    const res = await h.handlers.await(req('await'));
    expect(res.action).toBe('error');
  });

  // Client-disconnect abort: without it, a cancelled/abandoned await keeps
  // polling the registry dir every ~2s for the remaining minutes of its
  // 540s cap. The parent dispatcher signals the connection's close via the
  // dispatch context; the parked await must settle AND tear down its
  // interval + fs.watch immediately.
  test('abort signal settles a parked await and stops the poll', async () => {
    const h = makeHarness({ others: [makeOtherEntry()] });
    const aborter = new AbortController();
    const pending = h.handlers.await(
      req('await', { key: '/home/u/src/other', timeoutSeconds: 0.2 }),
      { signal: aborter.signal },
    );
    aborter.abort();
    const res = await pending;
    expect(res.action).toBe('await');
    expect(res.released).toBe(false);
    expect(res.aborted).toBe(true);
    // The dir watcher's cleanup ran — no lingering poll.
    expect(h.unwatch.count).toBe(1);
  });

  test('already-aborted signal → immediate aborted response, no watcher armed', async () => {
    const h = makeHarness({ others: [makeOtherEntry()] });
    const aborter = new AbortController();
    aborter.abort();
    const res = await h.handlers.await(
      req('await', { key: '/home/u/src/other', timeoutSeconds: 0.2 }),
      { signal: aborter.signal },
    );
    expect(res.released).toBe(false);
    expect(res.aborted).toBe(true);
    expect(h.watchCallbacks).toHaveLength(0);
  });
});
