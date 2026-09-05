# fnclaude

A Bun-based monorepo for Claude Code tooling with two packages:
`@rhombus.rocks/fnclaude` and the umbrella `fnclaude`.

Publishing is handled by **release-please** in manifest mode:

- **OIDC trusted publishing** — no long-lived secrets; the workflow auths to
  npm via GitHub Actions' OIDC identity, configured per-package.
- **npm provenance** — every published version carries a verifiable build
  attestation linking the artifact to this repo + the exact workflow run.
- **Single-stage publish** — every release-PR merge publishes directly to
  `@latest` via `npm publish --provenance`. No staging dist-tag; the artifact
  that merges is the artifact users install.

## How releases work

1. Conventional commits accumulate on `main` via squash-merged PRs.
2. `googleapis/release-please-action` opens or updates a per-package
   **release PR** (e.g. `chore(main): release @rhombus.rocks/fnclaude 0.2.0`) whenever
   there are new version-bumping commits for that package.
3. Release PRs auto-merge the moment the `verify` status check is green
   (`auto-merge.yml` covers all non-draft PRs).
4. Merging a release PR triggers a push to `main`, which fires `release.yml`'s
   publish steps: `npm publish --provenance` for the just-bumped package(s),
   at the default `@latest` dist-tag.

Net effect: every feature merge that warrants a version bump eventually ships
to npm `@latest` automatically, with no manual promotion step.

## Workflow files

| File | Role |
|---|---|
| `ci.yml` | `verify` (lint/test/build) — the required status check on `main` |
| `release.yml` | release-please (opens/updates release PRs on push to main) and the npm publish that follows a release-PR merge. Named `release.yml` because npm's trusted publisher is registered against that filename plus the `production` environment — renaming it breaks publishing. |
| `auto-merge.yml` | Enables auto-merge on every non-draft PR |

## Platform support

Supported on **Linux** and **macOS**. The codebase has a Windows fallback path (`spawn + process.exit` instead of `process.execve`) but it has never been exercised — treat it as untested. If you run on Windows, expect breakage.

## Install

```sh
bun add fnclaude
```

## Support

File bugs and feature requests on [GitHub Issues](https://github.com/fnclaude/fnclaude/issues). No other support channels exist.

## See also

- `CLAUDE.md` — conventions / discipline (branch policy, TDD, commit
  conventions, release flow)
- `release-please-config.json` — per-package version bump rules and
  changelog sections
