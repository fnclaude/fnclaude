# @fnclaude/docs

The published fnclaude documentation site: [fnclaude.rhombus.rocks](https://fnclaude.rhombus.rocks).

Built with [Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/).
`src/pages/index.astro` is the landing page, which sits outside Starlight's layout;
everything under `src/content/docs/` is a Starlight page.

```sh
bun run dev      # local server with hot reload
bun run build    # static build into dist/
bun run preview  # serve the built dist/
```

Deployment is automatic: `.github/workflows/pages.yml` builds this package and pushes
`dist/` to GitHub Pages on every push to `main` that touches it. `public/CNAME` holds
the custom domain.

## docs/ vs specs/

`docs/` is this — the site users read. `specs/` at the repo root holds internal design
documents, decision records, and reverse-engineering notes, which are not published.
