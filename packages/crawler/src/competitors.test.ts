import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fetcher } from "./index.js";
import { inspectPage, profileSitemaps, researchSite, RESEARCH_USER_AGENT } from "./competitors.js";

const urlset = (paths: string[]) => `<?xml version="1.0"?><urlset>${paths.map((path) => `<url><loc>https://rival.example${path}</loc></url>`).join("")}</urlset>`;
const range = (prefix: string, from: number, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${from + index}`);

describe("profileSitemaps", () => {
  // An index with 10 treatment files (100 URLs each) and 2 doctor files (50 each).
  const files: Record<string, string> = {
    "https://rival.example/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://rival.example/sitemap_index.xml",
    "https://rival.example/sitemap_index.xml": `<sitemapindex>${[
      ...range("https://rival.example/treatments-", 1, 10).map((url) => `${url}.xml`),
      "https://rival.example/doctors-1.xml", "https://rival.example/doctors-2.xml",
    ].map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("")}</sitemapindex>`,
    ...Object.fromEntries(range("", 1, 10).map((n) => [`https://rival.example/treatments-${n}.xml`, urlset(range(`/treatments/t${n}-`, 1, 100))])),
    "https://rival.example/doctors-1.xml": urlset(range("/doctors/d", 1, 50)),
    "https://rival.example/doctors-2.xml": urlset(range("/doctors/d", 51, 50)),
  };
  const agents: string[] = [];
  const fake: Fetcher = async (url, init) => {
    agents.push(init?.userAgent ?? "");
    return { url, finalUrl: url, headers: {}, status: files[url] ? 200 : 404, body: files[url] ?? "" };
  };

  it("samples every kind of sitemap within the budget and extrapolates the rest", async () => {
    const profile = await profileSitemaps("https://rival.example", fake, { maxFiles: 4, robots: { isAllowed: () => true, sitemaps: ["https://rival.example/sitemap_index.xml"] } });
    const family = (name: string) => profile.families.find((entry) => entry.family === name);
    assert.equal(profile.filesRead, 4, "the index and three leaf files");
    assert.ok(family("doctors"), "doctor files are read even though treatment files come first");
    assert.equal(family("treatments")?.estimated, 1000);
    assert.equal(family("doctors")?.estimated, 100);
    assert.equal(profile.partial, true);
  });

  it("researches a competitor as EumonBot and respects robots.txt", async () => {
    agents.length = 0;
    const research = await researchSite("rival.example", fake, { maxFiles: 3, samplePages: 1 });
    assert.equal(research.allowed, true);
    assert.ok(agents.every((agent) => agent === RESEARCH_USER_AGENT), "never impersonates a search engine");
    const blocked: Fetcher = async (url) => ({ url, finalUrl: url, headers: {}, status: 200, body: "User-agent: EumonBot\nDisallow: /" });
    const refused = await researchSite("rival.example", blocked);
    assert.equal(refused.allowed, false);
    assert.equal(refused.pages.length, 0);
  });
});

describe("inspectPage", () => {
  it("reads conversion paths, prices, FAQs, and structured data from visible content", () => {
    const html = `<html><head><title>IVF in Penang</title><script type="application/ld+json">{"@type":"MedicalProcedure"}</script>
      <script>var price = "$1"; function book now(){}</script></head><body><h1>IVF in Penang</h1>
      <p>Packages from RM 12,500. Book a consultation today.</p><h2>Frequently asked questions</h2>
      <a href="https://wa.me/60123456789">WhatsApp us</a><a href="tel:+60123456789">Call</a><form action="/enquire"></form></body></html>`;
    const page = inspectPage("https://rival.example/treatments/ivf", { status: 200, body: html });
    assert.deepEqual(page.conversion, { whatsapp: true, phone: true, email: false, form: true, booking: true, prices: true });
    assert.equal(page.faq, true);
    assert.deepEqual(page.schemaTypes, ["MedicalProcedure"]);
    const scriptOnly = inspectPage("https://rival.example/a", { status: 200, body: `<html><body><p>${"Plain text. ".repeat(40)}</p><script>var a = "$1"; "book now"</script></body></html>` });
    assert.equal(scriptOnly.conversion.prices, false, "prices inside scripts don't count");
    assert.equal(scriptOnly.conversion.booking, false);
  });
});
