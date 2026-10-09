---
version: 3
slug: "app-page-tsx"
primary_target: "app/page.tsx"
related_targets: ["app/globals.css","app/layout.tsx","app/components/ui.tsx","app/components/pixel.tsx","app/components/charts.tsx","app/components/Ask.tsx","app/components/AnalysisProgress.tsx","app/components/OverviewView.tsx","app/components/ConnectionsView.tsx","app/components/DataView.tsx","app/components/PagesView.tsx","app/components/PerformanceView.tsx","app/components/SetupView.tsx"]
---

# Dashboard

Mode: Operate. The operator (Eumon's founder) runs client sites through the pipeline: Overview, Ask, Connections, Data, Landing pages, Performance, Setup. The navigation model, views, and controls stay; the world changes around them.

Constraints (user, 2026-10-07, second revision): keep Better Auth's straight edges, hard corners, hairline rules, frame lines, and + registration marks; the soft, rounded pass is rejected. From cofounder.co and adaline.ai take only the colours (warm paper by day, warm forest-night by night, never #000), and from spline.design only the interactivity. Keep both themes following the device with a toggle, all motion, the pixel garden and seedling, hover readouts, and the keyboard-readable chart. Overview leads with the numbers; Connections is its own tab with a one-line link strip on Overview. Ask follows PostHog AI: a visible step trace, short notes between steps, and insight tiles with a header strip. A localhost-only demo site with fictional data (labelled as demo) exercises every view. Generated landing pages keep each client's brand and are out of scope. No invented results or claims in interface copy. No labels above headings.

## Direction contract

THESIS: Eumon tends client sites like a garden, drawn on a ruled workbench: everything sits on hairlines that meet at square corners, and the only soft things are the colour and the motion. Crawled pages sprout, answers show their working, a finished analysis blooms. It refuses the rounded, shadowed SaaS card and the cold pure-black console.

OWN-WORLD: Day is warm green-tinted paper with deep forest ink; night is warm forest-charcoal (#0f1411) with visible steps. Panels share 1px rules (they overlap by a pixel, never float on gaps or shadows); the work column is framed by full-height hairlines with + marks where rules cross. Corners are square everywhere: buttons, chips, badges, inputs, the composer, tiles, the drawer. Sprout green marks progress and positive state; sun, sky, and clay join it as data colours. Geist for prose, Geist Mono uppercase for machinery. Pixel sprites and the pixel garden are the only illustration. Shadows only on things that float: the toast, the garden tip, the chart readout, the drawer.

STORY: The operator opens a client and reads the numbers first, starts an update, and watches the garden fill while knowing how long is left and how to stop; the finished card says what changed. On any view they ask a question and watch Eumon read the site's data step by step, then get an answer with charts they can flip to rows.

FIRST VIEWPORT: Tinted rail with the pixel sprout mark, square nav items with a rotating green marker, the theme toggle at its foot; a ruled top bar with the breadcrumb, run chip, and Ask Eumon. Overview: title, lede, actions with a time estimate, then one ruled stack: KPI strip, the run or finished card, the Connections strip, then the report. Ask: a seedling, a greeting, one centred square composer, three chips.

FORM: Pinned by the user (Better Auth structure, cofounder.co and adaline.ai palettes, spline.design interactivity, PostHog AI for Ask), so no concept-seed roll. Signature move: the pixel garden. Motion: counts tween between polls, bars grow, lines draw, steps rise in, the drawer slides, the composer travels from centre to dock; under 300ms for interaction, one bloom per finished analysis; all of it off under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
