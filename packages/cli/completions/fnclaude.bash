# Bash completion for fnclaude (and the `fnc` shorthand).
#
# Install: source this file in ~/.bashrc, e.g.:
#   source /path/to/fnclaude.bash
#
# Requires bash-completion (`_init_completion`) to be loaded first. Most
# distros do this automatically; if not, add
#   source /usr/share/bash-completion/bash_completion
# before the source line above.

# Helper: emit basenames of all git worktrees in the current repo.
# The fnclaude worktree-intercept matches on the basename (or the `+workspace`
# suffix segment) of each worktree path, so basenames are what users tab to.
# Outputs nothing (no error) when not in a git repo.
_fnclaude_worktree_names() {
    local line name
    while IFS= read -r line; do
        if [[ "$line" == worktree\ * ]]; then
            name="${line#worktree }"
            # Prefer the `+workspace` suffix if present
            # (e.g. ~/src/repo@owner+feat-foo → feat-foo); otherwise basename.
            if [[ "$name" == *+* ]]; then
                name="${name##*+}"
            else
                name="${name##*/}"
            fi
            printf '%s\n' "$name"
        fi
    done < <(git worktree list --porcelain 2>/dev/null)
}

_fnclaude() {
    local cur prev words cword
    _init_completion || return

    # Magic positional: model alias at position 1.
    local -a model_aliases=(opus sonnet haiku)

    # Magic positional: effort level. `auto` is included here (rewrite-only
    # addition over the Go canonical set); used alone at position 1 it implies
    # `--model opus`.
    local -a effort_levels=(low medium high xhigh max auto)

    # Subcommand-style positionals (any positional slot, max one per invocation).
    local -a subcommand_tokens=(resume res continue con fork fk)

    # --permission-mode / -M enum values.
    local -a permission_modes=(acceptEdits auto bypassPermissions default dontAsk plan)

    # Flags that take a required argument (next word is the value).
    local -a flags_with_arg=(
        --also -A
        --agent -G
        --permission-mode -M
        --allowedTools -W
        --name
        --model
        --effort
        --mcp-config
        --append-system-prompt
    )

    # Flags with optional arguments — the next non-flag token is consumed if
    # present; otherwise the long flag stands alone.
    local -a flags_with_opt=(
        --from-pr -P
        --remote-control -R
        --tmux -T
        --print -p
        --worktree -w
    )

    # Complete value for flags whose previous token consumes a value.
    case "$prev" in
        --also|-A)
            # Directory argument.
            _filedir -d
            return
            ;;
        --agent|-G|--allowedTools|-W|--name|--mcp-config|--append-system-prompt)
            # Free-form string / file path; no useful enum.
            # --mcp-config can be a JSON literal or a path — let the shell guess.
            return
            ;;
        --model)
            COMPREPLY=( $(compgen -W "${model_aliases[*]}" -- "$cur") )
            return
            ;;
        --effort)
            COMPREPLY=( $(compgen -W "${effort_levels[*]}" -- "$cur") )
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
            mapfile -t wt_names < <(_fnclaude_worktree_names)
            COMPREPLY=( $(compgen -W "${wt_names[*]}" -- "$cur") )
            return
            ;;
        --from-pr|-P|--remote-control|-R|--print|-p)
            # Optional value; fall through to default completion below.
            ;;
    esac

    # If cur starts with '-', complete flags.
    if [[ "$cur" == -* ]]; then
        local -a all_flags=(
            # fnclaude-owned long flags
            --help --version
            --also --no-tmux --worktree
            --name --model --effort
            --resume --continue --fork-session --from-pr
            --mcp-config --print --append-system-prompt --tmux
            # claude-passthrough long flags fnclaude knows about
            --brief --chrome --dangerously-skip-permissions
            --agent --ide --permission-mode --remote-control
            --verbose --allowedTools
            # capital-letter shortcuts (no-value + required-value + optional)
            -A -B -C -D -F -G -I -M -P -R -T -V -W -w
            # the two reserved lowercase shorts
            -h -v -p
        )
        COMPREPLY=( $(compgen -W "${all_flags[*]}" -- "$cur") )
        return
    fi

    # Positional argument logic.
    # Walk already-typed words tracking magic-eaten slots (model + effort) and
    # subcommand-eaten slots, then count remaining post-magic positionals to
    # decide what the current slot offers.
    #
    # Slot rules after magic + subcommand are stripped:
    #   1st remaining → cwd
    #   2nd remaining → worktree name (same semantics as -w)
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

        # `--` sentinel: everything after it is the prompt body — bail out of
        # positional tracking; we won't offer fnclaude completions past it.
        if [[ "$w" == "--" ]]; then
            COMPREPLY=()
            return
        fi

        # Subcommand-style positional: eats a slot without affecting magic or
        # remaining-positional counts (matches parseArgs behaviour).
        local sc is_subcommand=false
        for sc in "${subcommand_tokens[@]}"; do
            [[ "$w" == "$sc" ]] && is_subcommand=true && break
        done
        if $is_subcommand; then
            continue
        fi

        # Magic positional: pos 1 model alias OR effort (effort-only → opus);
        # pos 2 effort level (only after a model alias).
        if [[ $magic_state -eq 0 ]]; then
            local m matched=false
            for m in "${model_aliases[@]}"; do
                [[ "$w" == "$m" ]] && matched=true && break
            done
            if $matched; then
                magic_state=1
                continue
            fi
            # Effort alone at pos 1 → magic done (opus implied at runtime).
            local e
            for e in "${effort_levels[@]}"; do
                if [[ "$w" == "$e" ]]; then
                    matched=true
                    break
                fi
            done
            if $matched; then
                magic_state=2
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
            COMPREPLY=( $(compgen -W "${model_aliases[*]} ${effort_levels[*]} ${subcommand_tokens[*]}" -- "$cur") )
        elif [[ $magic_state -eq 1 ]]; then
            COMPREPLY=( $(compgen -W "${effort_levels[*]} ${subcommand_tokens[*]}" -- "$cur") )
        else
            COMPREPLY=( $(compgen -W "${subcommand_tokens[*]}" -- "$cur") )
        fi
        _filedir -d
    elif [[ $post_magic_positionals -eq 1 ]]; then
        # 2nd remaining → worktree name (subcommand still valid since it
        # doesn't consume a remaining slot).
        local -a wt_names
        mapfile -t wt_names < <(_fnclaude_worktree_names)
        COMPREPLY=( $(compgen -W "${wt_names[*]} ${subcommand_tokens[*]}" -- "$cur") )
    else
        # 3rd+ remaining → error at runtime; only subcommands remain valid.
        COMPREPLY=( $(compgen -W "${subcommand_tokens[*]}" -- "$cur") )
    fi
}

complete -F _fnclaude fnclaude
complete -F _fnclaude fnc
