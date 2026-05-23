# npm-template

A GitHub template for projects that publish to **npm**, with:

- **OIDC trusted publishing** — no `NPM_TOKEN` secret; the workflow auths to
  npm via GitHub Actions' OIDC identity, configured per-package and per-workflow.
- **npm provenance** — every published version carries a verifiable build
  attestation linking the artifact to this repo + the exact workflow run.
- **`@next` → `@latest` promotion** — every PR merge publishes a `@next`
  pre-release automatically; you promote to `@latest` manually through a
  reviewer-gated workflow when the version is ready for general consumption.

## What you get

Out of the box:

- `semantic-release` reads conventional-commit history on every push to
  `main`, determines the version, publishes to npm under `@next`, and
  creates a GitHub pre-release.
- A manual `promote` workflow that moves the same artifact from `@next`
  to `@latest` on npm and converts the GitHub pre-release into the
  latest release. Gated by the `production` environment (required
  reviewer approval).
- `auto-merge.yml` enables auto-merge on every non-draft PR so the
  publish chain closes without human intervention until the promote gate.
- Conventional-commits → semver bump, with rules documented in `CLAUDE.md`.

## Use it

1. Click **Use this template** on GitHub (or `gh repo create
   <new-name> --template fnrhombus/npm-template --public`).
2. Run `claim-npm.ps1` to claim the npm package name with a placeholder
   `0.0.0` publish (idempotent — re-running on an already-claimed package
   is safe).
3. Run `setup-gh.ps1` to merge template files into your repo, configure
   branch protection + the `production` environment, set repo-level merge
   settings (squash-only, PR title/body squash, linear history, auto-merge,
   auto-delete-branch), and register GitHub Actions as a trusted publisher
   on the npm package.
4. Add the `AUTOMERGE_PAT` secret manually (Settings → Secrets and
   variables → Actions → New repository secret). Classic PAT with `repo`
   + `workflow` scopes. PAT — not `GITHUB_TOKEN` — because GitHub
   suppresses workflow triggers for `GITHUB_TOKEN`-actored events, which
   would prevent the post-merge `push` from triggering `publish-next`.
5. Fill in the `lint`, `test`, and `build` steps in
   `.github/workflows/ci.yml`'s `verify` job, and the corresponding
   `npm run` scripts in `package.json`.
6. Commit a `feat:` change on a branch and open a PR. Auto-merge enables;
   when `verify` goes green it merges; `publish-next` runs; `@next` ships.
7. When ready, go to Actions → "CI" → "Run workflow", approve the
   `production` environment gate, and `@latest` updates.

## Workflow files

| File | Role |
|---|---|
| `ci.yml` | `verify` (lint/test/build), `publish-next` (semantic-release on push to main), `promote` (workflow_dispatch, @next → @latest, gated) |
| `auto-merge.yml` | Enables auto-merge on every non-draft PR |

## See also

- `CLAUDE.md` — conventions / discipline (branch policy, TDD, commit
  conventions, release flow)
- `claim-npm.ps1` — claim the npm package name (run first, before
  configuring GitHub)
- `setup-gh.ps1` — configure GitHub repo settings, branch protection,
  environment, and npm trusted publisher (run second)
- `.releaserc.json` — semantic-release config
