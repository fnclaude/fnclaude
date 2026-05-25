# Contributing

## Setup

```sh
# requires Bun and mise
mise install          # installs Bun + any other pinned tools
bun install           # install workspace dependencies
```

Run the tests for a specific package from that package's directory:

```sh
cd packages/cli
bun test
```

Or from the repo root (runs all packages):

```sh
bun test
```

## Conventional commits

This repo uses [release-please](https://github.com/googleapis/release-please) for automated versioning and changelogs. Every commit on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/) — release-please reads commit types to decide whether and how to bump versions.

Format: `<type>(<scope>): <subject>`

The version-bump rules and changelog visibility for each type are documented in [`CLAUDE.md`](CLAUDE.md#version-bump-rules-conventional-commits).

## Test-driven development

`feat:`, `fix:`, and `perf:` PRs must include a test that fails before the change and passes after. The full TDD workflow is documented in [`CLAUDE.md`](CLAUDE.md#test-driven-changes--hard-rule).

`docs:`, `ci:`, `build:`, and `refactor:` commits are exempt — use those types explicitly if your change has no testable behavior delta.

## Branch policy

No direct commits to `main`. All changes land via PR from a feature branch. `main` is branch-protected.

## PR workflow

Auto-merge is enabled on all non-draft PRs (`.github/workflows/auto-merge.yml`). A PR merges the moment the `verify` status check goes green — there is no manual review gate for maintainer patches; keep them tight and well-tested.

## Bugs and feature requests

Open an issue on GitHub. Templates are provided — pick the one that fits.
