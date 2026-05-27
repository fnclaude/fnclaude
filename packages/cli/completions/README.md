# fnc shell completions

Completion scripts for the `fnc` command. Pick the file for your shell.

## zsh — `_fnc`

`_fnc` is a `compdef`-style completion function for `fnc`.

**Option A — drop into `$fpath`:**

```sh
cp _fnc /usr/local/share/zsh/site-functions/   # or any dir in $fpath
# restart shell or run: autoload -U compinit && compinit
```

**Option B — source directly:**

```sh
# in ~/.zshrc
source /path/to/completions/_fnc
```

## bash — `fnc.bash`

Registers `_fnc_complete` for `fnc` via `complete -F`.

```sh
# in ~/.bashrc
source /path/to/completions/fnc.bash
```

Requires bash-completion (`_init_completion`) to be loaded first. Most distros do this automatically; if not, add `source /usr/share/bash-completion/bash_completion` before the source line above.

## fish — `fnc.fish`

```sh
cp fnc.fish ~/.config/fish/completions/
```

Fish auto-loads files from that directory.
