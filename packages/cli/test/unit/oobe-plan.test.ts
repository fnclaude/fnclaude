/**
 * Unit tests for the interview's plan builder.
 *
 * The whole OOBE design rests on this file being right: the model relays and
 * decides nothing, so every way an interview can go wrong — asking about
 * something already configured, asking for a branch template after the plugin
 * was declined, handing `AskUserQuestion` five options — is a bug here. And
 * none of it is reachable from a test that would need a real session, a real
 * terminal, or fngit on PATH. So it is all tested here, through injected
 * detection.
 */

import { describe, expect, test } from 'bun:test';

import type { SpawnCandidate, ToolPresence } from '../../src/oobe/detect';
import {
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS_PER_BATCH,
  type PlanContext,
  buildPlan,
  MAX_CHIP_LENGTH,
  buildSpawnQuestion,
  nextBatch,
  progressLabel,
  progressText,
} from '../../src/oobe/plan';
import type { QuestionId } from '../../src/oobe/questions';

const NO_TOOLS: ToolPresence = { fngit: false, plugin: false, gitShim: false };

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    tools: NO_TOOLS,
    configured: new Set<string>(),
    spawnCandidates: [],
    answers: new Map<QuestionId, string | string[]>(),
    ...over,
  };
}

function answers(entries: [QuestionId, string | string[]][]): Map<QuestionId, string | string[]> {
  return new Map(entries);
}

/** Every question id the plan would ask, across all batches. */
function allIds(c: PlanContext): string[] {
  return buildPlan(c).flatMap((b) => b.questions.map((q) => q.id));
}

describe('batch order', () => {
  test('Tools comes first, so `{branch}` never refers forward', () => {
    expect(buildPlan(ctx()).map((b) => b.id)).toEqual([
      'tools',
      'sessions',
      'claude-git',
      'apply',
    ]);
  });

  test('Repos appears once a tool has been accepted', () => {
    const c = ctx({ answers: answers([['install-fngit', 'yes'], ['install-plugin', 'yes']]) });
    expect(buildPlan(c).map((b) => b.id)).toEqual(['repos', 'sessions', 'claude-git', 'apply']);
  });
});

describe('dependencies — Repos asks only what the chosen tools need', () => {
  test('both tools accepted → all four repo questions', () => {
    const c = ctx({ answers: answers([['install-fngit', 'yes'], ['install-plugin', 'yes']]) });
    const repos = buildPlan(c).find((b) => b.id === 'repos');
    expect(repos!.questions.map((q) => q.id)).toEqual([
      'clone-template',
      'worktree-template',
      'branch-template',
      'additional-src-dirs',
    ]);
  });

  test('fngit only → no branch template (only the plugin reads it)', () => {
    const c = ctx({ answers: answers([['install-fngit', 'yes'], ['install-plugin', 'no']]) });
    const ids = allIds(c);
    expect(ids).toContain('clone-template');
    expect(ids).toContain('worktree-template');
    expect(ids).toContain('additional-src-dirs');
    expect(ids).not.toContain('branch-template');
  });

  test('plugin only → worktree and branch templates, no clone destination', () => {
    const c = ctx({ answers: answers([['install-fngit', 'no'], ['install-plugin', 'yes']]) });
    const ids = allIds(c);
    expect(ids).toContain('worktree-template');
    expect(ids).toContain('branch-template');
    expect(ids).not.toContain('clone-template');
    expect(ids).not.toContain('additional-src-dirs');
  });

  test('both declined → the Repos batch is not shown at all', () => {
    const c = ctx({ answers: answers([['install-fngit', 'no'], ['install-plugin', 'no']]) });
    expect(buildPlan(c).map((b) => b.id)).not.toContain('repos');
  });

  test('the git-shim question needs fngit', () => {
    const withFngit = ctx({ answers: answers([['install-fngit', 'yes']]) });
    expect(allIds(withFngit)).toContain('git-shim');
    const without = ctx({ answers: answers([['install-fngit', 'no']]) });
    expect(allIds(without)).not.toContain('git-shim');
  });

  test('an ALREADY-INSTALLED tool satisfies the dependency without being asked', () => {
    // fngit on PATH means its question is skipped, but the repo questions it
    // gates must still appear — a skipped question is not a "no".
    const c = ctx({ tools: { fngit: true, plugin: false, gitShim: false } });
    const ids = allIds(c);
    expect(ids).not.toContain('install-fngit');
    expect(ids).toContain('clone-template');
    expect(ids).toContain('git-shim');
  });
});

describe('skips — a configured key is not asked about', () => {
  test('a set fnc key drops its question', () => {
    const c = ctx({ configured: new Set(['auto.tmux']) });
    expect(allIds(c)).not.toContain('auto-tmux');
  });

  test('a set shared key drops its question', () => {
    const c = ctx({
      answers: answers([['install-fngit', 'yes']]),
      configured: new Set(['repos.cloneTemplate']),
    });
    const ids = allIds(c);
    expect(ids).not.toContain('clone-template');
    expect(ids).toContain('worktree-template');
  });

  test('a batch whose questions are all configured is not shown', () => {
    const c = ctx({
      configured: new Set(['noopDir', 'auto.spawnCommand', 'auto.tmux', 'auto.handoff']),
    });
    expect(buildPlan(c).map((b) => b.id)).not.toContain('sessions');
  });

  test('an already-answered question is not re-asked', () => {
    const c = ctx({ answers: answers([['auto-tmux', 'always']]) });
    expect(allIds(c)).not.toContain('auto-tmux');
  });

  test('a tool already installed skips its question', () => {
    const c = ctx({ tools: { fngit: true, plugin: true, gitShim: false } });
    const ids = allIds(c);
    expect(ids).not.toContain('install-fngit');
    expect(ids).not.toContain('install-plugin');
  });
});

describe('progress — the denominator counts what will actually be shown', () => {
  test('a fresh machine, both tools declined', () => {
    const c = ctx({ answers: answers([['install-fngit', 'no'], ['install-plugin', 'no']]) });
    const plan = buildPlan(c);
    // Repos is gone, so Sessions is 1 of 3 rather than 2 of 5.
    expect(plan.map((b) => b.progressText)).toEqual([
      'Sessions (1/3)',
      'Claude and git (2/3)',
      'Apply (3/3)',
    ]);
    expect(plan.map((b) => b.progressLabel)).toEqual([
      'Sessions 1/3',
      'Claude 2/3',
      'Apply 3/3',
    ]);
  });

  test('indexes are 1-based and the total is the same on every batch', () => {
    const plan = buildPlan(ctx());
    for (const b of plan) expect(b.total).toBe(plan.length);
    expect(plan.map((b) => b.index)).toEqual(plan.map((_, i) => i + 1));
  });

  test('the header chip never exceeds 12 characters, on any reachable plan', () => {
    const plans = [
      ctx(),
      ctx({ answers: answers([['install-fngit', 'yes'], ['install-plugin', 'yes']]) }),
      ctx({ answers: answers([['install-fngit', 'no'], ['install-plugin', 'no']]) }),
      ctx({ tools: { fngit: true, plugin: true, gitShim: true } }),
    ];
    for (const c of plans) {
      for (const b of buildPlan(c)) {
        expect(b.progressLabel.length).toBeLessThanOrEqual(MAX_CHIP_LENGTH);
      }
    }
  });

  test("every batch's real name survives in the chip — no 'Sessio'", () => {
    // The compact form exists precisely so a name never has to be cut. If a
    // future batch title forces a truncation, this is what says so.
    const c = ctx({ answers: answers([['install-fngit', 'yes'], ['install-plugin', 'yes']]) });
    for (const b of buildPlan(c)) {
      const name = b.progressLabel.slice(0, b.progressLabel.lastIndexOf(' '));
      expect(b.title.startsWith(name)).toBe(true);
      // A cut, if any, lands on a word boundary rather than mid-word.
      if (name !== b.title) expect(b.title[name.length]).toBe(' ');
    }
  });

  test('the printed line keeps the spec\'s parenthesised form', () => {
    expect(progressText('Repos', 2, 6)).toBe('Repos (2/6)');
  });

  test('the chip drops the parens so the counter always survives', () => {
    expect(progressLabel('Claude and git', 2, 6)).toBe('Claude 2/6');
    expect(progressLabel('X', 10, 10)).toBe('X 10/10');
    expect(progressLabel('Sessions', 3, 6)).toBe('Sessions 3/6');
  });
});

describe('the AskUserQuestion caps', () => {
  test('no batch exceeds 4 questions', () => {
    const c = ctx({ answers: answers([['install-fngit', 'yes'], ['install-plugin', 'yes']]) });
    for (const b of buildPlan(c)) {
      expect(b.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_BATCH);
    }
  });

  test('no question exceeds 4 options', () => {
    const many: SpawnCandidate[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((bin, i) => ({
      template: `${bin} {bin} {dest}`,
      bin,
      isCurrent: i === 0,
      isTmux: false,
    }));
    const c = ctx({
      spawnCandidates: many,
      answers: answers([['install-fngit', 'yes'], ['install-plugin', 'yes']]),
    });
    for (const b of buildPlan(c)) {
      for (const q of b.questions) {
        expect(q.options.length).toBeLessThanOrEqual(MAX_OPTIONS_PER_QUESTION);
      }
    }
  });

  test('trimming keeps the recommended option, which is always first', () => {
    const many: SpawnCandidate[] = ['ghostty', 'kitty', 'alacritty', 'wezterm', 'foot'].map(
      (bin, i) => ({ template: `${bin} x`, bin, isCurrent: i === 0, isTmux: false }),
    );
    const q = buildSpawnQuestion(many);
    expect(q.options.length).toBe(4);
    expect(q.options[0]!.label).toContain('(Recommended)');
    expect(q.options[0]!.value).toBe('ghostty x');
  });

  test('the claude-flags multi-select is exactly at the cap', () => {
    const q = buildPlan(ctx()).find((b) => b.id === 'claude-git')!.questions[0]!;
    expect(q.id).toBe('claude-flags');
    expect(q.multiSelect).toBe(true);
    expect(q.options.length).toBe(4);
    // Free text is the tool's automatic slot and does not count against the cap.
    expect(q.freeText).toBeDefined();
  });
});

describe('the spawn-command question is built from detection', () => {
  test('the current terminal is recommended and first', () => {
    const q = buildSpawnQuestion([
      { template: 'kitty x', bin: 'kitty', isCurrent: false, isTmux: false },
      { template: 'ghostty x', bin: 'ghostty', isCurrent: true, isTmux: false },
    ]);
    // buildSpawnQuestion preserves the caller's order; detection puts the
    // current terminal first. Here it is second, so the label carries the
    // recommendation and the ordering contract is detection's to keep.
    const recommended = q.options.filter((o) => o.label.includes('(Recommended)'));
    expect(recommended.length).toBe(1);
    expect(recommended[0]!.value).toBe('ghostty x');
  });

  test('an installed-but-not-current emulator is offered without a recommendation', () => {
    const q = buildSpawnQuestion([{ template: 'kitty x', bin: 'kitty', isCurrent: false, isTmux: false }]);
    expect(q.options[0]!.label).not.toContain('(Recommended)');
    expect(q.options[0]!.description).toBe('also installed');
  });

  test('the tmux form is labelled for what it is', () => {
    const q = buildSpawnQuestion([
      { template: 'tmux new-window -d x', bin: 'tmux', isCurrent: false, isTmux: true },
    ]);
    expect(q.options[0]!.description).toBe('when running inside tmux');
  });

  test('with nothing detected the screen still has an option, not just free text', () => {
    const q = buildSpawnQuestion([]);
    expect(q.options.length).toBe(1);
    expect(q.options[0]!.value).toContain('tmux new-window');
  });
});

describe('nextBatch', () => {
  test('walks the interview as answers accumulate', () => {
    const given = new Map<QuestionId, string | string[]>();
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const batch = nextBatch(ctx({ answers: given }));
      if (batch === null) break;
      seen.push(batch.id);
      for (const q of batch.questions) {
        given.set(q.id, q.id === 'apply' ? 'apply' : (q.options[0]!.value ?? 'yes'));
      }
    }
    // Tools accepted (first option is "yes"), so Repos appears.
    expect(seen).toEqual(['tools', 'repos', 'sessions', 'claude-git', 'apply']);
  });

  test('terminates once Apply is answered — the loop above must not be infinite', () => {
    const given = new Map<QuestionId, string | string[]>();
    for (let i = 0; i < 20; i++) {
      const batch = nextBatch(ctx({ answers: given }));
      if (batch === null) {
        expect(given.has('apply')).toBe(true);
        return;
      }
      for (const q of batch.questions) {
        given.set(q.id, q.id === 'apply' ? 'apply' : (q.options[0]!.value ?? 'yes'));
      }
    }
    throw new Error('the interview never ended');
  });

  test('Apply is reached even when every other batch is skipped', () => {
    const c = ctx({
      tools: { fngit: true, plugin: true, gitShim: true },
      configured: new Set([
        'noopDir',
        'auto.spawnCommand',
        'auto.tmux',
        'auto.handoff',
        'claude.defaultArgs',
        'repos.cloneTemplate',
        'repos.worktreeTemplate',
        'repos.branchTemplate',
        'repos.additionalSrcDirs',
      ]),
    });
    const plan = buildPlan(c);
    expect(plan.map((b) => b.id)).toEqual(['claude-git', 'apply']);
  });
});
