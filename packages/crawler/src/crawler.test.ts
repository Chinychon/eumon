import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CrawlCoverage } from "@organic-growth/core";
import { aiReadiness, auditSitemap, defaultFetcher, robotsState, sitemapEntries, fetchGooglebotPage, findingsFromCrawlCoverage, headerNoindex, isBotChallenge, isEmptyShell, isSafePublicUrl, parseHtmlSignals, runTechnicalSeoAudit, type Fetcher, probeNotFound } from "./index.js";
import { hamming, nearDuplicate } from "@organic-growth/core";
import { classifyLanguage, classifyUrlType, isSameSite } from "./urls.js";

describe("isSameSite", () => {
  it("treats www and http/https variants as one site", () => {
    assert.equal(isSameSite("http://www.example.com/a", "https://example.com"), true);
    assert.equal(isSameSite("https://example.com/sitemap.xml", "https://www.example.com"), true);
    assert.equal(isSameSite("https://cdn.example.com/x", "https://example.com"), false);
    assert.equal(isSameSite("http://corex.okie.my/sitemap.xml", "https://edeadesign.com.my"), false);
  });
});

describe("URL classification", () => {
  it("groups by route family after any locale prefix", () => {
    assert.equal(classifyUrlType("https://x.com/"), "home");
    assert.equal(classifyUrlType("https://x.com/about"), "page");
    assert.equal(classifyUrlType("https://x.com/en/doctors/jane"), "doctors");
    assert.equal(classifyUrlType("https://x.com/our-services/outdoor-hoarding"), "our-services");
    assert.equal(classifyLanguage("https://x.com/id/dokter/a"), "id");
    assert.equal(classifyLanguage("https://x.com/doctors/a"), "default");
  });
});

describe("auditSitemap", () => {
  const files: Record<string, string> = {
    "https://shop.example/robots.txt": "User-agent: *\nDisallow:\nSitemap: http://agency-staging.example/sitemap.xml",
    "https://shop.example/sitemap.xml": `<urlset>
      <url><loc>https://shop.example/products/a</loc></url>
      <url><loc>https://www.shop.example/products/b</loc></url>
      <url><loc>https://elsewhere.example/c</loc></url>
    </urlset>`,
  };
  const fake: Fetcher = async (url) => ({ url, finalUrl: url, headers: {}, status: files[url] ? 200 : 404, body: files[url] ?? "" });

  it("skips a sitemap on another domain, reports it, and falls back to /sitemap.xml", async () => {
    const { audit, urls } = await auditSitemap("https://shop.example", fake);
    assert.deepEqual(urls, ["https://shop.example/products/a", "https://www.shop.example/products/b"]);
    assert.ok(audit.errors.some((error) => error.includes("agency-staging.example")));
  });
});

describe("runTechnicalSeoAudit", () => {
  it("flags robots.txt pointing at a sitemap on another domain", () => {
    const findings = runTechnicalSeoAudit({
      siteId: "s", analysisId: "a", baseUrl: "https://edeadesign.com.my",
      sitemap: { totalUrls: 0, sampledUrls: 0, indexFiles: [], urlTypes: {}, languages: {}, errors: [] },
      pages: [],
      robotsTxt: "User-agent: *\nSitemap: http://corex.okie.my/sitemap.xml",
    });
    const finding = findings.find((entry) => entry.title.includes("sitemap on another domain"));
    assert.ok(finding);
    assert.ok(finding.recommendation?.includes("https://edeadesign.com.my/sitemap.xml"));
  });
});

describe("defaultFetcher redirects", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("follows http→https and apex→www redirects on the same site", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://example.com/page") return new Response(null, { status: 301, headers: { location: "https://www.example.com/page" } });
      return new Response("<html><title>ok</title></html>", { status: 200 });
    }) as typeof fetch;
    const result = await defaultFetcher("http://example.com/page");
    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, "https://www.example.com/page");
  });

  it("refuses redirects to another site", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) as typeof fetch;
    await assert.rejects(defaultFetcher("https://example.com/"), /outside the connected website/);
  });
});

describe("parseHtmlSignals", () => {
  it("does not count scripts, JSON-LD, or framework payloads as page text", () => {
    const payload = "x".repeat(5000);
    const html = `<!doctype html><html><head><title>Procedure</title><script type="application/ld+json">{"@type":"WebPage","name":"${payload}"}</script></head>
      <body><div id="__next"></div><noscript>You need to enable JavaScript to run this app.</noscript><script>self.__next_f.push([1,"${payload}"])</script><style>.a{color:red}</style></body></html>`;
    const signals = parseHtmlSignals(html);
    assert.ok(signals.textLength < 20, `text length was ${signals.textLength}`);
    assert.equal(isEmptyShell(html, signals), true);
  });

  it("reads head tags whatever the attribute order or quoting", () => {
    const html = `<html><head>
      <meta content='Cardiologists in Kuala Lumpur' name=description>
      <link href="https://x.com/doctors/amy" rel="canonical">
      <meta content="noindex, follow" name="robots">
      <link href="https://x.com/id/doctors/amy" hreflang="id" rel="alternate">
      <link rel="alternate" hreflang="en" href="https://x.com/doctors/amy">
      </head><body><svg><title>icon</title></svg><h1>Dr Amy</h1><h1>Again</h1>
      <a href="https://www.x.com/hospitals">Hospitals</a><a href="/contact">Contact</a><a href="//cdn.x.com/a">CDN</a><a href="https://other.com/">Other</a><a href="#top">Top</a>
      </body></html>`;
    const signals = parseHtmlSignals(html, "https://x.com/doctors/amy");
    assert.equal(signals.description, "Cardiologists in Kuala Lumpur");
    assert.equal(signals.canonical, "https://x.com/doctors/amy");
    assert.equal(signals.robots, "noindex, follow");
    assert.equal(signals.metaNoindex, true);
    assert.deepEqual(signals.hreflang.map((entry) => entry.lang), ["id", "en"]);
    assert.equal(signals.h1Count, 2);
    assert.equal(signals.internalLinkCount, 2);
    assert.deepEqual(signals.internalLinks, ["/hospitals", "/contact"], "same-site paths only; www counts as the same site");
  });

  it("stores each link once, by path, whatever its query, fragment, or trailing slash", () => {
    const html = `<a href="/blog/">Blog</a><a href="/blog?page=2">More</a><a href="/blog#top">Top</a><a href="https://x.com/">Home</a><a href="caf%C3%A9">Café</a>`;
    assert.deepEqual(parseHtmlSignals(html, "https://x.com/guides/a").internalLinks, ["/blog", "", "/guides/café"]);
  });

  it("collects JSON-LD types, flattening @graph, and counts malformed blocks", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Physician"},{"@type":["MedicalOrganization","Hospital"]}]}</script>
      <script type='application/ld+json'>{ broken </script>`;
    const signals = parseHtmlSignals(html);
    assert.equal(signals.jsonLdCount, 2);
    assert.deepEqual(signals.jsonLdTypes, ["Physician", "MedicalOrganization", "Hospital"]);
    assert.equal(signals.invalidJsonLd, 1);
  });
});

describe("meta refresh redirects", () => {
  it("are redirects, not empty shells", () => {
    const html = `<!DOCTYPE html><link rel="me" href="https://m.example/@x"><meta http-equiv="refresh" content="0;URL='https://github.com/withastro/astro'">`;
    const signals = parseHtmlSignals(html);
    assert.equal(signals.metaRefresh, "https://github.com/withastro/astro");
    assert.equal(isEmptyShell(html, signals), false);
    assert.equal(parseHtmlSignals(`<meta http-equiv="refresh" content="300">`).metaRefresh, undefined, "a periodic reload is not a redirect");
  });
});

describe("headerNoindex", () => {
  it("applies unscoped and googlebot-scoped directives only", () => {
    assert.equal(headerNoindex("noindex, nofollow"), true);
    assert.equal(headerNoindex("max-snippet: 50, none"), true);
    assert.equal(headerNoindex("googlebot: noindex"), true);
    assert.equal(headerNoindex("otherbot: noindex, nofollow"), false);
    assert.equal(headerNoindex("nosnippet"), false);
    assert.equal(headerNoindex(undefined), false);
  });
});

describe("fetchGooglebotPage", () => {
  it("records noindex headers, canonical mismatches, and the route family", async () => {
    const fake: Fetcher = async (url) => ({
      url,
      finalUrl: "https://x.com/en/doctors/amy/",
      status: 200,
      headers: { "x-robots-tag": "noindex" },
      body: `<html><head><title>Dr Amy Tan, cardiologist</title><link rel="canonical" href="https://x.com/en/doctors/amy"></head><body><h1>Dr Amy</h1><p>${"Cardiology. ".repeat(60)}</p></body></html>`,
    });
    const page = await fetchGooglebotPage("https://x.com/en/doctors/amy", fake);
    assert.equal(page.noindex, true);
    assert.equal(page.canonicalMismatch, true);
    assert.equal(page.routeFamily, "doctors");
    assert.equal(page.h1Count, 1);
    assert.equal(page.isEmptyShell, false);
  });
});

describe("robots.txt rules in the technical audit", () => {
  const audit = (robotsTxt: string) => runTechnicalSeoAudit({
    siteId: "s", analysisId: "a", baseUrl: "https://x.com",
    sitemap: { totalUrls: 10, sampledUrls: 0, indexFiles: [], urlTypes: {}, languages: {}, errors: [] },
    pages: [],
    robotsTxt,
  });

  it("does not treat a block on AI crawlers as blocking the site", () => {
    const findings = audit("User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /");
    assert.equal(findings.some((finding) => finding.severity === "CRITICAL"), false);
    const ai = findings.find((finding) => finding.category === "ai_visibility");
    assert.equal(ai?.severity, "INFORMATIONAL");
    assert.equal(ai?.title, "robots.txt blocks AI training crawlers", "search and live fetchers can still read the site");
    assert.deepEqual(ai?.evidence.blocked, ["GPTBot", "ClaudeBot"]);
  });

  it("matches AI tokens exactly, so a group for one crawler doesn't decide for a longer name", () => {
    const findings = audit("User-agent: *\nAllow: /\n\nUser-agent: Applebot\nDisallow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /");
    const ai = findings.find((finding) => finding.category === "ai_visibility");
    assert.deepEqual(ai?.evidence.blocked, ["Claude-SearchBot"], "Applebot's group says nothing about Applebot-Extended, and ClaudeBot stays allowed");
    assert.equal(ai?.title, "robots.txt blocks AI assistants from reading the site");
  });

  it("tells search-facing blocks from training-only ones by each agent's role, not its name", () => {
    const training = audit("User-agent: *\nAllow: /\n\nUser-agent: Google-Extended\nDisallow: /").find((finding) => finding.category === "ai_visibility");
    assert.equal(training?.title, "robots.txt blocks AI training crawlers", "Google-Extended is a training opt-out; Google's AI answers still fetch as Googlebot");
    const search = audit("User-agent: *\nAllow: /\n\nUser-agent: PerplexityBot\nDisallow: /").find((finding) => finding.category === "ai_visibility");
    assert.equal(search?.title, "robots.txt blocks AI assistants from reading the site", "PerplexityBot feeds Perplexity's answers");
  });

  it("flags a sitewide block that applies to Googlebot", () => {
    assert.ok(audit("User-agent: *\nDisallow: /").some((finding) => finding.title === "robots.txt blocks Googlebot from the entire site"));
  });

  it("respects a Googlebot group that overrides a wildcard block", () => {
    const findings = audit("User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /");
    assert.equal(findings.some((finding) => finding.title.includes("blocks Googlebot")), false);
  });
});

describe("firewalls and bot challenges", () => {
  const content = `<html><head><title>Treatment prices in Penang</title></head><body><h1>Treatments</h1><p>${"Price list. ".repeat(60)}</p></body></html>`;

  it("re-fetches as a browser when a Googlebot request is refused, and records the refusal", async () => {
    const fake: Fetcher = async (url, init) => (init?.userAgent?.includes("Googlebot")
      ? { url, finalUrl: url, status: 403, headers: {}, body: "Forbidden" }
      : { url, finalUrl: url, status: 200, headers: {}, body: content });
    const page = await fetchGooglebotPage("https://x.com/treatments/a", fake);
    assert.equal(page.status, 200);
    assert.equal(page.googlebotBlockedStatus, 403);
    assert.equal(page.fetchMode, "raw");
    assert.equal(page.isEmptyShell, false);
  });

  it("marks challenge pages instead of reporting them as empty shells", async () => {
    const challenge = "<html><head><title>Just a moment...</title></head><body><script src=\"/cdn-cgi/challenge-platform/x.js\"></script></body></html>";
    const fake: Fetcher = async (url) => ({ url, finalUrl: url, status: 403, headers: {}, body: challenge });
    const page = await fetchGooglebotPage("https://x.com/a", fake);
    assert.equal(page.botChallenge, true);
    assert.equal(page.isEmptyShell, false);
    assert.equal(isBotChallenge({ status: 200, headers: {}, body: challenge }), false, "only refused responses count");
    assert.equal(isBotChallenge({ status: 403, headers: { "cf-mitigated": "challenge" }, body: "" }), true);
  });
});

describe("findingsFromCrawlCoverage", () => {
  const base: CrawlCoverage = {
    totalUrls: 1000, completedUrls: 990, failedUrls: 0, pendingUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0, missingTitleUrls: 0,
    issues: {}, issueExamples: {}, families: [],
  };
  const findings = (coverage: Partial<CrawlCoverage>) => findingsFromCrawlCoverage({ siteId: "s", analysisId: "a", coverage: { ...base, ...coverage } });

  it("names the templates where empty shells are concentrated", () => {
    const [finding] = findings({
      emptyShellUrls: 45,
      families: [
        { family: "doctors", urls: 900, crawled: 900, emptyShells: 0, errors: 0, noindex: 0, missingStructuredData: 0 },
        { family: "procedures", urls: 50, crawled: 50, emptyShells: 45, errors: 0, noindex: 0, missingStructuredData: 0 },
      ],
    });
    assert.ok(finding?.summary.includes("/procedures/ (45 of 50)"), finding?.summary);
    assert.equal(finding?.summary.includes("doctors"), false);
  });

  it("treats a noindex homepage as critical", () => {
    const result = findings({
      issues: { noindex: 1 },
      issueExamples: { noindex: [{ url: "https://x.com/", detail: "noindex" }] },
      families: [{ family: "home", urls: 1, crawled: 1, emptyShells: 0, errors: 0, noindex: 1, missingStructuredData: 0 }],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.title, "The homepage is marked noindex");
    assert.equal(result[0]?.severity, "CRITICAL");
  });

  it("recognizes a layout-level canonical that points every page at the homepage", () => {
    const urls = ["https://x.com/doctors/a", "https://x.com/doctors/b", "https://x.com/procedures/c"];
    const [finding] = findings({
      issues: { canonicalMismatch: 600 },
      issueExamples: { canonicalMismatch: urls.map((url) => ({ url, detail: "https://x.com/" })) },
    });
    assert.equal(finding?.title, "Pages declare the homepage as their canonical URL");
    assert.ok(["CRITICAL", "HIGH"].includes(finding?.severity ?? ""), finding?.severity);
  });

  it("keeps cosmetic issues below indexing problems", () => {
    const result = findings({ issues: { multipleH1: 900, missingDescription: 900, robotsBlocked: 200 } });
    const severity = (title: string) => result.find((finding) => finding.title.includes(title))?.organicImpactScore ?? 0;
    assert.ok(severity("robots.txt blocks") > severity("more than one H1"));
    assert.ok(severity("robots.txt blocks") > severity("meta descriptions"));
    assert.ok(severity("more than one H1") <= 20);
  });
});

describe("malformed HTML stays linear", () => {
  it("parses thousands of unclosed elements quickly", () => {
    const started = performance.now();
    parseHtmlSignals(`<html><body>${"<script>x <h1>y <title>z <!-- c ".repeat(15_000)}</body></html>`, "https://x.com/");
    assert.ok(performance.now() - started < 1500, `took ${Math.round(performance.now() - started)} ms`);
  });
});

describe("auditSitemap sections", () => {
  it("counts a translated page once and keeps every URL in the URL count", async () => {
    const paths = [
      ...["a", "b"].flatMap((slug) => [`/blog/${slug}`, `/id/blog/${slug}`, `/zh/blog/${slug}`]),
      "/doctors/d1", "/doctors/d2", "/doctors/d3", "/id/doctors/d1",
    ];
    const sitemap = `<urlset>${paths.map((path) => `<url><loc>https://clinic.example${path}</loc></url>`).join("")}</urlset>`;
    const fake: Fetcher = async (url) => ({ url, finalUrl: url, headers: {}, status: url.endsWith("/sitemap.xml") ? 200 : 404, body: url.endsWith("/sitemap.xml") ? sitemap : "" });
    const { audit } = await auditSitemap("https://clinic.example", fake);
    assert.equal(audit.urlTypes.blog, 6);
    assert.deepEqual(audit.sections?.blog, { pages: 2, languages: 3 });
    assert.deepEqual(audit.sections?.doctors, { pages: 3, languages: 2 }, "a partly translated section counts its largest edition");
  });
});

describe("sitemapEntries", () => {
  it("reads each URL with its lastmod, and keeps entries without one", () => {
    const xml = `<urlset><url><loc>https://a.example/x</loc><lastmod>2026-10-01</lastmod></url>
      <url><loc><![CDATA[https://a.example/y]]></loc></url></urlset>`;
    assert.deepEqual(sitemapEntries(xml), [{ loc: "https://a.example/x", lastmod: "2026-10-01" }, { loc: "https://a.example/y" }]);
  });

  it("stays linear on a sitemap whose url elements never close", () => {
    const xml = `<urlset>${"<url><loc>https://a.example/z</loc>".repeat(50_000)}`;
    const started = performance.now();
    assert.deepEqual(sitemapEntries(xml), []);
    assert.ok(performance.now() - started < 500, "a malformed file must not rescan for every opener");
  });

  it("hands lastmod to the sitemap audit", async () => {
    const files: Record<string, string> = {
      "https://a.example/sitemap.xml": `<urlset><url><loc>https://a.example/doctors/x</loc><lastmod>2026-09-30</lastmod></url></urlset>`,
    };
    const fake: Fetcher = async (url) => ({ url, finalUrl: url, headers: {}, status: files[url] ? 200 : 404, body: files[url] ?? "" });
    const { lastmod } = await auditSitemap("https://a.example", fake);
    assert.equal(lastmod.get("https://a.example/doctors/x"), "2026-09-30");
  });
});

describe("AI readiness", () => {
  const ok = (body: string, headers: Record<string, string> = {}) => ({ status: 200, body, headers });

  it("reads robots.txt per AI token, finds llms.txt, and counts FAQ markup", () => {
    const readiness = aiReadiness({
      robots: ok("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /"),
      llms: ok("# Example\n> A dental clinic\n"),
      pages: [{ jsonLdTypes: ["FAQPage", "Organization"] }, { jsonLdTypes: ["Article"] }, {}],
    });
    assert.equal(readiness.robots, "read");
    assert.equal(readiness.crawlers.find((crawler) => crawler.agent === "GPTBot")?.allowed, false);
    assert.equal(readiness.crawlers.find((crawler) => crawler.agent === "OAI-SearchBot")?.allowed, true);
    assert.equal(readiness.crawlers.find((crawler) => crawler.agent === "Google-Extended")?.kind, "control");
    assert.equal(readiness.llmsTxt, true);
    assert.deepEqual(readiness.faqPages, { pages: 1, of: 3 });
  });

  it("treats an error page as unreadable and a 404 as no robots.txt, and never mistakes HTML for llms.txt", () => {
    assert.equal(robotsState(ok("<!doctype html><html>Just a moment…</html>")).robots, "unreadable");
    assert.equal(robotsState({ status: 503, body: "" }).robots, "unreadable");
    assert.equal(robotsState({ status: 404, body: "Not found" }).robots, "missing");
    assert.equal(aiReadiness({ robots: null, llms: ok("<html><body>Home</body></html>", { "content-type": "text/html" }), pages: [] }).llmsTxt, false);
  });
});

describe("robotsState", () => {
  it("reads a 404 as no robots.txt, but a 403 challenge page as unreadable, never as 'everything allowed'", () => {
    const challenge = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl</body></html>";
    assert.equal(robotsState({ status: 404, body: "<html><body>Not found</body></html>", headers: { "content-type": "text/html" } }).robots, "missing");
    assert.equal(robotsState({ status: 403, body: challenge, headers: { "content-type": "text/html" } }).robots, "unreadable");
    assert.equal(robotsState({ status: 429, body: challenge }).robots, "unreadable");
  });

  it("trusts a body that is robots.txt even when the server labels it text/html", () => {
    const state = robotsState({ status: 200, body: "User-agent: *\nDisallow: /\n", headers: { "content-type": "text/html; charset=utf-8" } });
    assert.equal(state.robots, "read");
    assert.equal(state.body, "User-agent: *\nDisallow: /\n");
    assert.equal(robotsState({ status: 200, body: "<!doctype html><html><body>Soft 404</body></html>", headers: { "content-type": "text/plain" } }).robots, "unreadable");
  });
});

describe("soft 404s, hashes and locales on a crawled page", () => {
  const longText = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about implants, braces and whitening for patients in the city.`).join(" ");
  const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  const serve = (pages: Record<string, { status?: number; html: string }>): Fetcher => async (url) => {
    const page = pages[url] ?? { status: 404, html: html("Not found", "Nothing here.") };
    return { url, status: page.status ?? 200, finalUrl: url, headers: {}, body: page.html };
  };

  it("marks a 200 page that says it is missing as a soft 404, and leaves real pages and long pages alone", async () => {
    const fetcher = serve({
      "https://x.com/treatments/old": { html: html("Page not found", "Sorry, this treatment is no longer offered.") },
      "https://x.com/id/treatments/lama": { html: html("Halaman tidak ditemukan", "Maaf.") },
      "https://x.com/blog/404-errors": { html: html("What a 404 error means", longText) },
      "https://x.com/doctors/dr-lee": { html: html("Dr Lee", longText) },
    });
    const soft = await fetchGooglebotPage("https://x.com/treatments/old", fetcher);
    assert.equal(soft.softNotFound, true);
    assert.equal(soft.locale, "default");
    assert.equal((await fetchGooglebotPage("https://x.com/id/treatments/lama", fetcher)).softNotFound, true, "in Indonesian too");
    assert.equal((await fetchGooglebotPage("https://x.com/id/treatments/lama", fetcher)).locale, "id");
    const post = await fetchGooglebotPage("https://x.com/blog/404-errors", fetcher);
    assert.equal(post.softNotFound, undefined, "a long page about 404s is a page");
    const doctor = await fetchGooglebotPage("https://x.com/doctors/dr-lee", fetcher);
    assert.equal(doctor.softNotFound, undefined);
    assert.match(doctor.textHash ?? "", /^[0-9a-f]{16}$/, "enough text for a hash");
    assert.equal(soft.textHash, undefined, "too little text for a hash");
    assert.equal((await fetchGooglebotPage("https://x.com/gone", fetcher)).softNotFound, undefined, "a real 404 is not soft");
  });

  it("fingerprints the main content, so the same name over a mega-menu is not the same page, and the same bio at two hospitals is", async () => {
    const chrome = `<nav>${Array.from({ length: 120 }, (_, i) => `<a href="/s/${i}">Service ${i} for patients in Kuala Lumpur and Penang</a>`).join(" ")}</nav><header><h2>Demo Hospital Group</h2><p>${longText}</p></header>`;
    const footer = `<footer>${Array.from({ length: 60 }, (_, i) => `<a href="/c/${i}">Clinic ${i}</a> Open daily 8am to 8pm, call 03-1234 ${i}`).join(" ")}</footer>`;
    const bio = (hospital: string) => `Dr Lim Ai Wei is a consultant obstetrician and gynaecologist at ${hospital} with eighteen years of experience in high-risk pregnancy, minimally invasive surgery, fertility assessment and menopause care. She trained at the University of Malaya and in Singapore, sees patients for antenatal care, screening, contraception and the management of fibroids and endometriosis, speaks English, Malay and Mandarin, and consults on weekdays with Saturday sessions for returning patients. Appointments run through the patient line or WhatsApp; most insurers are accepted. Her clinical interests include recurrent miscarriage, polycystic ovary syndrome, adolescent gynaecology and the long-term follow-up of women after cancer treatment. She teaches undergraduate students, examines for the national college, has published on caesarean recovery and laparoscopic technique, and chairs the hospital's maternal safety committee. Outside the clinic she runs free antenatal classes twice a month and answers questions on the hospital's health talk series.`;
    const derm = "Dr Lim Ai Wei is a dermatologist treating acne, eczema, psoriasis and skin cancer screening. She trained in dermatology in Glasgow and offers laser treatments, mole checks and paediatric skin care, with clinics Monday to Friday and same-day appointments for urgent rashes. Patients value her clear explanations, careful follow-up and practical advice on sun protection and skincare routines for Malaysian weather.";
    const page = (body: string) => `<!doctype html><html><head><title>Dr Lim Ai Wei</title></head><body>${chrome}<main><h1>Dr Lim Ai Wei</h1><p>${body}</p></main>${footer}</body></html>`;
    const fetcher = serve({ "https://x.com/doctors/a": { html: page(bio("Pantai Hospital")) }, "https://x.com/doctors/b": { html: page(bio("Gleneagles Hospital Penang")) }, "https://x.com/doctors/c": { html: page(derm) } });
    const [a, b, other] = await Promise.all(["a", "b", "c"].map((slug) => fetchGooglebotPage(`https://x.com/doctors/${slug}`, fetcher)));
    assert.ok(nearDuplicate(a!.textHash!, b!.textHash!), `same bio, two hospitals: ${hamming(a!.textHash!, b!.textHash!)} bits`);
    assert.equal(nearDuplicate(a!.textHash!, other!.textHash!), false, `a different person: ${hamming(a!.textHash!, other!.textHash!)} bits`);
    const soft = await fetchGooglebotPage("https://x.com/gone-but-200", serve({ "https://x.com/gone-but-200": { html: `<!doctype html><html><head><title>Page not found</title></head><body>${chrome}<main><h1>Page not found</h1><p>Sorry.</p></main>${footer}</body></html>` } }));
    assert.equal(soft.softNotFound, true, "a not-found page under a big menu is still a not-found page");
  });

  it("reads 404 in a title only beside error, page or not found", async () => {
    const fetcher = serve({
      "https://x.com/blog/veneers-guide-404": { html: html("Veneers Guide 404", "Our 404th guide: veneers.") },
      "https://x.com/old": { html: html("404 - Page not found", "Sorry.") },
      "https://x.com/older": { html: html("Error 404", "Sorry.") },
    });
    assert.equal((await fetchGooglebotPage("https://x.com/blog/veneers-guide-404", fetcher)).softNotFound, undefined);
    assert.equal((await fetchGooglebotPage("https://x.com/old", fetcher)).softNotFound, true);
    assert.equal((await fetchGooglebotPage("https://x.com/older", fetcher)).softNotFound, true);
  });

  it("probes a URL that cannot exist and reports what the site answered", async () => {
    const ok = await probeNotFound("https://x.com", "run_1", serve({}));
    assert.deepEqual([ok.status, ok.title, ok.url.startsWith("https://x.com/eumon-404-probe-")], [404, "Not found", true]);
    const soft = await probeNotFound("https://x.com", "run_1", async (url) => ({ url, status: 200, finalUrl: url, headers: {}, body: html("Oops", "Something went wrong.") }));
    assert.deepEqual([soft.status, soft.title], [200, "Oops"]);
    const home = await probeNotFound("https://x.com", "run_1", async (url) => ({ url, status: 200, finalUrl: "https://x.com/", headers: {}, body: html("Demo Clinic", "Welcome.") }));
    assert.deepEqual([home.status, home.finalUrl, home.title], [200, "https://x.com/", "Demo Clinic"], "a redirect to the homepage is recorded as such");
  });
});

describe("coverage findings for soft 404s, near-duplicates and languages", () => {
  const base = { totalUrls: 14000, completedUrls: 14000, failedUrls: 0, pendingUrls: 0, emptyShellUrls: 0, httpErrorUrls: 0, missingTitleUrls: 0 };
  it("names soft 404s and the same page twice, with suffixed slugs called out", () => {
    const findings = findingsFromCrawlCoverage({ siteId: "s", analysisId: "a", coverage: {
      ...base,
      issues: { softNotFound: 4, nearDuplicate: 40, duplicateTitle: 40 },
      issueExamples: { softNotFound: [{ url: "https://x.com/treatments/old", detail: "Page not found" }] },
      nearDuplicateGroups: [
        { title: "Dr Lim Ai Wei", urls: ["https://x.com/doctors/dr-lim-ai-wei", "https://x.com/doctors/dr-lim-ai-wei-7f3a2b"], suffixed: true },
        { title: "Dr Chen San San", urls: ["https://x.com/doctors/dr-chen-san-san", "https://x.com/doctors/dr-chen-san-san-sunway"], suffixed: false },
      ],
      notFoundTitle: "Oops",
    } });
    const soft = findings.find((finding) => finding.title === "Pages that say not found but answer 200")!;
    assert.equal(soft.category, "indexing");
    assert.match(soft.summary, /4 pages/);
    assert.match(soft.summary, /Oops/);
    assert.deepEqual(soft.pagesAffected, ["https://x.com/treatments/old"]);
    const twice = findings.find((finding) => finding.title === "Pages that are the same page twice")!;
    assert.equal(twice.category, "content");
    assert.match(twice.summary, /40 pages/);
    assert.match(twice.summary, /1 pair differs only by a code at the end of the address/);
    assert.ok(twice.pagesAffected!.includes("https://x.com/doctors/dr-lim-ai-wei-7f3a2b"));
  });

  it("ends a finding's summary with the split by language when the crawl has more than one, and not otherwise", () => {
    const locales = [
      { locale: "default", urls: 7000, crawled: 7000, emptyShells: 0, errors: 0, noindex: 26, redirected: 0, missingDescription: 0, missingStructuredData: 0, softNotFound: 0 },
      { locale: "id", urls: 7000, crawled: 7000, emptyShells: 0, errors: 0, noindex: 9, redirected: 0, missingDescription: 0, missingStructuredData: 0, softNotFound: 0 },
    ];
    const split = findingsFromCrawlCoverage({ siteId: "s", analysisId: "a", coverage: { ...base, issues: { noindex: 35 }, locales } });
    const noindex = split.find((finding) => finding.title === "Sitemap lists pages that are marked noindex")!;
    assert.match(noindex.summary, /By language: 26 without a prefix, 9 under \/id\/\.$/);
    assert.deepEqual(noindex.evidence.byLocale, { default: 26, id: 9 });
    const single = findingsFromCrawlCoverage({ siteId: "s", analysisId: "a", coverage: { ...base, issues: { noindex: 35 } } });
    assert.doesNotMatch(single.find((finding) => finding.title === "Sitemap lists pages that are marked noindex")!.summary, /By language/);
  });
});

describe("isSafePublicUrl", () => {
  it("refuses local names written with a trailing dot, and still accepts public ones", () => {
    for (const url of ["http://localhost./", "http://foo.localhost./", "http://metadata.google.internal./", "http://printer.local./", "http://localhost../"]) {
      assert.equal(isSafePublicUrl(url), false, url);
    }
    assert.equal(isSafePublicUrl("https://example.com./"), true);
    assert.equal(isSafePublicUrl("http://127.0.0.1./"), false);
  });
});

describe("redirect hops and HSTS", () => {
  it("records how many redirects the fetch followed and whether HSTS is sent", async () => {
    const fake: Fetcher = async (url) => ({ url, finalUrl: "https://x.com/c", hops: 2, status: 200, headers: { "strict-transport-security": "max-age=1" }, body: "<html><head><title>T</title></head><body><main>x</main></body></html>" });
    const page = await fetchGooglebotPage("https://x.com/a", fake);
    assert.equal(page.redirectHops, 2);
    assert.equal(page.hsts, true);
    assert.equal(page.viewport, false, "always written, so absence means not checked");
  });
});
