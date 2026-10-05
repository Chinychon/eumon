import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { auditSitemap, defaultFetcher, runTechnicalSeoAudit, type Fetcher } from "./index.js";
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
