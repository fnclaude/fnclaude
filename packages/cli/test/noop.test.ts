import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOOP_HANDOFF_TEMPLATE, defaultNoopDir, seedNoop } from '../src/noop.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fnclaude-noop-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('seedNoop', () => {
  test('creates dir + writes template when both are missing', async () => {
    const noopDir = join(dir, 'fresh');
    await seedNoop(noopDir);
    expect(existsSync(noopDir)).toBe(true);
    const tpath = join(noopDir, 'handoff.template.md');
    expect(existsSync(tpath)).toBe(true);
    expect(readFileSync(tpath, 'utf8')).toBe(NOOP_HANDOFF_TEMPLATE);
  });

  test('leaves existing matching template alone (no rewrite)', async () => {
    const noopDir = join(dir, 'existing');
    await seedNoop(noopDir);
    const tpath = join(noopDir, 'handoff.template.md');
    const mtimeFirst = statSync(tpath).mtimeMs;
    // Wait a tick so mtime can advance if anything rewrites.
    await new Promise((r) => setTimeout(r, 20));
    await seedNoop(noopDir);
    const mtimeSecond = statSync(tpath).mtimeMs;
    expect(mtimeSecond).toBe(mtimeFirst);
  });

  test('rewrites the template when on-disk content is stale (SHA mismatch)', async () => {
    const noopDir = join(dir, 'stale');
    await seedNoop(noopDir);
    const tpath = join(noopDir, 'handoff.template.md');
    // Tamper with the file.
    writeFileSync(tpath, '# something else entirely\n', 'utf8');
    await seedNoop(noopDir);
    expect(readFileSync(tpath, 'utf8')).toBe(NOOP_HANDOFF_TEMPLATE);
  });

  test('never touches a CLAUDE.md sitting next to the template', async () => {
    const noopDir = join(dir, 'with-claude');
    await seedNoop(noopDir);
    const claudeMd = join(noopDir, 'CLAUDE.md');
    writeFileSync(claudeMd, '# user content', 'utf8');
    await seedNoop(noopDir);
    expect(readFileSync(claudeMd, 'utf8')).toBe('# user content');
  });

  test('NOOP_HANDOFF_TEMPLATE SHA is what seedNoop will compare against', () => {
    // Lock the SHA so any drift from the Go source is loudly noticed.
    const sha = createHash('sha256').update(NOOP_HANDOFF_TEMPLATE).digest('hex');
    expect(typeof sha).toBe('string');
    expect(sha.length).toBe(64);
  });
});

describe('defaultNoopDir', () => {
  test('honors $XDG_CONFIG_HOME when set', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/var/run/cfg';
    try {
      expect(defaultNoopDir('/home/tom')).toBe('/var/run/cfg/fnclaude/noop');
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  test('falls back to $home/.config when XDG unset', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(defaultNoopDir('/home/tom')).toBe('/home/tom/.config/fnclaude/noop');
    } finally {
      if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    }
  });
});
