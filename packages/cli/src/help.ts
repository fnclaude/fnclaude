// Help text + flag scanners for fnclaude's own --help / --version.
// Ported from src/main.go (helpText, wantsHelp, wantsVersion) in the Go
// reference.

/**
 * Binary version. Default "dev" for local builds; release pipeline can
 * override by patching this constant or via a build-time env knob. Mirrors
 * the Go reference's `var version = "dev"`.
 */
export let version = 'dev';

/**
 * Test helper: override the reported version. Kept narrow on purpose —
 * production callers should not mutate this at runtime.
 */
export function setVersion(v: string): void {
  version = v;
}

/**
 * True when the user passed -v or --version anywhere in argv BEFORE a
 * literal "--" terminator. fnclaude shadows claude's -v short flag (the
 * only lowercase short fnclaude claims); to reach claude's own --version,
 * the user runs `claude --version` directly.
 */
export function wantsVersion(argv: readonly string[]): boolean {
  for (const t of argv) {
    if (t === '--') return false;
    if (t === '-v' || t === '--version') return true;
  }
  return false;
}

/**
 * True when the user passed -h or --help anywhere in argv BEFORE a literal
 * "--" terminator. Tokens after "--" are part of the prompt to claude and
 * aren't fnclaude flags.
 */
export function wantsHelp(argv: readonly string[]): boolean {
  for (const t of argv) {
    if (t === '--') return false;
    if (t === '-h' || t === '--help') return true;
  }
  return false;
}

/**
 * Full --help text. Sourced verbatim from src/main.go's `helpText` constant
 * in the Go reference; keep in sync when either side changes.
 */
export const helpText = `fnclaude — claude CLI launcher with quality-of-life features

Usage:
  fnclaude [MODEL] [EFFORT] [CWD [WORKTREE]] [FLAGS...] [-- PROMPT]

Magic positional words (positions 1+2 only, before any path):
  Position 1 — model alias: opus | sonnet | haiku            → --model <alias>
  Position 2 — effort level: low | medium | high | xhigh | max → --effort <level>
                              (only honored when position 1 was a model alias)
  To use a directory literally named opus/max/etc., prefix with ./

Subcommand positionals (any positional slot, max one per invocation):
  resume | res        → --resume                  (session picker)
  continue | con      → --continue                (resume most recent)
  fork | fk           → --resume --fork-session   (picker; fork on select)
  Order-independent: "fnc resume opus" and "fnc opus resume" parse equivalently.
  To use a directory literally named one of these, prefix with ./

Positional paths (max 2 after magic/subcommand tokens):
  1st remaining → cwd to launch claude in (fallback $XDG_CONFIG_HOME/fnclaude/noop)
  2nd remaining → worktree name (same as -w <name>); see Worktree intercept below
  3rd+ remaining → error. Use -A/--also for extra dirs.

Reserved subcommands:
  mcp [--noop]  — internal MCP server (invoked automatically by claude
                  via injected --mcp-config; not for direct use)
  To use a directory literally named mcp, prefix with ./

fnclaude-owned flags:
  -A, --also <dir>     additional extra-dir (repeatable; the only way to add
                       extra dirs — positional extras no longer supported)
      --no-tmux        suppress auto-tmux injection for this invocation
  -h, --help           show this help
  -v, --version        print fnclaude's version and exit
                       (shadows claude's -v; use \`claude --version\` directly for that)

Capital-letter shortcuts (translate to claude long-form flags):
  -B → --brief                          -M → --permission-mode <mode>
  -C → --chrome                         -P → --from-pr [value]
  -D → --dangerously-skip-permissions   -R → --remote-control [name]
  -F → --fork-session                   -T → --tmux [classic]
  -G → --agent <agent>                  -V → --verbose
  -I → --ide                            -W → --allowedTools <tools>

All other claude flags pass through verbatim — run \`claude --help\` for the full
reference. POSIX collapsing is supported (-BVC = -B -V -C); only the last flag in
a collapsed group may take a value.

Cross-cwd resume: when claude shows the resume picker and you select a session
from a different cwd, fnclaude transparently re-launches in that cwd.

Worktree intercept: -w <name> matching an existing worktree of the project repo
swaps fnclaude's cwd to that worktree. Non-matching names pass through and the
new worktree's name is also set as the session --name.

Auto-name: when --, a prompt, and no --name/-n flag are all present, fnclaude
generates a 1-3 word session label via Haiku. With ANTHROPIC_API_KEY set, the
SDK is called directly; without it, fnclaude shells out to \`claude -p\` (which
uses your subscription auth). Falls back silently to a heuristic if both fail.

Config file:
  $XDG_CONFIG_HOME/fnclaude/config.toml (or ~/.config/fnclaude/config.toml)
  [exec.env] NAME = "value" entries are injected into claude's environment.

Environment variables (override config; precedence: CLI > env > config > default):
  ANTHROPIC_API_KEY                       direct-API auth for auto-name (else shells \`claude -p\`)
  FNCLAUDE_NAME_MODEL                     model for auto-name (default: claude-haiku-4-5)
  FNCLAUDE_NAME_TIMEOUT                   auto-name LLM timeout (default: 3s API / 15s CLI)
  FNCLAUDE_QUIET_MISSING_API_KEY          deprecated no-op (warning was removed)
  FNCLAUDE_TMUX                           never | worktree | always (default: never)
  FNCLAUDE_HANDOFF                        never | ask | <N> seconds (default: ask)
                                          controls noop router's proposing UX
                                          (user-initiated project switches always
                                          available; see README)
  FNC_PROMPTS_DIR                         override install-dir prompts location
                                          (default: <exe-dir>/prompts or
                                          <exe-dir>/../share/fnclaude/prompts)

Examples:
  fnclaude                                # interactive in ~/.config/fnclaude/noop
  fnclaude opus max ~/src/proj            # opus + max effort, launch in ~/src/proj
  fnclaude ~/src/proj my-wt               # cwd + worktree (same as -w my-wt)
  fnclaude ~/src/proj -A ~/src/extra      # main + extra dir (mcp/settings injected)
  fnclaude ~/src/proj -- "fix the bug"    # auto-name from prompt
  fnclaude -A docs/ ~/src/proj -V         # ergonomic flag form

For more, see https://github.com/fnrhombus/fnclaude
`;
