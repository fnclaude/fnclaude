/**
 * Unit tests for the coordination registry store: the SessionRegistry
 * writer (one file per session, write-temp-then-rename, this process is
 * the file's ONLY writer) and the readLiveEntries reader (skip + lazily
 * GC dead entries).
 *
 * All fs access goes through the injectable IRegistryFs seam — no real
 * directories are touched here.
 */

import { describe, expect, test } from 'bun:test';

import type { RegistryEntry } from '../../src/registry/RegistryEntry';
import {
  readLiveEntries,
  SessionRegistry,
  sessionNameFromArgs,
  type IRegistryFs,
} from '../../src/registry/SessionRegistry';

const DIR = '/state/fnclaude/registry';

interface FakeFs {
  files: Map<string, string>;
  events: string[];
  fs: IRegistryFs;
}

function makeFakeFs(): FakeFs {
  const files = new Map<string, string>();
  const events: string[] = [];
  const fs: IRegistryFs = {
    mkdir(dir: string): void {
      events.push(`mkdir:${dir}`);
    },
    writeFile(path: string, content: string): void {
      files.set(path, content);
      events.push(`write:${path}`);
    },
    rename(from: string, to: string): void {
      const content = files.get(from);
      if (content === undefined) {
        throw new Error(`ENOENT: rename ${from}`);
      }
      files.delete(from);
      files.set(to, content);
      events.push(`rename:${from}->${to}`);
    },
    unlink(path: string): void {
      if (!files.delete(path)) {
        throw new Error(`ENOENT: unlink ${path}`);
      }
      events.push(`unlink:${path}`);
    },
    readFile(path: string): string {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: read ${path}`);
      }
      return content;
    },
    readdir(dir: string): string[] {
      const prefix = `${dir}/`;
      const names: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.push(key.slice(prefix.length));
        }
      }
      if (!names.length && dir !== DIR) {
        throw new Error(`ENOENT: readdir ${dir}`);
      }
      return names;
    },
  };
  return { files, events, fs };
}

function makeRegistry(fake: FakeFs, overrides?: {
  id?: string;
  name?: string | null;
  pid?: number;
  starttime?: string | null;
}): SessionRegistry {
  return new SessionRegistry({
    dir: DIR,
    session: { id: overrides?.id ?? 'sid-1', name: overrides?.name ?? 'my-session' },
    ownerPid: overrides?.pid ?? 100,
    cwd: '/home/u/src/proj',
    fs: fake.fs,
    readStarttime: () => (overrides && 'starttime' in overrides ? overrides.starttime! : '555'),
    now: () => new Date('2026-08-11T12:00:00.000Z'),
  });
}

function ownFile(fake: FakeFs, id = 'sid-1'): RegistryEntry {
  const raw = fake.files.get(`${DIR}/${id}.json`);
  expect(raw).toBeDefined();
  return JSON.parse(raw!) as RegistryEntry;
}

describe('SessionRegistry.register', () => {
  test('writes <dir>/<session-id>.json with owner, cwd, startedAt and the implicit cwd claim', () => {
    const fake = makeFakeFs();
    makeRegistry(fake).register();

    const entry = ownFile(fake);
    expect(entry.session).toEqual({ id: 'sid-1', name: 'my-session' });
    expect(entry.owner).toEqual({ pid: 100, starttime: '555' });
    expect(entry.cwd).toBe('/home/u/src/proj');
    expect(entry.startedAt).toBe('2026-08-11T12:00:00.000Z');
    expect(entry.claims).toEqual([
      { key: '/home/u/src/proj', mode: 'exclusive', implicit: 'cwd' },
    ]);
  });

  test('writes atomically: temp file first, then rename onto the final path', () => {
    const fake = makeFakeFs();
    makeRegistry(fake).register();

    const write = fake.events.find((e) => e.startsWith('write:'));
    const rename = fake.events.find((e) => e.startsWith('rename:'));
    expect(write).toBeDefined();
    expect(rename).toBeDefined();
    // The write must NOT target the final path directly.
    expect(write).not.toBe(`write:${DIR}/sid-1.json`);
    // The rename lands on the final path.
    expect(rename!.endsWith(`->${DIR}/sid-1.json`)).toBe(true);
    // And the events happen in write-then-rename order.
    expect(fake.events.indexOf(write!)).toBeLessThan(fake.events.indexOf(rename!));
  });

  test('never throws on fs failure (advisory registry must not break launches)', () => {
    const fake = makeFakeFs();
    fake.fs.writeFile = () => {
      throw new Error('EACCES');
    };
    expect(() => makeRegistry(fake).register()).not.toThrow();
  });
});

describe('SessionRegistry.claim', () => {
  test('appends a claim and rewrites the file', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    reg.claim({ key: '/home/u/.cache/go-build', mode: 'using', note: 'go build dep' });

    const entry = ownFile(fake);
    expect(entry.claims).toEqual([
      { key: '/home/u/src/proj', mode: 'exclusive', implicit: 'cwd' },
      { key: '/home/u/.cache/go-build', mode: 'using', note: 'go build dep' },
    ]);
  });

  test('upserts by key: re-claiming the same key replaces mode/note, no duplicate', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    reg.claim({ key: '/shared/thing', mode: 'using' });
    reg.claim({ key: '/shared/thing', mode: 'exclusive', note: 'mutating now' });

    const claims = ownFile(fake).claims.filter((c) => c.key === '/shared/thing');
    expect(claims).toEqual([{ key: '/shared/thing', mode: 'exclusive', note: 'mutating now' }]);
  });

  test('normalizes the key (trailing slash stripped) before storing', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    reg.claim({ key: '/shared/thing/', mode: 'using' });

    expect(ownFile(fake).claims.some((c) => c.key === '/shared/thing')).toBe(true);
  });

  test('registers lazily when claim() lands before register()', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.claim({ key: '/shared/thing', mode: 'using' });

    const entry = ownFile(fake);
    // Full entry, implicit cwd claim included — not a claims-only fragment.
    expect(entry.owner.pid).toBe(100);
    expect(entry.claims.some((c) => c.implicit === 'cwd')).toBe(true);
    expect(entry.claims.some((c) => c.key === '/shared/thing')).toBe(true);
  });
});

describe('SessionRegistry.release', () => {
  test('removes the claim and rewrites; returns true', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    reg.claim({ key: '/shared/thing', mode: 'exclusive' });
    expect(reg.release({ key: '/shared/thing' })).toBe(true);
    expect(ownFile(fake).claims.some((c) => c.key === '/shared/thing')).toBe(false);
  });

  test('release matches on the normalized key', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    reg.claim({ key: '/shared/thing', mode: 'exclusive' });
    expect(reg.release({ key: '/shared/thing/' })).toBe(true);
  });

  test('releasing an unheld key returns false', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    expect(reg.release({ key: '/never/claimed' })).toBe(false);
  });
});

describe('SessionRegistry.unregister', () => {
  test('unlinks the own file', () => {
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    reg.unregister();
    expect(fake.files.has(`${DIR}/sid-1.json`)).toBe(false);
  });

  test('leaves the file alone when another process re-registered under the same id', () => {
    // Restart handoff: the replacement fnc re-registers <same-session-id>.json
    // with ITS pid before the old process exits. The old process's unlink must
    // not destroy the replacement's registration.
    const fake = makeFakeFs();
    const reg = makeRegistry(fake);
    reg.register();
    const replacement: RegistryEntry = { ...ownFile(fake), owner: { pid: 999, starttime: '777' } };
    fake.files.set(`${DIR}/sid-1.json`, JSON.stringify(replacement));
    reg.unregister();
    expect(fake.files.has(`${DIR}/sid-1.json`)).toBe(true);
  });

  test('is a no-op before register()', () => {
    const fake = makeFakeFs();
    expect(() => makeRegistry(fake).unregister()).not.toThrow();
  });
});

describe('readLiveEntries', () => {
  function seedEntry(fake: FakeFs, id: string, pid: number, starttime: string): RegistryEntry {
    const entry: RegistryEntry = {
      session: { id, name: `s-${id}` },
      owner: { pid, starttime },
      cwd: `/home/u/src/${id}`,
      startedAt: '2026-08-11T11:00:00.000Z',
      claims: [{ key: `/home/u/src/${id}`, mode: 'exclusive', implicit: 'cwd' }],
    };
    fake.files.set(`${DIR}/${id}.json`, JSON.stringify(entry));
    return entry;
  }

  test('returns live entries and skips + unlinks dead ones (lazy GC)', () => {
    const fake = makeFakeFs();
    seedEntry(fake, 'live-1', 100, '555');
    seedEntry(fake, 'dead-1', 200, '666');

    const entries = readLiveEntries({
      dir: DIR,
      fs: fake.fs,
      isLive: (owner) => owner.pid === 100,
    });

    expect(entries.map((e) => e.session.id)).toEqual(['live-1']);
    // Dead entry got GC'd.
    expect(fake.files.has(`${DIR}/dead-1.json`)).toBe(false);
  });

  test('lazy GC re-validates before unlink: a re-registered live entry survives', () => {
    // TOCTOU race: reader A parses a stale file (dead owner) and decides to
    // GC it. Before A's unlink lands, the SAME session id re-registers —
    // e.g. the user resumes a SIGKILLed session, so a new fnc renames its
    // fresh registration into the identical <session-id>.json path. A's
    // unlink-by-path would delete the LIVE entry, and since a session only
    // rewrites its file on register/claim/release, the victim would stay
    // invisible to every other session with no self-heal. The reader must
    // re-read immediately before unlinking and skip unless the owner still
    // matches the dead owner it decided on.
    const fake = makeFakeFs();
    seedEntry(fake, 'sid-x', 200, '666'); // dead content, seen by the scan
    const liveReplacement: RegistryEntry = {
      session: { id: 'sid-x', name: 's-sid-x' },
      owner: { pid: 100, starttime: '555' }, // live per isLive below
      cwd: '/home/u/src/sid-x',
      startedAt: '2026-08-11T11:30:00.000Z',
      claims: [{ key: '/home/u/src/sid-x', mode: 'exclusive', implicit: 'cwd' }],
    };
    // First read returns the stale content; by the time the reader comes
    // back to unlink, the live replacement has been renamed into place.
    const realReadFile = fake.fs.readFile.bind(fake.fs);
    let reads = 0;
    fake.fs.readFile = (path: string): string => {
      if (path === `${DIR}/sid-x.json`) {
        reads++;
        if (reads === 1) {
          return realReadFile(path);
        }
        return JSON.stringify(liveReplacement);
      }
      return realReadFile(path);
    };

    const entries = readLiveEntries({
      dir: DIR,
      fs: fake.fs,
      isLive: (owner) => owner.pid === 100,
    });

    // The stale content read this scan is correctly not reported live…
    expect(entries.map((e) => e.session.id)).toEqual([]);
    // …but the freshly re-registered file must NOT be unlinked.
    expect(fake.files.has(`${DIR}/sid-x.json`)).toBe(true);
  });

  test('lazy GC still unlinks when the re-read confirms the same dead owner', () => {
    const fake = makeFakeFs();
    seedEntry(fake, 'dead-1', 200, '666');

    readLiveEntries({
      dir: DIR,
      fs: fake.fs,
      isLive: (owner) => owner.pid === 100,
    });

    expect(fake.files.has(`${DIR}/dead-1.json`)).toBe(false);
  });

  test('missing registry dir → empty list', () => {
    const fake = makeFakeFs();
    expect(readLiveEntries({ dir: '/nope', fs: fake.fs, isLive: () => true })).toEqual([]);
  });

  test('skips malformed JSON files', () => {
    const fake = makeFakeFs();
    seedEntry(fake, 'live-1', 100, '555');
    fake.files.set(`${DIR}/broken.json`, '{not json');

    const entries = readLiveEntries({ dir: DIR, fs: fake.fs, isLive: () => true });
    expect(entries.map((e) => e.session.id)).toEqual(['live-1']);
  });

  test('ignores non-json and temp files', () => {
    const fake = makeFakeFs();
    seedEntry(fake, 'live-1', 100, '555');
    fake.files.set(`${DIR}/stray.txt`, 'x');
    fake.files.set(`${DIR}/sid-2.json.tmp-42`, '{}');

    const entries = readLiveEntries({ dir: DIR, fs: fake.fs, isLive: () => true });
    expect(entries.map((e) => e.session.id)).toEqual(['live-1']);
  });
});

describe('sessionNameFromArgs', () => {
  test('--name value form', () => {
    expect(sessionNameFromArgs(['--verbose', '--name', 'fix-auth-bug'])).toBe('fix-auth-bug');
  });

  test('--name=value form', () => {
    expect(sessionNameFromArgs(['--name=fix-auth-bug'])).toBe('fix-auth-bug');
  });

  // fnc accepts -n as the short form of --name (worktree/intercept.ts
  // hasNameInPassthrough, preserve-args.ts) — and names are the
  // SendMessage addresses the coordination protocol hands out, so a
  // -n-launched session registering as unnamed dead-ends the
  // ask→message→consent loop for its siblings.
  test('-n value short form', () => {
    expect(sessionNameFromArgs(['--verbose', '-n', 'fix-auth-bug'])).toBe('fix-auth-bug');
  });

  test('-n=value short form', () => {
    expect(sessionNameFromArgs(['-n=fix-auth-bug'])).toBe('fix-auth-bug');
  });

  test('absent → null', () => {
    expect(sessionNameFromArgs(['--verbose'])).toBeNull();
  });

  test('dangling --name with no value → null', () => {
    expect(sessionNameFromArgs(['--name'])).toBeNull();
  });

  test('dangling -n with no value → null', () => {
    expect(sessionNameFromArgs(['-n'])).toBeNull();
  });
});
