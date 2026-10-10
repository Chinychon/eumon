import { addDays, classifyReferringDomains, spamNetworks, type BacklinkSummary, type ReferringDomain, type CompetitorSuggestion, type LinkGap, type LinksInput, type SerpCompetitor, type SerpFeature, type SerpResult } from "@organic-growth/core";
import { classifyUrlType } from "@organic-growth/crawler";
import { recordCrawlLog, referringDomainCounts, replaceReferringDomains, saveSnapshot, upsertMetricPoints, type D1Like, type MetricPoint } from "@organic-growth/db";

/*
 * The demo clinic's data from the connectors beyond Google: results pages for
 * its searches, the domains that win them, backlinks and the link gap, Bing,
 * IndexNow submissions and four months of crawl log. All fictional.
 */

type Ranked = [keyword: string, volume: number, difficulty: number | null, intent: string | null, position: number, url: string];
type Demo = { siteId: string; origin: string; own: string; competitors: string[]; ranked: Record<string, Record<string, Ranked[]>>; paths: Array<{ path: string; family: string }> };

const DIRECTORY = "practo.com";
const PUBLISHER = "smilehealth-guide.example";
const NEWCOMER = "gigi-sihat.example";

/** Google's first page for one demo search: the domains that rank it, the site where it ranks, and result types by the kind of search. */
function demoSerp(demo: Demo, market: string, [keyword, volume, , intent, position, url]: Ranked, index: number, checkedAt: string): SerpResult {
  const local = /near me|terdekat|penang|kuala lumpur|singapore|kl\b/.test(keyword) && intent === "transactional";
  const priced = /price|cost|harga/.test(keyword);
  const features: SerpFeature[] = [
    ...(priced || intent === "informational" ? ["ai_overview" as const] : []),
    ...(local ? ["local_pack" as const] : []),
    ...(index % 2 === 0 ? ["people_also_ask" as const] : []),
    ...(index % 5 === 1 ? ["video" as const] : []),
  ];
  const rivals = demo.competitors.flatMap((domain) => (demo.ranked[domain]?.[market] ?? []).filter((row) => row[0] === keyword).map((row) => ({ domain, position: row[4], url: row[5] })));
  const others = [DIRECTORY, PUBLISHER, NEWCOMER, "youtube.com", "dentalcare-asia.example", "klinikpergigian.example", "toothfacts.example", "mysmile-centre.example"];
  const organic: SerpResult["organic"] = [];
  for (let slot = 1; slot <= 10; slot++) {
    const rival = rivals.find((entry) => entry.position === slot);
    if (position === slot) organic.push({ position: slot, domain: demo.own, url: `${demo.origin}${url}`, title: keyword });
    else if (rival) organic.push({ position: slot, domain: rival.domain, url: `https://${rival.domain}${rival.url}`, title: keyword });
    else {
      const domain = others[(slot + index) % others.length]!;
      organic.push({ position: slot, domain, url: `https://${domain}/${keyword.replace(/ /g, "-")}`, title: keyword });
    }
  }
  const cited = features.includes("ai_overview") && position <= 10;
  return {
    keyword, checkedAt: addDays(checkedAt, -(index % 20)), volume, features, position: position <= 10 ? position : null, url: position <= 10 ? `${demo.origin}${url}` : null,
    aiOverviewSources: features.includes("ai_overview") ? [...new Set([organic[0]!.domain, PUBLISHER, ...(cited ? [demo.own] : [])])] : [], cited,
    organic,
  };
}

/** Results pages per market, as the sync keeps them: the site's searches with volume, then its competitors' biggest gaps. */
export function demoSerpLists(demo: Demo, today: string): Array<{ market: string; periodEnd: string; rows: SerpResult[] }> {
  return Object.entries(demo.ranked[demo.own] ?? {}).map(([market, rows]) => {
    const ownKeywords = new Set(rows.map((row) => row[0]));
    const gaps = demo.competitors.flatMap((domain) => demo.ranked[domain]?.[market] ?? []).filter((row) => !ownKeywords.has(row[0]) && row[3] !== "navigational")
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map((row): Ranked => [row[0], row[1], row[2], row[3], 99, "/"]);
    const chosen = [...rows.filter((row) => row[3] !== "navigational"), ...gaps.filter((row, index, all) => all.findIndex((other) => other[0] === row[0]) === index)];
    return { market, periodEnd: today, rows: chosen.map((row, index) => demoSerp(demo, market, row, index, today)) };
  });
}

/** Domains that rank for the demo's searches; two aren't on its competitor list. */
const SERP_COMPETITORS: Record<string, SerpCompetitor[]> = {
  mys: [
    { domain: "brightcare-dental.example", keywords: 11, avgPosition: 4.2, visibility: 0.38, traffic: 2400 },
    { domain: "youtube.com", keywords: 9, avgPosition: 6.1, visibility: 0.21, traffic: 900 },
    { domain: DIRECTORY, keywords: 8, avgPosition: 3.4, visibility: 0.29, traffic: 1700 },
    { domain: "smile-dental.example", keywords: 7, avgPosition: 5.0, visibility: 0.24, traffic: 1300 },
    { domain: NEWCOMER, keywords: 6, avgPosition: 4.8, visibility: 0.22, traffic: 1100 },
    { domain: "demo-clinic.example", keywords: 12, avgPosition: 9.6, visibility: 0.17, traffic: 650 },
    { domain: PUBLISHER, keywords: 5, avgPosition: 7.2, visibility: 0.12, traffic: 400 },
  ],
  sgp: [
    { domain: "brightcare-dental.example", keywords: 4, avgPosition: 4.5, visibility: 0.3, traffic: 700 },
    { domain: "sg-dentalhub.example", keywords: 4, avgPosition: 3.1, visibility: 0.33, traffic: 820 },
    { domain: DIRECTORY, keywords: 3, avgPosition: 5.0, visibility: 0.15, traffic: 300 },
  ],
};

const SUMMARIES: BacklinkSummary[] = [
  { domain: "demo-clinic.example", rank: 182, backlinks: 2140, referringDomains: 151, referringMainDomains: 138, brokenBacklinks: 12, spamScore: 3 },
  { domain: "smile-dental.example", rank: 296, backlinks: 8350, referringDomains: 702, referringMainDomains: 640, brokenBacklinks: 31, spamScore: 4 },
  { domain: "brightcare-dental.example", rank: 418, backlinks: 21900, referringDomains: 1420, referringMainDomains: 1310, brokenBacklinks: 54, spamScore: 5 },
];

const GAP_NAMES = ["malaysia-health-news", "kl-family-guide", "parenting-my", "expat-life-sg", "dental-association-my", "best-of-penang", "jb-living", "smart-spending-my", "wellness-weekly", "clinic-directory-asia",
  "uni-dentistry-blog", "travel-health-asia", "the-kl-insider", "mum-and-baby-my", "insurance-compare-my", "health-forum-asia", "local-reviews-kl", "senior-care-my", "school-health-sg", "corporate-wellness-my"];

function demoLinkGap(competitors: string[]): LinkGap[] {
  return Array.from({ length: 46 }, (_, index) => ({
    domain: `${GAP_NAMES[index % GAP_NAMES.length]}${index >= GAP_NAMES.length ? `-${Math.floor(index / GAP_NAMES.length) + 1}` : ""}.example`,
    rank: Math.max(40, 520 - index * 11), backlinks: 1 + (index % 5) * 2, linksTo: competitors.slice(0, 3),
  }));
}

/** The demo's link profiles and gap, as the analysis and the view read them. */
export function demoLinks(demo: Demo, today: string): LinksInput {
  return {
    site: demo.own, competitors: demo.competitors, synced: true,
    summaries: SUMMARIES.filter((row) => row.domain === demo.own || demo.competitors.includes(row.domain)).map((row) => ({ periodEnd: addDays(today, -6), row })),
    gap: { periodEnd: addDays(today, -6), rows: demoLinkGap(demo.competitors) },
  };
}

export function demoSuggestions(): CompetitorSuggestion[] {
  return [
    { domain: NEWCOMER, kind: "competitor", keywords: 6, avgPosition: 4.8, visibility: 0.22, traffic: 1100, markets: ["mys"] },
    { domain: "sg-dentalhub.example", kind: "competitor", keywords: 4, avgPosition: 3.1, visibility: 0.33, traffic: 820, markets: ["sgp"] },
    { domain: DIRECTORY, kind: "directory", keywords: 11, avgPosition: 3.4, visibility: 0.44, traffic: 2000, markets: ["mys", "sgp"] },
  ];
}

const REAL_NAMES = ["smilehealth-guide", "klang-valley-health", "penang-family-care", "dentalcare-asia", "malaysia-parents-club", "kl-lifestyle-weekly", "toothfacts", "jb-community-news", "ipoh-living", "wellness-sg", "mysmile-centre", "orthodontic-society-my", "kids-health-forum", "bangsar-neighbours", "petaling-business-hub", "health-insurance-compare", "sg-dentalhub", "clinic-finder-asia", "mum-and-baby-blog", "expat-kl-guide", "klinikpergigian", "campus-health-uitm", "care-directory-my", "seniors-living-sg", "malay-mail-health-desk", "oral-care-research", "gigi-sihat", "family-budget-tips", "borneo-community", "sunway-residents", "nutrition-notes-asia", "pharmacy-tips-my", "school-nurses-network", "travel-medical-asia", "teeth-whitening-reviews", "city-guide-penang", "wellbeing-weekly", "smile-stories", "dental-students-my", "kl-moms-circle"];
const REAL_ANCHORS = ["Demo Dental Clinic", "demo-clinic.example", "click here", "this clinic", "affordable braces in kuala lumpur", "a family dentist we recommend", "Demo Clinic", "https://demo-clinic.example/", "their guide to dental implants", "read more", "dentist in petaling jaya", "how much do fillings cost"];
const REAL_PATHS = ["/resources/dental-care", "/blog/our-favourite-clinics", "/partners", "/health/local-services", "/guides/choosing-a-dentist", "/news/community-roundup", "/directory/clinics", "/lifestyle/smile-care", "/about/sponsors", "/reviews/best-of-the-year"];
const SPAM_PATH = "/dir/seo-growth-backlinks-77122";

/** The clinic's referring domains as DataForSEO would give them: 40 real (3 new, 4 lost, 3 pointing at missing pages) and a 120-site network, 90 of them new. Spam is decided by the real rules. */
export function demoReferringRows(demo: Demo, today: string): ReferringDomain[] {
  const rows: Array<Omit<ReferringDomain, "spam" | "spamReason">> = REAL_NAMES.map((name, i) => {
    const lost = i >= 5 && i < 9;
    const fresh = i >= 20 && i < 23;
    const broken = i >= 30 && i < 33;
    return {
      domain: `${name}.example`, urlFrom: `https://${name}.example${REAL_PATHS[(i * 7) % REAL_PATHS.length]}`,
      urlTo: broken ? `${demo.origin}/${["clinics/old-branch-closed", "treatments/retired-laser-whitening", "blog/2022-promo"][i - 30]}` : `${demo.origin}${i % 3 === 0 ? "/" : demo.paths[(i * 5) % demo.paths.length]!.path}`,
      anchor: REAL_ANCHORS[i % REAL_ANCHORS.length]!, dofollow: i % 5 !== 4,
      firstSeen: addDays(today, fresh ? -(4 + (i - 20) * 9) : -(60 + i * 17)), lastSeen: addDays(today, lost ? -(5 + (i - 5) * 5) : -1 - (i % 3)),
      lost, broken, rank: 40 + Math.round((i * 480) / 39), spamScore: i % 6,
    };
  });
  for (let i = 0; i < 120; i++) {
    rows.push({
      domain: `seo-links-${i}.example`, urlFrom: `https://seo-links-${i}.example${SPAM_PATH}`, urlTo: `${demo.origin}/`,
      anchor: `Premium SEO Authority Backlinks to Help ${demo.own} Websites Rank Higher`, dofollow: true,
      firstSeen: addDays(today, i < 90 ? -(1 + (i % 28)) : -(90 + i)), lastSeen: addDays(today, -1), lost: false, broken: false, rank: i % 6, spamScore: 60 + (i % 30),
    });
  }
  return classifyReferringDomains(rows, demo.own);
}

const DAY_MS = 86_400_000;

/**
 * Saves the connector lists as the sync would, six months of Bing and
 * referring-domain history, IndexNow submissions since the guides went live,
 * and 120 days of crawl log: Googlebot steady on the clinic pages, skipping
 * most of the blog, and spending a share of its requests on redirects.
 */
export async function seedDemoConnectors(db: D1Like, demo: Demo, now: number): Promise<void> {
  const today = new Date(now).toISOString().slice(0, 10);
  for (const list of demoSerpLists(demo, today)) await saveSnapshot(db, demo.siteId, { kind: "serp", scope: list.market, periodEnd: list.periodEnd, rows: list.rows });
  for (const [market, rows] of Object.entries(SERP_COMPETITORS)) await saveSnapshot(db, demo.siteId, { kind: "serp_competitors", scope: market, periodEnd: addDays(today, -9), rows });
  const links = demoLinks(demo, today);
  for (const entry of links.summaries) await saveSnapshot(db, demo.siteId, { kind: "backlinks", scope: entry.row.domain, periodEnd: entry.periodEnd, rows: [entry.row] });
  await saveSnapshot(db, demo.siteId, { kind: "link_gap", scope: demo.competitors.slice(0, 3).sort().join(","), periodEnd: links.gap!.periodEnd, rows: links.gap!.rows });

  const referring = demoReferringRows(demo, today);
  await replaceReferringDomains(db, demo.siteId, referring);
  await saveSnapshot(db, demo.siteId, { kind: "spam_networks", scope: demo.own, periodEnd: today, rows: spamNetworks(referring) });
  const counts = await referringDomainCounts(db, demo.siteId, addDays(today, -30));

  const serp = demoSerpLists(demo, today).flatMap((list) => list.rows);
  const points: MetricPoint[] = [
    { metric: "sync.serp", day: today, value: 2 }, { metric: "sync.serp_competitors", day: today, value: 0 }, { metric: "sync.backlinks", day: today, value: 9 },
    { metric: "sync.bing", day: today, value: 1 }, { metric: "sync.indexnow", day: today, value: 1 },
    { metric: "serp_ai_overviews", day: today, value: serp.filter((row) => row.features.includes("ai_overview")).length },
    { metric: "serp_ai_cited", day: today, value: serp.filter((row) => row.cited).length },
    { metric: "ref_domains_real", day: today, value: counts.real }, { metric: "ref_domains_spam", day: today, value: counts.spam },
    { metric: "links_new_real", day: today, value: counts.newReal }, { metric: "links_lost_real", day: today, value: counts.lostReal }, { metric: "links_broken_real", day: today, value: counts.brokenReal },
  ];
  for (const entry of links.summaries) {
    const suffix = entry.row.domain === demo.own ? "" : `:${entry.row.domain}`;
    points.push(
      { metric: `backlinks${suffix}`, day: entry.periodEnd, value: entry.row.backlinks },
      { metric: `ref_domains${suffix}`, day: entry.periodEnd, value: entry.row.referringMainDomains },
      { metric: `backlink_rank${suffix}`, day: entry.periodEnd, value: entry.row.rank },
    );
  }
  // The clinic's referring domains, monthly: slow growth since the guides started earning links.
  for (let month = 6; month >= 1; month--) points.push({ metric: "ref_domains", day: addDays(today, -6 - month * 30), value: 138 - month * 6 });
  // Bing: a small share of Google's clicks, a little more since go-live; crawl counts weekly.
  for (let back = 180; back >= 1; back--) {
    const day = addDays(today, -back);
    const lift = back <= 80 ? 1 + (80 - back) / 160 : 1;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const clicks = Math.round(5 * lift * (weekday === 0 || weekday === 6 ? 0.8 : 1) + (back % 3));
    points.push({ metric: "bing_clicks", day, value: clicks }, { metric: "bing_impressions", day, value: clicks * 41 + (back % 7) * 9 });
    if (back % 7 === 0) points.push({ metric: "bing_crawled_pages", day, value: 210 + (back % 21) }, { metric: "bing_crawl_errors", day, value: back % 14 ? 3 : 7 }, { metric: "bing_in_index", day, value: 1240 + Math.round(lift * 160) });
  }
  // IndexNow: every guide when they went live, then the pages that changed.
  points.push({ metric: "indexnow_submitted", day: addDays(today, -80), value: 60 });
  for (const back of [61, 40, 33, 26, 12, 4]) points.push({ metric: "indexnow_submitted", day: addDays(today, -back), value: 1 + (back % 4) });
  await upsertMetricPoints(db, demo.siteId, points);

  // 120 days of crawl log, as a log drain would have delivered it.
  const hits: Array<{ time: string; path: string; status: number; bot: string }> = [];
  const pages = demo.paths.filter((page) => page.family !== "blog");
  const blog = demo.paths.filter((page) => page.family === "blog");
  for (let back = 120; back >= 1; back--) {
    const day = addDays(today, -back);
    const dayMs = now - back * DAY_MS;
    // About twenty requests a day for a 1,700-URL sitemap: each clinic, dentist and treatment page roughly once a quarter, with the odd 503. Slow enough that the analysis says so.
    for (let slot = 0; slot < 12; slot++) {
      const page = pages[(back * 12 + slot) % pages.length]!;
      hits.push({ time: new Date(dayMs + slot * 600_000).toISOString(), path: page.path, status: slot === 7 && back % 9 === 0 ? 503 : 200, bot: "googlebot" });
    }
    // Only every fourth blog post is ever requested, the rest having no links pointing at them; drafts redirect.
    for (let slot = 0; slot < 5; slot++) {
      const post = blog[((back * 5 + slot) * 4) % blog.length];
      if (post) hits.push({ time: new Date(dayMs + slot * 900_000).toISOString(), path: post.path, status: post.path.startsWith("/blog/drafts/") ? 301 : 200, bot: "googlebot" });
    }
    for (let slot = 0; slot < 4; slot++) hits.push({ time: new Date(dayMs + slot * 900_000).toISOString(), path: `/search?q=${["braces", "implant", "kids", "price"][slot % 4]}&page=${slot}`, status: 200, bot: "googlebot" });
    hits.push({ time: `${day}T05:00:00.000Z`, path: "/old-promotions", status: 404, bot: "googlebot" });
    for (let slot = 0; slot < 12; slot++) hits.push({ time: new Date(dayMs + slot * 1_800_000).toISOString(), path: demo.paths[(back * 11 + slot * 29) % demo.paths.length]!.path, status: 200, bot: "bingbot" });
    for (const [agent, count] of [["GPTBot", 4], ["ClaudeBot", 2], ["PerplexityBot", 2], ["ChatGPT-User", back <= 80 ? 3 : 1], ["Bytespider", 1]] as const) {
      for (let slot = 0; slot < count; slot++) hits.push({ time: new Date(dayMs + slot * 3_600_000).toISOString(), path: demo.paths[(back * 7 + slot * 13 + agent.length) % demo.paths.length]!.path, status: 200, bot: agent });
    }
  }
  const days = new Map<string, { day: string; bot: string; family: string; statusClass: string; query: boolean; hits: number }>();
  const paths = new Map<string, { group: "google" | "bing"; path: string; lastSeen: string; lastStatus: number; hits: number }>();
  for (const hit of hits) {
    const family = classifyUrlType(`${demo.origin}${hit.path}`);
    const statusClass = hit.status >= 500 ? "5xx" : hit.status >= 400 ? "4xx" : hit.status >= 300 ? "3xx" : "2xx";
    const query = hit.path.includes("?");
    const key = `${hit.time.slice(0, 10)}|${hit.bot}|${family}|${statusClass}|${query}`;
    const row = days.get(key) ?? { day: hit.time.slice(0, 10), bot: hit.bot, family, statusClass, query, hits: 0 };
    row.hits++;
    days.set(key, row);
    if (hit.bot === "googlebot" || hit.bot === "bingbot") {
      const group = hit.bot === "googlebot" ? "google" : "bing";
      const seen = paths.get(`${group}|${hit.path}`);
      if (!seen || hit.time > seen.lastSeen) paths.set(`${group}|${hit.path}`, { group, path: hit.path, lastSeen: hit.time, lastStatus: hit.status, hits: (seen?.hits ?? 0) + 1 });
      else seen.hits++;
    }
  }
  await recordCrawlLog(db, demo.siteId, { days: [...days.values()], paths: [...paths.values()] });
}
