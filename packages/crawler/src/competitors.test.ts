import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fetcher } from "./index.js";
import { detectTrackers, inspectPage, profileSitemaps, researchSite, RESEARCH_USER_AGENT, scriptTrackers } from "./competitors.js";

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

  it("counts a translated page once per family, alongside its language editions", async () => {
    const sitemap = urlset(["a", "b", "c"].flatMap((slug) => [`/hospitals/${slug}`, `/km/hospitals/${slug}`, `/th/hospitals/${slug}`]));
    const translated: Fetcher = async (url) => ({ url, finalUrl: url, headers: {}, status: url.endsWith("/sitemap.xml") ? 200 : 404, body: url.endsWith("/sitemap.xml") ? sitemap : "" });
    const profile = await profileSitemaps("https://rival.example", translated, { robots: { isAllowed: () => true, sitemaps: [] } });
    const hospitals = profile.families.find((entry) => entry.family === "hospitals");
    assert.equal(hospitals?.estimated, 9);
    assert.equal(hospitals?.pages, 3);
    assert.equal(hospitals?.languages, 3);
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
      <a href="https://wa.me/60123456789">WhatsApp us</a><a href="tel:+60123456789">Call</a><form action="/enquire"><input type="email" name="email"><textarea name="message"></textarea></form>
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script></body></html>`;
    const page = inspectPage("https://rival.example/treatments/ivf", { status: 200, body: html });
    assert.deepEqual(page.conversion, { whatsapp: true, phone: true, email: false, form: true, booking: true, prices: true });
    assert.equal(page.faq, true);
    assert.deepEqual(page.schemaTypes, ["MedicalProcedure"]);
    assert.deepEqual(page.tracking, ["Google Analytics"]);
    const search = inspectPage("https://rival.example/a", { status: 200, body: `<form role="search"><input type="search" name="q"></form><p>${"Text. ".repeat(60)}</p>` });
    assert.equal(search.conversion.form, false, "a search box is not a lead form");
    const scriptOnly = inspectPage("https://rival.example/a", { status: 200, body: `<html><body><p>${"Plain text. ".repeat(40)}</p><script>var a = "$1"; "book now"</script></body></html>` });
    assert.equal(scriptOnly.conversion.prices, false, "prices inside scripts don't count");
    assert.equal(scriptOnly.conversion.booking, false);
  });
});

describe("scriptTrackers", () => {
  // Sites that bundle their analytics SDK only mention the vendors in a CSP allowlist.
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'self' https://www.googletagmanager.com https://*.posthog.com https://*.clarity.ms">`;
  const page = (scripts: string) => `<!doctype html><html><head>${csp}${scripts}</head><body><main>Clinic</main></body></html>`;
  const serving = (bodies: Record<string, string>) => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return { url, finalUrl: url, status: url in bodies ? 200 : 404, headers: {}, body: bodies[url] ?? "" };
    };
    return { fetcher, calls };
  };

  it("finds analytics bundled into the page's own scripts", async () => {
    const { fetcher } = serving({ "https://clinic.example/assets/app.js": 'import"./x.js";posthog.init("phc_x",{api_host:"https://n.clinic.example"});' });
    const html = page('<script type="module" crossorigin src="/assets/app.js"></script>');
    assert.deepEqual(await scriptTrackers(html, "https://clinic.example/", fetcher), ["PostHog"]);
  });

  it("never counts a security-policy allowlist as tracking", async () => {
    assert.deepEqual(detectTrackers(page("")), []);
    const { fetcher } = serving({ "https://clinic.example/app.js": "console.log(1)" });
    assert.deepEqual(await scriptTrackers(page('<script src="/app.js"></script>'), "https://clinic.example/", fetcher), []);
  });

  it("ignores other sites' scripts and fetches a shared bundle once per run", async () => {
    const { fetcher, calls } = serving({ "https://clinic.example/app.js": "gtag('config', 'G-ABC123')" });
    const cache = new Map<string, Promise<string[]>>();
    const html = page('<script src="https://cdn.other.example/x.js"></script><script src="/app.js"></script>');
    assert.deepEqual(await scriptTrackers(html, "https://clinic.example/a", fetcher, cache), ["Google Analytics"]);
    assert.deepEqual(await scriptTrackers(html, "https://clinic.example/b", fetcher, cache), ["Google Analytics"]);
    assert.deepEqual(calls, ["https://clinic.example/app.js"]);
  });
});
