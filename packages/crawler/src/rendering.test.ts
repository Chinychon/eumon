import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fetcher } from "./index.js";
import { fetchGooglebotPage } from "./index.js";
import { compareRendering, findingsFromRendering, samplePerFamily, testRepeatability } from "./rendering.js";

const shell = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><div id="root"></div><script src="/assets/index.js"></script></body></html>`;
const full = (title: string, extra = "") => `<html><head><title>${title}</title><meta name="description" content="Prices, doctors, and recovery time for this treatment in Penang."></head>
  <body><div id="root"><h1>${title}</h1><p>${"Recovery takes two weeks and costs are listed below. ".repeat(30)}</p>${extra}</div></body></html>`;
const fakeFetcher = (pages: Record<string, string>): Fetcher => async (url) => ({ url, finalUrl: url, status: 200, headers: {}, body: pages[url] ?? "" });

describe("compareRendering", () => {
  it("classifies client-rendered, server-rendered, and still-empty pages", async () => {
    const url = "https://x.com/treatments/ivf";
    const raw = await fetchGooglebotPage(url, fakeFetcher({ [url]: shell("Clinic") }));
    assert.equal(compareRendering(url, raw, full("IVF in Penang")).verdict, "client_rendered");
    assert.equal(compareRendering(url, raw, shell("Clinic")).verdict, "empty_after_render");
    const served = await fetchGooglebotPage(url, fakeFetcher({ [url]: full("IVF in Penang") }));
    assert.equal(compareRendering(url, served, full("IVF in Penang")).verdict, "server_rendered");
    assert.equal(compareRendering(url, served, full("IVF in Penang", `<section>${"<p>Reviews and FAQs loaded later. </p>".repeat(80)}</section>`)).verdict, "partially_client_rendered");
  });
});

describe("findingsFromRendering", () => {
  it("diagnoses a single-page app that renders content and titles in the browser", async () => {
    const urls = ["https://x.com/treatments/ivf", "https://x.com/doctors/amy"];
    const fetcher = fakeFetcher(Object.fromEntries(urls.map((url) => [url, shell("Vite + React")])));
    const comparisons = await Promise.all(urls.map(async (url, index) =>
      compareRendering(url, await fetchGooglebotPage(url, fetcher), full(index ? "Dr Amy Tan" : "IVF in Penang"))));
    const findings = findingsFromRendering({ siteId: "s", analysisId: "a", familySizes: { treatments: 300, doctors: 7000 }, comparisons });
    const content = findings.find((finding) => finding.title === "Page content only appears after JavaScript runs");
    assert.ok(content, findings.map((finding) => finding.title).join("; "));
    assert.ok(["CRITICAL", "HIGH"].includes(content.severity));
    assert.ok(content.summary.includes("/treatments/ pages") && content.summary.includes("/doctors/ pages"));
    const metadata = findings.find((finding) => finding.title === "Titles and meta tags are set by JavaScript");
    assert.ok(metadata?.summary.includes("“Vite + React”"), metadata?.summary);
  });

  it("flags crawler-specific breakage and dynamic rendering differently", async () => {
    const url = "https://x.com/a";
    const browser = await fetchGooglebotPage(url, fakeFetcher({ [url]: full("Page A") }));
    const empty = await fetchGooglebotPage(url, fakeFetcher({ [url]: shell("Page A") }));
    const worse = findingsFromRendering({ siteId: "s", analysisId: "a", familySizes: {}, userAgentPairs: [{ url, browser, googlebot: empty }] });
    assert.equal(worse[0]?.title, "Googlebot receives less content than browsers");
    const dynamic = findingsFromRendering({ siteId: "s", analysisId: "a", familySizes: {}, userAgentPairs: [{ url, browser: empty, googlebot: browser }] });
    assert.equal(dynamic[0]?.title, "Crawlers get pre-rendered HTML that browsers don't");
    assert.equal(dynamic[0]?.severity, "LOW");
  });

  it("reports intermittent shells on one template and ties them to cache misses", async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      const flaky = url.includes("/procedures/") && calls++ % 3 === 0;
      return { url, finalUrl: url, status: 200, headers: { "x-vercel-cache": flaky ? "MISS" : "HIT" }, body: flaky ? shell("Procedure") : full("Procedure") };
    };
    const results = await testRepeatability(["https://x.com/procedures/a", "https://x.com/procedures/b", "https://x.com/doctors/a"], fetcher, 3, 1);
    assert.equal(results.every((result) => result.attempts.length === 3), true);
    const findings = findingsFromRendering({ siteId: "s", analysisId: "a", familySizes: { procedures: 400, doctors: 7000 }, repeatability: results });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.title, "Intermittent empty or failed responses on /procedures/ pages");
    assert.ok(findings[0]?.summary.includes("cache misses"), findings[0]?.summary);
  });
});

describe("samplePerFamily", () => {
  it("covers every template before taking seconds from any", () => {
    const urls = ["/doctors/a", "/doctors/b", "/doctors/c", "/hospitals/a", "/blog/x", "/blog/y"].map((path) => `https://x.com${path}`);
    assert.deepEqual(samplePerFamily(urls, 2, 4).map((url) => new URL(url).pathname), ["/doctors/a", "/blog/x", "/hospitals/a", "/doctors/b"]);
  });
});
