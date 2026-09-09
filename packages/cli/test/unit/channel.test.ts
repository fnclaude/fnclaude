/**
 * fnc-as-a-channel: the dev-environment definition, the flags that register
 * it, the notification wire format, and the idle-wake probe.
 *
 * The through-line is that registration takes TWO independent things — the
 * `claude/channel` capability in `initialize` AND fnc's name on a channel
 * flag — and that the flag which carries the name is gated on being a source
 * checkout, because the development flag bypasses Anthropic's channel
 * allowlist and must never be armed on a user's installed copy.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isDevEnvironment } from '../../src/env/dev';
import {
  CHANNEL_CAPABILITY,
  formatChannelNotification,
  pushChannelMessage,
} from '../../src/mcp/channel';
import {
  buildChannelFlags,
  CHANNELS_FLAG,
  DEV_CHANNELS_FLAG,
  FNC_CHANNEL_ENTRY,
} from '../../src/mcp/channel-flags';
import { buildInitializeResponse } from '../../src/mcp/dispatch';
import {
  createChannelTestAckHandler,
  createChannelTestArmHandler,
  DEFAULT_ARM_DELAY_SECONDS,
} from '../../src/mcp/handlers/channel-test';

describe('isDevEnvironment', () => {
  function checkoutWithGit(): string {
    const root = mkdtempSync(join(tmpdir(), 'fnc-dev-'));
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    mkdirSync(join(root, 'bin'));
    return join(root, 'bin', 'fnc.js');
  }

  test('FNC_DEV=1 wins over the heuristic', () => {
    expect(isDevEnvironment({ binPath: '/opt/fnc/bin/fnc.js', env: { FNC_DEV: '1' } })).toBe(true);
  });

  test('FNC_DEV=0 wins too — a checkout can be treated as installed', () => {
    expect(isDevEnvironment({ binPath: checkoutWithGit(), env: { FNC_DEV: '0' } })).toBe(false);
  });

  test('a `.git` above the bin is a source checkout', () => {
    expect(isDevEnvironment({ binPath: checkoutWithGit(), env: {} })).toBe(true);
  });

  test('a worktree counts — its `.git` is a file, not a directory', () => {
    // checkoutWithGit writes `.git` as a gitdir: pointer file on purpose.
    const bin = checkoutWithGit();
    expect(readFileSync(join(bin, '..', '..', '.git'), 'utf8')).toContain('gitdir:');
    expect(isDevEnvironment({ binPath: bin, env: {} })).toBe(true);
  });

  test('node_modules is never dev, even with a `.git` above it', () => {
    const root = mkdtempSync(join(tmpdir(), 'fnc-dev-nm-'));
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n');
    const bin = join(root, 'node_modules', '@fnclaude', 'cli', 'bin', 'fnc.js');
    mkdirSync(join(bin, '..'), { recursive: true });
    expect(isDevEnvironment({ binPath: bin, env: {} })).toBe(false);
  });

  test('an installed path with no `.git` anywhere is not dev', () => {
    const root = mkdtempSync(join(tmpdir(), 'fnc-installed-'));
    mkdirSync(join(root, 'bin'));
    expect(isDevEnvironment({ binPath: join(root, 'bin', 'fnc.js'), env: {} })).toBe(false);
  });

  test('an empty bin path is not dev — the safe default', () => {
    expect(isDevEnvironment({ binPath: '', env: {} })).toBe(false);
  });
});

describe('buildChannelFlags — fnc always names itself, never on both flags', () => {
  test('production puts fnc on --channels', () => {
    expect(buildChannelFlags({ dev: false })).toEqual([CHANNELS_FLAG, FNC_CHANNEL_ENTRY]);
  });

  test('dev puts fnc on the development flag instead', () => {
    // The bypass does not extend from --channels to the development flag, so
    // the entry has to sit on the flag that grants it.
    expect(buildChannelFlags({ dev: true })).toEqual([DEV_CHANNELS_FLAG, FNC_CHANNEL_ENTRY]);
  });

  test('fnc is never named twice', () => {
    for (const dev of [true, false]) {
      const flags = buildChannelFlags({ dev, additional: [FNC_CHANNEL_ENTRY] });
      expect(flags.filter((t) => t === FNC_CHANNEL_ENTRY)).toHaveLength(1);
    }
  });

  test('configured additional entries ride --channels in both environments', () => {
    const entry = 'plugin:fakechat@claude-plugins-official';
    expect(buildChannelFlags({ dev: false, additional: [entry] })).toEqual([
      CHANNELS_FLAG,
      FNC_CHANNEL_ENTRY,
      entry,
    ]);
    expect(buildChannelFlags({ dev: true, additional: [entry] })).toEqual([
      CHANNELS_FLAG,
      entry,
      DEV_CHANNELS_FLAG,
      FNC_CHANNEL_ENTRY,
    ]);
  });

  test('configured development entries are IGNORED outside a dev environment', () => {
    // The whole point of the gate: a config file must not be able to arm an
    // allowlist bypass on an installed copy.
    const flags = buildChannelFlags({ dev: false, development: ['server:sneaky'] });
    expect(flags).not.toContain(DEV_CHANNELS_FLAG);
    expect(flags).not.toContain('server:sneaky');
  });

  test('and honoured inside one', () => {
    const flags = buildChannelFlags({ dev: true, development: ['server:mine'] });
    expect(flags).toEqual([DEV_CHANNELS_FLAG, FNC_CHANNEL_ENTRY, 'server:mine']);
  });

  test('blank and duplicate entries are dropped', () => {
    const flags = buildChannelFlags({ dev: false, additional: ['  ', 'plugin:a@b', 'plugin:a@b'] });
    expect(flags).toEqual([CHANNELS_FLAG, FNC_CHANNEL_ENTRY, 'plugin:a@b']);
  });
});

describe('the initialize response declares the capability', () => {
  test('presence of claude/channel is what registers the listener', () => {
    const caps = buildInitializeResponse().capabilities as {
      experimental?: Record<string, unknown>;
    };
    expect(caps.experimental?.['claude/channel']).toEqual({});
  });

  test('the capability value is always the empty object', () => {
    expect(CHANNEL_CAPABILITY).toEqual({ 'claude/channel': {} });
  });
});

describe('the channel notification wire format', () => {
  test('method and content are what Claude Code listens for', () => {
    const line = JSON.parse(formatChannelNotification({ content: 'ci failed' })) as {
      jsonrpc: string;
      method: string;
      params: { content: string; meta?: unknown };
      id?: unknown;
    };
    expect(line.jsonrpc).toBe('2.0');
    expect(line.method).toBe('notifications/claude/channel');
    expect(line.params.content).toBe('ci failed');
    // A notification carries no id — an id would make it a request awaiting a
    // response, and Claude Code never answers channel events.
    expect('id' in line).toBe(false);
  });

  test('meta is omitted entirely when empty rather than sent as {}', () => {
    const line = JSON.parse(formatChannelNotification({ content: 'x', meta: {} })) as {
      params: Record<string, unknown>;
    };
    expect('meta' in line.params).toBe(false);
  });

  test('non-identifier meta keys are dropped here, not silently by the client', () => {
    // Claude Code turns each key into a tag attribute and drops anything with
    // a hyphen without saying so. Dropping locally makes the typo testable.
    const line = JSON.parse(
      formatChannelNotification({
        content: 'x',
        meta: { run_id: '7', severity: 'high', 'bad-key': 'gone', 'also.bad': 'gone' },
      }),
    ) as { params: { meta: Record<string, string> } };
    expect(line.params.meta).toEqual({ run_id: '7', severity: 'high' });
  });

  test('pushChannelMessage writes one newline-terminated line', () => {
    const written: string[] = [];
    pushChannelMessage((line) => written.push(line), { content: 'hello' });
    expect(written).toHaveLength(1);
    expect(written[0]!.endsWith('\n')).toBe(true);
    expect(written[0]!.trimEnd()).not.toContain('\n');
  });
});

describe('the idle-wake probe', () => {
  function probe() {
    const written: string[] = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const logPath = join(mkdtempSync(join(tmpdir(), 'fnc-probe-')), 'probe.jsonl');
    const deps = {
      write: (line: string) => void written.push(line),
      logPath,
      schedule: (fn: () => void, ms: number) => void scheduled.push({ fn, ms }),
    };
    return { written, scheduled, logPath, deps };
  }

  function logLines(logPath: string): Array<Record<string, unknown>> {
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test('arming returns immediately and pushes nothing yet', async () => {
    // Returning before the push is the whole design: the turn has to end so
    // the session is idle when the event lands.
    const { written, scheduled, deps } = probe();
    const arm = createChannelTestArmHandler(deps);
    await arm({});
    expect(written).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(DEFAULT_ARM_DELAY_SECONDS * 1000);
  });

  test('the timer pushes a channel event tagged as the probe', async () => {
    const { written, scheduled, deps } = probe();
    await createChannelTestArmHandler(deps)({ delay_seconds: 5 });
    expect(scheduled[0]!.ms).toBe(5000);
    scheduled[0]!.fn();
    const line = JSON.parse(written[0]!) as {
      method: string;
      params: { content: string; meta: Record<string, string> };
    };
    expect(line.method).toBe('notifications/claude/channel');
    expect(line.params.meta.probe).toBe('idle_wake');
    // The event has to name the ack tool, or the model has no way to reply.
    expect(line.params.content).toContain('fnc_channel_test_ack');
  });

  test('a bogus delay falls back to the default rather than firing instantly', async () => {
    for (const delay of [0, -5, 'soon', null]) {
      const { scheduled, deps } = probe();
      await createChannelTestArmHandler(deps)({ delay_seconds: delay });
      expect(scheduled[0]!.ms).toBe(DEFAULT_ARM_DELAY_SECONDS * 1000);
    }
  });

  test('the log is the verdict: arm, push, ack in order', async () => {
    const { scheduled, logPath, deps } = probe();
    await createChannelTestArmHandler(deps)({ delay_seconds: 5 });
    scheduled[0]!.fn();
    await createChannelTestAckHandler(deps)({ note: 'idle, no prompt in flight' });

    const events = logLines(logPath);
    expect(events.map((e) => e.event)).toEqual(['arm', 'push', 'ack']);
    expect(events[2]!.note).toBe('idle, no prompt in flight');
    // Every entry is timestamped, since the push→ack gap IS the measurement.
    for (const event of events) expect(typeof event.at).toBe('string');
  });

  test('a push with no ack is a recorded negative result, not a crash', async () => {
    const { scheduled, logPath, deps } = probe();
    await createChannelTestArmHandler(deps)({ delay_seconds: 5 });
    scheduled[0]!.fn();
    expect(logLines(logPath).map((e) => e.event)).toEqual(['arm', 'push']);
  });

  test('an unwritable log does not stop the push', async () => {
    const written: string[] = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const deps = {
      write: (line: string) => void written.push(line),
      logPath: '/proc/definitely/not/writable/probe.jsonl',
      schedule: (fn: () => void, ms: number) => void scheduled.push({ fn, ms }),
    };
    await createChannelTestArmHandler(deps)({ delay_seconds: 5 });
    scheduled[0]!.fn();
    expect(written).toHaveLength(1);
  });
});
