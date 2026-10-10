import type { Check } from "./types.js";

/*
 * Every check the analysis runs. A finding names its check (`finding(CHECKS[id], …)`);
 * the Checks docs page is generated from this list. Ids are never renamed.
 * `category` is the finding’s category (it decides the dashboard tab); `class`
 * decides whether a failed page counts against the health score; severity is
 * set per finding by the producer and described in `docs.severity`.
 */

const c = (check: Check): Check => check;

const IMPACT = "The organic impact formula (packages/core/src/severity.ts)";

export const CATALOG: Check[] = [
  // robots.txt and access
  c({ id: "robots.googlebot_blocked", name: "Googlebot blocked site-wide", pillars: ["seo"], category: "indexing", class: "error", scope: "site", sources: ["crawl"], fix: "robots",
    docs: {
      what: "robots.txt, read as Googlebot reads it, disallows the homepage and everything below it.",
      why: "Google cannot fetch any page, so nothing new is indexed and existing rankings decay as pages are re-crawled and fail.",
      how: "Remove the site-wide Disallow from the group that applies to Googlebot (its own group, or User-agent: *) and keep only intentional private path blocks.",
      severity: "Always CRITICAL: the whole site is affected.",
    } }),
  c({ id: "robots.foreign_sitemap", name: "Sitemap on another domain", pillars: ["seo"], category: "sitemap", class: "error", scope: "site", sources: ["crawl"], fix: "robots",
    docs: {
      what: "robots.txt names a sitemap on a different host than the site.",
      why: "Search engines discover pages through the sitemap robots.txt declares; a foreign or stale sitemap, often an agency’s staging domain, hides the site’s real pages.",
      how: "Replace the Sitemap line in robots.txt with this site’s own sitemap URL and submit that sitemap in Search Console.",
      severity: `${IMPACT} with every sitemap URL affected; crawl-blocking when the site declares no sitemap of its own.`,
    } }),
  c({ id: "robots.ai_blocked", name: "robots.txt blocks AI crawlers", pillars: ["ai"], category: "ai_visibility", class: "notice", scope: "site", sources: ["crawl"], fix: "robots",
    docs: {
      what: "robots.txt disallows one or more AI crawlers or control tokens (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended and others).",
      why: "Blocking is a legitimate choice, so it never costs score. Blocking the search-facing crawlers keeps the site out of those assistants’ answers; blocking training crawlers does not.",
      how: "Keep the block if it is deliberate. To be cited in AI answers, allow the search-facing crawlers (OAI-SearchBot, PerplexityBot, Claude-SearchBot) while still blocking training crawlers if you prefer.",
      severity: "Always INFORMATIONAL (impact 10).",
    } }),
  c({ id: "access.bot_challenge", name: "Bot protection blocked the crawl", pillars: ["seo", "ai"], category: "indexing", class: "error", scope: "page", sources: ["crawl"], fix: "server", issue: "botChallenge",
    docs: {
      what: "Sitemap URLs answered the crawler with a bot-protection challenge (Cloudflare, Vercel, Akamai, Imperva, DataDome and similar) instead of the page.",
      why: "When the firewall challenges Googlebot or AI crawlers, they receive the challenge page, not the content, and the page drops out of search and answers.",
      how: "Allow verified search engine and AI search crawlers in the firewall or bot-management rules, and keep challenges for unverified traffic only.",
      severity: `${IMPACT} with the challenged URLs as pages affected.`,
    } }),
  c({ id: "access.googlebot_refused", name: "Firewall refuses unverified Googlebot", pillars: ["seo"], category: "indexing", class: "warning", scope: "site", sources: ["crawl"], fix: "server", issue: "botFallback",
    docs: {
      what: "Requests with Googlebot’s user agent were refused (401, 403, 429 or 503) while the same URL served a browser.",
      why: "Usually this blocks only impostors, which is fine. But if the rule checks the user agent alone, real Googlebot from an unexpected address is refused too, and those pages stop being crawled.",
      how: "Verify Googlebot by reverse DNS or Google’s published IP ranges rather than refusing every unverified request with its user agent, and check Search Console’s crawl stats for refused requests.",
      severity: `${IMPACT} with the refused URLs as pages affected.`,
    } }),

  // Server and HTTP
  c({ id: "server.soft_404_probe", name: "200 for pages that don’t exist", pillars: ["seo"], category: "indexing", class: "error", scope: "site", sources: ["probe"], fix: "server",
    docs: {
      what: "The analysis requests a URL that cannot exist; the site answers it with a status under 400 (often the homepage or a generic page).",
      why: "Every mistyped or removed URL becomes a crawlable page with the same content. Google calls these soft 404s, crawls them, indexes nothing, and keeps coming back.",
      how: "Return 404 (or 410) for unknown paths. In frameworks with a catch-all route, call the not-found handler when no record matches instead of rendering a fallback.",
      severity: "Fixed at 62 (MEDIUM).",
    } }),
  c({ id: "server.soft_200", name: "Sampled URLs answer 200 with no content", pillars: ["seo"], category: "indexing", class: "warning", scope: "page", sources: ["sample"], fix: "server",
    docs: {
      what: "Sampled URLs answered 200 with an empty shell or a not-found title.",
      why: "A 200 tells Google the page is real; an empty or not-found page under it wastes crawls and can be indexed as junk.",
      how: "Return true 404 or 410 for unknown entity slugs, and never self-canonicalise an empty shell.",
      severity: `${IMPACT}, crawl-blocking.`,
    } }),
  c({ id: "server.intermittent", name: "Intermittent failures", pillars: ["seo"], category: "rendering", class: "error", scope: "family", sources: ["sample"], fix: "server",
    docs: {
      what: "The same URLs of a page type were fetched several times; some attempts failed, timed out or came back empty.",
      why: "Googlebot sees whichever answer it gets. A template that fails one time in three loses pages from the index at random and slows Google’s crawl rate.",
      how: "Find the failing dependency in the server logs (database timeouts, cold starts, rate limits) and add caching or retries in front of it.",
      severity: `${IMPACT} for the page type’s sitemap URLs.`,
    } }),
  c({ id: "server.slow", name: "Slow responses", pillars: ["seo"], category: "rendering", class: "warning", scope: "family", sources: ["sample"], fix: "server",
    docs: {
      what: "A page type’s median response time to Googlebot was slow across repeated fetches.",
      why: "Slow responses lower Google’s crawl rate, so large sites get crawled less, and they hurt real users’ loading time.",
      how: "Cache the page (static generation with revalidation, or an edge cache), run independent data requests in parallel, and move slow lookups out of the request.",
      severity: `${IMPACT} for the page type’s sitemap URLs, capped at 45.`,
    } }),
  c({ id: "http.error", name: "URLs that fail", pillars: ["seo", "ai"], category: "indexing", class: "error", scope: "page", sources: ["crawl", "sample"], fix: "server",
    docs: {
      what: "Sitemap URLs that answered 4xx or 5xx, or could not be fetched.",
      why: "The sitemap asks Google to index pages that fail; each failure is a wasted crawl, and pages that keep failing drop out of the index and out of AI answers.",
      how: "Fix the pages that should exist, and remove or redirect the ones that should not, then regenerate the sitemap from live records only.",
      severity: `${IMPACT} with the failing URLs as pages affected.`,
    } }),
  c({ id: "fetch.failed", name: "Sampled page could not be fetched", pillars: ["seo"], category: "rendering", class: "warning", scope: "page", sources: ["sample"], fix: "server",
    docs: {
      what: "A sampled page failed to load at all during the analysis (network error, timeout or an unsafe redirect).",
      why: "If Eumon cannot fetch the page, crawlers may not be able to either, and every other check on that page is unknown.",
      how: "Open the URL from outside your network, check DNS, TLS and redirects, and look for the request in the server logs.",
      severity: "Fixed at 30 and reported as MEDIUM: the cause is unknown until the URL is opened.",
    } }),

  // Sitemap and indexing
  c({ id: "indexing.homepage_noindex", name: "Homepage marked noindex", pillars: ["seo"], category: "indexing", class: "error", scope: "site", sources: ["crawl"], fix: "meta",
    docs: {
      what: "The homepage carries a noindex directive in a robots meta tag or an X-Robots-Tag header.",
      why: "This is usually a staging setting that shipped to production, and it often affects the whole site: the homepage drops out of Google and links from it carry less weight.",
      how: "Remove the noindex from production (check environment-dependent metadata, framework robots settings and hosting headers), then request indexing in Search Console.",
      severity: "Fixed at 100 (CRITICAL).",
    } }),
  c({ id: "sitemap.noindex", name: "Sitemap lists noindex pages", pillars: ["seo"], category: "indexing", class: "warning", scope: "page", sources: ["crawl"], fix: "sitemap", issue: "noindex",
    docs: {
      what: "Sitemap URLs that carry a noindex directive.",
      why: "The sitemap asks Google to index pages that refuse it. A large share usually means a staging or preview setting reached production.",
      how: "For each section decide whether it should rank: remove the noindex if it should, or remove the URLs from the sitemap if it should not.",
      severity: `${IMPACT}, weighted by the share of served pages; crawl-blocking at 30% or more.`,
    } }),
  c({ id: "sitemap.blocked", name: "Sitemap lists blocked URLs", pillars: ["seo"], category: "indexing", class: "error", scope: "page", sources: ["crawl", "sample"], fix: "sitemap", issue: "robotsBlocked",
    docs: {
      what: "Sitemap URLs that robots.txt disallows for Googlebot.",
      why: "Google is told to index pages it is not allowed to fetch; they appear in Search Console as blocked and never rank on their content.",
      how: "Either remove the Disallow rule that catches them or drop them from the sitemap, whichever matches the intent.",
      severity: `${IMPACT}, crawl-blocking when a tenth of the sitemap is blocked.`,
    } }),
  c({ id: "sitemap.redirects", name: "Sitemap URLs redirect", pillars: ["seo"], category: "sitemap", class: "warning", scope: "page", sources: ["crawl", "sample"], fix: "sitemap", issue: "redirected",
    docs: {
      what: "Sitemap URLs that redirect once to another URL.",
      why: "A sitemap should list final URLs. Redirecting entries waste a crawl each and send mixed signals about which URL is canonical.",
      how: "Generate the sitemap from the final URLs (after trailing-slash, www and locale rules), and keep redirects for old links only.",
      severity: `${IMPACT}, capped at 45.`,
    } }),
  c({ id: "canonical.mismatch", name: "Canonical points elsewhere", pillars: ["seo"], category: "indexing", class: "notice", scope: "page", sources: ["crawl", "sample"], fix: "meta", issue: "canonicalMismatch",
    docs: {
      what: "Pages whose canonical tag names a different URL, including pages that all point at the homepage.",
      why: "Google usually follows the canonical and indexes the other URL instead. Pointing many pages at the homepage removes them from search.",
      how: "Give each indexable page a canonical tag naming its own final URL; point at another URL only for true duplicates.",
      severity: `${IMPACT}, crawl-blocking at scale. A notice for the score: pages that canonicalise elsewhere leave the score’s denominator instead of counting against it.`,
    } }),
  c({ id: "hreflang.missing", name: "Multilingual pages without hreflang", pillars: ["seo"], category: "metadata", class: "warning", scope: "page", sources: ["sample"], fix: "meta", requires: "two or more languages",
    docs: {
      what: "On a site with more than one language version, sampled pages carry no hreflang alternates in their HTML.",
      why: "Without hreflang Google may show the wrong language version in a market, or treat the versions as duplicates.",
      how: "Emit reciprocal hreflang alternates (plus x-default) in the initial HTML of every localized page.",
      severity: `${IMPACT}, commercial intent.`,
    } }),

  // Rendering
  c({ id: "render.empty_shell", name: "Empty HTML to crawlers", pillars: ["seo", "ai"], category: "rendering", class: "error", scope: "page", sources: ["crawl", "sample"], fix: "server",
    docs: {
      what: "Pages whose HTML, as Googlebot receives it, is an empty or thin shell that only fills in when JavaScript runs.",
      why: "Google renders JavaScript late and not always; AI crawlers do not run it at all. An empty shell is a page with nothing to rank or cite.",
      how: "Render the main content, title, description and structured data on the server or at build time, and validate the template across its sitemap URLs.",
      severity: `${IMPACT}: empty shells at scale add 55, and at 30% or more of the crawl the issue is crawl-blocking.`,
    } }),
  c({ id: "render.js_content", name: "Content added by JavaScript", pillars: ["seo", "ai"], category: "rendering", class: "warning", scope: "page", sources: ["render"], fix: "server", requires: "a browser render (one page per template)",
    docs: {
      what: "A page type whose rendered page has much more text than its HTML: the content only appears, fully or partly, after JavaScript runs.",
      why: "Search engines may index the HTML version, and AI crawlers only ever see it.",
      how: "Render the content that matters on the server (or prerender it) and keep JavaScript for interaction.",
      severity: `${IMPACT} for the page type’s sitemap URLs; higher when the content is missing entirely.`,
    } }),
  c({ id: "render.empty_after_js", name: "Empty after JavaScript", pillars: ["seo"], category: "rendering", class: "error", scope: "page", sources: ["render"], fix: "server", requires: "a browser render (one page per template)",
    docs: {
      what: "Pages that stay empty even after a real browser runs their JavaScript.",
      why: "There is nothing for anyone to index; the template or its data request is broken for crawlers.",
      how: "Open the page in a browser with the network panel, find the failing data request or script error, and fix it; then render the content on the server.",
      severity: `${IMPACT}, empty shells at scale.`,
    } }),
  c({ id: "render.meta_by_js", name: "Titles and meta set by JavaScript", pillars: ["seo", "ai"], category: "metadata", class: "error", scope: "page", sources: ["render"], fix: "meta", requires: "a browser render (one page per template)",
    docs: {
      what: "The title, description or canonical in the HTML differ from the rendered page: scripts set them after load.",
      why: "Crawlers that do not run JavaScript, which includes every AI crawler, see the generic values, so every page looks the same.",
      how: "Generate the title, description and canonical in the HTML response (generateMetadata, getServerSideProps head, useSeoMeta or prerendering).",
      severity: `${IMPACT} for the affected page types, capped.`,
    } }),
  c({ id: "render.googlebot_less", name: "Googlebot gets less content", pillars: ["seo", "ai"], category: "rendering", class: "warning", scope: "page", sources: ["sample"], fix: "server",
    docs: {
      what: "The same URL fetched as Googlebot returns noticeably less content than when fetched as a browser.",
      why: "Something treats crawlers differently (bot protection, a prerender service, geo rules). Google ranks what Googlebot gets.",
      how: "Compare the two responses, find the rule that serves crawlers less (firewall, prerender cache, A/B tool) and make it serve the same content.",
      severity: `${IMPACT}, empty shells at scale.`,
    } }),
  c({ id: "render.prerender_mismatch", name: "Crawlers get HTML browsers don’t", pillars: ["seo"], category: "rendering", class: "warning", scope: "page", sources: ["sample"], fix: "server",
    docs: {
      what: "Crawlers receive pre-rendered HTML while browsers receive an empty app shell.",
      why: "This is dynamic rendering, which Google calls a workaround: the two versions drift apart, and a stale prerender cache serves old content to crawlers.",
      how: "Render the same HTML for everyone (server rendering or static generation) and retire the prerender service.",
      severity: "Fixed at 15 (LOW): it works today, but the two versions drift.",
    } }),
  c({ id: "render.coverage_weak", name: "Large sitemap, weak render coverage", pillars: ["seo"], category: "sitemap", class: "warning", scope: "site", sources: ["sample"], fix: "server",
    docs: {
      what: "A large sitemap where the sampled pages render poorly for crawlers, so most of the sitemap is likely affected.",
      why: "The problem found on a few pages repeats across thousands of URLs of the same templates.",
      how: "Fix the templates behind the sampled pages first; a full crawl then confirms how many URLs recovered.",
      severity: `${IMPACT} with the sitemap size as pages affected.`,
    } }),

  // Titles, descriptions, headings
  c({ id: "title.weak", name: "Weak or missing titles", pillars: ["seo"], category: "metadata", class: "error", scope: "page", sources: ["crawl", "sample"], fix: "meta",
    docs: {
      what: "Indexable pages with no title, a title under 15 characters, or a title that is just the URL.",
      why: "The title is the strongest on-page signal of what a page is about and the headline of its search result.",
      how: "Generate a unique title per page on the server from the record it shows (name, location, key fact) and the site name.",
      severity: `${IMPACT}, capped at 45 for the sample and 65 for a full crawl.`,
    } }),
  c({ id: "title.duplicate", name: "Duplicate titles", pillars: ["seo"], category: "metadata", class: "warning", scope: "page", sources: ["crawl"], fix: "meta", issue: "duplicateTitle",
    docs: {
      what: "Indexable pages that share their title with another indexable page.",
      why: "Google cannot tell the pages apart from their titles, picks one, and may filter the rest as duplicates.",
      how: "Make each title name what is unique about its page; if the pages really are the same, keep one and redirect or canonicalise the others.",
      severity: `${IMPACT}, capped at 45.`,
    } }),
  c({ id: "description.missing", name: "Missing or thin descriptions", pillars: ["seo"], category: "metadata", class: "warning", scope: "page", sources: ["crawl", "sample"], fix: "meta", issue: "missingDescription",
    docs: {
      what: "Pages with no meta description or one under 40 characters.",
      why: "Google writes its own snippet when the description is missing; a written one usually earns more clicks from the same position.",
      how: "Write a unique description per page (or generate one from the record) that says what the searcher gets and why to click.",
      severity: `${IMPACT}, capped at 30.`,
    } }),
  c({ id: "heading.h1_missing", name: "Missing H1", pillars: ["seo", "ai"], category: "content", class: "warning", scope: "page", sources: ["crawl"], fix: "content", issue: "missingH1",
    docs: {
      what: "Pages with content but no H1 heading.",
      why: "The H1 tells search engines and assistants what the page is about; without it they rely on weaker signals.",
      how: "Give each page one H1 that names its subject, usually close to the title.",
      severity: `${IMPACT}, capped at 45.`,
    } }),
  c({ id: "heading.h1_multiple", name: "Multiple H1s", pillars: ["seo"], category: "content", class: "notice", scope: "page", sources: ["crawl"], fix: "content", issue: "multipleH1",
    docs: {
      what: "Pages with more than one H1 heading.",
      why: "Allowed by HTML and by Google, but it blurs which heading names the page; it is usually a template putting the logo or site name in an H1.",
      how: "Keep one H1 for the page’s subject and turn the others into H2s or plain text.",
      severity: `${IMPACT}, capped at 20.`,
    } }),

  // Content and structured data
  c({ id: "content.soft_404", name: "Soft 404s", pillars: ["seo"], category: "indexing", class: "error", scope: "page", sources: ["crawl"], fix: "server", issue: "softNotFound",
    docs: {
      what: "Pages that answer 200 but say they are missing, in their title or first heading, or carry the title the site gives a page that does not exist.",
      why: "Google calls these soft 404s: it crawls them, indexes nothing, and comes back.",
      how: "Return 404 or 410 for pages that are gone (or redirect to the page that replaced them) and take them out of the sitemap.",
      severity: `${IMPACT}, capped at 60.`,
    } }),
  c({ id: "content.near_duplicate", name: "Same page twice", pillars: ["seo"], category: "content", class: "warning", scope: "page", sources: ["crawl"], fix: "redirect", issue: "nearDuplicate",
    docs: {
      what: "Indexable pages with the same title and nearly the same main text (text fingerprints within 6 bits).",
      why: "Google picks one and ignores the rest, not always the one you would choose, and the clicks split.",
      how: "Keep one page per record: merge the duplicates in the data, or give the copies a canonical pointing at the page to keep.",
      severity: `${IMPACT}, capped at 55.`,
    } }),
  c({ id: "content.thin_records", name: "Record pages with almost no content", pillars: ["seo"], category: "content", class: "warning", scope: "page", sources: ["inventory"], fix: "content", requires: "a dataset",
    docs: {
      what: "Pages built from a dataset’s records that answered with an empty shell or under 250 characters of text.",
      why: "Google indexes few thin pages and ranks fewer; a catalogue of thin pages can drag down the whole site.",
      how: "Fill the record so the page has something to say, or leave the page out of the sitemap until it does.",
      severity: "40 plus 60 times the thin share, capped at 80.",
    } }),
  c({ id: "schema.missing", name: "No structured data", pillars: ["seo", "ai"], category: "structured_data", class: "warning", scope: "page", sources: ["crawl", "sample"], fix: "schema", issue: "missingStructuredData",
    docs: {
      what: "Detail pages (not the homepage or top-level pages) with no JSON-LD structured data in the HTML.",
      why: "Structured data tells search engines and assistants which entity a page describes (a business, a person, a product) and still earns rich results for many types.",
      how: "Add JSON-LD for the page’s entity type (LocalBusiness, Person, Product, Article…) with the facts the page shows, rendered in the HTML.",
      severity: IMPACT + ".",
    } }),
  c({ id: "schema.invalid", name: "Structured data fails to parse", pillars: ["seo", "ai"], category: "structured_data", class: "warning", scope: "page", sources: ["crawl"], fix: "schema", issue: "invalidStructuredData",
    docs: {
      what: "Pages with a JSON-LD block that is not valid JSON.",
      why: "A block that does not parse is ignored entirely, so the page has no structured data at all.",
      how: "Generate JSON-LD with JSON.stringify rather than string templates, and test a page in Google’s Rich Results Test.",
      severity: `${IMPACT} plus 10, capped at 50.`,
    } }),

  // Repository
  c({ id: "repo.client_fetch", name: "Template fetches content in the browser", pillars: ["seo", "ai"], category: "repository", class: "warning", scope: "family", sources: ["repo"], fix: "server", requires: "a connected repository",
    docs: {
      what: "A page template that loads its data in the browser (useEffect, SWR, onMounted), so the HTML is sent without it.",
      why: "Crawlers that do not run JavaScript, and Google before it renders, see a page without its content.",
      how: "Load the data on the server: a server component, getStaticProps or getServerSideProps, useFetch in Nuxt, or prerendering.",
      severity: `${IMPACT} with empty shells at scale when the crawl confirms it; 40 otherwise.`,
    } }),
  c({ id: "repo.no_own_title", name: "Template has no title of its own", pillars: ["seo", "ai"], category: "repository", class: "warning", scope: "family", sources: ["repo"], fix: "meta", requires: "a connected repository",
    docs: {
      what: "A dynamic template that sets its title in the browser, inherits one from a layout, or sets none.",
      why: "Every page of the type gets the same title in the HTML, so search engines and assistants cannot tell them apart.",
      how: "Build the title and description from the record on the server: generateMetadata, a server-rendered Head, or useSeoMeta.",
      severity: `${IMPACT} plus 5, or plus 20 when the crawl found duplicate titles on the type, capped at 65.`,
    } }),
  c({ id: "repo.sequential_awaits", name: "Sequential data requests", pillars: ["seo"], category: "repository", class: "notice", scope: "family", sources: ["repo"], fix: "server", requires: "a connected repository",
    docs: {
      what: "A route rendered per request that awaits three or more data requests one after another before sending HTML.",
      why: "The waits add up, so the page is slow for users and for Googlebot, which lowers the crawl rate.",
      how: "Run independent requests together with Promise.all, cache shared lookups, or make the route static with revalidation.",
      severity: `${IMPACT} plus 15 when the page type was measured slow, capped at 55; 20 otherwise.`,
    } }),
  c({ id: "repo.sitemap_capped", name: "Sitemap stops at 1,000 rows", pillars: ["seo"], category: "repository", class: "warning", scope: "site", sources: ["repo"], fix: "sitemap", requires: "a connected repository",
    docs: {
      what: "The sitemap reads a Supabase table without a range, so it stops at Supabase’s default of 1,000 rows.",
      why: "Records beyond the first 1,000 never reach the sitemap, so Google may never find their pages.",
      how: "Page through the table with .range(from, to) until a short page comes back, and split the sitemap before it reaches 50,000 URLs.",
      severity: "80 when a page type has exactly 1,000 sitemap URLs; 45 otherwise.",
    } }),
  c({ id: "repo.sitemap_unpaged", name: "Sitemap from one unpaged query", pillars: ["seo"], category: "repository", class: "warning", scope: "site", sources: ["repo"], fix: "sitemap", requires: "a connected repository",
    docs: {
      what: "The sitemap loads every row in one query and writes a single file.",
      why: "It slows down as the data grows and breaks at 50,000 URLs, the limit for one sitemap file.",
      how: "Query in pages (LIMIT/OFFSET or a cursor) and split the sitemap into an index with files of up to 50,000 URLs.",
      severity: "60 when the sitemap already has over 40,000 URLs; 25 otherwise.",
    } }),
  c({ id: "repo.unpaged_queries", name: "List queries without paging", pillars: ["seo"], category: "repository", class: "warning", scope: "site", sources: ["repo"], fix: "server", requires: "a connected repository",
    docs: {
      what: "Routes that read whole tables with no limit (or, on Supabase, no range).",
      why: "On Supabase they silently stop at 1,000 rows, so pages or static paths go missing; elsewhere response time grows with the table until pages time out.",
      how: "Paginate list queries (.range() in Supabase, take/skip in Prisma, LIMIT/OFFSET in SQL) and expose the pages as crawlable links.",
      severity: "55 when the truncation drops pages; 30 otherwise.",
    } }),

  // Search Console
  c({ id: "search.market_mismatch", name: "Visibility outside the target market", pillars: ["seo"], category: "search", class: "notice", scope: "site", sources: ["search"], fix: "content", requires: "Search Console",
    docs: {
      what: "Most search impressions come from countries outside the markets the business sells to.",
      why: "Rankings abroad bring visits that do not convert; the target market’s searches are not being won.",
      how: "Publish pages in the target market’s language around what that market searches for, and set hreflang and target markets.",
      severity: "55 plus 30 times how far the target-market share falls below 30%.",
    } }),
  c({ id: "search.navigational", name: "Traffic is mostly name lookups", pillars: ["seo"], category: "search", class: "notice", scope: "site", sources: ["search"], fix: "content", requires: "Search Console",
    docs: {
      what: "Most clicks come from people searching a specific record by name (a doctor, a product), not from category searches.",
      why: "Name searches only reach people who already know the name; the category searches that bring new customers are not being won.",
      how: "Build pages for the category searches (service by location, comparisons, prices) and link them to the record pages.",
      severity: "Fixed at 55 (MEDIUM).",
    } }),
  c({ id: "search.low_ctr", name: "Page-one results searchers skip", pillars: ["seo"], category: "search", class: "notice", scope: "page", sources: ["search"], fix: "meta", requires: "Search Console",
    docs: {
      what: "Pages ranking on page one whose click-through rate is well below what their position usually earns.",
      why: "The ranking is already there; a better title and description turn the same impressions into more visits.",
      how: "Rewrite the title and description to answer the search directly (price, location, what the searcher gets) and check what the competing results say.",
      severity: "35 plus 8 per tenfold of the clicks missed, capped at 70.",
    } }),
  c({ id: "search.cannibalisation", name: "Pages compete for the same searches", pillars: ["seo"], category: "search", class: "notice", scope: "page", sources: ["search"], fix: "links", requires: "Search Console",
    docs: {
      what: "Several pages of the site receive impressions for the same search.",
      why: "Google alternates between them, and neither collects all the signals, so both rank lower than one page would.",
      how: "Pick the page that should rank, link to it from the others with the search’s words, and merge or differentiate the rest.",
      severity: "Fixed at 35 (LOW): a prompt to review, not a measured loss.",
    } }),
  c({ id: "index.coverage", name: "Low indexed share", pillars: ["seo"], category: "indexing", class: "notice", scope: "site", sources: ["connector"], fix: "sitemap", requires: "Search Console",
    docs: {
      what: "Search Console’s Page indexing report (imported in Setup) counts under half of the URLs Google knows as indexed.",
      why: "Google indexes what it judges worth its crawl budget; a low share means many URLs it sees as thin, duplicate or broken.",
      how: "Give Google fewer, better URLs: keep only pages with real content in the sitemap, noindex or drop thin ones, and watch which page types Googlebot requests.",
      severity: "55 plus 70 times the shortfall below half, capped at 90.",
    } }),
  c({ id: "index.noindex_recovered", name: "Excluded URLs now indexable", pillars: ["seo"], category: "indexing", class: "notice", scope: "page", sources: ["connector"], fix: "sitemap", requires: "Search Console",
    docs: {
      what: "URLs Google excluded as noindex that serve an indexable page today.",
      why: "Google only revisits excluded URLs slowly unless asked, so the fix does not show until it does.",
      how: "In Search Console’s Page indexing report open \"Excluded by ’noindex’ tag\" and click Validate fix, then resubmit the sitemap.",
      severity: "40 plus 12 per tenfold of URLs, capped at 80.",
    } }),
  c({ id: "index.gone_urls", name: "Old URLs Google still crawls", pillars: ["seo"], category: "indexing", class: "warning", scope: "page", sources: ["connector"], fix: "redirect", requires: "Search Console",
    docs: {
      what: "URLs Google remembers that now return 404 or 410, with the live pages whose words they share.",
      why: "Each is a wasted fetch, and the old URL’s links and rankings are lost unless it redirects.",
      how: "Redirect each old URL (301) to the suggested live page, and the rest to the closest list page.",
      severity: "30 plus 12 per tenfold of URLs, capped at 70.",
    } }),

  // Trends and logs
  c({ id: "trend.impressions_fell", name: "Impressions fell", pillars: ["seo"], category: "search", class: "notice", scope: "site", sources: ["connector"], fix: "none", requires: "Search Console",
    docs: {
      what: "Search Console impressions in the latest week are 60% or less of the peak week.",
      why: "A sudden fall usually has a cause on the site (a sitemap, a redirect rule, a noindex) or in an algorithm update; the date narrows it down.",
      how: "Look at what changed on the site in the days before the fall, and at the Page indexing report; History records the day it recovers.",
      severity: "50 plus 0.4 times the percentage fall, capped at 90.",
    } }),
  c({ id: "trend.indexed_fell", name: "Indexed count fell", pillars: ["seo"], category: "indexing", class: "notice", scope: "site", sources: ["connector"], fix: "none", requires: "Search Console",
    docs: {
      what: "Google’s indexed count (from the Search Console import or Eumon’s inspection sample) fell 10% and 50 pages below its 90-day peak.",
      why: "Pages leaving the index stop earning impressions; the date and size point at the cause.",
      how: "The Search Console import names the reasons for each dropped page; the crawl’s noindex, redirect and error counts say which the site caused.",
      severity: "45 plus the percentage fall, capped at 85.",
    } }),
  c({ id: "trend.googlebot_pace", name: "Googlebot too slow for the sitemap", pillars: ["seo"], category: "indexing", class: "notice", scope: "site", sources: ["connector"], fix: "links", requires: "server logs",
    docs: {
      what: "At Googlebot’s request rate from the server logs, one pass of the sitemap takes over 60 days.",
      why: "New and changed pages wait weeks to be seen; the crawl budget is spread too thin.",
      how: "Keep only pages with real content in the sitemap, and link the important ones from pages Googlebot already visits often.",
      severity: "40 plus a tenth of the days, capped at 80.",
    } }),
  c({ id: "crawl.unrequested", name: "Page type Googlebot skips", pillars: ["seo"], category: "indexing", class: "warning", scope: "family", sources: ["connector"], fix: "links", requires: "server logs",
    docs: {
      what: "A page type whose sitemap URLs Googlebot has not requested in the log window (30% or more of them).",
      why: "A page Google does not fetch cannot be indexed or refreshed.",
      how: "Link these pages from pages Googlebot already visits, keep them in the sitemap with an accurate lastmod, and check Search Console’s crawl stats.",
      severity: "30 plus 35 times the skipped share plus the count, capped at 85.",
    } }),
  c({ id: "crawl.budget_wasted", name: "Googlebot on errors and redirects", pillars: ["seo"], category: "indexing", class: "notice", scope: "site", sources: ["connector"], fix: "server", requires: "server logs",
    docs: {
      what: "A fifth or more of Googlebot’s requests in the logs hit redirects, 4xx or 5xx responses.",
      why: "Each is a request not spent on a page you want indexed, and server errors make Google crawl more slowly.",
      how: "Point internal links and the sitemap at final URLs, fix or remove links to missing pages, and find the server errors in the same logs.",
      severity: "60 when 5% or more are server errors; 42 otherwise.",
    } }),
  c({ id: "crawl.budget_parameters", name: "Googlebot on parameter URLs", pillars: ["seo"], category: "indexing", class: "notice", scope: "site", sources: ["connector"], fix: "robots", requires: "server logs",
    docs: {
      what: "A quarter or more of Googlebot’s requests are for URLs with query strings (filters, sorting, tracking).",
      why: "They usually duplicate other pages and use up the crawl budget.",
      how: "Keep parameter URLs out of internal links, give them canonicals to the clean URL, and block crawl-trap parameters in robots.txt.",
      severity: "Fixed at 30 (LOW): parameter URLs cost crawls, not rankings.",
    } }),

  // Conversion and data: shown, never scored
  c({ id: "conversion.no_contact", name: "No obvious way to get in touch", pillars: [], category: "conversion", class: "warning", scope: "site", sources: ["sample"], fix: "content",
    docs: {
      what: "None of the inspected pages offers a phone link, WhatsApp link, contact form or booking link.",
      why: "Organic visitors who are ready to act leave when they cannot find how to; the traffic does not become enquiries.",
      how: "Put one clear call to action on every template: a WhatsApp or phone link, or a short enquiry form, above the fold on mobile.",
      severity: "Fixed at 60 (MEDIUM): every organic visit is affected.",
    } }),
  c({ id: "conversion.no_cta", name: "No call to action on a template", pillars: [], category: "conversion", class: "warning", scope: "family", sources: ["sample"], fix: "content",
    docs: {
      what: "A page type whose inspected page has no call to action.",
      why: "Every visitor who lands on that type of page has no next step; large page types lose the most enquiries.",
      how: "Add the site’s main call to action to the template, close to the content the visitor came for.",
      severity: "30 plus 8 per tenfold of the page type’s URLs, capped at 58.",
    } }),
  c({ id: "conversion.no_tracking", name: "No analytics or conversion tracking", pillars: [], category: "conversion", class: "warning", scope: "site", sources: ["sample", "repo"], fix: "content",
    docs: {
      what: "No analytics or tag manager was found in the inspected pages, their scripts or the repository.",
      why: "Without tracking nobody can tell which pages bring enquiries, so growth work cannot be measured.",
      how: "Install Google Analytics 4 (or another analytics tool) and mark the enquiry actions as key events; Eumon’s snippet tracks WhatsApp clicks.",
      severity: "Fixed at 45 (MEDIUM): nothing else can be measured without it.",
    } }),
  c({ id: "data.missing_field", name: "Records missing a field", pillars: [], category: "content", class: "warning", scope: "site", sources: ["inventory"], fix: "content", requires: "a dataset",
    docs: {
      what: "A dataset where 50 or more records lack a field (by language for fields with language variants).",
      why: "A page built from such a record has nothing to say in that field or language, so it is thin or left out.",
      how: "Fill the field in the source data; until then leave those pages out of the sitemap, or noindex them.",
      severity: "40 plus 60 times the missing share, capped at 75.",
    } }),
  c({ id: "data.duplicates", name: "Records listed more than once", pillars: [], category: "content", class: "warning", scope: "site", sources: ["inventory"], fix: "content", requires: "a dataset",
    docs: {
      what: "Records in a dataset that share a name (once honorifics, case and punctuation are dropped).",
      why: "Each copy gets its own page saying the same thing: Google keeps one and the clicks split. Two people can share a name, so this is a suspicion to review.",
      how: "Review the groups in the Data section, merge true duplicates, then redirect each dropped page to the one kept.",
      severity: "35 plus 10 per tenfold of records, capped at 70.",
    } }),
];
