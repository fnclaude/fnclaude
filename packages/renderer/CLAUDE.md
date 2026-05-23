# Working on fnclaude-renderer

## Branch policy — HARD RULE

**No direct commits to `main`.** All changes land via PR from a feature branch — `main` is protected, even the maintainer goes through the PR flow. Worktree mechanics, branch/PR cleanup, and templated paths are governed by `~/.claude/CLAUDE.git.md`. Don't restate them here.

## Release flow

This repo uses [release-please](https://github.com/googleapis/release-please), shape mirrors fnclaude:

- Every push to `main` (via PR merge) triggers `Release Please`.
- release-please keeps an open `chore(main): release vX.Y.Z` PR continuously up to date with the proposed next version and auto-generated `CHANGELOG.md` derived from conventional commits.
- That PR **auto-merges** once `test` is green (`.github/workflows/release-please.yml`). You don't manually merge it.
- The release-please merge tags `vX.Y.Z`. The `release.yml` workflow fires on the tag, cross-builds binaries with `bun build --compile`, and the `publish-aur` job pushes the version bump to AUR.

Effectively: every PR merge to `main` ships a release.

### Version bump rules (conventional commits)

| commit type | bump | shown in CHANGELOG |
|---|---|---|
| `feat:` | minor (0.X.0) | yes |
| `fix:` | patch (0.0.X) | yes |
| `feat!:` or `BREAKING CHANGE:` in body | major (X.0.0) | yes |
| `perf:`, `revert:` | patch (0.0.X) | yes |
| `docs:`, `refactor:`, `chore:`, `ci:`, `build:`, `test:` | none | hidden |

`docs:` / `refactor:` are `"hidden": true` in `release-please-config.json` so docs-only PRs don't cut releases.

## Test-driven changes — HARD RULE

**Every fix or feature PR must include a test that would fail without the code change.**

Auto-merge fires the moment `test` is green; without TDD, regressions slip in silently.

1. **Write the failing test first** against the broken state. Run `bun test`. Confirm it fails — and that the failure points at the bug, not an unrelated assertion.
2. **Write the minimum code to make it pass.** Re-run. Confirm green.
3. **Sanity check** before pushing: stash your code change, re-run the test, watch it fail. Pop the stash, re-run, watch it pass. If the test passes both ways, it isn't catching what you fixed — rewrite it.

When TDD is impractical, prefix the commit explicitly to opt out:

- `docs:` — markdown / comments / inline docstrings, no behavior change
- `ci:` / `build:` — workflows, mise tasks, packaging
- `refactor:` — pure restructuring with no observable behavior change

For `feat:`, `fix:`, `perf:` — TDD is non-negotiable.

## Commit conventions

- **Format:** `<type>(<scope>): <subject>` per [conventional commits](https://www.conventionalcommits.org/). Subject under ~70 chars; body explains the *why*. Release-please depends on this.
- **Author:** `fnrhombus`, email `2511516+fnrhombus@users.noreply.github.com` (GitHub noreply, never the underlying gmail).
- No Claude attribution anywhere — see `~/.claude/CLAUDE.md`.

## Before committing — verify the hook is active

The pre-commit hook runs `bun run check` (biome lint + format check). If `bun` or `biome` aren't on PATH the hook fails loudly. Before any `git commit` here:

```sh
command -v bun >/dev/null && echo "bun: $(which bun)" || echo "bun MISSING — run: eval \"\$(mise activate bash)\" (or zsh)"
```

`mise.toml`'s `[hooks] enter = "git config core.hooksPath .githooks"` auto-installs the hooks-path setting on `cd` for mise users. Non-mise users run that command once.

## Layout

- `src/` — TypeScript source
- `src/types/events.ts` — stream-json event shapes (contract between the process driver and the UI)
- `bin/` — compiled binaries (`bun build --compile`); gitignored
- `docs/` — design + spec docs
- `packaging/aur/` — PKGBUILD for `fnclaude-renderer-bin`
- `.github/workflows/` — `test`, `release-please`, `release`, `auto-merge`
- `mise.toml` — Bun pin + `[hooks] enter` for hook auto-install
