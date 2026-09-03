// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { INDEXABLE } from './src/site';

// Custom domain, so the site is served from the root rather than /fnclaude/.
// docs/public/CNAME is what tells GitHub Pages about it.
export default defineConfig({
  site: 'https://fnclaude.rhombus.rocks',
  integrations: [
    starlight({
      title: 'fnclaude',
      description: 'Session control for Claude Code.',
      customCss: ['./src/styles/custom.css'],
      // The two faces the theme is built on. Preconnect first so the
      // stylesheet request doesn't pay for a cold TLS handshake.
      head: [
        // Pre-launch: keep the site out of search results. The meta tag is the
        // whole mechanism — a robots.txt Disallow would stop crawlers reading
        // this and let the bare URL get indexed anyway.
        ...(INDEXABLE
          ? []
          : [
              {
                tag: /** @type {const} */ ('meta'),
                attrs: { name: 'robots', content: 'noindex, nofollow' },
              },
            ]),
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,700;0,800;1,400&family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&display=swap',
          },
        },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/fnclaude/fnclaude' },
      ],
      editLink: {
        baseUrl: 'https://github.com/fnclaude/fnclaude/edit/main/docs/',
      },
      // Explicit slugs rather than autogenerate: the labels are the design,
      // and autogenerate would derive them from filenames instead.
      sidebar: [
        {
          label: 'Guide',
          items: [
            { label: 'Getting Started', slug: 'getting-started' },
            { label: 'Installation', slug: 'installation' },
          ],
        },
        {
          label: 'Sessions',
          items: [
            { label: 'Resuming & continuing', slug: 'sessions/resuming' },
            { label: 'Switching projects', slug: 'sessions/switching-projects' },
            { label: 'Spawning siblings', slug: 'sessions/spawning-siblings' },
            { label: 'Worktrees', slug: 'sessions/worktrees' },
            { label: 'Model & effort', slug: 'sessions/model-and-effort' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Tool reference', slug: 'reference/tools' },
            { label: 'Repo resolution', slug: 'reference/repo-resolution' },
            { label: 'CLI flags', slug: 'reference/cli-flags' },
          ],
        },
      ],
    }),
  ],
});
