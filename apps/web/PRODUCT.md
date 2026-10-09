# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The operator: Eumon's founder, who runs Eumon on their own sites and on client sites as a done-for-you service. They use the console to analyse a site, collect its data, publish landing pages, and see which pages bring customers. Clients also use the dashboard: it is client-facing, so each client sees their own sites, results, and reports.

## Product Purpose

Eumon is a programmatic landing-page engine. It breaks a business down into the specific things people search for (doctors, procedures, malls, products, locations), collects structured facts for each, publishes one crawlable landing page per unit on the client's own domain, and measures which pages earn impressions, clicks, and enquiries so the rest can be improved. Success is more qualified enquiries from organic search, proven page by page.

## Positioning

Pages are generated from the site's own collected data and served as real HTML that Google can read, through a proxy, so it works on any stack (Next.js, WordPress, Drupal, custom) with GitHub optional. Every recommendation and every number in the console comes from the site's own crawl, Search Console, and conversion data, not from estimates.

## Operating Context

- Pipeline: scope the data, find its sources, collect records, generate pages, serve them pre-rendered, track performance, improve conversion.
- Evidence sources: a full Googlebot crawl of every sitemap URL, competitor sitemaps and sample pages, Google Search Console, and Eumon's own page and conversion events.
- Market: Southeast Asian SMBs first (Malaysia, Indonesia). Leads usually arrive by WhatsApp or phone. Pages are written in English, Malay, or Indonesian.
- medbaycare.com is the operator's own site and the running example; the engine stays generic. edeadesign.com.my is a non-JavaScript (Drupal) prospect used as the test case for CMS sites.
- Ask Eumon answers the operator's questions from the site's data with read-only tools and draws charts from tool rows.

## Capabilities and Constraints

- Only the website is required; GitHub, Search Console, target markets, and competitor domains each add evidence.
- Generated landing pages carry each client's brand, not Eumon's.
- Never hard-code one client's heuristics; fix the pipeline and prove it with the evaluation (`npm run eval`).
- A localhost-only demo site with fictional data, clearly labelled as demo, exists for development.

## Evidence on Hand

No customer proof yet: no testimonials, case studies, published results, or pricing. Never invent customer results, testimonials, rankings, traffic, or prices in the product or its copy, and never hand-type example data into a client's dataset.

## Product Principles

- Every number traces to data the site produced; when data is missing, say what to connect.
- The engine stays generic: any business that can be broken into searchable units, any stack.
- Show the work: what was read, what changed, how long is left, and how to stop.
- Pages exist to convert: each one answers exactly what the searcher wants and offers one clear next step.
