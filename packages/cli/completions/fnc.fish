# Fish completion for fnc.
#
# Install: copy this file to ~/.config/fish/completions/fnc.fish

# Disable file completion by default; we add it back selectively.
complete -c fnc -f

# ---------------------------------------------------------------------------
# Helper: emit basenames of all git worktrees in the current repo.
# Outputs nothing (no error) when not in a git repo.
# ---------------------------------------------------------------------------

function __fnc_worktree_names
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
# Flags — no value
# ---------------------------------------------------------------------------

complete -c fnc -n '__fish_use_subcommand' -l no-tmux          -d 'disable tmux integration'
complete -c fnc -s B -l brief              -d 'brief output mode'
complete -c fnc -s C -l chrome             -d 'open in Chrome'
complete -c fnc -s D -l dangerously-skip-permissions -d 'skip all permission prompts'
complete -c fnc -s F -l fork-session       -d 'fork the current session'
complete -c fnc -s I -l ide                -d 'enable IDE integration'
complete -c fnc -s V -l verbose            -d 'verbose output'

# ---------------------------------------------------------------------------
# Flags — required argument
# ---------------------------------------------------------------------------

complete -c fnc -s A -l also -r -a '(__fish_complete_directories)' -d 'add an extra directory'
complete -c fnc -s G -l agent -r          -d 'run a named agent'
complete -c fnc -s W -l allowedTools -r   -d 'restrict allowed tools'

# --permission-mode / -M enum
complete -c fnc -s M -l permission-mode -r -a 'acceptEdits\tauto-accept file edits
auto\tautomatic permission handling
bypassPermissions\tbypass all checks
default\tdefault handling
dontAsk\tnever ask
plan\tplan (read-only) mode' -d 'set permission mode'

# ---------------------------------------------------------------------------
# Flags — optional argument
# ---------------------------------------------------------------------------

complete -c fnc -s P -l from-pr        -d 'start from a PR (optional PR number or URL)'
complete -c fnc -s R -l remote-control -d 'enable remote control (optional name)'
complete -c fnc -s T -l tmux -a 'classic' -d 'set tmux mode (optional: classic)'

# -w / --worktree: complete existing worktree basenames from the current repo.
complete -c fnc -s w -l worktree -r -a '(__fnc_worktree_names)' -d 'use git worktree'

# ---------------------------------------------------------------------------
# Positional argument completion
# ---------------------------------------------------------------------------

# Token walker shared by all positional helpers. Sets three globals on
# return (caller-scope, via `set` without -l):
#   __fnc_magic_state         0=check model, 1=check effort, 2=magic done
#   __fnc_post_magic_count    count of post-magic, non-subcommand positionals
#   __fnc_first_pos           first post-magic positional (empty when none)
function __fnc_walk_tokens
    set -l tokens (commandline -opc)
    set -g __fnc_magic_state 0
    set -g __fnc_post_magic_count 0
    set -g __fnc_first_pos ''
    set -l skip_next false
    for tok in $tokens[2..]
        if $skip_next
            set skip_next false
            continue
        end
        # Flags that consume the next token.
        if contains -- $tok --also -A --agent -G --permission-mode -M --allowedTools -W --tmux -T --from-pr -P --remote-control -R --worktree -w
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
        if test $__fnc_magic_state -eq 0
            if contains -- $tok opus sonnet haiku
                set __fnc_magic_state 1
                continue
            end
            set __fnc_magic_state 2
        else if test $__fnc_magic_state -eq 1
            # Magic at pos 2: effort level (only after a model alias).
            if contains -- $tok low medium high xhigh max
                set __fnc_magic_state 2
                continue
            end
            set __fnc_magic_state 2
        end
        # Post-magic positional.
        set __fnc_post_magic_count (math $__fnc_post_magic_count + 1)
        if test $__fnc_post_magic_count -eq 1
            set __fnc_first_pos $tok
        end
    end
end

# Helper: at the position-1 slot (no post-magic positional typed AND magic not done).
function __fnc_pos_model
    __fnc_walk_tokens
    test $__fnc_magic_state -eq 0 -a $__fnc_post_magic_count -eq 0
end

# Helper: at the position-2 slot for effort (pos1 was a model alias).
function __fnc_pos_effort
    __fnc_walk_tokens
    test $__fnc_magic_state -eq 1 -a $__fnc_post_magic_count -eq 0
end

# Helper: at the cwd slot — no post-magic positional yet.
function __fnc_pos_cwd
    __fnc_walk_tokens
    test $__fnc_post_magic_count -eq 0
end

# Helper: at the worktree slot — exactly one post-magic positional.
function __fnc_pos_worktree
    __fnc_walk_tokens
    test $__fnc_post_magic_count -eq 1
end

# Helper: always (any positional slot may host a subcommand, max one).
function __fnc_any_positional_slot
    __fnc_walk_tokens
    test $__fnc_post_magic_count -le 1
end

# Position 1: model alias.
complete -c fnc -n '__fnc_pos_model' -a 'opus'   -d 'use claude-opus model'
complete -c fnc -n '__fnc_pos_model' -a 'sonnet' -d 'use claude-sonnet model'
complete -c fnc -n '__fnc_pos_model' -a 'haiku'  -d 'use claude-haiku model'

# Position 2: effort level (only when pos1 was a model alias).
complete -c fnc -n '__fnc_pos_effort' -a 'low'    -d 'low effort'
complete -c fnc -n '__fnc_pos_effort' -a 'medium' -d 'medium effort'
complete -c fnc -n '__fnc_pos_effort' -a 'high'   -d 'high effort'
complete -c fnc -n '__fnc_pos_effort' -a 'xhigh'  -d 'extra-high effort'
complete -c fnc -n '__fnc_pos_effort' -a 'max'    -d 'maximum effort'

# cwd slot (no post-magic positional typed yet): directory.
complete -c fnc -n '__fnc_pos_cwd' -a '(__fish_complete_directories)' -d 'launch directory'

# Worktree slot (one post-magic positional already typed): worktree basenames.
complete -c fnc -n '__fnc_pos_worktree' -a '(__fnc_worktree_names)' -d 'worktree name'

# Subcommands valid at any positional slot (max one per invocation; not
# enforced here — runtime catches the second).
complete -c fnc -n '__fnc_any_positional_slot' -a 'resume'   -d 'show session picker (--resume)'
complete -c fnc -n '__fnc_any_positional_slot' -a 'res'      -d 'show session picker (--resume)'
complete -c fnc -n '__fnc_any_positional_slot' -a 'continue' -d 'resume most recent session (--continue)'
complete -c fnc -n '__fnc_any_positional_slot' -a 'con'      -d 'resume most recent session (--continue)'
complete -c fnc -n '__fnc_any_positional_slot' -a 'fork'     -d 'fork current session (--resume --fork-session)'
complete -c fnc -n '__fnc_any_positional_slot' -a 'fk'       -d 'fork current session (--resume --fork-session)'
