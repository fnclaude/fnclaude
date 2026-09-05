/**
 * Unit tests for `fnc install` — flag parsing, the Apply plan, the detection
 * that feeds the spawn question, and the `~/.claude/CLAUDE.md` scan.
 *
 * The through-line is that `fnc install -y --flags` and the interactive wizard
 * must produce the SAME plan. That is why the flags become an answer map
 * rather than a second configuration path: there is one description of what
 * setup means, and both entry points feed it.
 */

import { describe, expect, test } from 'bun:test';

import {
  OLD_PLUGIN_QUALIFIED,
  PLUGIN_QUALIFIED,
  buildApplyPlan,
  describeApplyPlan,
  fngitInstallCommand,
  runApplyPlan,
} from '../../src/oobe/apply';
import { formatScan, scanClaudeMd } from '../../src/oobe/claude-md-scan';
import { currentEmulator, detectSpawnCandidates } from '../../src/oobe/detect';
import {
  buildWizardArgs,
  flagsToAnswers,
  isInstallSubcommand,
  parseInstallFlags,
  shouldRunOobe,
} from '../../src/install/subcommand';
import { leafPaths } from '../../src/config/configured';
import type { QuestionId } from '../../src/oobe/questions';

const ENV = { home: '/home/tom', xdgConfigHome: '/xdg', xdgStateHome: '/state' };

describe('isInstallSubcommand', () => {
  test('matches only the leading word', () => {
    expect(isInstallSubcommand(['install'])).toBe(true);
    expect(isInstallSubcommand(['install', '-y'])).toBe(true);
    expect(isInstallSubcommand(['repo', 'install'])).toBe(false);
    expect(isInstallSubcommand([])).toBe(false);
  });
});

describe('parseInstallFlags', () => {
  test('-y and --yes both set the non-interactive flag', () => {
    expect(parseInstallFlags(['-y']).flags!.yes).toBe(true);
    expect(parseInstallFlags(['--yes']).flags!.yes).toBe(true);
  });

  test('bare `install` is interactive', () => {
    expect(parseInstallFlags([]).flags!.yes).toBe(false);
  });

  test('paired and inline values both parse', () => {
    expect(parseInstallFlags(['--clone-template', '~/s/{repo}']).flags!.cloneTemplate).toBe(
      '~/s/{repo}',
    );
    expect(parseInstallFlags(['--clone-template=~/s/{repo}']).flags!.cloneTemplate).toBe(
      '~/s/{repo}',
    );
  });

  test('--no-X forms set false, not absent — declining is a real answer', () => {
    expect(parseInstallFlags(['--no-fngit']).flags!.fngit).toBe(false);
    expect(parseInstallFlags(['--fngit']).flags!.fngit).toBe(true);
    expect(parseInstallFlags([]).flags!.fngit).toBeUndefined();
  });

  test('a value flag with nothing after it is an error', () => {
    const r = parseInstallFlags(['--clone-template']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('needs a value');
  });

  test('an unknown flag is an error rather than being ignored', () => {
    // This command writes config and installs software; a silently dropped
    // --clone-template would be found out much later, with repos in the
    // wrong place.
    const r = parseInstallFlags(['--clone-tempalte', 'x']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown flag');
  });
});

describe('flagsToAnswers — the two entry points share one plan', () => {
  test('every flag maps to the question it answers', () => {
    const flags = parseInstallFlags([
      '-y',
      '--fngit',
      '--no-plugin',
      '--git-shim',
      '--clone-template',
      '~/s/{repo}',
      '--worktree-template',
      '~/s/{repo}+{input}',
      '--branch-template',
      '{input}',
      '--additional-src-dirs',
      '~/code,~/dev',
      '--noop-dir',
      '~/scratch',
      '--spawn-command',
      'kitty {bin}',
      '--tmux',
      'always',
      '--handoff',
      '3',
      '--claude-args',
      '--chrome --ide',
    ]).flags!;
    expect([...flagsToAnswers(flags).entries()]).toEqual([
      ['install-fngit', 'yes'],
      ['install-plugin', 'no'],
      ['git-shim', 'yes'],
      ['clone-template', '~/s/{repo}'],
      ['worktree-template', '~/s/{repo}+{input}'],
      ['branch-template', '{input}'],
      ['additional-src-dirs', '~/code,~/dev'],
      ['noop-dir', '~/scratch'],
      ['spawn-command', 'kitty {bin}'],
      ['auto-tmux', 'always'],
      ['auto-handoff', '3'],
      ['claude-flags', '--chrome --ide'],
    ] as [QuestionId, string][]);
  });

  test('an absent flag is NOT a "no" — it leaves the question unanswered', () => {
    const answers = flagsToAnswers(parseInstallFlags(['-y', '--fngit']).flags!);
    expect(answers.get('install-fngit')).toBe('yes');
    expect(answers.has('install-plugin')).toBe(false);
    expect(answers.has('auto-tmux')).toBe(false);
  });
});

describe('buildWizardArgs — the wizard session is locked down mechanically', () => {
  const args = buildWizardArgs('the prompt');

  test('the prompt rides as --append-system-prompt', () => {
    expect(args[0]).toBe('--append-system-prompt');
    expect(args[1]).toBe('the prompt');
  });

  test('it leaves no resume entry or history in the directory it runs in', () => {
    expect(args).toContain('--no-session-persistence');
  });

  test('the tools that could dirty the cwd are disallowed, not merely discouraged', () => {
    // oobe.md asks the model not to write anything. This is what makes it so
    // whether or not the model complies.
    const i = args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('Write,Edit,MultiEdit,NotebookEdit,Bash');
  });

  test('permission mode is default — the wizard is not a bypass session', () => {
    const i = args.indexOf('--permission-mode');
    expect(args[i + 1]).toBe('default');
  });

  test('no --resume / --continue / -w: this is a one-off session', () => {
    for (const flag of ['--resume', '--continue', '-w', '--worktree']) {
      expect(args).not.toContain(flag);
    }
  });
});

describe('shouldRunOobe', () => {
  test('runs when noOobe is falsy and the session is interactive', () => {
    expect(shouldRunOobe({ noOobe: false, interactive: true })).toBe(true);
  });

  test('never runs once noOobe is set', () => {
    expect(shouldRunOobe({ noOobe: true, interactive: true })).toBe(false);
  });

  test('never runs non-interactively — there is nobody to answer', () => {
    expect(shouldRunOobe({ noOobe: false, interactive: false })).toBe(false);
  });
});

describe('the Apply plan', () => {
  function plan(answers: [QuestionId, string][], over: { fngit?: boolean; plugin?: boolean } = {}) {
    const map = new Map<QuestionId, string | string[]>(answers);
    return buildApplyPlan({
      env: ENV,
      answers: map,
      shared: {},
      hasFngit: over.fngit ?? false,
      hasPlugin: over.plugin ?? false,
    });
  }

  test('always creates the starting directory and seeds the override dir', () => {
    const actions = plan([]);
    expect(actions[0]).toEqual({
      kind: 'mkdir',
      path: '/xdg/rhombus.rocks/fnclaude/noop',
      why: expect.any(String),
    });
    expect(actions[1]!.kind).toBe('seed-prompts');
    expect(actions[1]!.path).toBe('/xdg/rhombus.rocks/fnclaude/prompts');
  });

  test('a chosen noopDir is used, with ~ expanded', () => {
    expect(plan([['noop-dir', '~/scratch/fnc']])[0]!.path).toBe('/home/tom/scratch/fnc');
  });

  test('fngit is installed with plain npm and nothing else', () => {
    // Deliberate: most users have no version manager (owner, 2026-09-05).
    const run = plan([['install-fngit', 'yes']]).find((a) => a.kind === 'run')!;
    expect(run.kind === 'run' && run.command).toEqual([
      'npm',
      'install',
      '-g',
      '@rhombus.rocks/fngit',
    ]);
  });

  test('fngit is not re-installed when it is already there', () => {
    const runs = plan([['install-fngit', 'yes']], { fngit: true }).filter((a) => a.kind === 'run');
    expect(runs.some((a) => a.kind === 'run' && a.command.includes('@rhombus.rocks/fngit'))).toBe(
      false,
    );
  });

  test('the plugin install uses the new marketplace name', () => {
    const runs = plan([['install-plugin', 'yes']]).filter((a) => a.kind === 'run');
    const commands = runs.map((a) => (a.kind === 'run' ? a.command.join(' ') : ''));
    expect(commands.some((c) => c.includes(PLUGIN_QUALIFIED))).toBe(true);
    expect(commands.some((c) => c.includes(OLD_PLUGIN_QUALIFIED))).toBe(false);
  });

  test('noOobe is written LAST, so an interruption leaves the interview still due', () => {
    const actions = plan([['install-fngit', 'yes'], ['install-plugin', 'yes']]);
    const last = actions[actions.length - 1]!;
    expect(last.kind).toBe('write-config');
    expect(last.kind === 'write-config' && last.patch).toEqual({ noOobe: true });
  });

  test('declining everything still yields the directory, the prompts dir, and noOobe', () => {
    const actions = plan([['install-fngit', 'no'], ['install-plugin', 'no']]);
    expect(actions.map((a) => a.kind)).toEqual(['mkdir', 'seed-prompts', 'write-config']);
  });

  test('the preview describes every action — the Apply screen shows the truth', () => {
    const text = describeApplyPlan(plan([['install-fngit', 'yes']]));
    expect(text.split('\n').length).toBe(4);
    expect(text).toContain('npm install -g @rhombus.rocks/fngit');
  });
});

describe('fngitInstallCommand — fngit must never prompt when fnc drives it', () => {
  test('-y is always present', () => {
    expect(fngitInstallCommand({}, false)[2]).toBe('-y');
  });

  test('the collected templates are passed through', () => {
    const cmd = fngitInstallCommand(
      {
        'repos.cloneTemplate': '~/s/{repo}@{owner}',
        'repos.worktreeTemplate': '~/s/{repo}@{owner}+{input}',
        'repos.additionalSrcDirs': ['~/code', '~/dev'],
      },
      true,
    );
    expect(cmd).toContain('--clone-template');
    expect(cmd[cmd.indexOf('--clone-template') + 1]).toBe('~/s/{repo}@{owner}');
    expect(cmd[cmd.indexOf('--additional-src-dirs') + 1]).toBe('~/code,~/dev');
    expect(cmd).toContain('--shadow-git');
  });

  test('fnc installs the plugin itself, so fngit is told not to', () => {
    expect(fngitInstallCommand({}, false)).toContain('--no-plugin');
  });

  test('a declined git shim is passed as an explicit no', () => {
    expect(fngitInstallCommand({}, false)).toContain('--no-shadow-git');
  });

  test('an empty template is omitted rather than passed as ""', () => {
    expect(fngitInstallCommand({ 'repos.cloneTemplate': '' }, false)).not.toContain(
      '--clone-template',
    );
  });
});

describe('runApplyPlan — one failure does not abandon the rest', () => {
  test('a failed install still leaves the config and directories done', async () => {
    const made: string[] = [];
    const wrote: string[] = [];
    const outcome = await runApplyPlan(
      [
        { kind: 'mkdir', path: '/a', why: 'x' },
        { kind: 'run', command: ['false'], why: 'x' },
        { kind: 'write-config', path: '/c', patch: { noOobe: true }, why: 'x' },
      ],
      {
        mkdirp: (p) => made.push(p),
        seedPrompts: () => {},
        run: async () => ({ ok: false, stderr: 'EACCES' }),
        writeConfig: (p) => wrote.push(p),
      },
    );
    expect(made).toEqual(['/a']);
    expect(wrote).toEqual(['/c']);
    expect(outcome.done.length).toBe(2);
    expect(outcome.failed.length).toBe(1);
    expect(outcome.failed[0]!.reason).toBe('EACCES');
  });

  test('a thrown seam is caught and reported, not propagated', async () => {
    const outcome = await runApplyPlan([{ kind: 'mkdir', path: '/a', why: 'x' }], {
      mkdirp: () => {
        throw new Error('EROFS');
      },
      seedPrompts: () => {},
      run: async () => ({ ok: true, stderr: '' }),
      writeConfig: () => {},
    });
    expect(outcome.failed[0]!.reason).toBe('EROFS');
  });
});

describe('terminal detection', () => {
  test('recognises emulators by their own markers', () => {
    expect(currentEmulator({ GHOSTTY_RESOURCES_DIR: '/x' })).toBe('ghostty');
    expect(currentEmulator({ TERM_PROGRAM: 'ghostty' })).toBe('ghostty');
    expect(currentEmulator({ KITTY_WINDOW_ID: '1' })).toBe('kitty');
    expect(currentEmulator({ TERM: 'xterm-kitty' })).toBe('kitty');
    expect(currentEmulator({ WEZTERM_PANE: '0' })).toBe('wezterm');
    expect(currentEmulator({ KONSOLE_VERSION: '22' })).toBe('konsole');
  });

  test('an unknown terminal is null rather than a guess', () => {
    expect(currentEmulator({ TERM: 'xterm-256color' })).toBeNull();
    expect(currentEmulator({})).toBeNull();
  });

  test('the current terminal comes first and is marked current', () => {
    const c = detectSpawnCandidates({
      env: { GHOSTTY_RESOURCES_DIR: '/x' },
      which: () => null,
    });
    expect(c[0]!.bin).toBe('ghostty');
    expect(c[0]!.isCurrent).toBe(true);
  });

  test('other installed emulators follow, and are not marked current', () => {
    const c = detectSpawnCandidates({
      env: { GHOSTTY_RESOURCES_DIR: '/x' },
      which: (bin) => (bin === 'kitty' ? '/usr/bin/kitty' : null),
    });
    expect(c.map((x) => x.bin)).toEqual(['ghostty', 'kitty']);
    expect(c[1]!.isCurrent).toBe(false);
  });

  test('the current terminal is never offered twice', () => {
    const c = detectSpawnCandidates({
      env: { KITTY_WINDOW_ID: '1' },
      which: () => '/usr/bin/anything',
    });
    expect(c.filter((x) => x.bin === 'kitty').length).toBe(1);
  });

  test('tmux is offered only when we are inside it', () => {
    const inside = detectSpawnCandidates({ env: { TMUX: '/tmp/sock' }, which: () => null });
    expect(inside.some((c) => c.isTmux)).toBe(true);
    const outside = detectSpawnCandidates({ env: {}, which: () => null });
    expect(outside.some((c) => c.isTmux)).toBe(false);
  });

  test('nothing installed and nothing detected → no candidates, not a crash', () => {
    expect(detectSpawnCandidates({ env: {}, which: () => null })).toEqual([]);
  });
});

describe('the ~/.claude/CLAUDE.md scan reports, never edits', () => {
  test('finds worktree, clone, and ~/src mentions with 1-based line numbers', () => {
    const hits = scanClaudeMd('one\nput worktrees in ~/wt\nthree\nclone into ~/src\n');
    expect(hits).toEqual([
      { line: 2, text: 'put worktrees in ~/wt' },
      { line: 4, text: 'clone into ~/src' },
    ]);
  });

  test('matching is case-insensitive', () => {
    expect(scanClaudeMd('Worktrees go here').length).toBe(1);
  });

  test('an unrelated file yields nothing', () => {
    expect(scanClaudeMd('be concise\nuse tabs\n')).toEqual([]);
  });

  test('no hits prints nothing at all', () => {
    // A closing note that always mentions a file with nothing wrong in it
    // trains the reader to skip the whole note.
    expect(formatScan([])).toBeNull();
  });

  test('hits are rendered under the reviewed heading', () => {
    const text = formatScan([{ line: 7, text: 'clone into ~/src' }])!;
    expect(text).toContain('check they agree with the templates you just set');
    expect(text).toContain('7: clone into ~/src');
  });
});

describe('leafPaths — what counts as an already-configured key', () => {
  test('nested objects yield dotted paths, parents included', () => {
    expect(leafPaths({ auto: { tmux: 'never', handoff: '3' } })).toEqual([
      'auto',
      'auto.tmux',
      'auto.handoff',
    ]);
  });

  test('$schema is not a setting', () => {
    expect(leafPaths({ $schema: 'https://x', noOobe: true })).toEqual(['noOobe']);
  });

  test('an array is a VALUE, so its indices are not settings', () => {
    expect(leafPaths({ claude: { defaultArgs: ['--chrome'] } })).toEqual([
      'claude',
      'claude.defaultArgs',
    ]);
  });

  test('a key set to the recommended value still counts as configured', () => {
    // "Already configured" means present, not different-from-default: a user
    // who chose the default chose it, and re-asking would second-guess them.
    expect(leafPaths({ auto: { tmux: 'never' } })).toContain('auto.tmux');
  });

  test('a non-object document configures nothing', () => {
    expect(leafPaths(null)).toEqual([]);
    expect(leafPaths(['a'])).toEqual([]);
  });
});
