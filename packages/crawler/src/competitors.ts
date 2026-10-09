import { defaultFetcher, fetchRobots, isEmptyShell, isSafePublicUrl, parseHtmlSignals, type Fetcher, type FetchResult } from "./index.js";
import { elementSpans, findTags, visibleText } from "./html.js";
import type { RobotsPolicy } from "./robots.js";
import { classifyLanguage, classifyUrlType, isSameSite } from "./urls.js";

/** How Eumon identifies itself on third-party sites. Competitor research never impersonates a search engine. */
export const RESEARCH_USER_AGENT = "EumonBot/0.1 (+organic growth research; respects robots.txt)";
export const RESEARCH_TOKEN = "eumonbot";

export type SitemapFamilyProfile = {
  family: string;
  /** URLs seen in the sitemap files that were read. */
  urls: number;
  /** Extrapolated to sitemap files that were listed but not read within the budget. */
  estimated: number;
  /** Distinct pages, extrapolated like `estimated`: translations of one page count once (its largest language edition). */
  pages?: number;
  /** Language editions of this family seen in the sitemaps. */
  languages?: number;
  examples: string[];
};

export type SitemapProfile = {
  origin: string;
  filesRead: number;
  filesListed: number;
  urlsSeen: number;
  estimatedUrls: number;
  /** True when some listed sitemap files were not read and counts are extrapolated. */
  partial: boolean;
  families: SitemapFamilyProfile[];
  languages: Record<string, number>;
  notes: string[];
};

/** What one page shows a searcher and a crawler: content, structured data, and ways to convert. */
export type PageInspection = {
  url: string;
  family: string;
  status: number;
  title?: string;
  h1?: string;
  textLength: number;
  emptyShell: boolean;
  schemaTypes: string[];
  faq: boolean;
  conversion: { whatsapp: boolean; phone: boolean; email: boolean; form: boolean; booking: boolean; prices: boolean };
  /** Analytics and conversion-tracking tools whose snippets appear in the page. */
  tracking: string[];
};

export type SiteResearch = {
  domain: string;
  origin: string;
  /** robots.txt lets EumonBot read the site. When false, nothing else was fetched. */
  allowed: boolean;
  sitemap: SitemapProfile;
  pages: PageInspection[];
  error?: string;
};

/** `sitemap-doctors-12.xml` and `sitemap-doctors-3.xml` share the stem `sitemap-doctors-#.xml`. */
function fileStem(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop()!.replace(/\d+/g, "#").toLowerCase();
  } catch {
    return url;
  }
}

/** Families that describe site plumbing rather than content worth comparing. */
const NON_CONTENT_FAMILIES = new Set(["home", "page", "tag", "tags", "author", "authors", "feed", "wp-content", "wp-json", "cdn-cgi", "assets", "static", "uploads", "amp", "search", "cart", "account", "login"]);

export function isContentFamily(family: string): boolean {
  return !NON_CONTENT_FAMILIES.has(family);
}

/**
 * Profiles a site's sitemaps within a fixed budget: URL counts per route
 * family, without holding every URL in memory. When a sitemap index lists
 * more files than the budget allows, files are sampled across naming stems
 * (so `doctors-*.xml` and `treatments-*.xml` are both read) and counts are
 * extrapolated per stem.
 */
export async function profileSitemaps(
  baseUrl: string,
  fetcher: Fetcher = defaultFetcher,
  options: { maxFiles?: number; maxUrls?: number; userAgent?: string; robots?: RobotsPolicy | null } = {},
): Promise<SitemapProfile> {
  const origin = new URL(baseUrl).origin;
  const maxFiles = options.maxFiles ?? 15;
  const maxUrls = options.maxUrls ?? 50_000;
  const notes: string[] = [];
  const fetchFile = (url: string) => fetcher(url, { userAgent: options.userAgent, maxBytes: 25_000_000 });

  const declared = (options.robots?.sitemaps ?? []).filter((url) => isSameSite(url, origin) && isSafePublicUrl(url));
  const entries = declared.length ? declared : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  // Per stem: files listed, files read, and family counts (in total and per language) in the files read.
  const stems = new Map<string, { listed: Set<string>; read: number; counts: Map<string, number>; editions: Map<string, Map<string, number>> }>();
  const stemOf = (url: string) => {
    const key = fileStem(url);
    const entry = stems.get(key) ?? { listed: new Set<string>(), read: 0, counts: new Map<string, number>(), editions: new Map<string, Map<string, number>>() };
    stems.set(key, entry);
    return entry;
  };
  const examples = new Map<string, string[]>();
  const languages: Record<string, number> = {};
  // Files waiting to be read, per stem; read round-robin across stems so the
  // budget samples every kind of sitemap before reading a second file of any.
  const pending = new Map<string, string[]>();
  const enqueue = (url: string) => {
    const key = fileStem(url);
    const list = pending.get(key);
    if (list) list.push(url);
    else pending.set(key, [url]);
  };
  const visited = new Set<string>();
  let urlsSeen = 0;
  let filesRead = 0;
  let foundAny = false;
  let cursor = 0;
  const nextFile = (): string | undefined => {
    const keys = [...pending.keys()].filter((key) => pending.get(key)!.length);
    if (!keys.length) return undefined;
    const key = keys[cursor++ % keys.length]!;
    return pending.get(key)!.shift();
  };

  // Without a declared sitemap, try the conventional locations in order.
  const candidates = declared.length ? [] : [...entries];
  for (const entry of declared) enqueue(entry);
  if (!declared.length) enqueue(candidates.shift()!);

  while (filesRead < maxFiles && urlsSeen < maxUrls) {
    const url = nextFile();
    if (!url) {
      if (!foundAny && candidates.length) { enqueue(candidates.shift()!); continue; }
      break;
    }
    if (visited.has(url)) continue;
    visited.add(url);
    if (/\.gz($|\?)/i.test(url)) {
      notes.push(`Compressed sitemap ${url} was not read.`);
      continue;
    }
    let response: FetchResult;
    try {
      response = await fetchFile(url);
    } catch (error) {
      notes.push(`${url} could not be fetched (${error instanceof Error ? error.message : "error"}).`);
      continue;
    }
    if (response.status >= 400 || !/<(urlset|sitemapindex)\b/i.test(response.body)) {
      if (declared.length || foundAny) notes.push(`${url} returned ${response.status >= 400 ? `HTTP ${response.status}` : "no sitemap XML"}.`);
      stems.get(fileStem(url))?.listed.delete(url);
      continue;
    }
    foundAny = true;
    filesRead++;
    const locs = [...response.body.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((match) => match[1]!.trim());
    if (/<sitemapindex\b/i.test(response.body)) {
      // An index is a container, not a page list; only leaf files count toward a stem.
      stems.get(fileStem(url))?.listed.delete(url);
      for (const child of locs.filter((loc) => isSameSite(loc, origin) && isSafePublicUrl(loc))) {
        stemOf(child).listed.add(child);
        enqueue(child);
      }
      continue;
    }
    const stem = stemOf(url);
    stem.listed.add(url);
    stem.read++;
    for (const loc of locs) {
      if (!isSameSite(loc, origin)) continue;
      let family: string;
      try {
        family = classifyUrlType(loc);
      } catch {
        continue;
      }
      urlsSeen++;
      stem.counts.set(family, (stem.counts.get(family) ?? 0) + 1);
      const list = examples.get(family) ?? [];
      if (list.length < 5) list.push(loc);
      examples.set(family, list);
      const language = classifyLanguage(loc);
      languages[language] = (languages[language] ?? 0) + 1;
      const byLanguage = stem.editions.get(family) ?? new Map<string, number>();
      byLanguage.set(language, (byLanguage.get(language) ?? 0) + 1);
      stem.editions.set(family, byLanguage);
    }
  }
  if (!foundAny && !declared.length) notes.push("No sitemap was found at /sitemap.xml or /sitemap_index.xml, and robots.txt declares none.");

  const families = new Map<string, SitemapFamilyProfile>();
  const editions = new Map<string, Map<string, number>>();
  let filesListed = 0;
  let estimatedUrls = 0;
  for (const stem of stems.values()) {
    filesListed += stem.listed.size;
    const scale = stem.read ? stem.listed.size / stem.read : 0;
    for (const [family, count] of stem.counts) {
      const entry = families.get(family) ?? { family, urls: 0, estimated: 0, examples: examples.get(family) ?? [] };
      entry.urls += count;
      entry.estimated += Math.round(count * scale);
      families.set(family, entry);
      estimatedUrls += Math.round(count * scale);
    }
    for (const [family, byLanguage] of stem.editions) {
      const total = editions.get(family) ?? new Map<string, number>();
      for (const [language, count] of byLanguage) total.set(language, (total.get(language) ?? 0) + Math.round(count * scale));
      editions.set(family, total);
    }
  }
  for (const [family, entry] of families) {
    const byLanguage = [...(editions.get(family)?.values() ?? [])];
    entry.pages = byLanguage.length ? Math.max(...byLanguage) : entry.estimated;
    entry.languages = Math.max(byLanguage.length, 1);
  }
  const unreadStems = [...stems.entries()].filter(([, stem]) => stem.listed.size > 0 && stem.read === 0).map(([key]) => key);
  if (unreadStems.length) notes.push(`Sitemap files named like ${unreadStems.slice(0, 5).join(", ")} were not read within the budget, so their pages are not counted.`);
  if (urlsSeen >= maxUrls) notes.push(`Stopped after ${maxUrls.toLocaleString("en")} URLs; counts for the rest are extrapolated.`);

  return {
    origin,
    filesRead,
    filesListed: Math.max(filesListed, filesRead),
    urlsSeen,
    estimatedUrls,
    partial: estimatedUrls > urlsSeen || unreadStems.length > 0,
    families: [...families.values()].sort((a, b) => b.estimated - a.estimated),
    languages,
    notes,
  };
}

const TRACKERS: Array<[string, RegExp]> = [
  ["Google Analytics", /googletagmanager\.com\/gtag\/js|gtag\(\s*['"]config['"]|google-analytics\.com\/(analytics|ga)\.js/i],
  ["Google Tag Manager", /googletagmanager\.com\/gtm\.js|['"]GTM-[A-Z0-9]{4,}['"]/],
  ["PostHog", /posthog\.init|i\.posthog\.com|posthog-js/i],
  ["Plausible", /plausible\.io\/js/i],
  ["Meta Pixel", /connect\.facebook\.net\/[^"']*fbevents\.js|\bfbq\(\s*['"]init/i],
  ["Vercel Analytics", /\/_vercel\/insights|va\.vercel-scripts\.com/i],
  ["Microsoft Clarity", /clarity\.ms\/tag/i],
  ["Umami", /umami\.(is|js)|data-website-id=/i],
  ["Mixpanel", /cdn\.mxpnl\.com|mixpanel\.init/i],
  ["Eumon", /eumonTrack|eumon_sid|\/__eumon\//],
];

/** A form that collects contact details (not a site search box or newsletter-free filter). */
function hasLeadForm(html: string): boolean {
  return elementSpans(html, ["form"]).some((form) => {
    const body = html.slice(form.start, Math.min(form.end, form.start + 20_000));
    return /type=["']?(email|tel)\b|<textarea\b|name=["']?(phone|mobile|whatsapp|email|message|enquiry|inquiry)\b/i.test(body);
  });
}

const PRICE = /(?:RM|Rp|S\$|US\$|\$|€|£|฿|₱|₹|¥)\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:ringgit|rupiah|USD|MYR|IDR|SGD|EUR)\b/i;
const BOOKING = /\b(book (?:now|an? (?:appointment|consultation|call|demo))|schedule (?:a|an|your)|get a (?:free )?quote|request a (?:quote|call ?back)|buat janji|reservasi|daftar sekarang)\b/i;

/** Reads what a page offers a searcher and a crawler. */
export function inspectPage(url: string, response: Pick<FetchResult, "status" | "body">): PageInspection {
  const signals = parseHtmlSignals(response.body, url);
  const anchors = findTags(response.body, "a").map((anchor) => anchor.href ?? "");
  const text = visibleText(response.body.slice(0, 2_000_000));
  return {
    url,
    family: classifyUrlType(url),
    status: response.status,
    title: signals.title,
    h1: signals.headingOutline.find((heading) => heading.startsWith("h1:"))?.slice(3),
    textLength: signals.textLength,
    emptyShell: response.status < 400 && isEmptyShell(response.body, signals),
    schemaTypes: signals.jsonLdTypes,
    faq: signals.jsonLdTypes.includes("FAQPage") || /<(h[2-4]|summary)[^>]*>[^<]*(faq|frequently asked|pertanyaan umum)/i.test(response.body),
    conversion: {
      whatsapp: anchors.some((href) => /(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp:)/i.test(href)),
      phone: anchors.some((href) => /^tel:/i.test(href)),
      email: anchors.some((href) => /^mailto:/i.test(href)),
      form: hasLeadForm(response.body),
      booking: BOOKING.test(text),
      prices: PRICE.test(text),
    },
    tracking: detectTrackers(response.body),
  };
}

/** Analytics and conversion-tracking tools whose code appears in `text` (a page or a script). */
export function detectTrackers(text: string): string[] {
  return TRACKERS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/**
 * Trackers bundled into the page's own scripts, which its HTML alone can't
 * show: apps that install posthog-js or gtag through their JavaScript bundle
 * only name the vendors in a CSP allowlist. Same-site scripts only, at most
 * `maxScripts` per page; `cache` shares one fetch per script across a run.
 */
export async function scriptTrackers(
  html: string,
  pageUrl: string,
  fetcher: Fetcher = defaultFetcher,
  cache = new Map<string, Promise<string[]>>(),
  maxScripts = 3,
): Promise<string[]> {
  const scripts = [...new Set(findTags(html, "script").flatMap((tag) => {
    try {
      const url = tag.src ? new URL(tag.src, pageUrl).toString() : "";
      return url && isSameSite(url, pageUrl) ? [url] : [];
    } catch {
      return [];
    }
  }))].slice(0, maxScripts);
  const found = await Promise.all(scripts.map((url) => {
    let trackers = cache.get(url);
    if (!trackers) {
      trackers = fetcher(url, { maxBytes: 5_000_000 })
        .then((response) => (response.status < 400 ? detectTrackers(response.body) : []))
        .catch(() => []);
      cache.set(url, trackers);
    }
    return trackers;
  }));
  return [...new Set(found.flat())];
}

/**
 * Researches one competitor politely: robots.txt for EumonBot, a budgeted
 * sitemap profile, the homepage, and one example page from each of the
 * largest content families.
 */
export async function researchSite(
  domain: string,
  fetcher: Fetcher = defaultFetcher,
  options: { maxFiles?: number; maxUrls?: number; samplePages?: number } = {},
): Promise<SiteResearch> {
  const origin = `https://${domain}`;
  const empty: SitemapProfile = { origin, filesRead: 0, filesListed: 0, urlsSeen: 0, estimatedUrls: 0, partial: false, families: [], languages: {}, notes: [] };
  const fetchAs = (url: string) => fetcher(url, { userAgent: RESEARCH_USER_AGENT });
  let robots: RobotsPolicy | null;
  try {
    robots = await fetchRobots(origin, RESEARCH_TOKEN, RESEARCH_USER_AGENT, fetcher);
  } catch (error) {
    return { domain, origin, allowed: false, sitemap: empty, pages: [], error: `The site could not be reached (${error instanceof Error ? error.message : "error"}).` };
  }
  if (robots && !robots.isAllowed("/")) {
    return { domain, origin, allowed: false, sitemap: empty, pages: [], error: "robots.txt does not allow EumonBot, so the site was not analyzed." };
  }

  const sitemap = await profileSitemaps(origin, fetcher, { maxFiles: options.maxFiles, maxUrls: options.maxUrls, userAgent: RESEARCH_USER_AGENT, robots });
  const targets = [`${origin}/`, ...sitemap.families
    .filter((family) => isContentFamily(family.family) && family.examples.length)
    .slice(0, options.samplePages ?? 5)
    .map((family) => family.examples[Math.floor(family.examples.length / 2)]!)];
  const pages: PageInspection[] = [];
  for (const url of targets) {
    const path = new URL(url).pathname;
    if (robots && !robots.isAllowed(path)) continue;
    try {
      const response = await fetchAs(url);
      pages.push(inspectPage(response.finalUrl || url, response));
    } catch {
      // One unreachable example doesn't invalidate the rest of the research.
    }
  }
  return { domain, origin, allowed: true, sitemap, pages };
}
