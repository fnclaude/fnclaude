# rhombus.rocks shared config — contract

Shared by `@rhombus.rocks/fnclaude` (fnc), `@rhombus.rocks/fngit`, and the `worktree-paths` Claude Code plugin. Decisions of record: `TODO.md` § Restructure (2026-09-04). This file is the contract the three implementations code against, so that each can be built without the others being finished.

## Locations

| What | Path |
|---|---|
| shared config | `$XDG_CONFIG_HOME/rhombus.rocks/config.json` (default `~/.config/rhombus.rocks/config.json`) |
| fnc config | `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.json` |
| fnc prompt overrides | `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/prompts/<name>.md` (+ `README.txt`) |
| fnc noop dir (default) | `$XDG_CONFIG_HOME/rhombus.rocks/fnclaude/noop/` (configurable: `noopDir`) |
| fnc state (logs) | `$XDG_STATE_HOME/rhombus.rocks/fnclaude/` |
| fngit data (shims) | `$XDG_DATA_HOME/rhombus.rocks/fngit/shims/` |

Readers accept whichever of `config.{json,jsonc,toml,yaml}` exists at the location (first match in that order), parsed with `confbox` (unjs, zero deps). Writers write JSON with a `$schema` line. **No runtime schema validation**: loaders degrade per field (a wrong-shaped field contributes nothing; the rest loads). Rewrites drop comments; accepted.

Nothing reads Claude Code's `settings.json` for any of this any more. The old locations (`~/.claude/settings.json` `repoSettings`, `~/.fngitrc`, `$XDG_CONFIG_HOME/fnclaude/config.toml`, `/usr/share/fnrhombus/host-aliases.json`, `~/.local/share/fnrhombus/host-aliases.json`) are migration sources only: read once when the new file is absent, and moved by `fnc install` / `fngit install`. The `fnrhombus` name appears nowhere in new code, paths, or text.

## Shared file shape

```json
{
  "$schema": "https://json.schemastore.org/rhombus-rocks-config.json",
  "repos": {
    "cloneTemplate": "~/src/{repo}@{owner}",
    "worktreeTemplate": "~/src/{repo}@{owner}+{input}",
    "branchTemplate": "{input}",
    "additionalSrcDirs": ["~/.local/src", "~/code"],
    "hostAliases": { "git.example.com": "ex" }
  }
}
```

- `repos.cloneTemplate` — read by fngit. Placeholders: `{repo}` `{owner}` `{host}` `{host-plain}` `{host-short}`.
- `repos.worktreeTemplate` — read by fngit (search exclusion) and the plugin (worktree creation). Placeholders: the clone set plus `{input}` `{branch}` `{clone-path}` `{repo-dir}` `{cwd}`. fngit must accept the full set.
- `repos.branchTemplate` — read by the plugin only. Same placeholders minus `{branch}`. Listed in the schema with description "used by worktree-paths".
- `repos.additionalSrcDirs` — fngit; search-only; entries may be globs (`*` for one level; no recursive walk).
- `repos.hostAliases` — overrides only. **Built-in defaults live in fngit**: `github.com=gh`, `gitlab.com=gl`, `bitbucket.org=bb`, `codeberg.org=cb`. `{host-short}` on a host with neither a default nor an override is an error naming this key.
- Writers **merge** into the file (preserve keys they don't own), never overwrite the whole document.

Schema: `rhombus-rocks-config.json`, hand-written, lives in the fngit repo (`schemas/`), shipped in the package, published to SchemaStore by the owner (not by agents). TS types derived at compile time via `json-schema-to-ts` `FromSchema`.

## fnc config shape

```json
{
  "$schema": "https://json.schemastore.org/rhombus-rocks-fnclaude-config.json",
  "noOobe": true,
  "noopDir": "~/.config/rhombus.rocks/fnclaude/noop",
  "auto": { "tmux": "never", "handoff": "3", "spawnCommand": "ghostty -e {bin} {dest} --name {name} @{summary}" },
  "claude": { "defaultArgs": ["--chrome", "--brief"] },
  "exec": { "env": { "NAME": "value" } },
  "context": { "noticeThreshold": 0, "noticeTiers": [], "noticeRepeat": { "every": 0, "level": "info" } }
}
```

- `noOobe` — the interview runs whenever this is falsy or absent (including the whole file being absent) and the launch is interactive.
- `auto.tmux` — `never` | `always` | `worktree`. `auto.handoff` — `never` | `ask` | seconds as a string. `auto.spawnCommand` — template with `{bin} {dest} {name} {summary}`.
- `claude.defaultArgs` — appended to every claude launch.
- `context.*` — the existing notice settings, camelCased.

Schema: `rhombus-rocks-fnclaude-config.json`, hand-written, lives in the fnclaude repo (`packages/cli/schemas/`), shipped in the package.

## fngit CLI contract (what fnc relies on)

fnc talks to fngit **as a CLI on PATH**, never as a library. fngit is optional: when `fngit` is not on PATH, fnc accepts only real paths (absolute, `~`-prefixed, `./`-prefixed) and errors on any repo reference with a message naming `fnc install`.

- `fngit clone <ref> [git-clone-flags]` — resolves `<ref>` (bare name, `name@owner`, `owner/name`, `gh:owner/name`, HTTPS or SSH URL), finds an existing clone in the clone-template location or `additionalSrcDirs`, else clones via `gh`. **Prints the absolute path on stdout and nothing else**; progress on stderr; non-zero exit on failure with the reason on stderr. Already-cloned = prints the path, no network.
- `fngit install -y [--clone-template T] [--worktree-template T] [--additional-src-dirs a,b] [--host-alias host=alias]... [--plugin|--no-plugin] [--shadow-git|--no-shadow-git]` — non-interactive; never prompts when `-y` is given; writes the shared config (merge) and performs the install actions. `fnc install` drives this with the answers it collected; fnc owns the interview (`specs/oobe-interview.md`).
- Exit codes: 0 ok; non-zero with stderr reason. fnc must not parse stderr.

The `+workspace` suffix (`fnc <ref>+<ws>`) is fnc's: strip it before calling fngit, then pass `--worktree <ws>` to claude as today.

## worktree-paths plugin (assumed working as designed)

Marketplace `rhombus-rocks/claude-plugins`, plugin name `worktree-paths`. Reads `repos.worktreeTemplate` and `repos.branchTemplate` from the shared config. Installed by `fnc install` (via `claude plugin marketplace add rhombus-rocks/claude-plugins` + `claude plugin install worktree-paths@rhombus-rocks-claude-plugins`) and by `fngit install --plugin`. Both must detect the old `claude-code-worktree-paths@fnrhombus-plugins` install and swap it.

## Publishing

- Every repo publishes from `.github/workflows/release.yml` (the npm trusted publisher is registered against that filename and the `production` environment). fnclaude moves its publish step out of `ci.yml` into `release.yml` (release-please stays).
- Agents never publish, never run `npm publish`, never touch SchemaStore, never transfer repos.
