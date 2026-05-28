# Fish completion for fnclaude (and the `fnc` short alias).
#
# Install: copy this file to ~/.config/fish/completions/fnclaude.fish

# Disable file completion by default; we add it back selectively.
complete -c fnclaude -f
complete -c fnc -f

# ---------------------------------------------------------------------------
# Helper: emit basenames of all git worktrees in the current repo.
# Outputs nothing (no error) when not in a git repo.
# ---------------------------------------------------------------------------

function __fnclaude_worktree_names
    set -l names
    for line in (git worktree list --porcelain 2>/dev/null)
        if string match -q 'worktree *' -- $line
            set -l path (string replace 'worktree ' '' -- $line)
            set names $names (basename $path)
        end
    end
    string join \n $names
end

# ---------------------------------------------------------------------------
# Token walker shared by all positional helpers. Sets three globals on
# return (caller-scope, via `set` without -l):
#   __fnclaude_magic_state         0=check model, 1=check effort, 2=magic done
#   __fnclaude_post_magic_count    count of post-magic, non-subcommand positionals
#   __fnclaude_first_pos           first post-magic positional (empty when none)
# ---------------------------------------------------------------------------

function __fnclaude_walk_tokens
    set -l tokens (commandline -opc)
    set -g __fnclaude_magic_state 0
    set -g __fnclaude_post_magic_count 0
    set -g __fnclaude_first_pos ''
    set -l skip_next false
    for tok in $tokens[2..]
        if $skip_next
            set skip_next false
            continue
        end
        # Flags that consume the next token.
        if contains -- $tok --also -A --agent -G --permission-mode -M --allowedTools -W --tmux -T --from-pr -P --remote-control -R --worktree -w --name --model --effort --mcp-config --append-system-prompt --print -p
            set skip_next true
            continue
        end
        if string match -q -- '-*' $tok
            continue
        end
        # Subcommand-style positionals: eat a slot without affecting magic or
        # the remaining-positional count.
        if contains -- $tok resume res continue con fork fk
            continue
        end
        # Magic at pos 1: model alias.
        if test $__fnclaude_magic_state -eq 0
            if contains -- $tok opus sonnet haiku
                set __fnclaude_magic_state 1
                continue
            end
            # Effort alone at pos 1 implies opus; eats the magic slot.
            if contains -- $tok low medium high xhigh max auto
                set __fnclaude_magic_state 2
                continue
            end
            set __fnclaude_magic_state 2
        else if test $__fnclaude_magic_state -eq 1
            # Magic at pos 2: effort level (only after a model alias).
            if contains -- $tok low medium high xhigh max auto
                set __fnclaude_magic_state 2
                continue
            end
            set __fnclaude_magic_state 2
        end
        # Post-magic positional.
        set __fnclaude_post_magic_count (math $__fnclaude_post_magic_count + 1)
        if test $__fnclaude_post_magic_count -eq 1
            set __fnclaude_first_pos $tok
        end
    end
end

# Helper: at the position-1 slot (no post-magic positional typed AND magic not done).
function __fnclaude_pos_model
    __fnclaude_walk_tokens
    test $__fnclaude_magic_state -eq 0 -a $__fnclaude_post_magic_count -eq 0
end

# Helper: at the position-2 slot for effort (pos1 was a model alias).
function __fnclaude_pos_effort
    __fnclaude_walk_tokens
    test $__fnclaude_magic_state -eq 1 -a $__fnclaude_post_magic_count -eq 0
end

# Helper: at the cwd slot — no post-magic positional yet.
function __fnclaude_pos_cwd
    __fnclaude_walk_tokens
    test $__fnclaude_post_magic_count -eq 0
end

# Helper: at the worktree slot — exactly one post-magic positional.
function __fnclaude_pos_worktree
    __fnclaude_walk_tokens
    test $__fnclaude_post_magic_count -eq 1
end

# Helper: always (any positional slot may host a subcommand, max one).
function __fnclaude_any_positional_slot
    __fnclaude_walk_tokens
    test $__fnclaude_post_magic_count -le 1
end

# ---------------------------------------------------------------------------
# Both binary names share the same completion surface. The loop below
# applies every `complete` directive to fnclaude and fnc in turn.
# ---------------------------------------------------------------------------

for __fnclaude_cmd in fnclaude fnc
    # ── fnclaude-owned flags ──────────────────────────────────────────────
    complete -c $__fnclaude_cmd -s h -l help    -d 'show fnclaude help and exit'
    complete -c $__fnclaude_cmd -s v -l version -d "print fnclaude's version and exit"
    complete -c $__fnclaude_cmd      -l no-tmux -d 'suppress auto-tmux for this launch'

    # -A / --also: extra directory (repeatable).
    complete -c $__fnclaude_cmd -s A -l also -r -a '(__fish_complete_directories)' -d 'add an extra directory'

    # -w / --worktree: complete existing worktree basenames from the current repo.
    complete -c $__fnclaude_cmd -s w -l worktree -r -a '(__fnclaude_worktree_names)' -d 'use git worktree'

    # ── Capital-letter short flags (no value) ─────────────────────────────
    complete -c $__fnclaude_cmd -s B -l brief                          -d 'brief output mode'
    complete -c $__fnclaude_cmd -s C -l chrome                         -d 'open in Chrome'
    complete -c $__fnclaude_cmd -s D -l dangerously-skip-permissions   -d 'skip all permission prompts'
    complete -c $__fnclaude_cmd -s F -l fork-session                   -d 'fork the current session'
    complete -c $__fnclaude_cmd -s I -l ide                            -d 'enable IDE integration'
    complete -c $__fnclaude_cmd -s V -l verbose                        -d 'verbose output'

    # ── Capital-letter short flags (required value) ───────────────────────
    complete -c $__fnclaude_cmd -s G -l agent        -r -d 'run a named agent'
    complete -c $__fnclaude_cmd -s W -l allowedTools -r -d 'restrict allowed tools'

    # --permission-mode / -M enum
    complete -c $__fnclaude_cmd -s M -l permission-mode -r -a 'acceptEdits\tauto-accept file edits
auto\tautomatic permission handling
bypassPermissions\tbypass all checks
default\tdefault handling
dontAsk\tnever ask
plan\tplan (read-only) mode' -d 'set permission mode'

    # ── Capital-letter short flags (optional value) ───────────────────────
    complete -c $__fnclaude_cmd -s P -l from-pr        -d 'start from a PR (optional PR number or URL)'
    complete -c $__fnclaude_cmd -s R -l remote-control -d 'enable remote control (optional name)'
    complete -c $__fnclaude_cmd -s T -l tmux -a 'classic' -d 'set tmux mode (optional: classic)'

    # ── Session-mode long flags (long-form equivalents of subcommands) ────
    complete -c $__fnclaude_cmd -l resume   -d 'show session picker'
    complete -c $__fnclaude_cmd -l continue -d 'resume the most recent session'

    # ── Other claude long flags worth surfacing ───────────────────────────
    complete -c $__fnclaude_cmd      -l name                  -r -d 'session label (skips auto-name)'
    complete -c $__fnclaude_cmd      -l model                 -r -a 'opus sonnet haiku' -d 'set model alias'
    complete -c $__fnclaude_cmd      -l effort                -r -a 'low medium high xhigh max auto' -d 'set effort level'
    complete -c $__fnclaude_cmd      -l mcp-config            -r -d 'path to MCP config JSON'
    complete -c $__fnclaude_cmd -s p -l print                    -d 'print-mode invocation (-p)'
    complete -c $__fnclaude_cmd      -l append-system-prompt  -r -d 'append text to claude system prompt'

    # ── Positional argument completion ────────────────────────────────────
    # Position 1: model alias.
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'opus'   -d 'use claude-opus model'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'sonnet' -d 'use claude-sonnet model'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'haiku'  -d 'use claude-haiku model'

    # Effort levels are also valid at pos 1 (implies opus).
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'low'    -d 'low effort (implies opus)'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'medium' -d 'medium effort (implies opus)'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'high'   -d 'high effort (implies opus)'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'xhigh'  -d 'extra-high effort (implies opus)'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'max'    -d 'maximum effort (implies opus)'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_model' -a 'auto'   -d 'auto effort (implies opus)'

    # Position 2: effort level (only when pos1 was a model alias).
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_effort' -a 'low'    -d 'low effort'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_effort' -a 'medium' -d 'medium effort'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_effort' -a 'high'   -d 'high effort'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_effort' -a 'xhigh'  -d 'extra-high effort'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_effort' -a 'max'    -d 'maximum effort'
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_effort' -a 'auto'   -d 'auto effort'

    # cwd slot (no post-magic positional typed yet): directory.
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_cwd' -a '(__fish_complete_directories)' -d 'launch directory'

    # Worktree slot (one post-magic positional already typed): worktree basenames.
    complete -c $__fnclaude_cmd -n '__fnclaude_pos_worktree' -a '(__fnclaude_worktree_names)' -d 'worktree name'

    # Subcommands valid at any positional slot (max one per invocation; not
    # enforced here — runtime catches the second).
    complete -c $__fnclaude_cmd -n '__fnclaude_any_positional_slot' -a 'resume'   -d 'show session picker (--resume)'
    complete -c $__fnclaude_cmd -n '__fnclaude_any_positional_slot' -a 'res'      -d 'show session picker (--resume)'
    complete -c $__fnclaude_cmd -n '__fnclaude_any_positional_slot' -a 'continue' -d 'resume most recent session (--continue)'
    complete -c $__fnclaude_cmd -n '__fnclaude_any_positional_slot' -a 'con'      -d 'resume most recent session (--continue)'
    complete -c $__fnclaude_cmd -n '__fnclaude_any_positional_slot' -a 'fork'     -d 'fork current session (--resume --fork-session)'
    complete -c $__fnclaude_cmd -n '__fnclaude_any_positional_slot' -a 'fk'       -d 'fork current session (--resume --fork-session)'
end

set -e __fnclaude_cmd
