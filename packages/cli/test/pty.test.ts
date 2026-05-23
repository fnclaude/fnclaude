// Mirrors src/pty_run_test.go (Go reference) — pure-function unit tests for
// the shared PTY machinery: ring buffer, cross-cwd regex, reconstructArgv,
// and ensureCWD.
//
// The PTY-driven integration test (spawning a fixture child, asserting the
// ring buffer collects its output, and the handoff race kills it) lives in
// test/pty.integration.test.ts so this file stays platform-agnostic.

import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RingBuffer,
  crossCwdRe,
  detectCrossCwd,
  ensureCWD,
  reconstructArgv,
  RING_BUFFER_SIZE,
} from '../src/pty.js';

// ── crossCwdRe / detectCrossCwd ──────────────────────────────────────────

const claudeExactMessage = `This conversation is from a different directory.

To resume, run:
  cd /home/tom/src/arch-setup@fnrhombus && claude --resume 68aa15ae-af23-4c7a-b59f-5cee07c61790

(Command copied to clipboard)`;

describe('detectCrossCwd', () => {
  test('exact message: parses dest + uuid', () => {
    const m = detectCrossCwd(Buffer.from(claudeExactMessage));
    expect(m).not.toBeNull();
    expect(m!.dest).toBe('/home/tom/src/arch-setup@fnrhombus');
    expect(m!.uuid).toBe('68aa15ae-af23-4c7a-b59f-5cee07c61790');
  });

  test('no match in normal output', () => {
    expect(detectCrossCwd(Buffer.from('normal claude output\nno resume message'))).toBeNull();
  });

  test('empty input', () => {
    expect(detectCrossCwd(Buffer.alloc(0))).toBeNull();
  });

  test('partial message (only preamble)', () => {
    expect(
      detectCrossCwd(Buffer.from('This conversation is from a different directory.')),
    ).toBeNull();
  });

  test('TUI capture: cursor escapes between words still parse', () => {
    // The preamble uses \x1b[1C instead of spaces; the cd line is plain ASCII.
    const tuiCapture =
      'This\x1b[1Cconversation\x1b[1Cis\x1b[1Cfrom\x1b[1Ca\x1b[1Cdifferent\x1b[1Cdirectory.\r' +
      '\x1b[1B\x1b[K\rTo resume, run:\x1b[K\r\x1b[1C\x1b[1B' +
      'cd /home/tom/src/fnclaude@fnrhombus && claude --resume 22d4b53f-265f-4455-9e85-2e1afed6244b\x1b[K';
    const m = detectCrossCwd(Buffer.from(tuiCapture));
    expect(m).not.toBeNull();
    expect(m!.dest).toBe('/home/tom/src/fnclaude@fnrhombus');
    expect(m!.uuid).toBe('22d4b53f-265f-4455-9e85-2e1afed6244b');
  });

  test('multiple matches: last wins', () => {
    const second = `This conversation is from a different directory.

To resume, run:
  cd /home/tom/src/dots@rhombu5 && claude --resume aaaabbbb-1111-2222-3333-ccccddddeeee

(Command copied to clipboard)`;
    const m = detectCrossCwd(Buffer.from(`${claudeExactMessage}\n${second}`));
    expect(m).not.toBeNull();
    expect(m!.dest).toBe('/home/tom/src/dots@rhombu5');
    expect(m!.uuid).toBe('aaaabbbb-1111-2222-3333-ccccddddeeee');
  });

  test('embedded in larger output', () => {
    const prefix = '=== some normal claude output ===\nthinking...\nDone.\n\n';
    const m = detectCrossCwd(Buffer.from(prefix + claudeExactMessage));
    expect(m).not.toBeNull();
    expect(m!.dest).toBe('/home/tom/src/arch-setup@fnrhombus');
  });

  test('regex is exactly the Go source-of-truth pattern', () => {
    // Anchor: changing this regex MUST be a deliberate cross-language change.
    expect(crossCwdRe.source).toBe(
      'To resume, run:[\\s\\S]*?cd (\\S+) && claude --resume ([0-9a-fA-F-]{36})',
    );
  });
});

// ── RingBuffer ────────────────────────────────────────────────────────────

describe('RingBuffer', () => {
  test('small write fits under capacity', () => {
    const r = new RingBuffer(16);
    r.write(Buffer.from('hello'));
    expect(r.bytes().toString()).toBe('hello');
  });

  test('exact capacity', () => {
    const r = new RingBuffer(5);
    r.write(Buffer.from('12345'));
    expect(r.bytes().toString()).toBe('12345');
  });

  test('overflow keeps the last N bytes', () => {
    const r = new RingBuffer(5);
    r.write(Buffer.from('1234567890'));
    expect(r.bytes().toString()).toBe('67890');
  });

  test('multiple writes concatenate', () => {
    const r = new RingBuffer(6);
    r.write(Buffer.from('abc'));
    r.write(Buffer.from('def'));
    expect(r.bytes().toString()).toBe('abcdef');
  });

  test('multiple writes overflow keeps tail', () => {
    const r = new RingBuffer(4);
    r.write(Buffer.from('ab'));
    r.write(Buffer.from('cdef'));
    expect(r.bytes().toString()).toBe('cdef');
  });

  test('empty buffer returns zero-length', () => {
    expect(new RingBuffer(8).bytes().length).toBe(0);
  });

  test('production-sized ring holds cross-cwd msg + trailing clutter', () => {
    // Regression target: 4 KB was once enough for the captured fixture but
    // claude 2.1.143 emitted more trailing screen-cleanup escapes before
    // exit and rotated the message out. 64 KB is the current sized value.
    const leading = Buffer.alloc(2048);
    leading.fill(Buffer.from('\x1b[2K\x1b[1A'));
    const msg = Buffer.from(claudeExactMessage);
    const trailing = Buffer.alloc(7168);
    trailing.fill(Buffer.from('\x1b[1A\x1b[2K\x1b[K\x1b[?25h\x1b[?1004l\x1b[?2004l'));

    const r = new RingBuffer(RING_BUFFER_SIZE);
    r.write(leading);
    r.write(msg);
    r.write(trailing);
    const m = detectCrossCwd(r.bytes());
    expect(m).not.toBeNull();
    expect(m!.dest).toBe('/home/tom/src/arch-setup@fnrhombus');
  });
});

// ── reconstructArgv ──────────────────────────────────────────────────────

interface ReconstructCase {
  name: string;
  origArgs: string[];
  dest: string;
  uuid: string;
  want: string[];
}

const reconstructCases: ReconstructCase[] = [
  {
    name: 'no args',
    origArgs: [],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: ['/dest/dir', '--resume', '68aa15ae-af23-4c7a-b59f-5cee07c61790'],
  },
  {
    name: 'single path',
    origArgs: ['src/'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: ['/dest/dir', '--resume', '68aa15ae-af23-4c7a-b59f-5cee07c61790'],
  },
  {
    name: 'two paths replaced by single dest',
    origArgs: ['src/', 'extra/'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: ['/dest/dir', '--resume', '68aa15ae-af23-4c7a-b59f-5cee07c61790'],
  },
  {
    name: 'model preserved',
    origArgs: ['opus', 'src/'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: ['opus', '/dest/dir', '--resume', '68aa15ae-af23-4c7a-b59f-5cee07c61790'],
  },
  {
    name: 'model and effort preserved, flags preserved',
    origArgs: ['opus', 'max', 'src/', '-V'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: [
      'opus',
      'max',
      '/dest/dir',
      '--resume',
      '68aa15ae-af23-4c7a-b59f-5cee07c61790',
      '-V',
    ],
  },
  {
    name: 'path then flags',
    origArgs: ['src/', '--model', 'sonnet', '-V'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: [
      '/dest/dir',
      '--resume',
      '68aa15ae-af23-4c7a-b59f-5cee07c61790',
      '--model',
      'sonnet',
      '-V',
    ],
  },
  {
    name: 'flags only (no path args)',
    origArgs: ['--verbose'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: [
      '/dest/dir',
      '--resume',
      '68aa15ae-af23-4c7a-b59f-5cee07c61790',
      '--verbose',
    ],
  },
  {
    name: 'multiple magic words then multiple paths',
    origArgs: ['opus', 'xhigh', 'path1/', 'path2/', '--flag'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: [
      'opus',
      'xhigh',
      '/dest/dir',
      '--resume',
      '68aa15ae-af23-4c7a-b59f-5cee07c61790',
      '--flag',
    ],
  },
  {
    name: 'fork subcommand dropped on relaunch',
    origArgs: ['fork'],
    dest: '/dest/dir',
    uuid: '68aa15ae-af23-4c7a-b59f-5cee07c61790',
    want: ['/dest/dir', '--resume', '68aa15ae-af23-4c7a-b59f-5cee07c61790'],
  },
];

describe('reconstructArgv', () => {
  for (const tc of reconstructCases) {
    test(tc.name, () => {
      expect(reconstructArgv(tc.origArgs, tc.dest, tc.uuid)).toEqual(tc.want);
    });
  }
});

// ── ensureCWD ────────────────────────────────────────────────────────────

describe('ensureCWD', () => {
  test('already exists: noop, cleanup leaves dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fnclaude-ensurecwd-'));
    try {
      const { cleanup } = await ensureCWD(dir);
      await cleanup();
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('single missing dir: created then cleaned', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'fnclaude-ensurecwd-'));
    const target = join(parent, 'missing');
    try {
      const { cleanup } = await ensureCWD(target);
      expect(existsSync(target)).toBe(true);
      await cleanup();
      expect(existsSync(target)).toBe(false);
      expect(existsSync(parent)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('multi-level missing: all levels created, cleanup unwinds deepest first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fnclaude-ensurecwd-'));
    const target = join(root, 'a', 'b', 'c', 'd');
    try {
      const { cleanup } = await ensureCWD(target);
      expect(existsSync(target)).toBe(true);
      await cleanup();
      for (const p of [
        join(root, 'a', 'b', 'c', 'd'),
        join(root, 'a', 'b', 'c'),
        join(root, 'a', 'b'),
        join(root, 'a'),
      ]) {
        expect(existsSync(p)).toBe(false);
      }
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('path is a file: rejects with descriptive error, no FS change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fnclaude-ensurecwd-'));
    const target = join(root, 'afile');
    try {
      writeFileSync(target, 'x');
      await expect(ensureCWD(target)).rejects.toThrow(/not a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ancestor is a file: rejects, filesystem untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fnclaude-ensurecwd-'));
    try {
      mkdirSync(join(root, 'a'));
      const blocker = join(root, 'a', 'blocker');
      writeFileSync(blocker, 'x');
      const target = join(blocker, 'child', 'leaf');
      await expect(ensureCWD(target)).rejects.toThrow();
      // Blocker file untouched.
      expect(existsSync(blocker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cleanup tolerates externally-removed dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fnclaude-ensurecwd-'));
    const target = join(root, 'missing');
    try {
      const { cleanup } = await ensureCWD(target);
      rmSync(target, { recursive: true });
      await expect(cleanup()).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cleanup errors when fabricated dir is unexpectedly non-empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fnclaude-ensurecwd-'));
    const target = join(root, 'missing');
    try {
      const { cleanup } = await ensureCWD(target);
      writeFileSync(join(target, 'stray.log'), 'x');
      await expect(cleanup()).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
