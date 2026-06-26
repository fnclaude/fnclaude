/**
 * Unit tests for `writeSummaryFile` — the pure file-write seam used by
 * §8.2 (`fnc_switch_project`) and eventually §8.3 (`fnc_spawn_session`).
 *
 * The contract: write `summary` to `<base>/fnclaude-handoff-content-<hex>.md`
 * at mode 0600, return the resolved path. Base-dir + random-hex are
 * injectable for hermetic testing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSummaryFile } from '../../src/handoff/summary-file';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnc-summary-test-'));
  cleanupPaths.push(dir);
  return dir;
}

describe('writeSummaryFile', () => {
  test('writes summary to <base>/fnclaude-handoff-content-<hex>.md', async () => {
    const base = makeBaseDir();
    const r = await writeSummaryFile({
      summary: 'hello\nworld\n',
      baseDir: () => base,
      randomHex: () => 'deadbeefcafef00d',
    });
    expect(r.path).toBe(join(base, 'fnclaude-handoff-content-deadbeefcafef00d.md'));
    expect(readFileSync(r.path, 'utf8')).toBe('hello\nworld\n');
  });

  test('file mode is 0600', async () => {
    const base = makeBaseDir();
    const r = await writeSummaryFile({
      summary: 'x',
      baseDir: () => base,
      randomHex: () => '0123456789abcdef',
    });
    const st = statSync(r.path);
    // The low 9 bits are perms; 0o600 = owner rw, group/world none.
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('different hex tokens → different paths (uniqueness)', async () => {
    const base = makeBaseDir();
    const r1 = await writeSummaryFile({
      summary: 'one',
      baseDir: () => base,
      randomHex: () => 'aaaaaaaaaaaaaaaa',
    });
    const r2 = await writeSummaryFile({
      summary: 'two',
      baseDir: () => base,
      randomHex: () => 'bbbbbbbbbbbbbbbb',
    });
    expect(r1.path).not.toBe(r2.path);
    expect(readFileSync(r1.path, 'utf8')).toBe('one');
    expect(readFileSync(r2.path, 'utf8')).toBe('two');
  });

  test('empty summary is still written (zero-byte file is valid)', async () => {
    const base = makeBaseDir();
    const r = await writeSummaryFile({
      summary: '',
      baseDir: () => base,
      randomHex: () => '1111222233334444',
    });
    expect(readFileSync(r.path, 'utf8')).toBe('');
  });

  test('default base-dir uses XDG_RUNTIME_DIR when set', async () => {
    const base = makeBaseDir();
    const prev = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = base;
    try {
      const r = await writeSummaryFile({
        summary: 'xdg test',
        // no baseDir override → use default
        randomHex: () => 'cafecafecafecafe',
      });
      expect(r.path).toBe(join(base, 'fnclaude-handoff-content-cafecafecafecafe.md'));
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = prev;
      }
    }
  });

  test('default base-dir falls back to os.tmpdir() when XDG_RUNTIME_DIR unset', async () => {
    const prev = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      const r = await writeSummaryFile({
        summary: 'fallback test',
        randomHex: () => '5555666677778888',
      });
      cleanupPaths.push(r.path); // single-file cleanup since base is /tmp
      expect(r.path.startsWith(tmpdir())).toBe(true);
      expect(r.path.endsWith('fnclaude-handoff-content-5555666677778888.md')).toBe(true);
    } finally {
      if (prev !== undefined) {
        process.env.XDG_RUNTIME_DIR = prev;
      }
    }
  });

  test('default randomHex source produces 16 hex chars', async () => {
    // Stash the env to keep this hermetic against the suite's runtime dir.
    const base = makeBaseDir();
    const prev = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = base;
    try {
      const r = await writeSummaryFile({ summary: 'real random' });
      // path looks like .../fnclaude-handoff-content-<16hex>.md
      const m = r.path.match(/fnclaude-handoff-content-([0-9a-f]+)\.md$/);
      expect(m).not.toBeNull();
      expect(m![1]!.length).toBe(16);
    } finally {
      if (prev === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = prev;
      }
    }
  });
});
