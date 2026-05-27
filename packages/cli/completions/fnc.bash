# Bash completion for fnc.
#
# Install: source this file in ~/.bashrc, e.g.:
#   source /path/to/fnc.bash

# Helper: emit basenames of all git worktrees in the current repo.
# Outputs nothing (no error) when not in a git repo.
_fnc_worktree_names() {
    local line name
    while IFS= read -r line; do
        if [[ "$line" == worktree\ * ]]; then
            name="${line#worktree }"
            name="${name##*/}"  # basename
            printf '%s\n' "$name"
        fi
    done < <(git worktree list --porcelain 2>/dev/null)
}

_fnc_complete() {
    local cur prev words cword
    _init_completion || return

    # Model aliases (magic position 1).
    local -a model_aliases=(opus sonnet haiku)

    # Effort levels (magic position 2, only when position 1 was a model alias).
    local -a effort_levels=(low medium high xhigh max)

    # Subcommand-style positionals (any positional slot, max one per invocation).
    local -a subcommand_tokens=(resume res continue con fork fk)

    # --permission-mode / -M enum values.
    local -a permission_modes=(acceptEdits auto bypassPermissions default dontAsk plan)

    # Flags that take a required argument (next word is the value).
    local -a flags_with_arg=(--also -A --agent -G --permission-mode -M --allowedTools -W)

    # Flags with optional arguments — greedy: complete the optional value only
    # when cur already follows the flag.
    local -a flags_with_opt=(--from-pr -P --remote-control -R --tmux -T --worktree -w)

    # Complete value for flags that take a required argument.
    case "$prev" in
        --also|-A)
            # Directory argument.
            _filedir -d
            return
            ;;
        --agent|-G|--allowedTools|-W)
            # Free-form string; no completion.
            return
            ;;
        --permission-mode|-M)
            COMPREPLY=( $(compgen -W "${permission_modes[*]}" -- "$cur") )
            return
            ;;
        --tmux|-T)
            COMPREPLY=( $(compgen -W "classic" -- "$cur") )
            return
            ;;
        --worktree|-w)
            # Complete existing worktree basenames from the current repo.
            local -a wt_names
            mapfile -t wt_names < <(_fnc_worktree_names)
            COMPREPLY=( $(compgen -W "${wt_names[*]}" -- "$cur") )
            return
            ;;
        --from-pr|-P|--remote-control|-R)
            # Optional value; fall through to default completion below.
            ;;
    esac

    # If cur starts with '-', complete flags.
    if [[ "$cur" == -* ]]; then
        local -a all_flags=(
            --also --no-tmux
            --brief --chrome --dangerously-skip-permissions --fork-session
            --agent --ide --permission-mode --from-pr --remote-control
            --tmux --verbose --allowedTools --worktree
            -A -B -C -D -F -G -I -M -P -R -T -V -W -w
        )
        COMPREPLY=( $(compgen -W "${all_flags[*]}" -- "$cur") )
        return
    fi

    # Positional argument logic.
    # Walk the already-typed words tracking magic-eaten slots (model + effort)
    # and subcommand-eaten slots, then count remaining post-magic positionals
    # to decide what the current slot offers.
    #
    # Slot rules after magic + subcommand are stripped:
    #   1st remaining → cwd
    #   2nd remaining → worktree name (same as -w)
    #   3rd+ remaining → error at runtime; no completion offered.
    local magic_state=0          # 0=check model, 1=check effort, 2=magic done
    local post_magic_positionals=0
    local i
    local skip_next=false

    for (( i=1; i < cword; i++ )); do
        local w="${words[i]}"

        if $skip_next; then
            skip_next=false
            continue
        fi

        # If this word is a flag that consumes the next token, skip the next.
        local f
        for f in "${flags_with_arg[@]}"; do
            if [[ "$w" == "$f" ]]; then
                skip_next=true
                break
            fi
        done
        $skip_next && continue

        # Skip flags and their inline =value forms.
        [[ "$w" == -* ]] && continue

        # Subcommand-style positional: eats a slot without affecting magic or
        # remaining-positional counts (matches parseArgs behaviour).
        local sc is_subcommand=false
        for sc in "${subcommand_tokens[@]}"; do
            [[ "$w" == "$sc" ]] && is_subcommand=true && break
        done
        if $is_subcommand; then
            continue
        fi

        # Magic positional: pos 1 model alias, pos 2 effort level.
        if [[ $magic_state -eq 0 ]]; then
            local m matched=false
            for m in "${model_aliases[@]}"; do
                [[ "$w" == "$m" ]] && matched=true && break
            done
            if $matched; then
                magic_state=1
                continue
            fi
            magic_state=2
        elif [[ $magic_state -eq 1 ]]; then
            local e matched=false
            for e in "${effort_levels[@]}"; do
                [[ "$w" == "$e" ]] && matched=true && break
            done
            if $matched; then
                magic_state=2
                continue
            fi
            magic_state=2
        fi

        # Post-magic positional.
        (( post_magic_positionals++ ))
    done

    # Build completion candidates for the current slot.
    if [[ $post_magic_positionals -eq 0 ]]; then
        # Could be magic (if not yet consumed), subcommand, or cwd.
        if [[ $magic_state -eq 0 ]]; then
            COMPREPLY=( $(compgen -W "${model_aliases[*]} ${subcommand_tokens[*]}" -- "$cur") )
        elif [[ $magic_state -eq 1 ]]; then
            COMPREPLY=( $(compgen -W "${effort_levels[*]} ${subcommand_tokens[*]}" -- "$cur") )
        else
            COMPREPLY=( $(compgen -W "${subcommand_tokens[*]}" -- "$cur") )
        fi
        _filedir -d
    elif [[ $post_magic_positionals -eq 1 ]]; then
        # 2nd remaining → worktree name (subcommand still valid since it doesn't
        # consume a remaining slot).
        local -a wt_names
        mapfile -t wt_names < <(_fnc_worktree_names)
        COMPREPLY=( $(compgen -W "${wt_names[*]} ${subcommand_tokens[*]}" -- "$cur") )
    else
        # 3rd+ remaining → error at runtime; only subcommands remain valid.
        COMPREPLY=( $(compgen -W "${subcommand_tokens[*]}" -- "$cur") )
    fi
}

complete -F _fnc_complete fnc
