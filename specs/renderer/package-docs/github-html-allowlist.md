# GitHub Markdown HTML sanitization allowlist

Reference document for the renderer's GFM-parity target. This is **not** reverse-engineering material — it is a stable reference derived from public sources describing GitHub's sanitization pipeline.

## Provenance

GitHub renders Markdown via [commonmarker](https://github.com/gjtorikian/commonmarker) (comrak) with `unsafe: false` + `tagfilter: true`, then sanitizes the resulting HTML through [Selma](https://github.com/gjtorikian/selma) using an allowlist derived from the [html-pipeline](https://github.com/gjtorikian/html-pipeline) gem's `SanitizationFilter`.

GitHub's production sanitizer is closed-source and diverges in at least one documented way (see [id rewriting](#not-allowed) below). The canonical public source for the allowlist is:

- **Primary:** [`html_pipeline/sanitization_filter.rb`](https://raw.githubusercontent.com/gjtorikian/html-pipeline/main/lib/html_pipeline/sanitization_filter.rb) (3.x era)
- **Community cross-reference:** [gist.github.com/seanh/13a93686bf4c2cb16e658b3cf96807f2](https://gist.github.com/seanh/13a93686bf4c2cb16e658b3cf96807f2)

## Allowed tags

### Headings and structural

`h1` `h2` `h3` `h4` `h5` `h6` `p` `br` `hr` `blockquote` `pre` `div`

### Inline text and emphasis

`b` `i` `strong` `em` `s` `strike` `small` `mark` `sub` `sup` `ins` `del`

### Inline semantic

`a` `span` `code` `tt` `samp` `var` `kbd` `q` `cite` `abbr` `dfn` `bdo` `time` `wbr`

### Lists

`ol` `ul` `li` `dl` `dt` `dd`

### Tables

`table` `thead` `tbody` `tfoot` `tr` `td` `th` `caption`

### Media

`img` `picture` `source`

### Figures and details

`figure` `figcaption` `details` `summary`

### Ruby annotations

`ruby` `rt` `rp`

## Surviving attributes

### Element-specific

| Element | Allowed attributes |
|---|---|
| `a` | `href` |
| `img` | `src` `alt` `longdesc` `loading` |
| `div` | `itemscope` `itemtype` |
| `source` | `srcset` |
| `blockquote`, `del`, `ins`, `q` | `cite` |

### Global (any element)

`abbr` `accept` `accept-charset` `accesskey` `action` `align` `alt` `aria-describedby` `aria-hidden` `aria-label` `aria-labelledby` `axis` `border` `char` `charoff` `charset` `checked` `clear` `cols` `colspan` `compact` `coords` `datetime` `dir` `disabled` `enctype` `for` `frame` `headers` `height` `hreflang` `hspace` `id` `ismap` `label` `lang` `maxlength` `media` `method` `multiple` `name` `nohref` `noshade` `nowrap` `open` `progress` `prompt` `readonly` `rel` `rev` `role` `rows` `rowspan` `rules` `scope` `selected` `shape` `size` `span` `start` `summary` `tabindex` `title` `type` `usemap` `valign` `value` `width` `itemprop`

### Protocol restrictions

- `a@href` — any valid protocol (http, https, mailto, relative, etc.) by default; JavaScript URIs stripped.
- `cite@cite`, `img@src`, `img@longdesc` — restricted to `http`, `https`, and relative URIs.

## Not allowed

### Blocked tags

`script` `style` `iframe` `object` `embed` `form` `input` `button` `textarea` `select` `option` `link` `meta` `title` `head` `body` `html` `canvas` `svg` `math` `audio` `video` `noscript` `applet` `frame` `frameset` `marquee` `xmp` `plaintext`

Note: `picture` and `source` appear in the allowlist but are only meaningful for static `<img>` fallback; they carry no media/video semantics on GitHub.

### Blocked attributes

- `class` — stripped entirely.
- `style` (inline CSS) — stripped entirely.
- All `on*` event handlers (`onclick`, `onerror`, `onload`, …) — stripped.

### The `id` special case

`id` is in the global allowlist, but GitHub's production renderer rewrites values: any `id` attribute is prefixed with `user-content-` (e.g. `id="foo"` → `id="user-content-foo"`). This prevents anchor-injection attacks. The public `html-pipeline` source does not implement this rewrite; it is a closed-source production divergence.

### GFM tagfilter pre-pass

Before sanitization, comrak's `tagfilter` extension HTML-escapes the following raw tags, rendering them inert regardless of the allowlist: `title` `textarea` `style` `xmp` `iframe` `noembed` `noframes` `script` `plaintext`. A raw `<script>` in Markdown source becomes `&lt;script&gt;` in the HTML handed to the sanitizer — it never reaches the tag-stripping pass.

## Confirmed allowlist entries

These specific elements are verified allowed and are relevant to the renderer's feature targets:

| Element | Allowed? | Notes |
|---|---|---|
| `br` | yes | bare line break |
| `hr` | yes | thematic break |
| `mark` | yes | highlight |
| `table` | yes | |
| `thead` `tbody` `tfoot` | yes | table sections |
| `tr` `td` `th` | yes | table cells |
| `caption` | yes | table caption |
| `a` | yes | `href` only |
| `kbd` | yes | keyboard input |
| `sub` | yes | subscript |
| `sup` | yes | superscript |
| `details` | yes | collapsible container |
| `summary` | yes | collapsible label |
| `del` | yes | strikethrough/deletion |
| `ins` | yes | insertion |
| `img` | yes | `src` `alt` `longdesc` `loading` |

## Mapping to the fnclaude renderer

The renderer divides the allowlisted element space into two buckets:

### INTERPRET — real terminal rendering

These elements have a direct terminal equivalent and the renderer produces one:

| Element(s) | Terminal rendering |
|---|---|
| `br` | newline |
| `hr` | full-width rule |
| `a` | OSC 8 hyperlink |
| `mark` | highlight (reverse video or color) |
| `kbd` | NerdFont glyph(s) / styled box |
| `sub` `sup` | unicode subscript/superscript glyphs where available |
| `table` `thead` `tbody` `tfoot` `tr` `td` `th` `caption` | box-drawing table |
| `blockquote` | indented block with left border |
| `ol` `ul` `li` `dl` `dt` `dd` | standard list rendering |
| `h1`–`h6` | bold/sized headings |
| `b` `strong` | bold |
| `i` `em` | italic |
| `del` `s` `strike` | strikethrough |
| `ins` | underline |
| `code` `tt` `samp` `var` | monospace / code style |
| `q` | quotation marks |
| `abbr` `dfn` `cite` `bdo` `time` `small` | style pass-through or semantic annotation |

### COLOR AS RAW MARKUP — no terminal analog, rendered as literal tag text

Everything else in the allowlist that has no meaningful terminal representation is surfaced as colored literal markup rather than silently dropped. The same treatment applies to any non-allowlisted pseudo-XML that survives the input (e.g. `<Foo>`, component-style tags).

Elements in this bucket:

- `img` — until the image roadmap ships (wl-paste / Sixel path)
- `picture` `source` — no terminal media-switching equivalent
- `details` `summary` — collapsible interaction punted (requires mouse/keybd event plumbing)
- `div` `span` — no inherent terminal meaning; rendered as `<div>` / `<span>` in dim color
- `figure` `figcaption` — no terminal analog
- `ruby` `rt` `rp` — no CJK ruby support yet

**Deliberate divergence from GitHub:** GitHub strips unknown/unallowlisted tags silently. The renderer surfaces them as colored literal text instead. This is intentional — it makes malformed or unexpected markup visible during development and debugging rather than silently eating it.
