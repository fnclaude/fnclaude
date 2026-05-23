# Working on this project

## Branch policy — HARD RULE

**No direct commits to `main`.** All changes land via PR from a feature branch — `main` is protected, even the maintainer goes through the PR flow.

Worktree mechanics, branch/PR cleanup, and templated paths are governed by `~/.claude/CLAUDE.git.md`. Don't restate them here.

## Release flow

This repo uses [semantic-release](https://semantic-release.gitbook.io/) with a two-stage dist-tag promotion:

- Every push to `main` (necessarily via PR merge — see above) runs the
  `CI` workflow's `publish-next` job. semantic-release reads the
  conventional-commit history, determines the next version, publishes to
  npm under the `@next` dist-tag, and creates a GitHub **pre-release**.
- Promotion to `@latest` is a **manual gate**. Run the `CI` workflow via
  workflow_dispatch ("Run workflow" in the Actions UI); the `promote` job
  is gated by the `production` environment, which requires reviewer
  approval. It moves the same artifact from `@next` to `@latest` on npm
  and converts the GitHub pre-release into the latest release. No
  rebuild — the @next version is the @latest version.
- Auto-merge is enabled on every non-draft PR
  (`.github/workflows/auto-merge.yml`); it fires the moment the `verify`
  status check is green.

Effectively: every PR merge to `main` ships a `@next` pre-release. `@latest` is what users get on `npm install <pkg>` by default — that's the gated step.

### Version bump rules (conventional commits)

| commit type | bump | shown in release notes |
|---|---|---|
| `feat:` | minor (0.X.0) | yes |
| `fix:` | patch (0.0.X) | yes |
| `feat!:` or `BREAKING CHANGE:` in body | major (X.0.0) | yes |
| `perf:` | patch (0.0.X) | yes |
| `docs:`, `refactor:`, `chore:`, `ci:`, `build:`, `test:`, `style:` | none | hidden |

> Note: semantic-release's `@semantic-release/commit-analyzer` default rules already skip `docs:`/`refactor:`/`chore:`/`ci:`/`build:`/`test:`/`style:` — they don't bump a version and don't appear in release notes. No `releaseRules` override is needed in `.releaserc.json`, and intentionally none is configured. Compare with release-please, which couples CHANGELOG visibility with bump-eligibility and needs explicit `"hidden": true` per type.

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
npm test          # the new test should FAIL here
git stash pop
npm test          # and pass here
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
