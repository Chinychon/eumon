# Docs site conventions

Source for the Eumon developer docs. `node docs/site/build.mjs` combines everything into `docs/site/dist/eumon-docs.html`, which is published as a Claude artifact.

## Pages: `pages/<slug>.html`

Each page is one HTML fragment: no `<html>`, `<head>`, `<style>` or `<script>`. It starts with:

```html
<article id="<slug>" data-title="Short nav title" data-group="Start here|How it works|Reference|Operating it">
  <h1>Page title</h1>
  <p class="lede">One or two sentences: what this page explains and who needs it.</p>
  ...
</article>
```

Allowed markup (the shell styles exactly these):
- `h2`, `h3` (each `h2` gets an `id`, kebab-case, used for deep links and the page's mini table of contents)
- `p`, `ul`, `ol`, `li`, `strong`, `em`, `code`, `pre><code`, `table` with `thead`/`tbody`, `dl`/`dt`/`dd`
- Cross-links to other pages: `<a href="#<slug>">`; to a section: `<a href="#<slug>--<h2-id>">`
- File references: `<code class="path">packages/db/src/index.ts:527</code>` (repo-relative, line number when pointing at one thing)
- Callouts: `<div class="callout note|warn|trap"><p>…</p></div>` (note = context, warn = easy to get wrong, trap = has bitten us)
- Diagrams: `<figure data-diagram="<name>"><figcaption>One sentence.</figcaption></figure>` — the build inlines `diagrams/<name>.svg`
- Key/value facts: `<dl class="facts">`

No inline styles, no classes other than the ones above, no emoji, no images.

## Diagrams: `diagrams/<name>.svg`

A bare `<svg>` with `viewBox`, `role="img"`, `aria-labelledby` pointing at its `<title>`/`<desc>` (ids `dg-<name>-title`, `dg-<name>-desc`). Colours come only from classes the shell defines, so diagrams follow light and dark mode:
`.d-paper` `.d-node` `.d-node-focal` `.d-store` `.d-ext` `.d-zone` (fills/strokes); `.d-ink` `.d-muted` `.d-soft` `.d-accent` `.d-link` (text fill); `.d-arrow` `.d-arrow-accent` `.d-arrow-link` `.d-arrow-dashed` (connector strokes); `.d-mask` (label mask fill = paper).
Markers: reference `url(#dg-<name>-arrow)` etc., defined inside the SVG's own `<defs>` with `fill` via the same classes. Square corners (`rx="0"` or `rx="2"` at most): the product's design rule is hard corners.

## Writing

Write for a capable developer who has never seen the repo. Plain, direct sentences. Every claim is checked against the code; name the file. No marketing tone, no em-dash asides, no "it's worth noting".
