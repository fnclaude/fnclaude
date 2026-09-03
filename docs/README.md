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

## The @bruits/satteri-* optional deps

Astro bundles Starlight's syntax highlighter into the prerender chunk, which moves its
napi `require()` out of its own package directory and breaks the lookup for the
platform binding. Declaring the bindings on this package puts them somewhere the
bundled require can still resolve. Without them, importing anything from
`@astrojs/starlight/components` fails the build under Bun.

## docs/ vs specs/

`docs/` is this — the site users read. `specs/` at the repo root holds internal design
documents, decision records, and reverse-engineering notes, which are not published.
