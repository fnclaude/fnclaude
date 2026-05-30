import { describe, expect, test } from 'bun:test';

import { pruneLogDir } from '../../src/log/prune.ts';

function fakeFs(files: Record<string, number>) {
  const unlinked: string[] = [];
  return {
    unlinked,
    readdir: () => Object.keys(files),
    stat: (p: string) => ({ mtimeMs: files[p.split('/').pop()!] ?? 0 }),
    unlink: (p: string) => {
      unlinked.push(p.split('/').pop()!);
    },
  };
}

describe('pruneLogDir', () => {
  test('keeps the N most-recent by mtime, unlinks the rest', () => {
    const fs = fakeFs({
      'fnclaude-1-1.jsonl': 100,
      'fnclaude-2-2.jsonl': 300,
      'fnclaude-3-3.jsonl': 200,
      'fnclaude-4-4.jsonl': 50,
    });
    const result = pruneLogDir({
      dir: '/logs',
      keep: 2,
      readdir: fs.readdir,
      stat: fs.stat,
      unlink: fs.unlink,
    });
    // keep the two newest (mtime 300, 200) → unlink the two oldest (100, 50)
    expect(fs.unlinked.sort()).toEqual(['fnclaude-1-1.jsonl', 'fnclaude-4-4.jsonl']);
    expect(result.removed.map((p) => p.split('/').pop()).sort()).toEqual([
      'fnclaude-1-1.jsonl',
      'fnclaude-4-4.jsonl',
    ]);
  });

  test('ignores non-matching files', () => {
    const fs = fakeFs({
      'fnclaude-1-1.jsonl': 100,
      'fnclaude-2-2.jsonl': 200,
      'other.txt': 999,
      'config.toml': 999,
    });
    pruneLogDir({ dir: '/logs', keep: 1, readdir: fs.readdir, stat: fs.stat, unlink: fs.unlink });
    expect(fs.unlinked).toEqual(['fnclaude-1-1.jsonl']);
  });

  test('keep >= file count removes nothing', () => {
    const fs = fakeFs({ 'fnclaude-1-1.jsonl': 100, 'fnclaude-2-2.jsonl': 200 });
    const result = pruneLogDir({
      dir: '/logs',
      keep: 5,
      readdir: fs.readdir,
      stat: fs.stat,
      unlink: fs.unlink,
    });
    expect(fs.unlinked).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  test('swallows a top-level readdir error', () => {
    const errors: unknown[] = [];
    const result = pruneLogDir({
      dir: '/logs',
      keep: 1,
      readdir: () => {
        throw new Error('ENOENT');
      },
      stat: () => ({ mtimeMs: 0 }),
      unlink: () => {},
      onError: (e) => errors.push(e),
    });
    expect(result.removed).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test('swallows per-file unlink errors and keeps going', () => {
    const errors: unknown[] = [];
    const unlinked: string[] = [];
    const files: Record<string, number> = {
      'fnclaude-1-1.jsonl': 10,
      'fnclaude-2-2.jsonl': 20,
      'fnclaude-3-3.jsonl': 30,
    };
    pruneLogDir({
      dir: '/logs',
      keep: 1,
      readdir: () => Object.keys(files),
      stat: (p) => ({ mtimeMs: files[p.split('/').pop()!] ?? 0 }),
      unlink: (p) => {
        const name = p.split('/').pop()!;
        if (name === 'fnclaude-1-1.jsonl') throw new Error('EBUSY');
        unlinked.push(name);
      },
      onError: (e) => errors.push(e),
    });
    // both old files attempted; one threw (swallowed), the other unlinked
    expect(unlinked).toEqual(['fnclaude-2-2.jsonl']);
    expect(errors).toHaveLength(1);
  });
});
