/**
 * What the interview can find out for itself.
 *
 * Every question the wizard can answer from the machine is one the user
 * doesn't have to. Two kinds of detection matter:
 *
 *   - **Skips.** A question whose key is already configured is not asked at
 *     all, and a batch whose questions are all skipped is not shown. The
 *     progress denominator counts only the batches that will actually appear,
 *     so `Repos (2/4)` on a machine that already has fngit set up is honest.
 *   - **Options.** The spawn-command question offers one line per installed
 *     terminal emulator, with the CURRENT terminal recommended. Offering a
 *     command for an emulator that isn't installed would be a broken default.
 *
 * All of it goes through injected seams — `which`, `env`, `fileExists` — so
 * the plan builder is testable without a terminal, a plugin install, or fngit
 * on PATH. That matters here more than usual: none of those exist in CI.
 */

/** Injected environment probes. */
export interface DetectSeams {
  /** Resolve a binary on PATH. Defaults to `Bun.which`. */
  which?: (bin: string) => string | null;
  /** The process environment. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Does a path exist? Defaults to a real `statSync`. */
  fileExists?: (path: string) => boolean;
}

/**
 * Terminal emulators fnc knows how to drive, in the order they are offered
 * when none is the current terminal. Each `args` is the tail that follows the
 * binary; `{bin} {dest} --name {name} @{summary}` is the fnc invocation the
 * emulator ends up running.
 *
 * The list is deliberately short and concrete. An emulator absent from it is
 * still reachable through the free-text slot — better than guessing at a
 * launch syntax and shipping a default that silently does nothing.
 */
export const KNOWN_EMULATORS: readonly { bin: string; template: string }[] = [
  { bin: 'ghostty', template: 'ghostty -e {bin} {dest} --name {name} @{summary}' },
  { bin: 'kitty', template: 'kitty {bin} {dest} --name {name} @{summary}' },
  { bin: 'alacritty', template: 'alacritty -e {bin} {dest} --name {name} @{summary}' },
  { bin: 'wezterm', template: 'wezterm start -- {bin} {dest} --name {name} @{summary}' },
  { bin: 'foot', template: 'foot {bin} {dest} --name {name} @{summary}' },
  { bin: 'gnome-terminal', template: 'gnome-terminal -- {bin} {dest} --name {name} @{summary}' },
  { bin: 'konsole', template: 'konsole -e {bin} {dest} --name {name} @{summary}' },
  { bin: 'xterm', template: 'xterm -e {bin} {dest} --name {name} @{summary}' },
];

/** The tmux option, offered whenever the wizard is running inside tmux. */
export const TMUX_SPAWN_TEMPLATE = 'tmux new-window -d {bin} {dest} --name {name} @{summary}';

export interface SpawnCandidate {
  /** The command template. */
  template: string;
  /** The emulator's binary name, or `tmux`. */
  bin: string;
  /** True for the emulator fnc is currently running inside. */
  isCurrent: boolean;
  /** True when running inside tmux. */
  isTmux: boolean;
}

/**
 * Which terminal is this? `TERM_PROGRAM` is set by most modern emulators;
 * ghostty and kitty additionally export their own markers. Returns the
 * matching binary name from {@link KNOWN_EMULATORS}, or null.
 */
export function currentEmulator(env: Record<string, string | undefined>): string | null {
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  if (env.GHOSTTY_RESOURCES_DIR !== undefined || termProgram === 'ghostty') return 'ghostty';
  if (env.KITTY_WINDOW_ID !== undefined || term.includes('kitty')) return 'kitty';
  if (env.ALACRITTY_WINDOW_ID !== undefined || term.includes('alacritty')) return 'alacritty';
  if (env.WEZTERM_PANE !== undefined || termProgram === 'wezterm') return 'wezterm';
  if (env.KONSOLE_VERSION !== undefined) return 'konsole';
  if (term.includes('foot')) return 'foot';
  if (env.GNOME_TERMINAL_SCREEN !== undefined) return 'gnome-terminal';
  return null;
}

/**
 * Build the spawn-command options: the current terminal first (recommended),
 * then other installed emulators, then tmux when we're inside it.
 *
 * The caller trims to the 4-option cap. Ordering here is what decides WHICH
 * four survive, so it puts the ones a user is most likely to want first.
 */
export function detectSpawnCandidates(seams: DetectSeams = {}): SpawnCandidate[] {
  const env = seams.env ?? process.env;
  const which = seams.which ?? ((bin: string) => Bun.which(bin));

  const current = currentEmulator(env);
  const out: SpawnCandidate[] = [];

  if (current !== null) {
    const known = KNOWN_EMULATORS.find((e) => e.bin === current);
    if (known !== undefined) {
      out.push({ template: known.template, bin: known.bin, isCurrent: true, isTmux: false });
    }
  }
  for (const e of KNOWN_EMULATORS) {
    if (e.bin === current) continue;
    if (which(e.bin) === null) continue;
    out.push({ template: e.template, bin: e.bin, isCurrent: false, isTmux: false });
  }
  if (env.TMUX !== undefined && env.TMUX !== '') {
    out.push({ template: TMUX_SPAWN_TEMPLATE, bin: 'tmux', isCurrent: false, isTmux: true });
  }
  return out;
}

export interface ToolPresence {
  /** Is `fngit` on PATH? */
  fngit: boolean;
  /** Is the worktree-paths plugin already installed for Claude Code? */
  plugin: boolean;
  /** Is a `git` shim already first on PATH? */
  gitShim: boolean;
}

/**
 * Detect what is already installed.
 *
 * The plugin check is a filesystem probe rather than a `claude plugin list`
 * call: `claude` may not be installed, and shelling out to it during a wizard
 * that is itself running inside claude would be a poor trade for one boolean.
 * A false negative costs one extra question and an install that no-ops.
 */
export function detectTools(seams: DetectSeams = {}): ToolPresence {
  const env = seams.env ?? process.env;
  const which = seams.which ?? ((bin: string) => Bun.which(bin));
  const home = env.HOME ?? '';

  const gitPath = which('git');
  return {
    fngit: which('fngit') !== null,
    plugin: pluginInstalled(seams, home),
    // A shim is a `git` on PATH that isn't the system one. Both the new
    // marketplace name and the pre-migration one count as installed.
    gitShim:
      gitPath !== null &&
      !gitPath.startsWith('/usr/bin/') &&
      !gitPath.startsWith('/bin/') &&
      gitPath.includes('rhombus.rocks'),
  };
}

/** Marketplace/plugin directory names, new and pre-migration. */
const PLUGIN_DIRS = [
  'worktree-paths@rhombus-rocks-claude-plugins',
  'claude-code-worktree-paths@fnclaude-plugins',
] as const;

function pluginInstalled(seams: DetectSeams, home: string): boolean {
  if (home === '') return false;
  const exists =
    seams.fileExists ??
    ((path: string): boolean => {
      try {
        // Lazily required so the module stays importable in a pure-data test.
        // eslint-disable-next-line
        return require('node:fs').existsSync(path) as boolean;
      } catch {
        return false;
      }
    });
  for (const dir of PLUGIN_DIRS) {
    if (exists(`${home}/.claude/plugins/${dir}`)) return true;
  }
  return false;
}
