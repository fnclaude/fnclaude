# Working on this project

## Branch policy — HARD RULE

**No direct commits to `main`.** All changes land via PR from a feature branch — `main` is protected, even the maintainer goes through the PR flow.

Worktree mechanics, branch/PR cleanup, and templated paths are governed by `~/.claude/CLAUDE.git.md`. Don't restate them here.

## Release flow

This repo uses [release-please](https://github.com/googleapis/release-please) in manifest mode for per-package versioning across a 3-package monorepo (`fnclaude`, `@fnclaude/cli`, `@fnclaude/renderer`). Every PR merge eventually publishes the affected package directly to `@latest`; the release PR's branch-protection-gated `verify` check IS the gate — there is no second-stage promotion dance.

- Every push to `main` (necessarily via PR merge — see above) runs the
  `CI` workflow's `release-please` job via `googleapis/release-please-action`.
  For each package with new conventional commits scoped to its path, the
  action opens or updates a per-package **release PR** (titled like
  `chore(main): release @fnclaude/cli 0.2.0`).
- Release PRs are non-draft, so `auto-merge.yml` covers them — they merge
  the moment `verify` is green. Merging a release PR triggers another
  push to `main`, which fires release-please-action again; this time the
  action's `paths_released` output includes the just-merged package, and a
  downstream step runs `npm publish --provenance` for it (defaults to the
  `@latest` dist-tag). OIDC trusted-publisher auth handles npm
  credentials — no `NPM_TOKEN`.
- No promotion gate. Branch protection on `main` requires `verify` to be
  green before any PR (feature OR release PR) can merge — that's the gate.
  A two-stage `@next` → `@latest` flow would require `npm dist-tag add`,
  which doesn't yet support OIDC trusted-publishing
  ([npm/cli#8547](https://github.com/npm/cli/issues/8547)); the only way
  to wire it up would be a long-lived `NPM_TOKEN` in the repo, which
  trades the OIDC win for a modest gate value.

Net effect: every feature merge eventually ships a release of the
affected package to `@latest`. The cost is two pushes per feature (the
feature merge, then the bot's release PR auto-merging); the trade-off
is per-package versioning and per-package CHANGELOGs that fit the
monorepo shape.

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

### Reproduce reported bugs in the test suite first

**When Tom describes a bug, or you find one referenced in an issue, the
FIRST action is to land a committed test that reproduces it** — not a
shell command you ran once, not a theory, not a fix proposal. A
regression assertion that fails in CI for the right reason.

**Do not read source files, form diagnoses, or theorize about root cause
before that test exists and fails for the right reason.** The failing
committed test is the gate that unlocks investigation. No test → no
investigation. This isn't intake ceremony — it's the only way to confirm
you're looking at the actual bug rather than a theory about it.

This is upstream of the "write the failing test first" workflow below.
That rule covers the *implementation phase* of a known bug; this rule
covers the *intake phase*. The reproducer level doesn't matter — unit,
integration, or e2e — but pick the **cheapest level that faithfully
replicates the bug**. A unit test on the broken function is preferred
over an integration test, which is preferred over e2e. Don't reach for
an e2e harness if a unit assertion on the same code path catches the
same failure. What matters is that the bug is visible in CI before you
touch the code that's supposed to fix it.

If reproduction needs new infrastructure to be observable (e.g. starting
the MCP server as a subprocess and verifying the JSON-RPC handshake),
build that infrastructure as part of the repro. The harness itself is
regression-prevention work, equally valuable to the fix.

Auto-merge is enabled on every non-draft PR (`.github/workflows/auto-merge.yml`);
it fires the moment the `verify` status check is green. Without TDD, a PR
can land before any test captures the bug behavior — which means future
regressions slip in silently. With no second-stage promotion gate, the
test suite is the only thing standing between a buggy `feat:`/`fix:` and
a published `@latest` artifact — TDD isn't a nice-to-have, it's the gate.

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
