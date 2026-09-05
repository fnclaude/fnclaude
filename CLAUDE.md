# Working on this project

## Branch policy — HARD RULE

**No direct commits to `main`.** All changes land via PR from a feature branch — `main` is protected, even the maintainer goes through the PR flow.

Worktree mechanics, branch/PR cleanup, and templated paths are governed by `~/.claude/CLAUDE.git.md`. Don't restate them here.

## Issue tracking — check BOTH repos

The canonical issues repo is **`fnclaude/fnclaude`** (matches the cwd `origin` remote). A legacy **`fnrhombus/fnclaude`** repo still exists from before the org migration and may collect misfiled issues — `gh issue create` run from a stale clone, a browser tab pointed at the old URL, an agent that resolved the owner from memory.

**When asked "what issues exist" (any phrasing — open issues, bugs, features, the backlog, what's filed):** query *both* repos before answering. A bare `gh issue list` only hits the cwd remote and will silently miss anything sitting in `fnrhombus/fnclaude`.

```sh
gh issue list --repo fnclaude/fnclaude --state open --limit 100
gh issue list --repo fnrhombus/fnclaude --state open --limit 100
```

Anything that lands in `fnrhombus/fnclaude` is misplaced by definition — transfer it with `gh issue transfer <number> fnclaude/fnclaude` (the issue keeps its body and comments; only the number changes). Don't leave stragglers there; the legacy repo should drain to zero.

## Release flow

This repo uses [release-please](https://github.com/googleapis/release-please) in manifest mode for per-package versioning across a 2-package monorepo (`fnclaude`, `@fnclaude/cli`). Every PR merge eventually publishes the affected package directly to `@latest`; the release PR's branch-protection-gated `verify` check IS the gate — there is no second-stage promotion dance.

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

**Step zero — verify the live binary is the code you think it is.** A
bug report from a live `fnc` invocation describes the *installed* entry
point, which is not necessarily the source you're about to write a test
against. Before writing the repro, resolve what actually ran:
`command -v fnc`, `readlink -f` the result, check whether it imports
`src/` directly or a built/published artifact, and confirm the backing
checkout's branch, commit, and cleanliness. (On Tom's machine,
`~/.local/bin/fnc` symlinks into this repo's main checkout and the shim
ends in `await import('../src/main.ts')` — the main checkout's
working-tree state IS the live behavior.) A repro test written against
code the user isn't running reproduces nothing.

**Do not read source files, form diagnoses, or theorize about root cause
before that test exists and fails for the right reason.** The failing
committed test is the gate that unlocks investigation. No test → no
investigation. This isn't intake ceremony — it's the only way to confirm
you're looking at the actual bug rather than a theory about it.

**This holds even when you resume a bug mid-investigation** — e.g. after
a context compaction whose summary already contains heavy diagnosis ("two
hypotheses", a root-cause theory, a half-built repro). Inherited
investigation is NOT a substitute for a committed failing test. If no such
test exists yet, writing one is still your *first* action, before reading
another source file — discard the carried-over theory until a failing test
confirms it. A test written *after* a diagnosis only validates the
diagnosis; if it's incomplete, the test goes green while the bug survives.
And stash-sanity every repro (fail without the fix, pass with it) — a repro
that passes both ways, e.g. an injected seam that bypasses the buggy line,
reproduces nothing.

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

**Multi-worktree caveat:** `git stash` uses a single shared stack rooted in the common `.git` dir — stashes are not per-worktree. Concurrent stash/pop pairs across sibling worktrees interleave on that stack and swap changes between worktrees (observed: two agents' sanity runs swapped their implementation files; one PR's fix landed in the other's worktree). Because parallel per-PR worktrees are the default here and stash-sanity fires on every `fix:`/`feat:`, this collision is the common case, not the edge case. Safe alternative: copy your changed implementation files aside (`cp <impl-files> /tmp/`), restore the originals (`git checkout HEAD -- <impl-files>`), run `bun test` (expect FAIL), then copy the saved files back and re-run (expect PASS). Or serialize: only use `git stash` after confirming `git stash list` is empty and no sibling worktree is mid-sanity.

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

There is currently no `pre-commit` hook in `.githooks/`: the only one that
existed formatted the renderer package's TypeScript with biome, and the
renderer was excised. `mise.toml`'s `[hooks] enter` still points git at
`.githooks/`, so dropping a hook in there is all it takes to add one back.

If you do add a hook, make sure its tooling is reachable before you commit —
subagent worktrees routinely lack mise's activation and will fail loudly:

```sh
command -v <your-formatter> >/dev/null && echo "ok: $(which <your-formatter>)" \
  || echo "MISSING — run: eval \"$(mise activate bash)\" (or zsh)"
```

Don't `--no-verify` to bypass — if the hook can't run, that's a setup
problem to fix, not a check to skip.
