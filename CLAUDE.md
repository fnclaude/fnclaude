# Working on this project

## Branch policy — HARD RULE

**No direct commits to `main`.** All changes land via PR from a feature branch — `main` is protected, even the maintainer goes through the PR flow.

Worktree mechanics, branch/PR cleanup, and templated paths are governed by `~/.claude/CLAUDE.git.md`. Don't restate them here.

## Release flow

This repo uses [release-please](https://github.com/googleapis/release-please) in manifest mode for per-package versioning across a 3-package monorepo (`fnclaude`, `@fnclaude/cli`, `@fnclaude/renderer`). The shipping pattern matches the standard `@next` → `@latest` two-stage promotion: every PR merge eventually publishes a `@next` pre-release for the affected package; promotion to `@latest` is a manual gate.

- Every push to `main` (necessarily via PR merge — see above) runs the
  `CI` workflow's `release-please` job via `googleapis/release-please-action`.
  For each package with new conventional commits scoped to its path, the
  action opens or updates a per-package **release PR** (titled like
  `chore(main): release @fnclaude/cli 0.2.0`).
- Release PRs are non-draft, so `auto-merge.yml` covers them — they merge
  the moment `verify` is green. Merging a release PR triggers another
  push to `main`, which fires release-please-action again; this time the
  action's `paths_released` output includes the just-merged package, and a
  downstream step runs `npm publish --provenance --tag next` for it.
  OIDC trusted-publisher auth handles npm credentials — no `NPM_TOKEN`.
- Promotion to `@latest` is a **manual gate** per package. Trigger the
  `CI` workflow via `workflow_dispatch` with `package` and `version`
  inputs; the `promote` job is gated by the `production` environment
  (required reviewer approval). It moves the dist-tag via
  `npm dist-tag add` and flips the GitHub release from prerelease → latest.
  No rebuild — the `@next` artifact is the `@latest` artifact.

Net effect: every feature merge eventually ships a `@next` pre-release for
the affected package. The cost is two pushes per feature (the feature merge,
then the bot's release PR auto-merging); the trade-off is per-package
versioning and per-package CHANGELOGs that fit the monorepo shape.

### Version bump rules (conventional commits)

| commit type | bump | shown in release notes |
|---|---|---|
| `feat:` | minor (0.X.0) | yes |
| `fix:` | patch (0.0.X) | yes |
| `feat!:` or `BREAKING CHANGE:` in body | major (X.0.0) | yes |
| `perf:` | patch (0.0.X) | yes |
| `docs:`, `refactor:`, `chore:`, `ci:`, `build:`, `test:`, `style:` | none | hidden |

> Note: release-please couples CHANGELOG visibility with bump-eligibility.
> The no-bump types (`docs:`, `refactor:`, `chore:`, `ci:`, `build:`,
> `test:`, `style:`) are explicitly listed with `"hidden": true` in
> `release-please-config.json`'s `changelog-sections` to keep them out of
> CHANGELOGs and prevent accidental version bumps.

## Test-driven changes — HARD RULE

**Every fix or feature PR must include a test that would fail without the
code change.**

Auto-merge is enabled on every non-draft PR (`.github/workflows/auto-merge.yml`);
it fires the moment the `verify` status check is green. Without TDD, a PR
can land before any test captures the bug behavior — which means future
regressions slip in silently. The `@next` → `@latest` promotion gate
catches gross issues, but TDD is what catches the subtle ones that pass
human review.

The workflow:

1. **Write the failing test first**, against the broken state. Run your
   test command. Confirm it fails — and that the failure message points
   at the bug, not an unrelated assertion.
2. **Write the minimum code to make it pass.** Re-run. Confirm green.
3. **Sanity check** before pushing: stash your code change, re-run the
   test, watch it fail. Pop the stash, re-run, watch it pass. If the test
   passes both ways, the test isn't actually catching what you fixed —
   rewrite it.

```sh
git stash --keep-index -- <your-code-files>
bun test          # the new test should FAIL here
git stash pop
bun test          # and pass here
```

When TDD is impractical, prefix the commit explicitly to opt out:

- `docs:` — markdown / comments / inline docstrings, no behavior change
- `ci:` / `build:` — workflows, packaging that aren't unit-testable
- `refactor:` — pure restructuring with no observable behavior change
  (the existing test suite is your safety net)

For `feat:`, `fix:`, `perf:` — TDD is non-negotiable. PR description
should call out which test would have failed pre-fix.

## Commit conventions

- **Format:** `<type>(<scope>): <subject>` per
  [conventional commits](https://www.conventionalcommits.org/). Subject
  under ~70 chars; body explains the *why*.
- **No `--no-verify`** to bypass pre-commit hooks. If a hook fails,
  investigate and fix the underlying issue.

## Before committing — verify hook tooling

`.githooks/pre-commit` (auto-registered via `mise.toml`'s `[hooks] enter`,
or manually with `git config core.hooksPath .githooks` for non-mise users)
must be able to find its tooling on PATH. Subagent worktrees routinely
lack mise's activation and will fail loudly if your hook depends on
mise-managed tools. Before any `git commit`, verify the formatter/linter
your hook runs is actually reachable:

```sh
command -v <your-formatter> >/dev/null && echo "ok: $(which <your-formatter>)" \
  || echo "MISSING — run: eval \"$(mise activate bash)\" (or zsh)"
```

Don't `--no-verify` to bypass — if the hook can't run, that's a setup
problem to fix, not a check to skip.
