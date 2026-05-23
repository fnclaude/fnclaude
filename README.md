# fnclaude

A Bun-based monorepo for Claude Code tooling with three packages:
`@fnclaude/cli`, `@fnclaude/renderer`, and the umbrella `fnclaude`.

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
   **release PR** (e.g. `chore(main): release @fnclaude/cli 0.2.0`) whenever
   there are new version-bumping commits for that package.
3. Release PRs auto-merge the moment the `verify` status check is green
   (`auto-merge.yml` covers all non-draft PRs).
4. Merging a release PR triggers a push to `main`, which fires the publish
   step: `npm publish --provenance --tag latest` for the just-bumped package(s).

Net effect: every feature merge that warrants a version bump eventually ships
to npm `@latest` automatically, with no manual promotion step.

## Workflow files

| File | Role |
|---|---|
| `ci.yml` | `verify` (lint/test/build), `release-please` (opens/updates release PRs on push to main), publish (runs on release-PR merge) |
| `auto-merge.yml` | Enables auto-merge on every non-draft PR |

## Install

```sh
bun add fnclaude
```

## See also

- `CLAUDE.md` — conventions / discipline (branch policy, TDD, commit
  conventions, release flow)
- `release-please-config.json` — per-package version bump rules and
  changelog sections
