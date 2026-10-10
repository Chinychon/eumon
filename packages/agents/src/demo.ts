import type { DataRecord, Dataset, Finding, KeywordsInput, PageTemplate, RankedKeyword, SearchMetricRow } from "@organic-growth/core";
import { addDays, keyOf, REF_ALPHABET, REF_LENGTH, slugify, suggestRedirect } from "@organic-growth/core";
import { crawlGooglebotBatch, probeAiCrawlers, probeHost, probeNotFound, researchSite, type Fetcher, type SiteResearch } from "@organic-growth/crawler";
import {
  chunks, createAnalysis, createLead, recordLeadClick, updateLead, defaultPageSettings, recordSyncRun, recountCrawl, upsertPageSettings, datasetCoverage, deleteSite, getAnalysisJob, getCrawlCoverage, getCrawlProgress, importSearchConsoleUrls, insertChange, insertConversionEvent, listAllRecords,
  listCrawlLogDays, listCrawlPageResults, listPendingCrawlUrls, probePages, recordLandingSession, replaceCurrentSearchMetrics, replacePageSearchMetrics, runStatements, saveAnalysisReport, saveCrawlBatch,
  saveIndexStatus, saveSearchConsoleChart, saveSearchConsoleChecks, saveSearchConsoleSummary, saveSiteScope, saveSnapshot, searchConsoleReconciliation, saveTopQueriesSnapshot, saveUrlIndexStatus, listSiteCompetitorDomains, setSiteCompetitorDomains, syncFirstPartyResults, updateSiteGa4Property, upsertMetricPoints, type MetricPoint, setSiteMarkets, setTemplatePublication, syncTemplatePages, updateAnalysisProgress,
  updateAnalysisStatus, upsertDataset, upsertRecords, upsertSite, upsertTemplate, type D1Like,
} from "@organic-growth/db";
import { generatePages } from "@organic-growth/pages";
import { demoLinks, demoSerpLists, demoSuggestions, seedDemoConnectors } from "./demo-connectors.js";
import { crawlLogCoverage } from "./log-coverage.js";
import { queueFullCrawl, runFullAnalysis } from "./pipeline.js";
import { probeTitleForCoverage } from "./not-found-probe.js";
import { loadTrendSignals } from "./trend-signals.js";
import { loadInventories } from "./inventory-data.js";

/*
 * A demo site for local development: a fictional dental clinic served from
 * memory, analysed by the real crawler and pipeline. Version 1 is the site a
 * month ago, version 2 today, version 3 after fixes, so re-runs show changes.
 */

export const DEMO_SITE_ID = "site_demo_clinic";
const ORIGIN = "https://demo-clinic.example";
const COMPETITORS = ["smile-dental.example", "brightcare-dental.example"];
const DAY = 86_400_000;

/** Dev-only routes accept only requests addressed to this machine. */
export function isLocalHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}

const FIRST = ["Aisha", "Ben", "Chen", "Daniel", "Elena", "Farah", "Gopal", "Hana", "Irfan", "Jia", "Kumar", "Lina", "Mei", "Nadia"];
const LAST = ["Tan", "Lim", "Wong", "Rahman", "Singh", "Lee", "Ng", "Ismail", "Chua", "Yusof"];
const SPECIALTIES = ["General dentistry", "Orthodontics", "Implantology", "Endodontics", "Paediatric dentistry", "Periodontics"];
const CITIES = ["kuala-lumpur", "petaling-jaya", "penang", "johor-bahru", "ipoh", "melaka", "kota-kinabalu", "kuching", "shah-alam", "seremban", "singapore"];
const TREATMENTS = ["dental-implants", "braces", "invisalign", "root-canal", "teeth-whitening", "wisdom-tooth-removal", "scaling-and-polishing", "veneers", "dentures", "crowns", "bridges", "fillings"];
const PAGES = ["about", "contact", "pricing", "insurance", "faq", "careers", "reviews", "new-patients", "emergency", "privacy", "terms", "promotions", "search"];
const title = (slug: string) => slug.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");

const DENTISTS = Array.from({ length: 140 }, (_, i) => ({
  name: `Dr ${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
  slug: `dr-${slugify(`${FIRST[i % FIRST.length]}-${LAST[Math.floor(i / FIRST.length) % LAST.length]}`)}-${i + 1}`,
  specialty: SPECIALTIES[i % SPECIALTIES.length]!,
  clinic: CITIES[i % CITIES.length]!,
  years: 3 + (i * 7) % 25,
}));
const TREATMENT_LIST = Array.from({ length: 60 }, (_, i) => {
  const base = TREATMENTS[i % TREATMENTS.length]!;
  const variant = Math.floor(i / TREATMENTS.length);
  return { slug: variant ? `${base}-${["for-children", "for-seniors", "same-day", "aftercare"][variant - 1]}` : base, base, price: 150 + ((i * 137) % 40) * 100 };
});
// Every tenth guide carries the year it was written in its address.
const BLOG = Array.from({ length: 900 }, (_, i) => `${TREATMENTS[i % TREATMENTS.length]}-guide-${i + 1}${i % 10 === 0 ? "-2024" : ""}`);

type Page = { path: string; family: string; index: number };

const RETIRED_TREATMENTS = ["gold-crowns", "amalgam-fillings"];

/** Every URL the demo sitemap lists: about 1,800 across six page types. */
function demoPages(): Page[] {
  const pages: Page[] = [{ path: "/", family: "home", index: 0 }];
  PAGES.forEach((slug, index) => pages.push({ path: `/${slug}`, family: "page", index }));
  DENTISTS.forEach((dentist, index) => pages.push({ path: `/dentists/${dentist.slug}`, family: "dentists", index }));
  TREATMENT_LIST.forEach((treatment, index) => pages.push({ path: `/treatments/${treatment.slug}`, family: "treatments", index }));
  // Two retired treatments still in the sitemap answer 200 with "not found" (soft 404s), and one dentist is listed twice under a coded slug.
  RETIRED_TREATMENTS.forEach((slug, index) => pages.push({ path: `/treatments/${slug}`, family: "treatments", index: TREATMENT_LIST.length + index }));
  pages.push({ path: `/dentists/${DENTISTS[3]!.slug}-2b7f1a`, family: "dentists", index: 3 });
  CITIES.forEach((city, index) => pages.push({ path: `/clinics/${city}`, family: "clinics", index }));
  BLOG.forEach((slug, index) => pages.push({ path: index < 12 ? `/blog/drafts/${slug}` : `/blog/${slug}`, family: "blog", index }));
  let index = 0;
  for (const treatment of TREATMENT_LIST) {
    for (const city of CITIES) pages.push({ path: `/prices/${treatment.slug}/${city}`, family: "prices", index: index++ });
  }
  return pages;
}

const PROSE = "Our dentists explain every step before treatment starts, give you a written quote, and follow up after your visit. "
  + "Appointments are available on weekdays and Saturdays, and most insurance panels are accepted at every clinic. "
  + "Bring any previous X-rays you have; if you don't have them, we take new ones at the first visit at no extra charge. ";

/**
 * Each demo page's internal links: the homepage reaches clinics, treatments,
 * the blog, and two of Eumon's guides; clinics reach their dentists; a
 * treatment reaches its price pages in five cities only, so price pages in
 * the other cities are orphans.
 */
function relatedLinks(path: string): string[] {
  const [, first, second, third] = path.split("/");
  if (path === "/") return [...CITIES.map((city) => `/clinics/${city}`), ...TREATMENTS.map((treatment) => `/treatments/${treatment}`), `/blog/${BLOG[12]}`, "/guides/braces", "/guides/dental-implants"];
  if (first === "treatments") return CITIES.slice(0, 5).map((city) => `/prices/${second}/${city}`);
  if (first === "clinics") return [...DENTISTS.filter((dentist) => dentist.clinic === second).map((dentist) => `/dentists/${dentist.slug}`), `/prices/dental-implants/${second}`];
  if (first === "dentists") return [`/clinics/${DENTISTS.find((dentist) => dentist.slug === second)?.clinic}`];
  if (first === "blog") {
    const next = BLOG[BLOG.indexOf((second === "drafts" ? third : second) ?? "") + 1];
    return next ? [`/blog/${next}`] : [];
  }
  if (first === "prices") return [`/treatments/${second}`, `/clinics/${third}`];
  return [];
}

function document(input: { path: string; title: string; description: string; h1: string; body: string; jsonLd?: object; robots?: string; tracking?: boolean; shell?: boolean }) {
  const ld = input.jsonLd ? `<script type="application/ld+json">${JSON.stringify(input.jsonLd)}</script>` : "";
  const head = `<title>${input.title}</title><meta name="description" content="${input.description}"><link rel="canonical" href="${ORIGIN}${input.path}">`
    + (input.robots ? `<meta name="robots" content="${input.robots}">` : "")
    + (input.tracking ? `<script async src="https://www.googletagmanager.com/gtag/js?id=G-DEMO"></script>` : "") + ld;
  if (input.shell) return `<!doctype html><html lang="en"><head>${head}</head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>`;
  const nav = `<nav><a href="/">Home</a> <a href="/treatments/dental-implants">Treatments</a> <a href="/dentists/${DENTISTS[0]!.slug}">Dentists</a> <a href="/clinics/kuala-lumpur">Clinics</a> <a href="/contact">Contact</a></nav>`;
  const cta = `<p><a href="https://wa.me/60300000000?text=Hi">Chat on WhatsApp</a> or <a href="/contact">book an appointment</a>.</p>`;
  const related = relatedLinks(input.path).map((href) => `<li><a href="${href}">${href}</a></li>`).join("");
  return `<!doctype html><html lang="en"><head>${head}</head><body>${nav}<main><h1>${input.h1}</h1>${input.body}<ul>${related}</ul><h2>Book a visit</h2><p>${PROSE}</p>${cta}</main></body></html>`;
}

/** The demo site's response for one path, as it stood in `version`. */
function demoResponse(path: string, version: number): { status: number; body: string } | null {
  const [, first, second, third] = path.split("/");
  if (path === "/") return { status: 200, body: document({ path, title: "Demo Dental Clinic | Dentists in Malaysia and Singapore", description: "Demo data: a fictional dental clinic group.", h1: "Dental care across 11 clinics", body: `<p>${PROSE.repeat(3)}</p>`, tracking: true, jsonLd: { "@context": "https://schema.org", "@type": "Dentist", name: "Demo Dental Clinic" } }) };
  // The pricing page was told to keep its prices out of search snippets, which also keeps it out of AI answers.
  if (first && !second && PAGES.includes(first)) return { status: 200, body: document({ path, title: `${title(first)} | Demo Dental Clinic`, description: `${title(first)} at Demo Dental Clinic.`, h1: title(first), body: `<p>${PROSE.repeat(2)}</p>`, tracking: true, robots: first === "pricing" ? "max-snippet:0" : undefined }) };
  if (first === "dentists" && second && !third) {
    // The duplicate listing: the same dentist under a slug with a code on the end.
    const index = DENTISTS.findIndex((dentist) => dentist.slug === second.replace(/-2b7f1a$/, ""));
    const dentist = DENTISTS[index];
    if (!dentist) return null;
    // Twelve dentists left the clinic; their pages 404 until version 3 drops them from the sitemap.
    if (index >= DENTISTS.length - 12 && version < 3) return { status: 404, body: "<!doctype html><html><head><title>Not found</title></head><body><h1>Page not found</h1></body></html>" };
    const schema = version === 3 || (version === 2 && index % 7 !== 0);
    return { status: 200, body: document({
      path, title: `${dentist.name}, ${dentist.specialty} in ${title(dentist.clinic)} | Demo Dental Clinic`, description: `${dentist.name} has ${dentist.years} years of experience in ${dentist.specialty.toLowerCase()}.`,
      h1: `${dentist.name}`, body: `<p>${dentist.name} practises ${dentist.specialty.toLowerCase()} at our ${title(dentist.clinic)} clinic and has ${dentist.years} years of experience.</p><p>${PROSE.repeat(2)}</p>`,
      tracking: true, ...(schema ? { jsonLd: { "@context": "https://schema.org", "@type": "Dentist", name: dentist.name, medicalSpecialty: dentist.specialty } } : {}),
    }) };
  }
  if (first === "treatments" && second && !third) {
    if (RETIRED_TREATMENTS.includes(second)) {
      return { status: 200, body: document({ path, title: "Halaman tidak ditemukan | Demo Dental Clinic", description: "Rawatan ini tidak lagi ditawarkan.", h1: "Halaman tidak ditemukan", body: "<p>Maaf, rawatan ini tidak lagi ditawarkan di klinik kami.</p>" }) };
    }
    const treatment = TREATMENT_LIST.find((entry) => entry.slug === second);
    if (!treatment) return null;
    return { status: 200, body: document({ path, title: `${title(treatment.slug)}: cost, recovery, and what to expect | Demo Dental Clinic`, description: `${title(treatment.slug)} from RM ${treatment.price}.`, h1: title(treatment.slug), body: `<p>${title(treatment.slug)} starts from RM ${treatment.price} at every clinic.</p><p>${PROSE.repeat(3)}</p>`, tracking: true, jsonLd: { "@context": "https://schema.org", "@type": "MedicalProcedure", name: title(treatment.slug) } }) };
  }
  if (first === "clinics" && second && !third && CITIES.includes(second)) {
    return { status: 200, body: document({ path, title: `Dentist in ${title(second)} | Demo Dental Clinic`, description: `Our ${title(second)} clinic.`, h1: `Demo Dental Clinic ${title(second)}`, body: `<p>${PROSE.repeat(3)}</p>`, tracking: true, jsonLd: { "@context": "https://schema.org", "@type": "Dentist", name: `Demo Dental Clinic ${title(second)}` } }) };
  }
  if (first === "blog" && second) {
    const slug = second === "drafts" ? third : second;
    const index = BLOG.indexOf(slug ?? "");
    if (index < 0) return null;
    if (version === 1 && index % 180 === 7) return { status: 500, body: "<!doctype html><html><head><title>Error</title></head><body><h1>Something went wrong</h1></body></html>" };
    // Older guides: a 2024 date in their markup, and a hero image still linked over HTTP with no alt text.
    const old = index % 9 === 4;
    return { status: 200, body: document({
      path, title: `${title(slug!)} | Demo Dental Clinic blog`, description: `A guide from our dentists.`, h1: title(slug!),
      body: `${old ? '<img src="http://img.demo-clinic.example/hero.jpg">' : ""}<p>${PROSE.repeat(2)}</p>`, robots: index % 25 === 3 ? "noindex, follow" : undefined,
      ...(old ? { jsonLd: { "@context": "https://schema.org", "@type": "BlogPosting", headline: title(slug!), datePublished: "2024-03-01" } } : {}),
    }) };
  }
  if (first === "prices" && second && third) {
    const treatment = TREATMENT_LIST.findIndex((entry) => entry.slug === second);
    const city = CITIES.indexOf(third);
    if (treatment < 0 || city < 0) return null;
    // Price pages render in the browser: all of them in version 1, the long tail in version 2, none after the fix.
    const shell = version === 1 || (version === 2 && treatment * CITIES.length + city >= 520);
    const h1 = `${title(second)} price in ${title(third)}`;
    return { status: 200, body: document({ path, title: `${h1} | Demo Dental Clinic`, description: `What ${title(second).toLowerCase()} costs in ${title(third)}.`, h1, body: `<p>${h1}: from RM ${TREATMENT_LIST[treatment]!.price}, with a written quote before treatment.</p><p>${PROSE.repeat(2)}</p>`, shell, jsonLd: { "@context": "https://schema.org", "@type": "Offer", price: TREATMENT_LIST[treatment]!.price, priceCurrency: "MYR" } }) };
  }
  return null;
}

/** Fictional competitors: one strong on price pages, one on locations and reviews. */
function competitorSite(domain: string): Map<string, string> {
  const pages = new Map<string, string>();
  const families = domain.startsWith("smile")
    ? { prices: 1500, dentists: 300, treatments: 80, blog: 400 }
    : { locations: 80, reviews: 400, treatments: 45, blog: 250 };
  for (const [family, count] of Object.entries(families)) {
    for (let i = 0; i < count; i++) {
      const slug = family === "prices" ? `${TREATMENTS[i % TREATMENTS.length]}/${CITIES[i % CITIES.length]}-${i}` : `${family}-${i + 1}`;
      pages.set(`/${family}/${slug}`, `<!doctype html><html><head><title>${title(family)} ${i + 1} | ${domain}</title></head><body><h1>${title(family)} ${i + 1}</h1><p>${PROSE.repeat(2)}</p><a href="https://wa.me/60300000001">WhatsApp</a></body></html>`);
    }
  }
  pages.set("/", `<!doctype html><html><head><title>${domain}</title></head><body><h1>${domain}</h1><p>${PROSE.repeat(3)}</p></body></html>`);
  return pages;
}

const COMPETITOR_SITES = new Map(COMPETITORS.map((domain) => [domain, competitorSite(domain)]));

function sitemap(urls: Array<{ loc: string; lastmod?: string }>) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url.loc}</loc>${url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>`;
}

/** Serves the demo site (as of `version`) and its competitors from memory. */
export function demoFetcher(version: number, now = Date.now()): Fetcher {
  const settled = new Date(now - 60 * DAY).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const pages = demoPages().filter((page) => !(version === 3 && page.family === "dentists" && page.index >= DENTISTS.length - 12));
  return async (url, init) => {
    const target = new URL(url);
    const reply = (status: number, body: string, type = "text/html") => ({ url, status, finalUrl: url, headers: { "content-type": type } as Record<string, string>, body });
    if (target.hostname === "demo-clinic.example") {
      // The firewall challenges PerplexityBot although robots.txt allows it (Cloudflare's AI crawler setting).
      if (/PerplexityBot/.test(init?.userAgent ?? "")) return { ...reply(403, "<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>"), headers: { "cf-mitigated": "challenge" } };
      // HTTP redirects to HTTPS.
      if (target.protocol === "http:") return { ...reply(200, "<!doctype html><html><body></body></html>"), finalUrl: `${ORIGIN}${target.pathname}`, hops: 1 };
      // An old address redirects twice before it reaches the page.
      if (target.pathname === "/insurance") return { ...reply(200, demoResponse("/insurance", version)!.body), finalUrl: `${ORIGIN}/insurance-and-plans`, hops: 2 };
      if (target.pathname === "/robots.txt") return reply(200, "User-agent: *\nDisallow: /search\nDisallow: /blog/drafts/\n\nUser-agent: Bytespider\nUser-agent: CCBot\nDisallow: /\n\nSitemap: https://demo-clinic.example/sitemap.xml\n", "text/plain");
      if (target.pathname === "/sitemap.xml") {
        // Version 3 changed the price and dentist pages, so an update fetches only those again.
        return reply(200, sitemap(pages.map((page) => ({ loc: `${ORIGIN}${page.path}`, lastmod: version === 3 && (page.family === "prices" || page.family === "dentists") ? today : settled }))), "application/xml");
      }
      const response = demoResponse(target.pathname, version);
      return response ? reply(response.status, response.body) : reply(404, "<!doctype html><html><head><title>Not found</title></head><body><h1>Not found</h1></body></html>");
    }
    const site = COMPETITOR_SITES.get(target.hostname);
    if (site) {
      if (target.pathname === "/robots.txt") return reply(200, `User-agent: *\nAllow: /\nSitemap: https://${target.hostname}/sitemap.xml\n`, "text/plain");
      if (target.pathname === "/sitemap.xml") return reply(200, sitemap([...site.keys()].map((path) => ({ loc: `https://${target.hostname}${path}` }))), "application/xml");
      const body = site.get(target.pathname);
      return body ? reply(200, body) : reply(404, "<!doctype html><html><body><h1>Not found</h1></body></html>");
    }
    throw new Error(`The demo has no site at ${target.hostname}.`);
  };
}

/** What a browser would show: price-page shells fill in with their content. */
async function renderDemo(urls: string[], version: number): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const url of urls) {
    const path = new URL(url).pathname;
    const response = demoResponse(path, 3);
    const raw = demoResponse(path, version);
    if (response && raw?.status === 200) output[url] = response.body;
  }
  return output;
}

/** Ninety days of Search Console rows for the demo, aggregated per query, page, country, and device. */
export function demoSearchRows(now = Date.now()): SearchMetricRow[] {
  const periodEnd = new Date(now - 2 * DAY).toISOString().slice(0, 10);
  const periodStart = new Date(now - 92 * DAY).toISOString().slice(0, 10);
  const rows: SearchMetricRow[] = [];
  const add = (query: string, page: string, country: string, impressions: number, position: number) => {
    for (const device of ["MOBILE", "DESKTOP"]) {
      const share = device === "MOBILE" ? 0.72 : 0.28;
      const shown = Math.max(1, Math.round(impressions * share));
      const ctr = position <= 1.5 ? 0.3 : position <= 3 ? 0.12 : position <= 10 ? 0.03 : 0.004;
      const clicks = Math.round(shown * ctr);
      rows.push({ query, page: `${ORIGIN}${page}`, country, device, impressions: shown, clicks, ctr: clicks / shown, position, periodStart, periodEnd });
    }
  };
  add("demo dental clinic", "/", "mys", 4200, 1.1);
  add("demo dental clinic", "/", "sgp", 900, 1.3);
  TREATMENTS.forEach((treatment, i) => {
    const words = treatment.replace(/-/g, " ");
    add(`${words} price malaysia`, `/treatments/${treatment}`, "mys", 2600 - i * 150, 6 + i * 0.8);
    add(`${words} cost kuala lumpur`, `/prices/${treatment}/kuala-lumpur`, "mys", 1400 - i * 80, 11 + i);
    add(`${words} cost kuala lumpur`, `/treatments/${treatment}`, "mys", 600, 14);
    add(`${words} singapore`, `/treatments/${treatment}`, "sgp", 700 - i * 30, 9 + i * 0.5);
    add(`${words} penang`, `/prices/${treatment}/penang`, "mys", 500 - i * 20, 4.2 + i * 0.3);
    add(`best ${words} clinic`, `/clinics/kuala-lumpur`, "idn", 450, 18);
  });
  DENTISTS.slice(0, 30).forEach((dentist, i) => add(`${dentist.name.toLowerCase()} dentist`, `/dentists/${dentist.slug}`, "mys", 300 - i * 6, 1.6 + (i % 5) * 0.4));
  CITIES.forEach((city, i) => add(`dentist ${city.replace(/-/g, " ")}`, `/clinics/${city}`, city === "singapore" ? "sgp" : "mys", 1800 - i * 110, 3 + i * 0.9));
  return rows;
}

/*
 * Fictional DataForSEO answers for the demo, shaped like real ones (the
 * recorded answer in dataforseo.test.ts): brand and clinic-name searches
 * that are navigational, Malay wording beside English, some keywords DataForSEO
 * has no difficulty or intent for, and many rankings past page one.
 */
type Priced = [keyword: string, volume: number | null, difficulty: number | null, intent: string | null, position: number, clicks: number, impressions: number];
type Ranked = [keyword: string, volume: number, difficulty: number | null, intent: string | null, position: number, url: string];

const DEMO_PRICED: Record<string, Priced[]> = {
  mys: [
    ["dental implants kuala lumpur", 1900, 34, "commercial", 4.2, 64, 1830],
    ["braces price malaysia", 2400, 41, "commercial", 6.1, 52, 2410],
    ["demo dental clinic", null, null, null, 1.1, 48, 310],
    ["scaling and polishing cost", 1300, 22, "commercial", 5.3, 37, 1480],
    ["dentist penang", 880, 27, "commercial", 6.8, 24, 960],
    ["wisdom tooth removal cost kl", 720, 19, "transactional", 5.9, 21, 770],
    ["root canal treatment price", 590, 31, "commercial", 7.2, 18, 690],
    ["teeth whitening johor bahru", 480, 15, "transactional", 9.6, 12, 540],
    ["paediatric dentist petaling jaya", 260, 12, "commercial", 8.3, 9, 330],
    ["harga implan gigi", 1600, 18, "commercial", 11.4, 8, 1240],
    ["klinik gigi terdekat", 6600, 38, "transactional", 17.8, 7, 2950],
    ["harga pasang braces", 2900, 25, "commercial", 12.6, 6, 1580],
    ["cabut gigi bongsu harga", 1000, 14, "commercial", 9.1, 6, 610],
    ["how much are dental implants in malaysia", 390, 21, "informational", 7.4, 5, 420],
    ["invisalign price malaysia", 1600, 52, "commercial", 13.2, 4, 980],
    ["veneers malaysia", 1300, 29, "commercial", 15.7, 3, 870],
    ["dental crown price", 720, 26, "commercial", 14.1, 3, 560],
    ["is root canal painful", 320, 9, "informational", 8.8, 3, 380],
    ["klinik gigi kuala lumpur", 2400, 33, "transactional", 21.5, 2, 1120],
    ["gigi palsu harga", 880, null, null, 18.2, 2, 640],
    ["demo dental penang", null, null, null, 1.4, 11, 95],
    ["dentist open sunday kl", 590, 16, "transactional", 10.3, 2, 300],
    ["tampal gigi harga", 1300, 11, "commercial", 23.9, 1, 720],
    ["dentist near me", 14800, 61, "transactional", 34.0, 1, 2100],
  ],
  sgp: [
    ["invisalign singapore price", 2900, 58, "commercial", 8.7, 29, 2050],
    ["dental implant singapore cost", 1900, 47, "commercial", 9.8, 11, 1360],
    ["dentist singapore", 4400, 55, "transactional", 18.3, 6, 1890],
    ["wisdom tooth surgery singapore", 1600, 36, "commercial", 12.4, 5, 990],
    ["teeth whitening singapore", 1300, 39, "commercial", 16.0, 3, 760],
    ["demo dental singapore", null, null, null, 1.2, 9, 70],
    ["how much is scaling and polishing in singapore", 390, 17, "informational", 9.4, 3, 310],
    ["braces singapore price", 1900, 44, "commercial", 14.6, 2, 880],
  ],
};

const own = "demo-clinic.example";
const DEMO_RANKED: Record<string, Record<string, Ranked[]>> = {
  [own]: {
    mys: [
      ["dental implants kuala lumpur", 1900, 34, "commercial", 4, "/guides/dental-implants"], ["braces price malaysia", 2400, 41, "commercial", 6, "/guides/braces"],
      ["scaling and polishing cost", 1300, 22, "commercial", 5, "/guides/scaling-and-polishing"], ["dentist penang", 880, 27, "commercial", 7, "/clinics/penang"],
      ["demo dental clinic", 320, null, "navigational", 1, "/"], ["harga implan gigi", 1600, 18, "commercial", 11, "/guides/dental-implants"],
      ["klinik gigi terdekat", 6600, 38, "transactional", 18, "/clinics"], ["harga pasang braces", 2900, 25, "commercial", 13, "/guides/braces"],
      ["invisalign price malaysia", 1600, 52, "commercial", 13, "/guides/invisalign"], ["veneers malaysia", 1300, 29, "commercial", 16, "/prices/veneers"],
      ["klinik gigi kuala lumpur", 2400, 33, "transactional", 22, "/clinics/kuala-lumpur"], ["dentist near me", 14800, 61, "transactional", 34, "/clinics"],
      ["tampal gigi harga", 1300, 11, "commercial", 24, "/prices/fillings"], ["gigi palsu harga", 880, null, null, 19, "/prices/dentures"],
    ],
    sgp: [
      ["invisalign singapore price", 2900, 58, "commercial", 9, "/clinics/singapore"], ["dental implant singapore cost", 1900, 47, "commercial", 10, "/clinics/singapore"],
      ["dentist singapore", 4400, 55, "transactional", 18, "/clinics/singapore"], ["braces singapore price", 1900, 44, "commercial", 15, "/clinics/singapore"],
    ],
  },
  "brightcare-dental.example": {
    mys: [
      ["brightcare dental", 1300, null, "navigational", 1, "/"], ["dental implants kuala lumpur", 1900, 34, "commercial", 2, "/implants"],
      ["veneers price malaysia", 3600, 24, "commercial", 3, "/veneers-price"], ["emergency dentist kl", 1600, 9, "transactional", 2, "/emergency"],
      ["gum disease treatment", 2200, 18, "informational", 5, "/gum-disease"], ["dental crown cost", 1300, 29, "commercial", 7, "/crowns"],
      ["harga veneer gigi", 2400, 16, "commercial", 4, "/ms/veneer"], ["klinik gigi terdekat", 6600, 38, "transactional", 6, "/clinics"],
      ["sakit gigi berlubang", 3600, 7, "informational", 9, "/ms/gigi-berlubang"], ["dental bridge cost", 880, 21, "commercial", 6, "/bridges"],
      ["bad breath treatment", 1900, 12, "informational", 11, "/halitosis"], ["dentist near me", 14800, 61, "transactional", 12, "/clinics"],
      ["teeth grinding night guard", 720, 14, "commercial", 8, "/night-guard"], ["dental clinic reviews kl", 590, 19, "commercial", 4, "/reviews"],
      ["invisalign price malaysia", 1600, 52, "commercial", 9, "/invisalign"], ["full mouth dental implants cost", 480, 33, "commercial", 5, "/implants/full-mouth"],
      ["gigi kuning", 2900, null, null, 14, "/ms/gigi-kuning"], ["dental check up price", 1000, 13, "commercial", 7, "/check-up"],
    ],
    sgp: [
      ["dentist singapore", 4400, 55, "transactional", 7, "/sg"], ["veneers singapore price", 1900, 31, "commercial", 4, "/sg/veneers"],
      ["emergency dentist singapore", 1300, 22, "transactional", 3, "/sg/emergency"], ["dental implant singapore cost", 1900, 47, "commercial", 6, "/sg/implants"],
      ["gum treatment singapore", 590, 18, "commercial", 8, "/sg/gums"], ["brightcare dental singapore", 480, null, "navigational", 1, "/sg"],
    ],
  },
  "smile-dental.example": {
    mys: [
      ["smile dental", 880, null, "navigational", 1, "/"], ["kids dentist kl", 900, 11, "commercial", 3, "/kids"],
      ["teeth cleaning price", 2600, 21, "commercial", 4, "/cleaning"], ["veneers price malaysia", 3600, 24, "commercial", 8, "/veneers"],
      ["braces price malaysia", 2400, 41, "commercial", 3, "/braces"], ["harga scaling gigi", 2900, 13, "commercial", 2, "/ms/scaling"],
      ["dentist for children penang", 480, 8, "commercial", 2, "/kids/penang"], ["clear aligners malaysia", 1300, 37, "commercial", 6, "/aligners"],
      ["dental x ray price", 390, 10, "commercial", 5, "/x-ray"], ["gigi sensitif", 1600, null, null, 10, "/ms/gigi-sensitif"],
      ["klinik gigi kanak kanak", 720, 9, "commercial", 4, "/ms/kanak-kanak"], ["teeth whitening price malaysia", 1900, 23, "commercial", 7, "/whitening"],
      ["fluoride treatment kids", 320, 6, "informational", 6, "/kids/fluoride"], ["dentist near me", 14800, 61, "transactional", 19, "/clinics"],
    ],
    sgp: [
      ["kids dentist singapore", 1300, 19, "commercial", 2, "/sg/kids"], ["invisalign singapore price", 2900, 58, "commercial", 5, "/sg/invisalign"],
      ["teeth cleaning singapore", 1600, 24, "commercial", 6, "/sg/cleaning"], ["smile dental singapore", 390, null, "navigational", 1, "/sg"],
      ["braces singapore price", 1900, 44, "commercial", 4, "/sg/braces"],
    ],
  },
};

/** Estimated monthly visits for a ranking, the way DataForSEO's etv falls off past the top 3. */
const estimatedTraffic = (volume: number, position: number) => Math.round(volume * (position <= 1 ? 0.3 : position <= 3 ? 0.15 : position <= 10 ? 0.04 : position <= 20 ? 0.008 : 0.002) * 10) / 10;

/** What the demo's connector data is built from. */
const demoConnectorInput = () => ({ siteId: DEMO_SITE_ID, origin: ORIGIN, own, competitors: COMPETITORS, ranked: DEMO_RANKED, paths: demoPages() });

/** The demo's keyword lists, as the analysis and the view read them. */
export function demoKeywords(today: string): KeywordsInput {
  return {
    site: own,
    competitors: COMPETITORS,
    synced: true,
    priced: Object.values(DEMO_PRICED).map((rows) => ({
      periodEnd: addDays(today, -3),
      rows: rows.map(([keyword, volume, difficulty, intent, position, clicks, impressions]) => ({ keyword, volume, difficulty, intent, position, clicks, impressions })),
    })),
    ranked: Object.entries(DEMO_RANKED).flatMap(([domain, markets]) => Object.values(markets).map((rows) => ({
      domain, periodEnd: today,
      rows: rows.map(([keyword, volume, difficulty, intent, position, url]): RankedKeyword => ({ keyword, volume, difficulty, intent, position, url, traffic: estimatedTraffic(volume, position) })),
    }))),
  };
}

/**
 * Saves the demo's keyword lists per market as the sync would, and twelve
 * weeks of top-10 counts and estimated traffic per domain, the clinic
 * climbing since its guides went live.
 */
async function seedDemoKeywords(db: D1Like, now: number) {
  const today = new Date(now).toISOString().slice(0, 10);
  for (const [market, rows] of Object.entries(DEMO_PRICED)) {
    await saveSnapshot(db, DEMO_SITE_ID, { kind: "keywords", scope: `sc-domain:demo-clinic.example|${market}`, periodEnd: addDays(today, -3),
      rows: rows.map(([keyword, volume, difficulty, intent, position, clicks, impressions]) => ({ keyword, volume, difficulty, intent, position, clicks, impressions })) });
  }
  const points: MetricPoint[] = [{ metric: "sync.competitor_keywords", day: today, value: 1 }, { metric: "sync.keyword_volumes", day: today, value: 1 }];
  for (const [domain, markets] of Object.entries(DEMO_RANKED)) {
    const rows: RankedKeyword[] = [];
    for (const [market, ranked] of Object.entries(markets)) {
      const list = ranked.map(([keyword, volume, difficulty, intent, position, url]): RankedKeyword => ({ keyword, volume, difficulty, intent, position, url, traffic: estimatedTraffic(volume, position) }));
      await saveSnapshot(db, DEMO_SITE_ID, { kind: "competitor_keywords", scope: `${domain}|${market}`, periodEnd: today, rows: list });
      rows.push(...list);
    }
    const suffix = domain === own ? "" : `:${domain}`;
    const top10 = rows.filter((row) => row.position <= 10).length;
    const traffic = rows.reduce((total, row) => total + row.traffic, 0);
    for (let week = 11; week >= 0; week--) {
      // The clinic gained since go-live; competitors held roughly steady.
      const back = domain === own ? 1 - week * 0.045 : 1 - (week % 3) * 0.02;
      points.push(
        { metric: `kw_top10${suffix}`, day: addDays(today, -7 * week), value: Math.max(0, Math.round(top10 * back)) },
        { metric: `kw_traffic${suffix}`, day: addDays(today, -7 * week), value: Math.round(traffic * back) },
      );
    }
  }
  await upsertMetricPoints(db, DEMO_SITE_ID, points);
}

/** Analyses a crawled demo run with the real pipeline and saves the report. */
async function analyzeDemo(db: D1Like, input: { analysisId: string; version: number; declared: number; reused?: { urls: number; from?: string }; now: number }) {
  const fetcher = demoFetcher(input.version, input.now);
  const research: SiteResearch[] = [];
  for (const domain of COMPETITORS) research.push(await researchSite(domain, fetcher, { maxFiles: 5, maxUrls: 5_000 }));
  const notFoundProbe = await probeNotFound(ORIGIN, input.analysisId, fetcher);
  const [coverage, examples, datasets] = await Promise.all([
    getCrawlCoverage(db, input.analysisId, { notFoundTitle: probeTitleForCoverage(notFoundProbe) }),
    listCrawlPageResults(db, input.analysisId, 50),
    datasetCoverage(db, DEMO_SITE_ID),
  ]);
  // The probe as the analysis workflow runs it: the homepage and one page per template, as each AI agent.
  const robotsTxt = (await fetcher(`${ORIGIN}/robots.txt`)).body;
  const pages = [`${ORIGIN}/`, ...await probePages(db, input.analysisId, 5)];
  const hostProbe = { ai: await probeAiCrawlers(pages, robotsTxt, fetcher), host: await probeHost(ORIGIN, fetcher), robotsReadable: true };
  const report = await runFullAnalysis({
    analysisId: input.analysisId,
    siteId: DEMO_SITE_ID,
    name: "Demo Dental Clinic",
    baseUrl: ORIGIN,
    gscProperty: "sc-domain:demo-clinic.example",
    searchMetrics: demoSearchRows(input.now),
    fetcher,
    maxPages: 25,
    repeatability: false,
    notFoundProbe,
    hostProbe,
    competitorResearch: research,
    datasets,
    targetMarkets: ["mys", "sgp"],
    // The keyword lists the growth plan prices queries and finds gaps with, as a synced site has them.
    keywords: demoKeywords(new Date(input.now).toISOString().slice(0, 10)),
    // Likewise results pages, links, suggested competitors and the crawl log.
    connectors: {
      serp: demoSerpLists(demoConnectorInput(), new Date(input.now).toISOString().slice(0, 10)).flatMap((list) => list.rows),
      suggestions: demoSuggestions(),
      links: demoLinks(demoConnectorInput(), new Date(input.now).toISOString().slice(0, 10)),
      logCoverage: await crawlLogCoverage(db, DEMO_SITE_ID, input.analysisId, new Date(input.now).toISOString().slice(0, 10)),
      searchConsole: await searchConsoleReconciliation(db, DEMO_SITE_ID, input.analysisId),
      trends: await loadTrendSignals(db, DEMO_SITE_ID, await listCrawlLogDays(db, DEMO_SITE_ID, addDays(new Date(input.now).toISOString().slice(0, 10), -182)), new Date(input.now).toISOString().slice(0, 10)),
      inventory: await loadInventories(db, DEMO_SITE_ID, { analysisId: input.analysisId }),
    },
    crawlCoverage: { coverage, examples },
    renderPages: (urls) => renderDemo(urls, input.version),
  });
  await saveAnalysisReport(db, input.analysisId, {
    ...report, sitemapUrlsDeclared: input.declared,
    ...(input.reused?.urls ? { crawlReuse: input.reused } : {}),
  }, report.plan.highestImpactOpportunity);
}

/** Crawls every pending URL of a demo run at once, with crawl times spread over `minutes` ending at `end`. */
async function crawlAll(db: D1Like, analysisId: string, version: number, end: number, minutes: number) {
  const fetcher = demoFetcher(version, end);
  for (let urls = await listPendingCrawlUrls(db, analysisId, 500); urls.length; urls = await listPendingCrawlUrls(db, analysisId, 500)) {
    const outcomes = await crawlGooglebotBatch(urls, fetcher, 20);
    await saveCrawlBatch(db, { analysisId, outcomes: outcomes.map((outcome) => ("page" in outcome ? outcome : { url: outcome.url, error: outcome.error })) });
  }
  // One fetch every few hundred milliseconds, so pace and estimates read like a real crawl.
  const { results } = await db.prepare("SELECT url FROM pages WHERE analysis_id = ? AND crawled_at IS NOT NULL ORDER BY url").bind(analysisId).all<{ url: string }>();
  const step = (minutes * 60_000) / Math.max(results.length, 1);
  const start = end - minutes * 60_000;
  const statements = results.map((row, index) => db.prepare("UPDATE pages SET crawled_at = ? WHERE analysis_id = ? AND url = ?").bind(new Date(start + index * step).toISOString(), analysisId, row.url));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
  await recountCrawl(db, analysisId);
}

async function completedAnalysis(db: D1Like, id: string, version: number, at: number) {
  await createAnalysis(db, { id, siteId: DEMO_SITE_ID, status: "running", createdAt: new Date(at - 8 * 60_000).toISOString() });
  const queued = await queueFullCrawl(db, { analysisId: id, siteId: DEMO_SITE_ID, baseUrl: ORIGIN, maxUrls: 25_000, full: true, fetcher: demoFetcher(version, at), now: at });
  await crawlAll(db, id, version, at - 60_000, 6);
  await analyzeDemo(db, { analysisId: id, version, declared: queued.declared, now: at });
  // The save stamps the real clock; this run finished at its simulated time.
  await db.prepare("UPDATE analyses SET completed_at = ? WHERE id = ?").bind(new Date(at).toISOString(), id).run();
}

const DENTIST_FIELDS: Dataset["fields"] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "specialty", label: "Specialty", type: "text" },
  { key: "clinic", label: "Clinic", type: "text" },
  { key: "years", label: "Years of experience", type: "number" },
  { key: "languages", label: "Languages", type: "list" },
  { key: "bio_en", label: "Bio (EN)", type: "text" },
  { key: "bio_ms", label: "Bio (MS)", type: "text" },
];
const TREATMENT_FIELDS: Dataset["fields"] = [
  { key: "name", label: "Treatment", type: "text", required: true },
  { key: "price_from", label: "Price from (RM)", type: "number" },
  { key: "duration", label: "Duration", type: "text" },
  { key: "recovery", label: "Recovery", type: "text" },
  { key: "summary", label: "Summary", type: "text" },
];

/** Datasets, a live template with daily metrics, and conversions, as if the engine had run for three months. */
async function seedPageEngine(db: D1Like, now: number) {
  const at = new Date(now - 80 * DAY).toISOString();
  const datasets: Array<{ dataset: Dataset; records: Array<Record<string, string | number | string[]>> }> = [
    {
      dataset: { id: "dataset_demo_dentists", siteId: DEMO_SITE_ID, name: "Dentists", entityType: "dentist", description: "Every dentist at the clinic group, with specialty and clinic.", fields: DENTIST_FIELDS, keyField: "name", pageIdeas: [], status: "active", createdAt: at, updatedAt: at },
      records: DENTISTS.slice(0, 128).map((dentist, i) => ({
        name: dentist.name, specialty: dentist.specialty, clinic: title(dentist.clinic), years: dentist.years, languages: i % 3 ? ["English", "Malay"] : ["English", "Mandarin", "Malay"],
        // Every dentist has an English bio; half have no Malay one yet, which the inventory finding reports.
        bio_en: `${dentist.name} is a ${dentist.specialty.toLowerCase()} at the ${title(dentist.clinic)} clinic with ${dentist.years} years of experience.`,
        ...(i % 2 ? { bio_ms: `${dentist.name} ialah ${dentist.specialty.toLowerCase()} di klinik ${title(dentist.clinic)} dengan ${dentist.years} tahun pengalaman.` } : {}),
      })),
    },
    {
      dataset: { id: "dataset_demo_treatments", siteId: DEMO_SITE_ID, name: "Treatments", entityType: "treatment", description: "Treatments with starting prices, duration, and recovery.", fields: TREATMENT_FIELDS, keyField: "name", pageIdeas: [], status: "active", createdAt: at, updatedAt: at },
      records: TREATMENT_LIST.map((treatment, i) => ({
        name: title(treatment.slug), price_from: treatment.price, duration: `${1 + (i % 4)} visits`, recovery: i % 2 ? "Same day" : "Two to three days",
        summary: `${title(treatment.slug)} is planned after an examination and X-rays. Your dentist explains the options, the expected number of visits, and the written quote before anything starts, and a follow-up visit is included in the price. Most patients return to work the same or the next day.`,
      })),
    },
  ];
  for (const { dataset, records } of datasets) {
    await upsertDataset(db, dataset);
    await upsertRecords(db, records.map((data) => ({ siteId: DEMO_SITE_ID, datasetId: dataset.id, key: slugify(String(data.name)), data })), dataset.fields);
  }
  const template: PageTemplate = {
    id: "template_demo_treatments", siteId: DEMO_SITE_ID, datasetId: "dataset_demo_treatments", name: "Treatment guides", groupBy: [],
    pathPattern: "/guides/{name}", titlePattern: "{name} in Malaysia: price from RM {price_from}", descriptionPattern: "{name}: price, duration, and recovery at Demo Dental Clinic.",
    h1Pattern: "{name}", introPattern: "{summary}", itemTitleField: "name", itemFields: ["price_from", "duration", "recovery"], sortDir: "asc", minRecords: 1,
    faq: [{ question: "How much does {name} cost?", answer: "{name} starts from RM {price_from}, confirmed in a written quote." }], status: "active", createdAt: at, updatedAt: at,
  };
  await upsertTemplate(db, template);
  const records: DataRecord[] = await listAllRecords(db, template.datasetId, 1_000);
  const generated = generatePages({ siteId: DEMO_SITE_ID, siteName: "Demo Dental Clinic", template, dataset: datasets[1]!.dataset, records, mountPath: "/guides", now: new Date(at) });
  await syncTemplatePages(db, template.id, generated);
  await setTemplatePublication(db, template.id, true);

  // Ninety days of per-page metrics: search grows as pages get indexed; visits and WhatsApp taps follow.
  const { results: live } = await db.prepare("SELECT id, path FROM generated_pages WHERE template_id = ? AND status = 'published' ORDER BY path").bind(template.id).all<{ id: string; path: string }>();
  const statements = [];
  const searched: Parameters<typeof replacePageSearchMetrics>[2] = [];
  for (const [p, page] of live.entries()) {
    let clicks28 = 0;
    let impressions28 = 0;
    const weight = 1 / (1 + p * 0.15);
    for (let d = 89; d >= 0; d--) {
      const day = new Date(now - d * DAY).toISOString().slice(0, 10);
      const growth = Math.min(1, (90 - d) / 60);
      const wave = 1 + 0.25 * Math.sin((d + p) / 3.5);
      const impressions = Math.round(220 * weight * growth * wave);
      const clicks = Math.round(impressions * (0.02 + 0.03 * growth));
      const views = Math.round(clicks * 1.3 + (d % 7 === 0 ? 2 : 0));
      if (d >= 2 && d < 30) { clicks28 += clicks; impressions28 += impressions; }
      statements.push(db.prepare(
        `INSERT INTO page_metrics_daily (site_id, page_id, day, googlebot_hits, views, cta_clicks, search_clicks, search_impressions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(page_id, day) DO NOTHING`,
      ).bind(DEMO_SITE_ID, page.id, day, 1 + ((d + p) % 4), views, Math.round(views * 0.08), clicks, impressions));
    }
    // The last 28 days of Search Console rows per page, split across two queries, as a sync stores them.
    const name = page.path.split("/").pop()!.replace(/-/g, " ");
    for (const [query, share, position] of [[`${name} price malaysia`, 0.7, 6 + (p % 7)], [`${name} cost`, 0.3, 9 + (p % 5)]] as const) {
      const shown = Math.round(impressions28 * share);
      const clicked = Math.round(clicks28 * share);
      searched.push({ pageUrl: `${ORIGIN}${page.path}`, query, clicks: clicked, impressions: shown, ctr: shown ? clicked / shown : 0, position, periodStart: new Date(now - 30 * DAY).toISOString().slice(0, 10), periodEnd: new Date(now - 2 * DAY).toISOString().slice(0, 10) });
    }
  }
  await replacePageSearchMetrics(db, DEMO_SITE_ID, searched);
  // AI agents reading the guides since go-live: crawlers steady, live fetches (an assistant answering someone) growing. CCBot and Bytespider are blocked in robots.txt.
  const agents: Array<[string, number, number]> = [
    ["GPTBot", 3, 0], ["OAI-SearchBot", 2, 1], ["ChatGPT-User", 0, 6], ["ClaudeBot", 2, 0], ["Claude-SearchBot", 1, 1], ["Claude-User", 0, 2],
    ["PerplexityBot", 2, 1], ["Perplexity-User", 0, 4], ["Meta-ExternalAgent", 2, 0], ["Amazonbot", 1, 0], ["DeepSeekBot", 1, 0], ["GoogleOther", 1, 0],
  ];
  for (let d = 79; d >= 0; d--) {
    const day = new Date(now - d * DAY).toISOString().slice(0, 10);
    const growth = Math.min(1, (80 - d) / 60);
    const page = live[d % Math.max(1, Math.min(live.length, 12))];
    if (!page) break;
    for (const [agent, steady, rising] of agents) {
      const count = Math.round(steady * (1 + ((d + agent.length) % 3) * 0.5) + rising * growth * (1 + 0.3 * Math.sin(d / 4)));
      if (count) statements.push(db.prepare("INSERT INTO ai_page_daily (site_id, page_id, day, signal, name, count) VALUES (?, ?, ?, 'fetch', ?, ?)").bind(DEMO_SITE_ID, page.id, day, agent, count));
    }
    for (const [assistant, rate] of [["chatgpt", 3], ["perplexity", 1.2], ["gemini", 0.6], ["copilot", 0.3], ["deepseek", 0.4]] as const) {
      const count = Math.round(rate * growth * (1 + 0.4 * Math.sin((d + rate) / 3)));
      if (count) statements.push(db.prepare("INSERT INTO ai_page_daily (site_id, page_id, day, signal, name, count) VALUES (?, ?, ?, 'referral', ?, ?)").bind(DEMO_SITE_ID, page.id, day, assistant, count));
    }
  }
  for (const group of chunks(statements, 100)) await runStatements(db, group);

  for (let i = 0; i < 260; i++) {
    const page = live[i % Math.max(live.length, 1)];
    const occurredAt = new Date(now - ((i * 7919) % (88 * DAY / 60_000)) * 60_000 - DAY).toISOString();
    // The visitor first landed on a generated page, so the enquiry is attributed to it.
    const source = i % 9 === 0 ? "ai:chatgpt" : i % 13 === 0 ? "ai:perplexity" : i % 3 === 0 ? "other" : "search";
    if (page) await recordLandingSession(db, { siteId: DEMO_SITE_ID, sessionId: `session_demo_${i % 180}`, pageId: page.id, source });
    await insertConversionEvent(db, {
      id: `event_demo_${i}`, siteId: DEMO_SITE_ID, event: i % 5 === 0 ? "form_submit" : i % 11 === 0 ? "phone_click" : "whatsapp_click",
      ...(page ? { pageUrl: `${ORIGIN}${page.path}` } : {}), sessionId: `session_demo_${i % 180}`, occurredAt,
    });
  }
  await seedDemoLeads(db, live, now);
  // The proxy rule was verified when the guides went live, so the engine's pages count as live on the clinic's domain.
  const goLive = new Date(now - 80 * DAY).toISOString();
  await upsertPageSettings(db, {
    ...defaultPageSettings(DEMO_SITE_ID, "Demo Dental Clinic", ORIGIN),
    ctaLabel: "WhatsApp us", ctaUrl: "https://wa.me/60123456789", ctaCopy: "Ask about price and availability at your nearest clinic.",
    currency: "MYR", verifiedAt: goLive, updatedAt: goLive,
  });
  // A CTA test that has run since go-live: the price-led copy is ahead.
  for (const [id, label, copy, impressions, clicks] of [
    ["cta_demo_a", "WhatsApp us", "Ask about price and availability at your nearest clinic.", 4120, 297],
    ["cta_demo_b", "Get my price", "Send your treatment and get a written price on WhatsApp.", 4065, 388],
  ] as const) {
    await db.prepare("INSERT INTO cta_variants (id, site_id, label, copy, url, impressions, clicks, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .bind(id, DEMO_SITE_ID, label, copy, "https://wa.me/60123456789", impressions, clicks, goLive).run();
  }
  // Three snippet rewrites Eumon suggested and the user applied, far enough back to show their effect.
  for (const [index, [field, back]] of ([["title", 40], ["description", 33], ["title", 26]] as const).entries()) {
    const page = live[index * 5];
    if (!page) continue;
    const before = await db.prepare("SELECT title, description FROM generated_pages WHERE id = ?").bind(page.id).first<{ title: string; description: string }>();
    const name = page.path.split("/").pop()!.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
    const [after, reason] = field === "title"
      ? [`${name}: price at 11 clinics in Malaysia, written quote on WhatsApp`, "Skipped on page one: the title didn't answer the price searches it ranks for"]
      : [`${name} at 11 clinics in Malaysia and Singapore. See the price, then WhatsApp for a written quote.`, "Low click-through near the top of page one; the snippet now leads with the price"];
    await db.prepare("INSERT INTO page_revisions (id, page_id, field, before_value, after_value, reason, author, created_at) VALUES (?, ?, ?, ?, ?, ?, 'operator', ?)")
      .bind(`rev_demo_${index}`, page.id, field, (field === "title" ? before?.title : before?.description) ?? "", after, reason, new Date(now - back * DAY).toISOString()).run();
  }
  await saveSiteScope(db, DEMO_SITE_ID, {
    goal: "More WhatsApp enquiries for implants and braces from patients in Malaysia and Singapore",
    businessSummary: "Demo data: a fictional group of 11 dental clinics in Malaysia and Singapore.",
    conversionGoal: "A WhatsApp enquiry or a booking form submission",
  });
}

/**
 * WhatsApp leads with reference codes over 80 days: most from visitors who
 * landed on a treatment guide, some from the rest of the site, and a few
 * entered by hand. About half became chats, a third of those qualified, and
 * some became customers worth the treatment's price.
 */
async function seedDemoLeads(db: D1Like, live: Array<{ id: string; path: string }>, now: number) {
  const code = (n: number) => Array.from({ length: REF_LENGTH }, (_, k) => REF_ALPHABET[(n * 7 + k * 13 + Math.floor(n / (k + 1))) % REF_ALPHABET.length]).join("");
  const at = (ms: number) => new Date(Math.min(ms, now - 60_000)).toISOString();
  for (let i = 0; i < 150; i++) {
    const clicked = now - ((i * 4271) % (80 * 24 * 60)) * 60_000 - 3 * 3600_000;
    const fromGuide = i % 6 !== 1;
    const page = live[(i * 3) % Math.max(live.length, 1)];
    const sessionId = fromGuide ? `session_lead_${i}` : `session_main_${i}`;
    if (fromGuide && page) await recordLandingSession(db, { siteId: DEMO_SITE_ID, sessionId, pageId: page.id, source: i % 8 === 0 ? "ai:chatgpt" : i % 5 === 0 ? "other" : "search" });
    const id = `lead_demo_${i}`;
    await recordLeadClick(db, { id, siteId: DEMO_SITE_ID, ref: `${code(i)}`, sessionId, pageUrl: fromGuide && page ? `${ORIGIN}${page.path}` : `${ORIGIN}/contact`, placement: fromGuide ? ["hero", "sticky", "footer-band"][i % 3] : "main site", at: at(clicked) });
    // Recent clicks are still waiting for staff to match them.
    if (now - clicked < 2 * DAY || i % 9 === 4) continue;
    if (i % 2 === 0 || i % 7 === 0) {
      await updateLead(db, DEMO_SITE_ID, id, { status: "chat", at: at(clicked + 15 * 60_000) });
      if (i % 3 === 0) await updateLead(db, DEMO_SITE_ID, id, { status: "qualified", at: at(clicked + DAY) });
      if (i % 3 === 0 && i % 4 === 0) await updateLead(db, DEMO_SITE_ID, id, { status: "won", value: 900 + ((i * 137) % 40) * 150, at: at(clicked + 6 * DAY) });
      else if (i % 10 === 2) await updateLead(db, DEMO_SITE_ID, id, { status: "lost", at: at(clicked + 3 * DAY) });
    }
  }
  for (const [n, channel] of [[1, "phone"], [2, "walk-in"], [3, "phone"]] as const) {
    await createLead(db, { id: `lead_demo_manual_${n}`, siteId: DEMO_SITE_ID, channel, at: new Date(now - n * 9 * DAY).toISOString() });
  }
}

/**
 * A Search Console export as a real one looks: most of the catalogue found but
 * not crawled, dentist pages Google saw as noindex that are indexable now, old
 * slugs that redirect or are gone (a dozen matching a live page), the overview
 * table, and sixteen weeks of indexed counts. Live checks are pre-recorded:
 * the demo never fetches outside.
 */
async function seedDemoSearchConsole(db: D1Like, now: number) {
  const at = new Date(now - 3 * DAY).toISOString();
  const { results } = await db.prepare("SELECT url, route_family AS family FROM pages WHERE analysis_id = 'analysis_demo_1' AND crawl_state = 'complete' AND status < 400 ORDER BY url").all<{ url: string; family: string }>();
  const prices = results.filter((row) => row.family === "prices").map((row) => row.url);
  const dentists = results.filter((row) => row.family === "dentists").map((row) => row.url);
  const live = dentists.slice(0, 70);
  // Old slugs: a year ago the dentist pages had no "dr-" and only two name parts.
  const shortSlug = (url: string) => url.replace(/\/dentists\/([^/]+)$/, (_, slug: string) => `/dentists/${slug.replace(/^dr-/, "").split("-").slice(0, 2).join("-")}`);
  const redirected = dentists.slice(0, 50).map((url) => ({ url: `${url}-2019`, to: url }));
  const gone = dentists.slice(0, 20).map(shortSlug).filter((url) => !dentists.includes(url));
  const list = (urls: string[]) => urls.map((url) => ({ url, lastCrawled: at.slice(0, 10) }));
  await importSearchConsoleUrls(db, DEMO_SITE_ID, { reason: "discovered", reasonText: "Discovered – currently not indexed", urls: list(prices), importedAt: at });
  await importSearchConsoleUrls(db, DEMO_SITE_ID, { reason: "noindex", reasonText: "Excluded by 'noindex' tag", urls: list([...live, ...redirected.map((entry) => entry.url), ...gone]), importedAt: at });
  await saveSearchConsoleChecks(db, DEMO_SITE_ID, [
    ...redirected.map((entry) => ({ url: entry.url, status: 200, finalUrl: entry.to, noindex: false, suggestedUrl: null })),
    ...gone.map((url) => ({ url, status: 404, finalUrl: null, noindex: null, suggestedUrl: suggestRedirect(url, dentists) })),
  ]);
  const indexed = 300;
  await saveSearchConsoleSummary(db, DEMO_SITE_ID, [
    { reason: "indexed", reasonText: "Indexed", source: null, validation: null, pages: indexed },
    { reason: "discovered", reasonText: "Discovered – currently not indexed", source: "Google systems", validation: "Not Started", pages: prices.length },
    { reason: "noindex", reasonText: "Excluded by 'noindex' tag", source: "Website", validation: "Failed", pages: live.length + redirected.length + gone.length },
    { reason: "crawled", reasonText: "Crawled – currently not indexed", source: "Google systems", validation: "Not Started", pages: 9 },
    { reason: "not_found", reasonText: "Not found (404)", source: "Website", validation: "Not Started", pages: gone.length },
  ], at);
  await saveSearchConsoleChart(db, DEMO_SITE_ID, Array.from({ length: 16 }, (_, week) => {
    const back = 15 - week;
    return { day: new Date(now - (back * 7 + 3) * DAY).toISOString().slice(0, 10), indexed: Math.round(indexed * (1 - back / 18)), notIndexed: Math.round((prices.length + 200) * (1 - back / 24)) };
  }));
}

/** One pull request, merged between the two analyses, for a first-run finding the second run no longer reports: History's "Fixed with Eumon" row. */
async function seedDemoFix(db: D1Like, now: number) {
  type Reported = { findings: Finding[] };
  const [first, second] = await Promise.all([getAnalysisJob(db, "analysis_demo_1"), getAnalysisJob(db, "analysis_demo_2")]);
  const after = new Set((second?.report as Reported | undefined)?.findings.map(keyOf) ?? []);
  const fixed = (first?.report as Reported | undefined)?.findings.find((finding) => !after.has(keyOf(finding)));
  if (!fixed) return;
  await insertChange(db, {
    id: "change_demo_1", siteId: DEMO_SITE_ID, analysisId: "analysis_demo_1", findingId: fixed.id, title: fixed.title,
    reason: fixed.recommendation ?? fixed.summary, evidence: {}, filesChanged: ["app/prices/[city]/page.tsx"], pagesAffected: fixed.pagesAffected ?? [], patch: "",
    status: "merged", prUrl: "https://github.com/demo-clinic/site/pull/12", prNumber: 12, author: "eumon", createdAt: new Date(now - 20 * DAY).toISOString(),
  });
}

/**
 * Rebuilds the demo site: two finished analyses a month apart (so changes
 * show), Search Console rows, datasets with a live template, and conversions.
 */
export async function seedDemoSite(db: D1Like, now = Date.now()): Promise<{ siteId: string }> {
  await deleteSite(db, DEMO_SITE_ID);
  const created = new Date(now - 95 * DAY).toISOString();
  await upsertSite(db, { id: DEMO_SITE_ID, name: "Demo Dental Clinic (demo data)", baseUrl: ORIGIN, gscProperty: "sc-domain:demo-clinic.example", createdAt: created, updatedAt: created });
  await setSiteMarkets(db, DEMO_SITE_ID, ["mys", "sgp"]);
  await setSiteCompetitorDomains(db, DEMO_SITE_ID, COMPETITORS);
  await replaceCurrentSearchMetrics(db, DEMO_SITE_ID, demoSearchRows(now));
  await seedPageEngine(db, now);
  // Before the analyses, which read the crawl log.
  await seedDemoConnectors(db, demoConnectorInput(), now);
  await completedAnalysis(db, "analysis_demo_1", 1, now - 30 * DAY);
  await seedDemoSearchConsole(db, now);
  await completedAnalysis(db, "analysis_demo_2", 2, now - 2 * DAY);
  await seedDemoFix(db, now);
  await seedDemoResults(db, now);
  return { siteId: DEMO_SITE_ID };
}

/** URLs fetched per second in a simulated run: about four minutes for the whole site, so the estimate shows. */
const DEMO_RATE = 8;

/** Starts a simulated run on the demo site; each progress poll advances it (`advanceDemoRun`). */
export async function startDemoRun(db: D1Like, input: { analysisId: string; full: boolean; now?: number }): Promise<void> {
  const now = input.now ?? Date.now();
  await createAnalysis(db, { id: input.analysisId, siteId: DEMO_SITE_ID, status: "running", createdAt: new Date(now).toISOString() });
  await updateAnalysisStatus(db, input.analysisId, "running");
  await updateAnalysisProgress(db, input.analysisId, "sitemap", "Reading the sitemap");
  const queued = await queueFullCrawl(db, { analysisId: input.analysisId, siteId: DEMO_SITE_ID, baseUrl: ORIGIN, maxUrls: 25_000, full: input.full, fetcher: demoFetcher(3, now), now });
  await updateAnalysisProgress(db, input.analysisId, "sitemap", "Reading the sitemap", { declared: queued.declared, reused: queued.reused, ...(queued.reusedFrom ? { reusedFrom: queued.reusedFrom } : {}) });
}

/**
 * Moves a simulated run forward to where it would be by now: the sitemap for
 * a few seconds, then the crawl at DEMO_RATE, each competitor, and the report.
 * ponytail: concurrent polls may crawl the same batch twice; the writes are idempotent.
 */
export async function advanceDemoRun(db: D1Like, analysisId: string, now = Date.now()): Promise<void> {
  const job = await getAnalysisJob(db, analysisId);
  if (!job || job.siteId !== DEMO_SITE_ID || job.status !== "running" || !job.progress) return;
  const since = (stage: string) => now - Date.parse(job.progress?.history?.find((entry) => entry.stage === stage)?.at ?? new Date(now).toISOString());
  const stage = job.progress.stage;
  if (stage === "sitemap") {
    if (since("sitemap") < 4_000) return;
    await updateAnalysisProgress(db, analysisId, "crawl", "Crawling sitemap URLs as Googlebot", job.progress.detail);
  } else if (stage === "crawl") {
    const progress = await getCrawlProgress(db, analysisId);
    const due = Math.min(400, Math.floor((since("crawl") / 1000) * DEMO_RATE) - progress.crawled);
    const urls = due > 0 ? await listPendingCrawlUrls(db, analysisId, due) : [];
    if (urls.length) {
      const outcomes = await crawlGooglebotBatch(urls, demoFetcher(3, now), 20);
      await saveCrawlBatch(db, { analysisId, outcomes: outcomes.map((outcome) => ("page" in outcome ? outcome : { url: outcome.url, error: outcome.error })) });
      await updateAnalysisProgress(db, analysisId, "crawl", `Crawled ${(progress.crawled + urls.length).toLocaleString()} of ${(progress.crawled + progress.pending).toLocaleString()} sitemap URLs as Googlebot`, job.progress.detail);
    } else if (progress.pending === 0) {
      await updateAnalysisProgress(db, analysisId, "competitors", "Reading competitor sitemaps and sample pages", job.progress.detail);
    }
  } else if (stage === "competitors") {
    const done = Math.floor(since("competitors") / 3_000);
    if (done < COMPETITORS.length) {
      const domain = COMPETITORS[done]!;
      if (job.progress.detail?.competitor !== domain) await updateAnalysisProgress(db, analysisId, "competitors", `Reading ${domain}`, { ...job.progress.detail, competitor: domain, done, of: COMPETITORS.length });
    } else {
      await updateAnalysisProgress(db, analysisId, "analysis", "Checking rendering, indexing, and search data", job.progress.detail);
    }
  } else if (stage === "analysis" && since("analysis") >= 3_000) {
    await updateAnalysisProgress(db, analysisId, "saving", "Saving findings and growth plan", job.progress.detail);
    const detail = job.progress.detail ?? {};
    await analyzeDemo(db, {
      analysisId, version: 3, now, declared: Number(detail.declared ?? 0),
      reused: Number(detail.reused) ? { urls: Number(detail.reused), ...(detail.reusedFrom ? { from: String(detail.reusedFrom) } : {}) } : undefined,
    });
  }
}

/**
 * Fictional Results history for the demo: Search Console and GA4 back 16
 * months, growth after Eumon's guides went live 80 days ago, weekly ranking
 * buckets, and index statuses. Real sites get these from the daily sync.
 */
async function seedDemoResults(db: D1Like, now: number) {
  const today = new Date(now).toISOString().slice(0, 10);
  const goLive = addDays(today, -80);
  // A fictional GA4 property, so the view shows the organic sessions below.
  await updateSiteGa4Property(db, DEMO_SITE_ID, "properties/0");
  await db.prepare("UPDATE generated_pages SET published_at = ? WHERE site_id = ? AND status = 'published'").bind(`${goLive}T02:00:00.000Z`, DEMO_SITE_ID).run();
  const points: MetricPoint[] = [];
  for (let back = 486; back >= 1; back--) {
    const day = addDays(today, -back);
    const live = day >= goLive;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const season = 1 + 0.12 * Math.sin(back / 24) - (weekday === 0 || weekday === 6 ? 0.18 : 0);
    const lift = live ? 1 + Math.min(1, (80 - back + 1) / 60) * 0.55 : 1;
    const clicks = Math.round(70 * season * lift);
    const impressions = Math.round(2600 * season * (live ? lift * 1.1 : 1));
    const position = live ? 11 - Math.min(1, (80 - back) / 60) * 2.5 : 11;
    points.push(
      { metric: "search_clicks", day, value: clicks },
      { metric: "search_impressions", day, value: impressions },
      { metric: "search_position_weight", day, value: impressions * position },
      { metric: "search_clicks@markets", day, value: Math.round(clicks * 0.93) },
      { metric: "search_impressions@markets", day, value: Math.round(impressions * 0.9) },
      { metric: "search_position_weight@markets", day, value: Math.round(impressions * 0.9) * (position - 0.4) },
      { metric: "ga4_sessions", day, value: Math.round(clicks * 2.6) },
      { metric: "ga4_organic_sessions", day, value: Math.round(clicks * 1.15) },
      { metric: "ga4_organic_engaged_sessions", day, value: Math.round(clicks * 0.8) },
      { metric: "ga4_organic_key_events", day, value: Math.round(clicks * 0.05) },
    );
    // AI assistants have sent a trickle of visitors for a year, growing since the guides went live.
    if (back <= 365) {
      const chatgpt = Math.round(clicks * (live ? 0.05 * lift : 0.03) * (1 + ((back % 5) - 2) * 0.1));
      const perplexity = Math.round(chatgpt * 0.35);
      const gemini = Math.round(chatgpt * 0.2);
      const deepseek = Math.round(chatgpt * 0.12);
      points.push(
        { metric: "ga4_ai_sessions", day, value: chatgpt + perplexity + gemini + deepseek },
        { metric: "ga4_ai_sessions.chatgpt", day, value: chatgpt },
        { metric: "ga4_ai_sessions.perplexity", day, value: perplexity },
        { metric: "ga4_ai_sessions.gemini", day, value: gemini },
        { metric: "ga4_ai_sessions.deepseek", day, value: deepseek },
        { metric: "ga4_ai_key_events", day, value: Math.round((chatgpt + perplexity + gemini + deepseek) * 0.08) },
      );
    }
    if (live) {
      const eumonClicks = Math.round(clicks * Math.min(0.32, (80 - back + 1) / 200));
      points.push(
        { metric: "eumon_search_clicks", day, value: eumonClicks },
        { metric: "eumon_search_impressions", day, value: eumonClicks * 38 },
        { metric: "eumon_search_position_weight", day, value: eumonClicks * 38 * 9 },
      );
    }
  }
  for (let week = 0; week < 16; week++) {
    const day = addDays(today, -7 * week);
    const growth = Math.max(0, 16 - week);
    // Question searches ("how much does … cost") in each 28-day query list, as the daily sync derives them.
    points.push(
      { metric: "question_queries", day: addDays(day, -3), value: 31 + growth * 2 },
      { metric: "question_clicks", day: addDays(day, -3), value: 120 + growth * 14 },
      { metric: "question_impressions", day: addDays(day, -3), value: 5200 + growth * 310 },
    );
    for (const [top, base] of [[3, 14], [10, 52], [20, 118], [100, 290]] as const) {
      const queries = base + growth * (top === 3 ? 1 : 3);
      for (const suffix of ["", "@markets"]) {
        points.push(
          { metric: `queries_top${top}${suffix}`, day, value: suffix ? Math.round(queries * 0.9) : queries },
          { metric: `queries_top${top}.new${suffix}`, day, value: 2 + (week % 3) },
          { metric: `queries_top${top}.lost${suffix}`, day, value: week % 2 },
        );
      }
    }
  }
  await upsertMetricPoints(db, DEMO_SITE_ID, points);
  const { results: guides } = await db.prepare("SELECT id FROM generated_pages WHERE site_id = ? AND status = 'published' ORDER BY path").bind(DEMO_SITE_ID).all<{ id: string }>();
  await saveIndexStatus(db, DEMO_SITE_ID, guides.slice(0, 52).map((page, index) => ({
    pageId: page.id,
    verdict: index < 40 ? "PASS" : "NEUTRAL",
    coverageState: index < 40 ? "Submitted and indexed" : "Discovered - currently not indexed",
    lastCrawlTime: index < 40 ? `${addDays(today, -(index % 9) - 1)}T03:00:00Z` : null,
  })));
  // Fictional top queries over the last 28 finalized days, each beside the 28 before.
  const queries: Array<[string, number, number, number, [number, number, number] | null]> = [
    ["dental implants kuala lumpur", 64, 1830, 4.2, [41, 1650, 5.6]],
    ["braces price malaysia", 52, 2410, 6.1, [47, 2290, 6.4]],
    ["demo dental clinic", 48, 310, 1.1, [44, 290, 1.2]],
    ["scaling and polishing cost", 37, 1480, 5.3, [22, 1210, 7.9]],
    ["invisalign singapore price", 29, 2050, 8.7, [33, 2120, 8.1]],
    ["dentist penang", 24, 960, 6.8, [15, 820, 9.4]],
    ["wisdom tooth removal cost kl", 21, 770, 5.9, null],
    ["root canal treatment price", 18, 690, 7.2, [19, 640, 7.0]],
    ["teeth whitening johor bahru", 12, 540, 9.6, null],
    ["paediatric dentist petaling jaya", 9, 330, 8.3, [4, 260, 12.5]],
  ];
  await saveTopQueriesSnapshot(db, DEMO_SITE_ID, {
    property: "sc-domain:demo-clinic.example", markets: ["mys", "sgp"], periodEnd: addDays(today, -3),
    rows: queries.map(([query, clicks, impressions, position, was]) => ({
      query, clicks, impressions, position, before: was ? { clicks: was[0], impressions: was[1], position: was[2] } : null,
    })),
  });
  // Fictional real-user speed: 30 weeks for phones and desktops, phones slower, both improving after go-live.
  const speed: MetricPoint[] = [{ metric: "sync.crux", day: today, value: 1 }];
  for (let week = 29; week >= 0; week--) {
    const day = addDays(today, -2 - week * 7);
    const after = day >= addDays(today, -80) ? 0.8 : 1;
    speed.push(
      { metric: "crux_lcp_p75.phone", day, value: Math.round(4300 * after + (week % 4) * 60) },
      { metric: "crux_lcp_p75.desktop", day, value: Math.round(2300 * after + (week % 3) * 40) },
      { metric: "crux_inp_p75.phone", day, value: Math.round(320 * after) },
      { metric: "crux_inp_p75.desktop", day, value: Math.round(140 * after) },
      { metric: "crux_cls_p75.phone", day, value: 0.12 },
      { metric: "crux_cls_p75.desktop", day, value: 0.05 },
    );
  }
  const competitors = await listSiteCompetitorDomains(db, DEMO_SITE_ID);
  await upsertMetricPoints(db, DEMO_SITE_ID, [
    ...speed,
    { metric: "lab_score_home.phone", day: today, value: 41 }, { metric: "lab_score_home.desktop", day: today, value: 78 },
    { metric: "lab_score_eumon.phone", day: today, value: 96 }, { metric: "lab_score_eumon.desktop", day: today, value: 99 },
    ...[0, 1, 2, 3].map((month) => ({ metric: "authority", day: addDays(today, -month * 30), value: 1.6 + (3 - month) * 0.1 })),
    ...competitors.map((domain, index) => ({ metric: `authority:${domain}`, day: today, value: 2.4 - index * 0.9 })),
  ]);
  // Fictional URL Inspection results for a sample of the latest crawl's pages.
  const { results: sample } = await db.prepare(
    `SELECT url, family FROM (
       SELECT url, route_family AS family, ROW_NUMBER() OVER (PARTITION BY route_family ORDER BY url) AS turn
       FROM pages WHERE analysis_id = 'analysis_demo_2' AND crawl_state = 'complete' AND status < 400)
     ORDER BY turn, family LIMIT 600`,
  ).all<{ url: string; family: string }>();
  const states = ["Submitted and indexed", "Submitted and indexed", "Submitted and indexed", "Crawled - currently not indexed", "Discovered - currently not indexed", "URL is unknown to Google"];
  await saveUrlIndexStatus(db, DEMO_SITE_ID, sample.map((row, index) => {
    const state = row.family === "prices" && index % 2 ? "Discovered - currently not indexed" : states[index % states.length]!;
    return {
      url: row.url, family: row.family, verdict: state === "Submitted and indexed" ? "PASS" : "NEUTRAL", coverageState: state,
      lastCrawlTime: state.startsWith("Submitted") || state.startsWith("Crawled") ? `${addDays(today, -(index % 40))}T02:00:00Z` : null,
    };
  }));
  await seedDemoKeywords(db, now);
  // Three syncs for the history in Setup: two clean daily runs, and a Sync now where Analytics refused the token.
  const ran = (daysBack: number, hour: number) => new Date(now - daysBack * DAY + hour * 3600_000).toISOString();
  const clean = ["speed: 2 weeks", "lab: 2 scores", "authority: 3 domains", "search: 7 days", "search@markets: 7 days", "rankings: skipped (Mondays)", "inspected 52 pages", "coverage: inspected 50 in 2 steps", "analytics: 7 days", "keywords: lists fresh",
    "search competitors: lists fresh", "search results: 10 pages checked, $0.04", "backlinks: lists fresh", "bing: 14 days", "indexnow: nothing changed", "crawl log: 64 Googlebot and 12 Bingbot requests yesterday"];
  await recordSyncRun(db, { id: "sync_demo_1", siteId: DEMO_SITE_ID, trigger: "daily", startedAt: ran(2, 4.25), finishedAt: ran(2, 4.27), notes: clean });
  await recordSyncRun(db, { id: "sync_demo_2", siteId: DEMO_SITE_ID, trigger: "manual", startedAt: ran(1, 9.1), finishedAt: ran(1, 9.12),
    notes: [...clean.filter((note) => !note.startsWith("analytics")), "analytics failed: Google Analytics report request failed (403): The caller does not have permission. Reconnect Google in Setup."] });
  await recordSyncRun(db, { id: "sync_demo_3", siteId: DEMO_SITE_ID, trigger: "daily", startedAt: ran(1, 4.25), finishedAt: ran(1, 4.28), notes: clean });
  await syncFirstPartyResults(db, DEMO_SITE_ID, new Date(now));
}
