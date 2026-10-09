import type { DataRecord, Dataset, PageTemplate, PricedKeyword, RankedKeyword, SearchMetricRow } from "@organic-growth/core";
import { addDays, slugify } from "@organic-growth/core";
import { crawlGooglebotBatch, researchSite, type Fetcher, type SiteResearch } from "@organic-growth/crawler";
import {
  chunks, createAnalysis, datasetCoverage, deleteSite, getAnalysisJob, getCrawlCoverage, getCrawlProgress, insertConversionEvent, listAllRecords,
  listCrawlPageResults, listPendingCrawlUrls, recordLandingSession, replaceCurrentSearchMetrics, replacePageSearchMetrics, runStatements, saveAnalysisReport, saveCrawlBatch,
  saveIndexStatus, saveSiteScope, saveSnapshot, saveTopQueriesSnapshot, saveUrlIndexStatus, listSiteCompetitorDomains, setSiteCompetitorDomains, syncFirstPartyResults, updateSiteGa4Property, upsertMetricPoints, type MetricPoint, setSiteMarkets, setTemplatePublication, syncTemplatePages, updateAnalysisProgress,
  updateAnalysisStatus, upsertDataset, upsertRecords, upsertSite, upsertTemplate, type D1Like,
} from "@organic-growth/db";
import { generatePages } from "@organic-growth/pages";
import { queueFullCrawl, runFullAnalysis } from "./pipeline.js";

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
const BLOG = Array.from({ length: 900 }, (_, i) => `${TREATMENTS[i % TREATMENTS.length]}-guide-${i + 1}`);

type Page = { path: string; family: string; index: number };

/** Every URL the demo sitemap lists: about 1,800 across six page types. */
function demoPages(): Page[] {
  const pages: Page[] = [{ path: "/", family: "home", index: 0 }];
  PAGES.forEach((slug, index) => pages.push({ path: `/${slug}`, family: "page", index }));
  DENTISTS.forEach((dentist, index) => pages.push({ path: `/dentists/${dentist.slug}`, family: "dentists", index }));
  TREATMENT_LIST.forEach((treatment, index) => pages.push({ path: `/treatments/${treatment.slug}`, family: "treatments", index }));
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
  if (first && !second && PAGES.includes(first)) return { status: 200, body: document({ path, title: `${title(first)} | Demo Dental Clinic`, description: `${title(first)} at Demo Dental Clinic.`, h1: title(first), body: `<p>${PROSE.repeat(2)}</p>`, tracking: true }) };
  if (first === "dentists" && second && !third) {
    const index = DENTISTS.findIndex((dentist) => dentist.slug === second);
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
    return { status: 200, body: document({ path, title: `${title(slug!)} | Demo Dental Clinic blog`, description: `A guide from our dentists.`, h1: title(slug!), body: `<p>${PROSE.repeat(2)}</p>`, robots: index % 25 === 3 ? "noindex, follow" : undefined }) };
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
  return async (url) => {
    const target = new URL(url);
    const reply = (status: number, body: string, type = "text/html") => ({ url, status, finalUrl: url, headers: { "content-type": type }, body });
    if (target.hostname === "demo-clinic.example") {
      if (target.pathname === "/robots.txt") return reply(200, "User-agent: *\nDisallow: /search\nDisallow: /blog/drafts/\nSitemap: https://demo-clinic.example/sitemap.xml\n", "text/plain");
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

/** Analyses a crawled demo run with the real pipeline and saves the report. */
async function analyzeDemo(db: D1Like, input: { analysisId: string; version: number; declared: number; reused?: { urls: number; from?: string }; now: number }) {
  const fetcher = demoFetcher(input.version, input.now);
  const research: SiteResearch[] = [];
  for (const domain of COMPETITORS) research.push(await researchSite(domain, fetcher, { maxFiles: 5, maxUrls: 5_000 }));
  const [coverage, examples, datasets] = await Promise.all([
    getCrawlCoverage(db, input.analysisId),
    listCrawlPageResults(db, input.analysisId, 50),
    datasetCoverage(db, DEMO_SITE_ID),
  ]);
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
    competitorResearch: research,
    datasets,
    targetMarkets: ["mys", "sgp"],
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
  const { results } = await db.prepare("SELECT id FROM pages WHERE analysis_id = ? AND crawled_at IS NOT NULL ORDER BY url").bind(analysisId).all<{ id: string }>();
  const step = (minutes * 60_000) / Math.max(results.length, 1);
  const start = end - minutes * 60_000;
  const statements = results.map((row, index) => db.prepare("UPDATE pages SET crawled_at = ? WHERE id = ?").bind(new Date(start + index * step).toISOString(), row.id));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

async function completedAnalysis(db: D1Like, id: string, version: number, at: number) {
  await createAnalysis(db, { id, siteId: DEMO_SITE_ID, status: "running", createdAt: new Date(at - 8 * 60_000).toISOString() });
  await updateAnalysisStatus(db, id, "running", { startedAt: new Date(at - 7 * 60_000).toISOString() });
  const queued = await queueFullCrawl(db, { analysisId: id, siteId: DEMO_SITE_ID, baseUrl: ORIGIN, maxUrls: 25_000, full: true, fetcher: demoFetcher(version, at), now: at });
  await crawlAll(db, id, version, at - 60_000, 6);
  await analyzeDemo(db, { analysisId: id, version, declared: queued.declared, now: at });
  await updateAnalysisStatus(db, id, "completed", { completedAt: new Date(at).toISOString() });
}

const DENTIST_FIELDS: Dataset["fields"] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "specialty", label: "Specialty", type: "text" },
  { key: "clinic", label: "Clinic", type: "text" },
  { key: "years", label: "Years of experience", type: "number" },
  { key: "languages", label: "Languages", type: "list" },
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
      records: DENTISTS.slice(0, 128).map((dentist, i) => ({ name: dentist.name, specialty: dentist.specialty, clinic: title(dentist.clinic), years: dentist.years, languages: i % 3 ? ["English", "Malay"] : ["English", "Mandarin", "Malay"] })),
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
        `INSERT INTO page_metrics_daily (site_id, page_id, day, googlebot_hits, other_bot_hits, views, cta_clicks, search_clicks, search_impressions, search_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(page_id, day) DO NOTHING`,
      ).bind(DEMO_SITE_ID, page.id, day, 1 + ((d + p) % 4), (d + p) % 3, views, Math.round(views * 0.08), clicks, impressions, Math.max(2.5, 24 - growth * 16 + (p % 5))));
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
  for (const group of chunks(statements, 100)) await runStatements(db, group);

  for (let i = 0; i < 260; i++) {
    const page = live[i % Math.max(live.length, 1)];
    const occurredAt = new Date(now - ((i * 7919) % (88 * DAY / 60_000)) * 60_000 - DAY).toISOString();
    // The visitor first landed on a generated page, so the enquiry is attributed to it.
    if (page) await recordLandingSession(db, { siteId: DEMO_SITE_ID, sessionId: `session_demo_${i % 180}`, pageId: page.id });
    await insertConversionEvent(db, {
      id: `event_demo_${i}`, siteId: DEMO_SITE_ID, event: i % 5 === 0 ? "form_submit" : i % 11 === 0 ? "phone_click" : "whatsapp_click",
      ...(page ? { pageUrl: `${ORIGIN}${page.path}` } : {}), sessionId: `session_demo_${i % 180}`, occurredAt,
    });
  }
  await saveSiteScope(db, DEMO_SITE_ID, {
    goal: "More WhatsApp enquiries for implants and braces from patients in Malaysia and Singapore",
    businessSummary: "Demo data: a fictional group of 11 dental clinics in Malaysia and Singapore.",
    conversionGoal: "A WhatsApp enquiry or a booking form submission",
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
  await completedAnalysis(db, "analysis_demo_1", 1, now - 30 * DAY);
  await completedAnalysis(db, "analysis_demo_2", 2, now - 2 * DAY);
  await seedDemoResults(db, now);
  return { siteId: DEMO_SITE_ID };
}

/** URLs fetched per second in a simulated run: about four minutes for the whole site, so the estimate shows. */
const DEMO_RATE = 8;

/** Starts a simulated run on the demo site; each progress poll advances it (`advanceDemoRun`). */
export async function startDemoRun(db: D1Like, input: { analysisId: string; full: boolean; now?: number }): Promise<void> {
  const now = input.now ?? Date.now();
  await createAnalysis(db, { id: input.analysisId, siteId: DEMO_SITE_ID, status: "running", createdAt: new Date(now).toISOString() });
  await updateAnalysisStatus(db, input.analysisId, "running", { startedAt: new Date(now).toISOString() });
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
       SELECT url, COALESCE(json_extract(result_json, '$.routeFamily'), 'other') AS family,
         ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(result_json, '$.routeFamily'), 'other') ORDER BY url) AS turn
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
  // Fictional keyword data for Malaysia: the demo's queries priced (one unknown to DataForSEO), and ranked lists for the clinic and both competitors.
  const volumes: Array<[number | null, number, string]> = [[1900, 34, "commercial"], [2400, 41, "commercial"], [null, 0, "navigational"], [1300, 22, "commercial"], [2900, 58, "commercial"], [880, 27, "commercial"], [720, 19, "transactional"], [590, 31, "commercial"], [480, 15, "transactional"], [260, 12, "commercial"]];
  const pricedRows: PricedKeyword[] = queries.map(([query, clicks, impressions, position], index) => {
    const [volume, difficulty, intent] = volumes[index]!;
    return { keyword: query, volume, difficulty: volume === null ? null : difficulty, intent: volume === null ? null : intent, position, clicks, impressions };
  });
  await saveSnapshot(db, DEMO_SITE_ID, { kind: "keywords", scope: "sc-domain:demo-clinic.example|mys", periodEnd: addDays(today, -3), rows: pricedRows });
  const rankedRow = (keyword: string, volume: number, difficulty: number, intent: string, position: number, url: string): RankedKeyword =>
    ({ keyword, volume, difficulty, intent, position, url, traffic: Math.round(volume * (position <= 3 ? 0.2 : position <= 10 ? 0.05 : 0.01)) });
  const rankedLists: Record<string, RankedKeyword[]> = {
    "demo-clinic.example": [rankedRow("dental implants kuala lumpur", 1900, 34, "commercial", 4, "/implants"), rankedRow("braces price malaysia", 2400, 41, "commercial", 6, "/braces"), rankedRow("demo dental clinic", 300, 0, "navigational", 1, "/")],
    [competitors[0] ?? "brightcare-dental.example"]: [
      rankedRow("veneers price malaysia", 3600, 24, "commercial", 3, "/veneers-price"), rankedRow("dental implants kuala lumpur", 1900, 34, "commercial", 2, "/implants"),
      rankedRow("gum disease treatment", 2200, 18, "informational", 5, "/gum-disease"), rankedRow("emergency dentist kl", 1600, 9, "transactional", 2, "/emergency"), rankedRow("dental crown cost", 1300, 29, "commercial", 7, "/crowns"),
    ],
    [competitors[1] ?? "smile-dental.example"]: [
      rankedRow("veneers price malaysia", 3600, 24, "commercial", 8, "/veneers"), rankedRow("kids dentist kl", 900, 11, "commercial", 3, "/kids"), rankedRow("teeth cleaning price", 2600, 21, "commercial", 4, "/cleaning"),
    ],
  };
  const keywordPoints: MetricPoint[] = [{ metric: "sync.competitor_keywords", day: today, value: 1 }, { metric: "sync.keyword_volumes", day: today, value: 1 }];
  for (const [domain, rows] of Object.entries(rankedLists)) {
    await saveSnapshot(db, DEMO_SITE_ID, { kind: "competitor_keywords", scope: `${domain}|mys`, periodEnd: today, rows });
    const suffix = domain === "demo-clinic.example" ? "" : `:${domain}`;
    keywordPoints.push({ metric: `kw_top10${suffix}`, day: today, value: rows.filter((row) => row.position <= 10).length }, { metric: `kw_traffic${suffix}`, day: today, value: rows.reduce((total, row) => total + row.traffic, 0) });
  }
  await upsertMetricPoints(db, DEMO_SITE_ID, keywordPoints);
  await syncFirstPartyResults(db, DEMO_SITE_ID, new Date(now));
}
