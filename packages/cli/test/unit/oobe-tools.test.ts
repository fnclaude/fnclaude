/**
 * Unit tests for the interview's state machine and its three MCP tools.
 *
 * The property that matters most here is the one that makes the wizard
 * resumable: **every answer is written to the config the moment it is given.**
 * There is no separate resume mechanism — an interrupted wizard picks up
 * because the next run reads those keys and skips their questions. If a write
 * were deferred to Apply, an abort would silently discard everything the user
 * had already decided.
 *
 * The other half is the boundary: what must NOT happen before Apply. Nothing
 * outside the config file — no directories, no installs, no `noOobe`.
 */

import { describe, expect, test } from 'bun:test';

import {
  createOobeAnswerHandler,
  createOobeNextHandler,
  createOobeReaskHandler,
} from '../../src/mcp/handlers/oobe';
import type { ToolPresence } from '../../src/oobe/detect';
import { OobeState, coerceAnswer, patchFor } from '../../src/oobe/state';

const ENV = { home: '/home/tom', xdgConfigHome: '/xdg', xdgStateHome: '/state' };
const NO_TOOLS: ToolPresence = { fngit: false, plugin: false, gitShim: false };
const FNC_CONFIG = '/xdg/rhombus.rocks/fnclaude/config.json';

interface Write {
  path: string;
  patch: Record<string, unknown>;
}

function makeState(over: Partial<ConstructorParameters<typeof OobeState>[0]> = {}): {
  state: OobeState;
  writes: Write[];
} {
  const writes: Write[] = [];
  const state = new OobeState({
    env: ENV,
    tools: NO_TOOLS,
    spawnCandidates: [],
    configured: new Set<string>(),
    writeFnc: (path, patch) => writes.push({ path, patch }),
    ...over,
  });
  return { state, writes };
}

describe('patchFor — a dotted path becomes a nested patch the writer can merge', () => {
  test('one level', () => {
    expect(patchFor('noopDir', '/x')).toEqual({ noopDir: '/x' });
  });

  test('two levels', () => {
    expect(patchFor('auto.tmux', 'always')).toEqual({ auto: { tmux: 'always' } });
  });

  test('three levels', () => {
    expect(patchFor('a.b.c', 1)).toEqual({ a: { b: { c: 1 } } });
  });
});

describe('coerceAnswer — the two questions whose config shape differs from the screen', () => {
  test('claude flags: a multi-select list becomes an array', () => {
    expect(coerceAnswer('claude-flags', ['--chrome', '--brief'])).toEqual(['--chrome', '--brief']);
  });

  test('claude flags: free text is split on whitespace', () => {
    expect(coerceAnswer('claude-flags', '--betas x  --bare')).toEqual(['--betas', 'x', '--bare']);
  });

  test('claude flags: nothing chosen is an empty array, not [""]', () => {
    expect(coerceAnswer('claude-flags', '')).toEqual([]);
  });

  test('source dirs: a comma-separated line becomes a trimmed array', () => {
    expect(coerceAnswer('additional-src-dirs', '~/code, ~/dev ,~/src')).toEqual([
      '~/code',
      '~/dev',
      '~/src',
    ]);
  });

  test('source dirs: the "None" answer is an empty array', () => {
    expect(coerceAnswer('additional-src-dirs', '')).toEqual([]);
  });

  test('everything else passes through as a string', () => {
    expect(coerceAnswer('auto.tmux' as never, 'always')).toBe('always');
    expect(coerceAnswer('noop-dir', '~/x')).toBe('~/x');
  });
});

describe('answers are written as they arrive — this is what makes it resumable', () => {
  test('an fnc-config answer is written immediately, not at Apply', () => {
    const { state, writes } = makeState();
    expect(state.answer('auto-tmux', 'always').ok).toBe(true);
    expect(writes).toEqual([{ path: FNC_CONFIG, patch: { auto: { tmux: 'always' } } }]);
  });

  test('each answer is its own merge patch, so earlier ones survive', () => {
    const { state, writes } = makeState();
    state.answer('auto-tmux', 'always');
    state.answer('auto-handoff', '3');
    state.answer('noop-dir', '~/scratch');
    expect(writes.map((w) => w.patch)).toEqual([
      { auto: { tmux: 'always' } },
      { auto: { handoff: '3' } },
      { noopDir: '~/scratch' },
    ]);
  });

  test('the coerced value is what gets written', () => {
    const { state, writes } = makeState();
    state.answer('claude-flags', ['--chrome', '--ide']);
    expect(writes[0]!.patch).toEqual({ claude: { defaultArgs: ['--chrome', '--ide'] } });
  });

  test('a decision answer writes nothing — it is an instruction, not a setting', () => {
    const { state, writes } = makeState();
    state.answer('install-fngit', 'yes');
    state.answer('install-plugin', 'no');
    state.answer('git-shim', 'yes');
    expect(writes).toEqual([]);
  });

  test('a shared-config answer is collected for fngit, not written by fnc', () => {
    // Two writers on one document is how merge conflicts start: fngit owns
    // the shared file, so fnc hands it the values instead.
    const { state, writes } = makeState();
    state.answer('install-fngit', 'yes');
    state.answer('clone-template', '~/src/{repo}@{owner}');
    expect(writes).toEqual([]);
    expect(state.sharedAnswers()).toEqual({ 'repos.cloneTemplate': '~/src/{repo}@{owner}' });
  });

  test('a write failure is reported rather than swallowed', () => {
    const { state } = makeState({
      writeFnc: () => {
        throw new Error('read-only filesystem');
      },
    });
    const r = state.answer('auto-tmux', 'always');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('read-only filesystem');
  });

  test('an unknown question id is rejected', () => {
    const { state } = makeState();
    const r = state.answer('not-a-question', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown question id');
  });
});

describe('an answered question is not asked again', () => {
  test('within the run', () => {
    const { state } = makeState();
    state.answer('install-fngit', 'no');
    state.answer('install-plugin', 'no');
    const batch = state.next().batch;
    expect(batch!.id).toBe('sessions');
  });

  test('across runs, via the config keys already on disk', () => {
    const { state } = makeState({
      configured: new Set(['noopDir', 'auto.spawnCommand', 'auto.tmux', 'auto.handoff']),
    });
    state.answer('install-fngit', 'no');
    state.answer('install-plugin', 'no');
    expect(state.next().batch!.id).toBe('claude-git');
  });
});

describe('Apply and Abort', () => {
  test('Apply reports applied and ends the interview', () => {
    const { state } = makeState();
    const r = state.answer('apply', 'apply');
    expect(r).toEqual({ ok: true, applied: true });
    expect(state.outcome()).toBe('applied');
    expect(state.next().batch).toBeNull();
  });

  test('Abort ends it too, and reports itself as an abort', () => {
    const { state } = makeState();
    const r = state.answer('apply', 'abort');
    expect(r).toEqual({ ok: true, aborted: true });
    expect(state.outcome()).toBe('aborted');
    expect(state.next().batch).toBeNull();
  });

  test('Abort leaves the answers already written on disk', () => {
    const { state, writes } = makeState();
    state.answer('auto-tmux', 'always');
    state.answer('apply', 'abort');
    // The tmux write happened when it was answered and is not undone.
    expect(writes).toEqual([{ path: FNC_CONFIG, patch: { auto: { tmux: 'always' } } }]);
  });

  test('nothing more is accepted once it is finished', () => {
    const { state } = makeState();
    state.answer('apply', 'abort');
    expect(state.answer('auto-tmux', 'always').ok).toBe(false);
  });
});

describe('reask — the Apply screen\'s "change something" path', () => {
  test('returns the question and re-opens it for `next`', () => {
    const { state } = makeState();
    state.answer('install-fngit', 'yes');
    state.answer('install-plugin', 'no');
    state.answer('clone-template', '~/wrong/{repo}');

    const r = state.reask('clone-template');
    expect(r.ok).toBe(true);
    expect(r.question!.id).toBe('clone-template');

    // The key is on disk now, so re-opening has to defeat the skip as well as
    // forgetting the answer — otherwise the question would never come back.
    const ids = state.next().batch!.questions.map((q) => q.id);
    expect(ids).toContain('clone-template');
  });

  test('re-opens a question whose key was already configured before the run', () => {
    const { state } = makeState({ configured: new Set(['auto.tmux']) });
    state.answer('install-fngit', 'no');
    state.answer('install-plugin', 'no');
    expect(state.next().batch!.questions.map((q) => q.id)).not.toContain('auto-tmux');
    state.reask('auto-tmux');
    expect(state.next().batch!.questions.map((q) => q.id)).toContain('auto-tmux');
  });

  test('withdraws an Apply that had already been given', () => {
    const { state } = makeState();
    state.answer('apply', 'apply');
    expect(state.outcome()).toBe('applied');
    state.reask('auto-tmux');
    expect(state.outcome()).toBeNull();
    expect(state.next().batch).not.toBeNull();
  });

  test('the Apply screen itself cannot be re-asked', () => {
    const { state } = makeState();
    const r = state.reask('apply');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('answer it instead');
  });

  test('an unknown id is rejected', () => {
    const { state } = makeState();
    expect(state.reask('nope').ok).toBe(false);
  });

  test('the machine-specific spawn question can be re-asked', () => {
    const { state } = makeState({
      spawnCandidates: [{ template: 'kitty x', bin: 'kitty', isCurrent: true, isTmux: false }],
    });
    const r = state.reask('spawn-command');
    expect(r.ok).toBe(true);
    expect(r.question!.options[0]!.value).toBe('kitty x');
  });
});

describe('the MCP tools', () => {
  function handlers(over: Partial<ConstructorParameters<typeof OobeState>[0]> = {}) {
    const { state, writes } = makeState(over);
    const applied: number[] = [];
    const aborted: number[] = [];
    const args = {
      state,
      onApply: async () => {
        applied.push(1);
        return { summary: 'did the things' };
      },
      onAbort: () => {
        aborted.push(1);
      },
    };
    return {
      state,
      writes,
      applied,
      aborted,
      next: createOobeNextHandler(args),
      answer: createOobeAnswerHandler(args),
      reask: createOobeReaskHandler(args),
    };
  }

  test('fnc_oobe_next returns a batch shaped for AskUserQuestion', async () => {
    const h = handlers();
    const r = await h.next({ op: 'oobe_next' });
    expect(r.done).toBe(false);
    expect(r.batch).toBe('tools');
    expect(r.progress).toBe('Tools 1/4');
    expect(r.progress_text).toBe('Tools (1/4)');
    const questions = r.questions as Record<string, unknown>[];
    expect(questions.length).toBe(2);
    expect(questions[0]!.id).toBe('install-fngit');
    expect(questions[0]!.question).toBe('Install fngit to resolve repo names?');
    const options = questions[0]!.options as { label: string; value: string }[];
    expect(options[0]!.label).toBe('Yes (Highly Recommended)');
    expect(options[0]!.value).toBe('yes');
  });

  test('the Sessions batch carries its preamble', async () => {
    const h = handlers();
    await h.answer({ op: 'oobe_answer', id: 'install-fngit', value: 'no' });
    await h.answer({ op: 'oobe_answer', id: 'install-plugin', value: 'no' });
    const r = await h.next({ op: 'oobe_next' });
    expect(r.batch).toBe('sessions');
    expect(String(r.preamble)).toContain('no project at all');
  });

  test('fnc_oobe_answer records and writes', async () => {
    const h = handlers();
    const r = await h.answer({ op: 'oobe_answer', id: 'auto-tmux', value: 'always' });
    expect(r.ok).toBe(true);
    expect(h.writes[0]!.patch).toEqual({ auto: { tmux: 'always' } });
  });

  test('fnc_oobe_answer accepts an array for the multi-select', async () => {
    const h = handlers();
    await h.answer({ op: 'oobe_answer', id: 'claude-flags', value: ['--chrome', '--ide'] });
    expect(h.writes[0]!.patch).toEqual({ claude: { defaultArgs: ['--chrome', '--ide'] } });
  });

  test('a missing id is an error, not a silent no-op', async () => {
    const h = handlers();
    const r = await h.answer({ op: 'oobe_answer', value: 'x' });
    expect(r.action).toBe('error');
    expect(String(r.error)).toContain('missing `id`');
  });

  test('answering Apply runs the actions and returns their summary', async () => {
    const h = handlers();
    const r = await h.answer({ op: 'oobe_answer', id: 'apply', value: 'apply' });
    expect(h.applied.length).toBe(1);
    expect(r.done).toBe(true);
    expect(r.message).toBe('did the things');
  });

  test('answering Abort runs nothing and says the answers are kept', async () => {
    const h = handlers();
    const r = await h.answer({ op: 'oobe_answer', id: 'apply', value: 'abort' });
    expect(h.applied.length).toBe(0);
    expect(h.aborted.length).toBe(1);
    expect(r.done).toBe(true);
    expect(String(r.message)).toContain('answers are saved');
  });

  test('fnc_oobe_next says done once the interview is over', async () => {
    const h = handlers();
    await h.answer({ op: 'oobe_answer', id: 'apply', value: 'apply' });
    const r = await h.next({ op: 'oobe_next' });
    expect(r.done).toBe(true);
  });

  test('fnc_oobe_reask hands one question back', async () => {
    const h = handlers();
    await h.answer({ op: 'oobe_answer', id: 'auto-tmux', value: 'always' });
    const r = await h.reask({ op: 'oobe_reask', id: 'auto-tmux' });
    const questions = r.questions as Record<string, unknown>[];
    expect(questions.length).toBe(1);
    expect(questions[0]!.id).toBe('auto-tmux');
  });

  test('fnc_oobe_reask on an unknown id errors', async () => {
    const h = handlers();
    const r = await h.reask({ op: 'oobe_reask', id: 'nope' });
    expect(r.action).toBe('error');
  });
});
