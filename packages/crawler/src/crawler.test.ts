import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { auditSitemap, defaultFetcher, fetchGooglebotPage, headerNoindex, isEmptyShell, parseHtmlSignals, runTechnicalSeoAudit, type Fetcher } from "./index.js";
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
    const ai = findings.find((finding) => finding.title.includes("AI search crawlers"));
    assert.equal(ai?.severity, "INFORMATIONAL");
    assert.deepEqual(ai?.evidence.blocked, ["GPTBot", "ClaudeBot"]);
  });

  it("flags a sitewide block that applies to Googlebot", () => {
    assert.ok(audit("User-agent: *\nDisallow: /").some((finding) => finding.title === "robots.txt blocks Googlebot from the entire site"));
  });

  it("respects a Googlebot group that overrides a wildcard block", () => {
    const findings = audit("User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /");
    assert.equal(findings.some((finding) => finding.title.includes("blocks Googlebot")), false);
  });
});
