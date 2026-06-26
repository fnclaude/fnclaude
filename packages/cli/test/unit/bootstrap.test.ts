import { describe, expect, test } from 'bun:test';

import { bootstrapRepo, type BootstrapDeps } from '../../src/repo/bootstrap';

interface Calls {
  confirms: string[];
  mkdirp: string[];
  gitInit: Array<{ dir: string; url: string }>;
  ghRepoCreate: Array<{ owner: string; name: string }>;
  logs: string[];
}

function makeDeps(opts: {
  answers: boolean[];
  gitInitResult?: { ok: true } | { ok: false; error: string };
  ghCreateResult?: { ok: true } | { ok: false; error: string };
  mkdirpThrows?: boolean;
}): { deps: BootstrapDeps; calls: Calls } {
  const calls: Calls = { confirms: [], mkdirp: [], gitInit: [], ghRepoCreate: [], logs: [] };
  let answerIdx = 0;
  const deps: BootstrapDeps = {
    confirm: async (question, def) => {
      calls.confirms.push(question);
      const a = opts.answers[answerIdx++];
      return a === undefined ? def : a;
    },
    mkdirp: async (path) => {
      calls.mkdirp.push(path);
      if (opts.mkdirpThrows) throw new Error('permission denied');
    },
    gitInit: async (dir, url) => {
      calls.gitInit.push({ dir, url });
      return opts.gitInitResult ?? { ok: true };
    },
    ghRepoCreate: async (owner, name) => {
      calls.ghRepoCreate.push({ owner, name });
      return opts.ghCreateResult ?? { ok: true };
    },
    log: (msg) => calls.logs.push(msg),
  };
  return { deps, calls };
}

const base = {
  owner: 'rhombus-toolkit',
  name: 'ioc',
  host: 'github.com',
  destination: '/home/u/src/ioc@rhombus-toolkit',
  url: 'https://github.com/rhombus-toolkit/ioc.git',
};

describe('bootstrapRepo', () => {
  test('declined at first prompt → declined, no fs/git calls', async () => {
    const { deps, calls } = makeDeps({ answers: [false] });
    const r = await bootstrapRepo({ ...base, deps });
    expect(r).toEqual({ kind: 'declined' });
    expect(calls.mkdirp).toHaveLength(0);
    expect(calls.gitInit).toHaveLength(0);
    expect(calls.ghRepoCreate).toHaveLength(0);
  });

  test('accepted local-only → gitInit called, ghRepoCreate NOT called, launched', async () => {
    const { deps, calls } = makeDeps({ answers: [true, false] });
    const r = await bootstrapRepo({ ...base, deps });
    expect(r).toEqual({ kind: 'launched', cwd: base.destination });
    expect(calls.mkdirp).toEqual([base.destination]);
    expect(calls.gitInit).toEqual([{ dir: base.destination, url: base.url }]);
    expect(calls.ghRepoCreate).toHaveLength(0);
  });

  test('accepted both → gitInit and ghRepoCreate both called, launched', async () => {
    const { deps, calls } = makeDeps({ answers: [true, true] });
    const r = await bootstrapRepo({ ...base, deps });
    expect(r).toEqual({ kind: 'launched', cwd: base.destination });
    expect(calls.gitInit).toHaveLength(1);
    expect(calls.ghRepoCreate).toEqual([{ owner: 'rhombus-toolkit', name: 'ioc' }]);
  });

  test('ghRepoCreate failure → still launched with cwd, warning logged', async () => {
    const { deps, calls } = makeDeps({
      answers: [true, true],
      ghCreateResult: { ok: false, error: 'name already exists' },
    });
    const r = await bootstrapRepo({ ...base, deps });
    expect(r).toEqual({ kind: 'launched', cwd: base.destination });
    expect(calls.logs.some((l) => l.includes('warning') && l.includes('name already exists'))).toBe(
      true,
    );
  });

  test('gitInit failure → error, ghRepoCreate not reached', async () => {
    const { deps, calls } = makeDeps({
      answers: [true, true],
      gitInitResult: { ok: false, error: 'git not found' },
    });
    const r = await bootstrapRepo({ ...base, deps });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error).toContain('git not found');
    expect(calls.ghRepoCreate).toHaveLength(0);
  });

  test('mkdirp failure → error, gitInit not reached', async () => {
    const { deps, calls } = makeDeps({ answers: [true], mkdirpThrows: true });
    const r = await bootstrapRepo({ ...base, deps });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error).toContain('permission denied');
    expect(calls.gitInit).toHaveLength(0);
  });

  test('first prompt uses friendly wording, drops scary phrasing', async () => {
    const { deps, calls } = makeDeps({ answers: [false] });
    await bootstrapRepo({ ...base, deps });
    const q = calls.confirms[0];
    expect(q).toContain(`${base.owner}/${base.name} doesn't exist yet`);
    expect(q).toContain(`create it as a new local repo at ${base.destination}`);
    expect(q).not.toContain('Bootstrap');
    expect(q).not.toContain("doesn't exist on");
  });

  test('non-interactive defaults (confirm returns def=false) → declined', async () => {
    // Simulates the non-TTY path: confirm always returns its default (false).
    const { deps, calls } = makeDeps({ answers: [] });
    const r = await bootstrapRepo({ ...base, deps });
    expect(r).toEqual({ kind: 'declined' });
    expect(calls.gitInit).toHaveLength(0);
  });
});
