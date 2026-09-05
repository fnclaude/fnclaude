# Contributing

## Setup

Bun is the only prerequisite — it is the runtime, package manager, and test runner.

```sh
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

### First build

`packages/cli` lowers its dependency-injection sugar to plain TypeScript through a
Go-based transform before it bundles. That transform host is compiled once, on the
first build, into a shared cache (roughly a minute on a cold machine); every build
after that reuses the cached host and finishes in a couple of seconds. No system Go
install is needed — the toolchain ships with the transform's dev dependency.

```sh
cd packages/cli
bun run build              # stage + bundle into dist/, writes the dist/.lowered sentinel
bun run test:composition  # the composition-tier tests, which exercise the lowering lane
```

The plain `bun test` unit tier pays none of this — it runs the source directly with no
transform.

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
