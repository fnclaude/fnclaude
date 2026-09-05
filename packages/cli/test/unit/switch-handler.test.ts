/**
 * §8.2 — Unit tests for `createSwitchHandler` / `fnc_switch_project`.
 *
 * Ports the behavioral assertions from Go canonical's
 * `socket_listener_test.go` `OpSwitch_*` cases:
 *   - One-shot writes summary + stashes argv + fires trigger.
 *   - `permission_mode='never'` → paste-flow + clipboard write.
 *   - Clipboard failure in never mode → paste-flow with
 *     clipboard_ok=false; command + message still set.
 *   - Transfer denylist (--worktree etc.) stripped from preserved args.
 *   - Live permission-mode capture happens only when no override AND
 *     no preserved flag carries it.
 *
 * Plus TS-specific cases: missing required fields, override forwarding,
 * file-write failure surfacing as action='error'.
 */

import { describe, expect, test } from 'bun:test';

import { createHandoffTrigger } from '../../src/handoff/trigger';
import {
  createSwitchHandler,
  type CopyToClipboardFn,
  type LivePermissionModeReader,
  type WriteSummaryFn,
} from '../../src/mcp/handlers/switch';
import type { WireRequest, WireResponse } from '../../src/mcp/wire';

interface SummarySpy {
  fn: WriteSummaryFn;
  calls: { summary: string }[];
  fixedPath: string;
}

function makeSummarySpy(fixedPath = '/tmp/fixture/summary.md'): SummarySpy {
  const calls: { summary: string }[] = [];
  return {
    fn: async ({ summary }) => {
      calls.push({ summary });
      return { path: fixedPath };
    },
    calls,
    fixedPath,
  };
}

interface ClipSpy {
  fn: CopyToClipboardFn;
  calls: WireRequest[];
}

function makeClipSpy(clipboardOk: boolean): ClipSpy {
  const calls: WireRequest[] = [];
  return {
    fn: async (req) => {
      calls.push(req);
      return { action: 'done', clipboard_ok: clipboardOk } as WireResponse;
    },
    calls,
  };
}

const REQUIRED_FIELDS: WireRequest = {
  op: 'switch',
  destination: 'arch-setup@fnclaude',
  name: 'fix-thing',
  summary: 'summary content',
};

// ─────────────────────────────────────────────────────────────────────────────
// Required-arg validation
// ─────────────────────────────────────────────────────────────────────────────

describe('createSwitchHandler — required args', () => {
  test('missing destination → action=error', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy();
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
    });
    const r = await handler({ op: 'switch', name: 'x', summary: 's' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('destination');
    expect(summary.calls).toHaveLength(0);
    expect(trigger.getStashedArgv()).toBeNull();
  });

  test('missing name → action=error', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy();
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
    });
    const r = await handler({ op: 'switch', destination: 'd', summary: 's' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('name');
    expect(summary.calls).toHaveLength(0);
  });

  test('missing summary → action=error', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy();
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
    });
    const r = await handler({ op: 'switch', destination: 'd', name: 'n' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('summary');
    expect(summary.calls).toHaveLength(0);
  });

  test('all three missing → error names all three', async () => {
    const trigger = createHandoffTrigger();
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: makeSummarySpy().fn,
    });
    const r = await handler({ op: 'switch' });
    expect(r.action).toBe('error');
    expect(r.error).toContain('destination');
    expect(r.error).toContain('name');
    expect(r.error).toContain('summary');
  });

  test('non-string fields are treated as missing', async () => {
    const trigger = createHandoffTrigger();
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: makeSummarySpy().fn,
    });
    const r = await handler({
      op: 'switch',
      destination: 123 as unknown as string,
      name: 'n',
      summary: 's',
    });
    expect(r.action).toBe('error');
    expect(r.error).toContain('destination');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Normal switch — stashes argv + fires trigger
// ─────────────────────────────────────────────────────────────────────────────

describe('createSwitchHandler — normal switch', () => {
  test('writes summary, stashes argv, fires trigger, returns action=done', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/tmp/test/summary.md');
    let fired = false;
    void trigger.awaitTrigger().then(() => {
      fired = true;
    });

    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
    });
    const r = await handler({ ...REQUIRED_FIELDS });

    expect(r.action).toBe('done');
    expect(summary.calls).toHaveLength(1);
    expect(summary.calls[0]!.summary).toBe('summary content');

    const argv = trigger.getStashedArgv();
    expect(argv).toEqual([
      'arch-setup@fnclaude',
      '--name',
      'fix-thing',
      '@/tmp/test/summary.md',
    ]);

    // Give the awaitTrigger callback a chance to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(fired).toBe(true);
  });

  test('with magic prefix, magic comes first then dest', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/summary.md');
    const handler = createSwitchHandler({
      origArgs: ['opus', 'max'],
      trigger,
      writeSummary: summary.fn,
    });
    await handler({ ...REQUIRED_FIELDS });

    const argv = trigger.getStashedArgv();
    expect(argv).toEqual([
      'opus',
      'max',
      'arch-setup@fnclaude',
      '--name',
      'fix-thing',
      '@/p/summary.md',
    ]);
  });

  test('transfer denylist strips --worktree from preserved args', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    const handler = createSwitchHandler({
      // Original argv: src/ positional, -w worktree-name, --ide
      origArgs: ['src/', '-w', 'old-worktree', '--ide'],
      trigger,
      writeSummary: summary.fn,
    });
    await handler({ ...REQUIRED_FIELDS });

    const argv = trigger.getStashedArgv()!;
    // --ide should survive; -w and its value should be stripped.
    expect(argv).toContain('--ide');
    expect(argv).not.toContain('-w');
    expect(argv).not.toContain('old-worktree');
  });

  test('transfer denylist strips --add-dir + extras + --mcp-config + --settings', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    const handler = createSwitchHandler({
      origArgs: [
        'src/',
        '--add-dir',
        '/somewhere',
        '--mcp-config',
        '/old.json',
        '--settings',
        '/settings.json',
        '-A',
        '/extra',
        '--ide',
      ],
      trigger,
      writeSummary: summary.fn,
    });
    await handler({ ...REQUIRED_FIELDS });

    const argv = trigger.getStashedArgv()!;
    expect(argv).toContain('--ide');
    expect(argv).not.toContain('--add-dir');
    expect(argv).not.toContain('--mcp-config');
    expect(argv).not.toContain('--settings');
    expect(argv).not.toContain('-A');
    expect(argv).not.toContain('/somewhere');
    expect(argv).not.toContain('/old.json');
    expect(argv).not.toContain('/settings.json');
    expect(argv).not.toContain('/extra');
  });

  test('override permission_mode is forwarded as flag pair', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
    });
    await handler({
      ...REQUIRED_FIELDS,
      permission_mode: 'plan',
    });

    const argv = trigger.getStashedArgv()!;
    const idx = argv.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('plan');
  });

  test('override model strips bare-magic positional', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    const handler = createSwitchHandler({
      origArgs: ['opus'],
      trigger,
      writeSummary: summary.fn,
    });
    await handler({
      ...REQUIRED_FIELDS,
      model: 'sonnet',
    });

    const argv = trigger.getStashedArgv()!;
    // bare 'opus' should be stripped, --model sonnet appended.
    expect(argv).not.toContain('opus');
    const idx = argv.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('sonnet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Live permission-mode capture
// ─────────────────────────────────────────────────────────────────────────────

describe('createSwitchHandler — live permission-mode capture', () => {
  test('appends --permission-mode <live> when no override, no preserved flag, session_id present', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    const liveReader: LivePermissionModeReader = (sid) => {
      expect(sid).toBe('01234567-89ab-cdef-0123-456789abcdef');
      return 'acceptEdits';
    };
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
      livePermissionModeReader: liveReader,
    });
    await handler({
      ...REQUIRED_FIELDS,
      session_id: '01234567-89ab-cdef-0123-456789abcdef',
    });

    const argv = trigger.getStashedArgv()!;
    const idx = argv.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('acceptEdits');
  });

  test('explicit override wins over live capture', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    let liveCalled = false;
    const liveReader: LivePermissionModeReader = () => {
      liveCalled = true;
      return 'auto';
    };
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
      livePermissionModeReader: liveReader,
    });
    await handler({
      ...REQUIRED_FIELDS,
      session_id: '01234567-89ab-cdef-0123-456789abcdef',
      permission_mode: 'plan',
    });

    const argv = trigger.getStashedArgv()!;
    expect(argv).toContain('plan');
    expect(argv).not.toContain('auto');
    expect(liveCalled).toBe(false);
  });

  test('preserved --permission-mode skips live capture', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    let liveCalled = false;
    const liveReader: LivePermissionModeReader = () => {
      liveCalled = true;
      return 'auto';
    };
    const handler = createSwitchHandler({
      origArgs: ['--permission-mode', 'bypassPermissions'],
      trigger,
      writeSummary: summary.fn,
      livePermissionModeReader: liveReader,
    });
    await handler({
      ...REQUIRED_FIELDS,
      session_id: '01234567-89ab-cdef-0123-456789abcdef',
    });

    expect(liveCalled).toBe(false);
    const argv = trigger.getStashedArgv()!;
    expect(argv).toContain('bypassPermissions');
  });

  test('no session_id → no live capture', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    let liveCalled = false;
    const liveReader: LivePermissionModeReader = () => {
      liveCalled = true;
      return 'auto';
    };
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
      livePermissionModeReader: liveReader,
    });
    await handler({ ...REQUIRED_FIELDS });

    expect(liveCalled).toBe(false);
    const argv = trigger.getStashedArgv()!;
    expect(argv).not.toContain('--permission-mode');
  });

  test('live reader returning null → no flag appended', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/p/s.md');
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
      livePermissionModeReader: () => null,
    });
    await handler({
      ...REQUIRED_FIELDS,
      session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    const argv = trigger.getStashedArgv()!;
    expect(argv).not.toContain('--permission-mode');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Never-mode paste-flow branch
// ─────────────────────────────────────────────────────────────────────────────

describe('createSwitchHandler — permission_mode=never paste-flow', () => {
  test('returns paste_flow with command + clipboard write, no argv stashed', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/runtime/summary.md');
    const clip = makeClipSpy(true);
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
      handleCopyToClipboard: clip.fn,
    });
    const r = await handler({
      ...REQUIRED_FIELDS,
      permission_mode: 'never',
    });

    expect(r.action).toBe('paste_flow');
    expect(r.command).toBe(
      'fnclaude arch-setup@fnclaude --name fix-thing @/runtime/summary.md',
    );
    expect(r.clipboard_ok).toBe(true);
    expect(typeof r.message).toBe('string');

    // Clipboard called with the rendered command.
    expect(clip.calls).toHaveLength(1);
    expect(clip.calls[0]!.op).toBe('copy_to_clipboard');
    expect(clip.calls[0]!.text).toBe(r.command);

    // Trigger must NOT have fired — never mode keeps the current session alive.
    expect(trigger.getStashedArgv()).toBeNull();
  });

  test('paste-flow command includes magic prefix + preserved/override flags', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/r/s.md');
    const clip = makeClipSpy(true);
    const handler = createSwitchHandler({
      origArgs: ['opus', 'src/', '--ide'],
      trigger,
      writeSummary: summary.fn,
      handleCopyToClipboard: clip.fn,
    });
    const r = await handler({
      ...REQUIRED_FIELDS,
      permission_mode: 'never',
    });

    expect(r.action).toBe('paste_flow');
    // Magic word 'opus' comes first; positional 'src/' is dropped by
    // preserveArgs phase 2; --ide is preserved; then dest, --name name,
    // @summaryPath.
    expect(r.command).toBe(
      'fnclaude opus arch-setup@fnclaude --ide --name fix-thing @/r/s.md',
    );
  });

  test('clipboard failure → paste_flow with clipboard_ok=false, command + message still set', async () => {
    const trigger = createHandoffTrigger();
    const summary = makeSummarySpy('/r/s.md');
    const clip = makeClipSpy(false);
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: summary.fn,
      handleCopyToClipboard: clip.fn,
    });
    const r = await handler({
      ...REQUIRED_FIELDS,
      permission_mode: 'never',
    });

    expect(r.action).toBe('paste_flow');
    expect(r.clipboard_ok).toBe(false);
    expect(typeof r.command).toBe('string');
    expect(r.command!.length).toBeGreaterThan(0);
    expect(typeof r.message).toBe('string');
    expect(r.message!.length).toBeGreaterThan(0);
    expect(trigger.getStashedArgv()).toBeNull();
  });

  test('clipboard success vs. failure → different message strings', async () => {
    const trigger1 = createHandoffTrigger();
    const trigger2 = createHandoffTrigger();
    const summary = makeSummarySpy('/r/s.md');

    const okHandler = createSwitchHandler({
      origArgs: [],
      trigger: trigger1,
      writeSummary: summary.fn,
      handleCopyToClipboard: makeClipSpy(true).fn,
    });
    const failHandler = createSwitchHandler({
      origArgs: [],
      trigger: trigger2,
      writeSummary: summary.fn,
      handleCopyToClipboard: makeClipSpy(false).fn,
    });

    const okR = await okHandler({ ...REQUIRED_FIELDS, permission_mode: 'never' });
    const failR = await failHandler({ ...REQUIRED_FIELDS, permission_mode: 'never' });

    expect(okR.message).not.toBe(failR.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// File-write failure handling
// ─────────────────────────────────────────────────────────────────────────────

describe('createSwitchHandler — summary write failure', () => {
  test('write throws → action=error, no stashArgv, no trigger fire', async () => {
    const trigger = createHandoffTrigger();
    const failingWrite: WriteSummaryFn = async () => {
      throw new Error('EACCES: permission denied');
    };
    const handler = createSwitchHandler({
      origArgs: [],
      trigger,
      writeSummary: failingWrite,
    });
    const r = await handler({ ...REQUIRED_FIELDS });

    expect(r.action).toBe('error');
    expect(r.error).toContain('EACCES');
    expect(trigger.getStashedArgv()).toBeNull();
  });
});
