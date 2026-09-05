/**
 * The interview, as data.
 *
 * Every string a user reads during `fnc install` is here, copied verbatim from
 * `specs/oobe-interview.md` — the text the owner reviewed on 2026-09-04. The
 * model that relays these questions never writes any of it: it calls
 * `fnc_oobe_next`, presents what comes back through one `AskUserQuestion`, and
 * posts the answer. Keeping the text in code rather than in a prompt is what
 * makes that possible, and what makes the wording testable.
 *
 * Two `AskUserQuestion` limits shape the structure and are load-bearing:
 * **at most 4 questions per call**, and **at most 4 options per question**
 * (verified live, 2026-09-04). "Other" (free text) is added by the tool
 * itself, so an option list of 4 plus free text is the maximum a screen can
 * carry. `plan.ts` enforces both.
 *
 * The first option is always the recommended one and says so in its label.
 */

/** Where an answer is written. */
export type AnswerTarget =
  /** fnc's own config, at the given dotted path. */
  | { kind: 'fnc'; path: string }
  /** The shared rhombus.rocks config, at the given dotted path. */
  | { kind: 'shared'; path: string }
  /** Not a config key: an install decision that only drives the Apply step. */
  | { kind: 'decision' };

export interface QuestionOption {
  /** Shown as the option label. Carries "(Recommended)" where the spec does. */
  label: string;
  /** The second line under the label. Omitted where the spec shows none. */
  description?: string;
  /** What the answer becomes. Absent means "the label is the value". */
  value?: string;
}

export interface Question {
  id: QuestionId;
  /** `AskUserQuestion` header chip. At most 12 characters. */
  header: string;
  /** The question itself. */
  question: string;
  /** Prose shown with the question. */
  detail?: string;
  /** True for the one multi-select question (claude flags). */
  multiSelect?: boolean;
  options: QuestionOption[];
  /**
   * What to say about the automatic "Other" slot when free text is the
   * intended path. Absent means free text isn't expected for this question.
   */
  freeText?: string;
  target: AnswerTarget;
}

export type QuestionId =
  | 'install-fngit'
  | 'install-plugin'
  | 'clone-template'
  | 'worktree-template'
  | 'branch-template'
  | 'additional-src-dirs'
  | 'noop-dir'
  | 'spawn-command'
  | 'auto-tmux'
  | 'auto-handoff'
  | 'claude-flags'
  | 'git-shim'
  | 'apply';

export type BatchId = 'tools' | 'repos' | 'sessions' | 'claude-git' | 'apply';

export interface BatchSpec {
  id: BatchId;
  /** Printed in the session before the batch, e.g. "Tools". */
  title: string;
  /** Printed as session text before the batch. */
  preamble?: string;
  questions: readonly Question[];
}

/** fngit's built-in host aliases, quoted in the placeholder definitions. */
export const BUILT_IN_HOST_ALIASES = 'github.com=gh, gitlab.com=gl, bitbucket.org=bb, codeberg.org=cb';

/**
 * fngit's standard search list, offered as the recommended answer to "other
 * places". Deliberately no recursive `/**`: fngit's search is two fixed rungs
 * per directory, and `*` only for a fixed owner level. A recursive glob would
 * mean a full tree walk on every lookup.
 */
export const STANDARD_SRC_DIRS =
  '~/.local/src, ~/code, ~/dev, ~/projects, ~/Projects, ~/workspace, ~/repos, ~/git, ~/go/src/*/*, /usr/local/src, /usr/src, /opt';

export const DEFAULT_CLONE_TEMPLATE = '~/src/{repo}@{owner}';
export const DEFAULT_WORKTREE_TEMPLATE = '~/src/{repo}@{owner}+{input}';
export const DEFAULT_BRANCH_TEMPLATE = '{input}';

const TOOLS: readonly Question[] = [
  {
    id: 'install-fngit',
    header: 'Tools',
    question: 'Install fngit to resolve repo names?',
    detail:
      "With it, `fnc fnclaude` finds the repo in your source directories or clones it from GitHub, at the path your clone template says. Without it, fnc only accepts real paths to repos you've cloned yourself.",
    options: [{ label: 'Yes (Highly Recommended)', value: 'yes' }, { label: 'No', value: 'no' }],
    target: { kind: 'decision' },
  },
  {
    id: 'install-plugin',
    header: 'Tools',
    question: 'Install the worktree-paths plugin for Claude Code?',
    detail:
      'When Claude Code creates a worktree, it buries it inside the repo at `.claude/worktrees/<name>/` and names the branch `worktree-<name>`. Install this to override both, using the templates in the next questions.',
    options: [{ label: 'Yes (Highly Recommended)', value: 'yes' }, { label: 'No', value: 'no' }],
    target: { kind: 'decision' },
  },
];

const REPOS: readonly Question[] = [
  {
    id: 'clone-template',
    header: 'Repos',
    question: 'Where should fnc clone repos to?',
    detail:
      'fnc performs best when it can derive the owner, repo, and branch from the directory name alone, without opening any files. Placeholders: `{repo}`, `{owner}`, `{host}` e.g. `github.com`, `{host-plain}` e.g. `github`, `{host-short}` e.g. `gh`',
    options: [{ label: `${DEFAULT_CLONE_TEMPLATE} (Recommended)`, value: DEFAULT_CLONE_TEMPLATE }],
    freeText: 'a path template',
    target: { kind: 'shared', path: 'repos.cloneTemplate' },
  },
  {
    id: 'worktree-template',
    header: 'Repos',
    question: 'Where should worktrees go?',
    detail:
      'Placeholders: `{repo}`, `{owner}`, `{host}` e.g. `github.com`, `{host-plain}` e.g. `github`, `{host-short}` e.g. `gh`, `{input}` the requested worktree name, `{branch}` the branch name from the next question, `{clone-path}` absolute path of the main checkout e.g. `{clone-path}+{branch}`, `{repo-dir}` directory name of the main checkout, `{cwd}` directory name the request came from',
    options: [
      { label: `${DEFAULT_WORKTREE_TEMPLATE} (Recommended)`, value: DEFAULT_WORKTREE_TEMPLATE },
    ],
    freeText: 'a path template',
    target: { kind: 'shared', path: 'repos.worktreeTemplate' },
  },
  {
    id: 'branch-template',
    header: 'Repos',
    question: 'How should new branches be named?',
    detail:
      'Placeholders: `{input}` the requested worktree name, `{repo}`, `{owner}`, `{repo-dir}`, `{cwd}`, `{host}`, `{host-plain}`, `{host-short}`',
    options: [
      {
        label: `${DEFAULT_BRANCH_TEMPLATE} (Recommended)`,
        description: 'same as the worktree name',
        value: DEFAULT_BRANCH_TEMPLATE,
      },
    ],
    freeText: 'a branch-name template',
    target: { kind: 'shared', path: 'repos.branchTemplate' },
  },
  {
    id: 'additional-src-dirs',
    header: 'Repos',
    question: 'Other places to search for repositories.',
    detail: 'These are searched before asking GitHub. Nothing is ever cloned into them.',
    options: [
      {
        label: `${STANDARD_SRC_DIRS} (Recommended)`,
        description: "fngit's standard list",
        value: STANDARD_SRC_DIRS,
      },
      {
        label: 'None',
        description: 'only the clone directory is searched',
        value: '',
      },
    ],
    freeText: 'comma-separated; globs allowed',
    target: { kind: 'shared', path: 'repos.additionalSrcDirs' },
  },
];

/** Printed as session text before the Sessions batch. */
export const SESSIONS_PREAMBLE =
  "fnc can start a session with no project at all. Run `fnc` with no path and Claude opens in a small directory that belongs to fnc, with a prompt that acts as a router: you describe what you want, and it either answers directly or transfers you to the right place. It's the place to start when you don't yet know which repo the work belongs in, or have a task that doesn't belong to any project or repository.";

/**
 * The Sessions batch minus the spawn-command question, whose options depend on
 * which terminal emulators are installed. `plan.ts` splices that one in.
 */
const SESSIONS_STATIC: readonly Question[] = [
  {
    id: 'noop-dir',
    header: 'Sessions',
    question: "Where should fnc's starting directory live?",
    options: [
      {
        label: '~/.config/rhombus.rocks/fnclaude/noop (Recommended)',
        value: '~/.config/rhombus.rocks/fnclaude/noop',
      },
    ],
    freeText: 'a path',
    target: { kind: 'fnc', path: 'noopDir' },
  },
  {
    id: 'auto-tmux',
    header: 'Sessions',
    question: 'When should fnc add `--tmux`?',
    detail: 'Claude Code has no setting for this, so fnc supplies the default.',
    options: [
      { label: 'Never (Recommended)', value: 'never' },
      { label: 'Always', value: 'always' },
      {
        label: 'When creating a new worktree',
        description: '`fnc -w <name>` with no existing match opens in tmux',
        value: 'worktree',
      },
    ],
    target: { kind: 'fnc', path: 'auto.tmux' },
  },
  {
    id: 'auto-handoff',
    header: 'Sessions',
    question: 'How should session transfers be handled?',
    options: [
      {
        label: 'Delay 3 seconds (Recommended)',
        description: 'Ctrl+C during the countdown cancels',
        value: '3',
      },
      { label: 'Proceed immediately', value: '0' },
      { label: 'Ask each time', value: 'ask' },
    ],
    freeText: 'number of seconds to delay',
    target: { kind: 'fnc', path: 'auto.handoff' },
  },
];

/** The spawn-command question's fixed parts; options come from detection. */
export const SPAWN_COMMAND_QUESTION: Omit<Question, 'options'> = {
  id: 'spawn-command',
  header: 'Sessions',
  question: 'How should fnc open a new terminal window?',
  detail:
    "Used when fnc spawns a session. Placeholders: `{bin}` fnc's own path, `{dest}` the project to open, `{name}` the session name, `{summary}` the handoff summary file",
  freeText: 'a command template',
  target: { kind: 'fnc', path: 'auto.spawnCommand' },
};

const CLAUDE_GIT: readonly Question[] = [
  {
    id: 'claude-flags',
    header: 'Claude+git',
    question: 'Which claude flags should fnc pass on every launch?',
    detail: 'Claude Code has no setting for these, so fnc supplies the default. Pick any.',
    multiSelect: true,
    options: [
      { label: '--chrome', description: 'enable the Claude in Chrome browser integration', value: '--chrome' },
      { label: '--brief', description: 'enable the SendUserMessage tool for short status pings', value: '--brief' },
      { label: '--ide', description: 'connect to a running IDE automatically on startup', value: '--ide' },
      { label: '--verbose', description: 'show full tool output in the transcript', value: '--verbose' },
    ],
    freeText: 'any other flags, space-separated',
    target: { kind: 'fnc', path: 'claude.defaultArgs' },
  },
  {
    id: 'git-shim',
    header: 'Claude+git',
    question: 'Put a `git` shim first on your PATH?',
    detail:
      'Every `git clone <name>` from any shell, script, or editor then gets the lookup. Everything else passes straight through to git.',
    options: [{ label: 'Yes (Recommended)', value: 'yes' }, { label: 'No', value: 'no' }],
    target: { kind: 'decision' },
  },
];

const APPLY: readonly Question[] = [
  {
    id: 'apply',
    header: 'Apply',
    question: 'Ready to apply?',
    detail: 'Above is every file that will be written and every command that will be run.',
    options: [
      { label: 'Apply (Recommended)', value: 'apply' },
      { label: 'Abort', description: 'keep the answers saved so far, run nothing', value: 'abort' },
    ],
    freeText: 'tell me what to change, e.g. "the clone template"',
    target: { kind: 'decision' },
  },
];

/**
 * The batches in order. Tools first so `{branch}` never refers forward, then
 * Repos, Sessions, Claude and git, Apply. The Done note is printed rather than
 * asked, so it isn't a batch here.
 */
export const BATCH_SPECS: readonly BatchSpec[] = [
  { id: 'tools', title: 'Tools', questions: TOOLS },
  { id: 'repos', title: 'Repos', questions: REPOS },
  { id: 'sessions', title: 'Sessions', preamble: SESSIONS_PREAMBLE, questions: SESSIONS_STATIC },
  { id: 'claude-git', title: 'Claude and git', questions: CLAUDE_GIT },
  { id: 'apply', title: 'Apply', questions: APPLY },
];

/**
 * Look one question up by id, for `fnc_oobe_reask`. Returns the STATIC
 * definition; `spawn-command` is absent here because its options depend on
 * the machine, so the plan builder owns it — the caller rebuilds that one.
 */
export function findQuestion(id: string): Question | undefined {
  for (const batch of BATCH_SPECS) {
    for (const q of batch.questions) {
      if (q.id === id) return q;
    }
  }
  return undefined;
}

/**
 * The closing note, printed after Apply. It covers the two things the
 * interview deliberately does NOT ask about, so a user who wants them knows
 * where to go. "System prompt" is the term used for the fragments in every
 * user-facing string.
 */
export function closingNote(sharedConfigPath: string, promptsDir: string): string {
  return `Two things you didn't get asked about, for when you want to dig in:
- **Host aliases** for \`{host-short}\` default to \`gh\`, \`gl\`, \`bb\`, \`cb\`. Add or change them under \`repos.hostAliases\` in \`${sharedConfigPath}\`.
- **Prompt overrides**: any file you drop in \`${promptsDir}/\` replaces fnc's packaged system prompt of the same name. The \`README.txt\` there lists the names.

Re-run this any time with \`fnc install\`.`;
}

/** Heuristic patterns for the post-Apply `~/.claude/CLAUDE.md` scan. */
export const CLAUDE_MD_SCAN_PATTERNS = ['worktree', 'clone', '~/src'] as const;

export const CLAUDE_MD_SCAN_HEADER =
  'Your `~/.claude/CLAUDE.md` mentions worktrees or clone paths on these lines; check they agree with the templates you just set:';
