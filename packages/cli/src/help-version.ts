/**
 * --help / --version short-circuits. Pure detection functions plus the
 * help text and lazy version reader.
 *
 * Both detectors scan argv left-to-right and stop at the first literal
 * `--` — anything after the sentinel is prompt body, not fnclaude flags
 * (matches Go canonical's wantsHelp/wantsVersion at src/main.go:463-481,
 * 569-585).
 *
 * `-v` is a fnclaude-claimed short flag — the user reaches claude's own
 * --version via `claude --version` directly. This is the ONLY lowercase
 * short flag fnclaude reserves; everything else is uppercase-only.
 */

const SENTINEL = '--';

export function wantsHelp(args: readonly string[]): boolean {
  for (const tok of args) {
    if (tok === SENTINEL) return false;
    if (tok === '-h' || tok === '--help') return true;
  }
  return false;
}

export function wantsVersion(args: readonly string[]): boolean {
  for (const tok of args) {
    if (tok === SENTINEL) return false;
    if (tok === '-v' || tok === '--version') return true;
  }
  return false;
}

export const helpText = `fnclaude — claude CLI launcher with quality-of-life features

Usage:
  fnc [MODEL] [EFFORT] [SUBCOMMAND] [CWD [WORKTREE]] [FLAGS...] [-- PROMPT]

Magic positional words (order-independent for SUBCOMMAND; MODEL/EFFORT scanned
left-to-right at the head of argv before any flags):
  Model alias:   opus | sonnet | haiku                       → --model <alias>
  Effort level:  low | medium | high | xhigh | max | auto    → --effort <level>
                  (effort alone at position 1 implies opus)
  Subcommand:    resume | res                                → --resume
                 continue | con                              → --continue
                 fork | fk                                   → --resume --fork-session
  To use a directory literally named one of these, prefix with ./

Positional paths (max 2 after magic/subcommand tokens):
  1st remaining → cwd to launch claude in
                  (fallback: $XDG_CONFIG_HOME/fnclaude/noop)
  2nd remaining → worktree name (same semantics as -w <name>)
  3rd+ remaining → error. Use -A/--also for extra dirs.

Reserved subcommands:
  mcp [--noop]  — internal MCP server (invoked automatically by claude via
                  injected --mcp-config; not for direct use)
  To use a directory literally named mcp, prefix with ./

fnclaude-owned flags (not forwarded to claude):
  -A, --also <dir>     additional extra-dir (repeatable; deferred — see PRD)
      --no-tmux        suppress auto-tmux injection for this invocation
  -w, --worktree <n>   worktree intercept (matches existing → swap cwd;
                       no match → forwarded as new-worktree request)
  -h, --help           show this help and exit
  -v, --version        print fnclaude's version and exit
                       (shadows claude's -v; use \`claude --version\` directly)

Capital-letter shortcuts (translate to claude long-form flags):
  -B → --brief                          -M → --permission-mode <mode>
  -C → --chrome                         -P → --from-pr [value]
  -D → --dangerously-skip-permissions   -R → --remote-control [name]
  -F → --fork-session                   -T → --tmux [classic]
  -G → --agent <agent>                  -V → --verbose
  -I → --ide                            -W → --allowedTools <tools>

All other claude flags pass through verbatim — run \`claude --help\` for the
full reference. POSIX collapsing is supported (-BVC = -B -V -C); only the
last flag in a collapsed group may take a value.

Cross-cwd resume: when claude shows the resume picker and you select a
session from a different cwd, fnclaude transparently re-launches in that
cwd. All flags from the original invocation are preserved.

Worktree intercept: -w <name> (or a 2nd positional) matching an existing
worktree of the project repo swaps fnclaude's cwd to that worktree.
Non-matching names pass through as a new-worktree request. --name is
always set, whether entering or creating.

Auto-name: when --, a prompt, and no --name/-n are all present, fnclaude
generates a 1-3 word session label via Haiku. Falls back silently to a
heuristic on failure or timeout.

Config: $XDG_CONFIG_HOME/fnclaude/config.toml
Repo settings (clone template, worktree paths): ~/.claude/settings.json

For more, see https://github.com/fnclaude/fnclaude
`;

let cachedVersion: string | null = null;

export async function getVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = (await Bun.file(pkgUrl).json()) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev';
  } catch {
    cachedVersion = '0.0.0-dev';
  }
  return cachedVersion;
}
