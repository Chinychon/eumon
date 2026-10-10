import type { CrawlPageResult, Finding, SitemapAudit } from "@organic-growth/core";
import { CHECKS, finding, organicImpactScore, simhash } from "@organic-growth/core";
import { contentMarkup, elementSpans, findTags, hasToken, innerText, parseAttributes, stripElements, visibleText } from "./html.js";
import { contentSignals } from "./content-signals.js";
import { GOOGLEBOT_TOKEN, parseRobots, type RobotsPolicy } from "./robots.js";
import { classifyLanguage, classifyUrlType, isSameSite, sameDocument } from "./urls.js";

export const GOOGLEBOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface FetchResult {
  url: string;
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: string;
  /** Redirects followed before this response. */
  hops?: number;
}

export type Fetcher = (
  url: string,
  init?: { userAgent?: string; headers?: Record<string, string>; maxBytes?: number },
) => Promise<FetchResult>;

export function isSafePublicUrl(value: string, expectedOrigin?: string): boolean {
  try {
    const url = new URL(value);
    // "localhost." and "x.internal." name the same hosts as without the dot.
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) return false;
    if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (host.startsWith("[") || host.includes(":")) return false;
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
    if (url.port && !["80", "443"].includes(url.port)) return false;
    return !expectedOrigin || url.origin === expectedOrigin;
  } catch {
    return false;
  }
}

async function boundedText(response: Response, maxBytes = 2_000_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response body limit exceeded");
        throw new Error(`Response exceeded the ${maxBytes} byte crawl limit.`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

export const defaultFetcher: Fetcher = async (url, init) => {
  if (!isSafePublicUrl(url)) throw new Error("Crawler only accepts public HTTP(S) website URLs.");
  let target = url;
  let hops = 0;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const res = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": init?.userAgent ?? BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...init?.headers,
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      const next = new URL(location, target).toString();
      if (!isSafePublicUrl(next) || !isSameSite(next, url)) throw new Error("Crawler blocked a redirect outside the connected website.");
      target = next;
      hops++;
      continue;
    }
    const body = await boundedText(res, init?.maxBytes);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { url, status: res.status, finalUrl: target, headers, body, ...(hops ? { hops } : {}) };
  }
  throw new Error("Crawler stopped after an unsafe or excessive redirect chain.");
};

/** robots.txt as it applies to `token`, or null when the site has none (4xx/5xx). Throws when the site is unreachable. */
export async function fetchRobots(baseUrl: string, token: string, userAgent: string, fetcher: Fetcher = defaultFetcher): Promise<RobotsPolicy | null> {
  const response = await fetcher(new URL("/robots.txt", baseUrl).toString(), { userAgent, maxBytes: 500_000 });
  return response.status < 400 ? parseRobots(response.body, token) : null;
}

export type HtmlSignals = {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  hreflang: Array<{ lang: string; href: string }>;
  jsonLdCount: number;
  jsonLdTypes: string[];
  /** Every JSON-LD object on the page, `@graph` members included (50 at most). */
  jsonLdObjects: Array<Record<string, unknown>>;
  invalidJsonLd: number;
  headingOutline: string[];
  h1Count: number;
  internalLinkCount: number;
  /** Distinct same-site link paths (no query, fragment, or trailing slash; `` is the homepage). */
  internalLinks: string[];
  /** Characters of visible text; scripts, styles, JSON-LD, and framework payloads excluded. */
  textLength: number;
  hasRootMount: boolean;
  /** A robots or googlebot meta tag excludes the page from the index. */
  metaNoindex: boolean;
  /** Target of a `<meta http-equiv="refresh">` redirect (delay of 10 s or less). */
  metaRefresh?: string;
  bodyTextSample: string;
  /** Visible text of the main content: `<main>` or `<article>` when the page has one, else the body without nav, header, footer, aside and forms. */
  mainText: string;
};

/**
 * Reads the SEO-relevant signals a non-rendering crawler gets from an HTML
 * response. Tags are matched by attribute, so attribute order and quoting
 * don't matter. `pageUrl` lets absolute same-site links count as internal.
 */
export function parseHtmlSignals(html: string, pageUrl?: string): HtmlSignals {
  const markup = contentMarkup(html);
  const metas = findTags(markup, "meta");
  const links = findTags(markup, "link");
  const metaContent = (name: string) => metas.find((meta) => meta.name?.toLowerCase() === name)?.content;

  const titleSpan = elementSpans(markup, ["title"])[0];
  const title = titleSpan ? markup.slice(titleSpan.contentStart, titleSpan.contentEnd) : undefined;
  const canonical = links.find((link) => hasToken(link.rel, "canonical") && link.href)?.href;
  const hreflang = links
    .filter((link) => hasToken(link.rel, "alternate") && link.hreflang && link.href)
    .map((link) => ({ lang: link.hreflang!, href: link.href! }));
  const robots = metaContent("robots");
  const googlebot = metaContent("googlebot");
  const refresh = metas.find((meta) => meta["http-equiv"]?.toLowerCase() === "refresh")?.content?.match(/^\s*(\d+(?:\.\d+)?)\s*[;,]\s*url\s*=\s*['"]?([^'"]+)/i);
  const jsonLd = readJsonLd(html);

  const headingOutline: string[] = [];
  let h1Count = 0;
  for (const heading of elementSpans(markup, ["h1", "h2", "h3"])) {
    if (heading.tag === "h1") h1Count++;
    if (headingOutline.length < 20) headingOutline.push(`${heading.tag}:${innerText(markup.slice(heading.contentStart, Math.min(heading.contentEnd, heading.contentStart + 2000))).slice(0, 120)}`);
  }

  let internalLinkCount = 0;
  const internalLinks = new Set<string>();
  for (const anchor of findTags(markup, "a")) {
    const href = anchor.href?.trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    const internal = href.startsWith("/") ? !href.startsWith("//") : Boolean(pageUrl && isSameSite(resolveUrl(href, pageUrl), pageUrl));
    if (!internal) continue;
    internalLinkCount++;
    // ponytail: 300 distinct targets per page covers mega-menus; raise if sites need more.
    const path = linkPath(href, pageUrl);
    if (path !== null && internalLinks.size < 300) internalLinks.add(path);
  }

  const text = visibleText(markup);
  const main = elementSpans(markup, ["main", "article"])[0];
  const mainText = visibleText(main ? markup.slice(main.contentStart, main.contentEnd) : stripElements(markup, ["nav", "header", "footer", "aside", "form"]));
  return {
    title: title ? innerText(title) : undefined,
    description: metaContent("description"),
    canonical,
    robots,
    hreflang,
    jsonLdCount: jsonLd.blocks,
    jsonLdTypes: jsonLd.types,
    jsonLdObjects: jsonLd.objects,
    invalidJsonLd: jsonLd.invalid,
    headingOutline,
    h1Count,
    internalLinkCount,
    internalLinks: [...internalLinks],
    textLength: text.length,
    hasRootMount: /\bid=["']?(root|app|__next|__nuxt|svelte)["'\s>]/i.test(markup),
    metaNoindex: [robots, googlebot].some((value) => /\b(noindex|none)\b/i.test(value ?? "")),
    metaRefresh: refresh && Number(refresh[1]) <= 10 ? refresh[2]!.trim() : undefined,
    bodyTextSample: text.slice(0, 280),
    mainText,
  };
}

/** A link's path as the link graph stores it: no query, fragment, or trailing slash. */
export function linkPath(href: string, base = "https://site.invalid/"): string | null {
  try {
    return decodeURI(new URL(href, base).pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

/** Counts JSON-LD blocks and collects their schema.org types; malformed blocks are counted, not thrown. */
function readJsonLd(html: string): { blocks: number; types: string[]; objects: Array<Record<string, unknown>>; invalid: number } {
  const types = new Set<string>();
  const objects: Array<Record<string, unknown>> = [];
  let blocks = 0;
  let invalid = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (objects.length < 50) objects.push(node);
      const type = node["@type"];
      for (const entry of Array.isArray(type) ? type : [type]) {
        if (typeof entry === "string" && entry) types.add(entry.replace(/^https?:\/\/schema\.org\//i, ""));
      }
      if (Array.isArray(node["@graph"])) visit(node["@graph"]);
    }
  };
  for (const script of elementSpans(html, ["script"])) {
    if (parseAttributes(script.attrs).type?.toLowerCase() !== "application/ld+json") continue;
    blocks++;
    try {
      visit(JSON.parse(html.slice(script.contentStart, script.contentEnd).trim()));
    } catch {
      invalid++;
    }
  }
  return { blocks, types: [...types].slice(0, 30), objects, invalid };
}

/**
 * True when an `X-Robots-Tag` header excludes the page from Google's index.
 * Directives may be scoped to a crawler (`googlebot: noindex`); ones scoped
 * to other crawlers don't apply.
 */
export function headerNoindex(value: string | undefined): boolean {
  if (!value) return false;
  const valued = new Set(["unavailable_after", "max-snippet", "max-image-preview", "max-video-preview"]);
  let agent: string | null = null;
  for (const part of value.split(",")) {
    let directive = part.trim().toLowerCase();
    const scoped = directive.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/);
    if (scoped && !valued.has(scoped[1]!)) {
      agent = scoped[1]!;
      directive = scoped[2]!;
    }
    if ((agent === null || agent === GOOGLEBOT_TOKEN) && /^(noindex|none)$/.test(directive)) return true;
  }
  return false;
}

/**
 * A page that gives a non-rendering crawler nothing to index: little visible
 * text, typically with a client-side mount point waiting for JavaScript.
 */
export function isEmptyShell(html: string, signals = parseHtmlSignals(html)): boolean {
  // A meta-refresh stub is a redirect, not a page that failed to render.
  if (signals.metaRefresh) return false;
  if (signals.textLength < 400 && signals.hasRootMount) return true;
  if (signals.textLength < 200) return true;
  return signals.hasRootMount && signals.jsonLdCount === 0 && signals.headingOutline.length === 0 && signals.textLength < 800;
}

export async function fetchPageAudit(
  url: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<{
  raw: CrawlPageResult;
  googlebot: CrawlPageResult;
  comparison: {
    rawEmpty: boolean;
    googlebotEmpty: boolean;
    titleMismatch: boolean;
    textDelta: number;
  };
  rawHtml: string;
  googlebotHtml: string;
}> {
  const [rawFetch, botFetch] = await Promise.all([
    fetcher(url, { userAgent: BROWSER_UA }),
    fetcher(url, { userAgent: GOOGLEBOT_UA }),
  ]);

  const raw = toCrawlResult(url, rawFetch, "raw");
  const googlebot = toCrawlResult(url, botFetch, "googlebot");

  return {
    raw,
    googlebot,
    comparison: {
      rawEmpty: raw.isEmptyShell,
      googlebotEmpty: googlebot.isEmptyShell,
      titleMismatch: (raw.title ?? "") !== (googlebot.title ?? ""),
      textDelta: 0,
    },
    rawHtml: rawFetch.body,
    googlebotHtml: botFetch.body,
  };
}

/** Responses that usually mean a firewall or rate limiter refused the request, not that the page is broken. */
const REFUSED_STATUSES = new Set([401, 403, 429, 503]);

/**
 * A bot-protection interstitial (Cloudflare, Vercel, Akamai, Imperva,
 * PerimeterX, DataDome…) instead of the site's own page.
 */
export function isBotChallenge(response: Pick<FetchResult, "status" | "headers" | "body">): boolean {
  if (!REFUSED_STATUSES.has(response.status)) return false;
  if (response.headers["cf-mitigated"] === "challenge") return true;
  return /cf-chl-|challenge-platform|<title>\s*(just a moment|attention required|access denied|vercel security checkpoint)|_incapsula_|px-captcha|captcha-delivery|datadome/i.test(response.body.slice(0, 50_000));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Words a page uses to say it is missing, in the languages the sites Eumon serves write in. "404" counts only beside error, page or not found: a guide numbered 404 is a guide. */
const NOT_FOUND = /\b(page |halaman )?not found\b|\berror\s*-?\s*404\b|\b404\s*-?\s*(error|not found|page)\b|^\s*404\b|doesn[’']?t exist|does not exist|no longer available|tidak (di)?temukan|tidak dijumpai|halaman tidak ada|找不到|不存在/i;

/** A page that answered under 400 but says it is missing, in its title or first heading, with little else in its main content: Google's soft 404. */
function isSoftNotFound(status: number, signals: HtmlSignals): boolean {
  if (status >= 400 || signals.mainText.length >= 2000) return false;
  const h1 = signals.headingOutline.find((entry) => entry.startsWith("h1:"))?.slice(3) ?? "";
  return NOT_FOUND.test(`${signals.title ?? ""} ${h1}`);
}

/** Fetches a URL that cannot exist, as Googlebot, and reports what the site answered: a status under 400 is a soft-404 site; `finalUrl` says where it was sent (the homepage, often). */
export async function probeNotFound(baseUrl: string, runId: string, fetcher: Fetcher = defaultFetcher): Promise<{ url: string; finalUrl?: string; status: number; title?: string }> {
  const url = `${new URL(baseUrl).origin}/eumon-404-probe-${runId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase() || "x"}`;
  try {
    const response = await fetcher(url, { userAgent: GOOGLEBOT_UA });
    return { url, finalUrl: response.finalUrl || url, status: response.status, title: parseHtmlSignals(response.body, response.finalUrl || url).title };
  } catch {
    return { url, status: 599 };
  }
}

/**
 * The full crawl uses the Googlebot request profile for every sitemap URL.
 * Raw-vs-Googlebot and browser comparisons remain a representative sample,
 * where they provide much more signal per request.
 *
 * Many firewalls reject requests that claim to be Googlebot but don't come
 * from Google's network (real Googlebot is verified by reverse DNS). When a
 * Googlebot request is refused, the page is re-fetched as a browser so the
 * crawl still describes the page, and the refusal is recorded.
 */
export async function fetchGooglebotPage(
  url: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<CrawlPageResult> {
  let response = await fetcher(url, { userAgent: GOOGLEBOT_UA });
  if (response.status === 429 && !isBotChallenge(response)) {
    const retryAfter = Number(response.headers["retry-after"]);
    await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 3_000);
    response = await fetcher(url, { userAgent: GOOGLEBOT_UA });
  }
  if (REFUSED_STATUSES.has(response.status)) {
    const browser = await fetcher(url, { userAgent: BROWSER_UA }).catch(() => null);
    if (browser && browser.status < 400 && !isBotChallenge(browser)) {
      return { ...toCrawlResult(url, browser, "raw", true), googlebotBlockedStatus: response.status };
    }
  }
  const page = toCrawlResult(url, response, "googlebot", true);
  return isBotChallenge(response) ? { ...page, botChallenge: true, isEmptyShell: false, internalLinks: [] } : page;
}

export type GooglebotCrawlOutcome =
  | { url: string; page: CrawlPageResult }
  | { url: string; error: string };

/** Crawls a bounded batch without overwhelming the connected website. */
export async function crawlGooglebotBatch(
  urls: string[],
  fetcher: Fetcher = defaultFetcher,
  concurrency = 6,
): Promise<GooglebotCrawlOutcome[]> {
  const outcomes: GooglebotCrawlOutcome[] = new Array(urls.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), urls.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= urls.length) return;
      const url = urls[index]!;
      try {
        outcomes[index] = { url, page: await fetchGooglebotPage(url, fetcher) };
      } catch (error) {
        outcomes[index] = {
          url,
          error: error instanceof Error ? error.message : "The crawler could not fetch this URL.",
        };
      }
    }
  });
  await Promise.all(workers);
  return outcomes;
}

function toCrawlResult(
  url: string,
  fetchResult: FetchResult,
  mode: CrawlPageResult["fetchMode"],
  withLinks = false,
): CrawlPageResult {
  const finalUrl = fetchResult.finalUrl || url;
  const signals = parseHtmlSignals(fetchResult.body, finalUrl);
  const content = contentSignals(fetchResult.body, finalUrl, { jsonLdTypes: signals.jsonLdTypes, jsonLd: signals.jsonLdObjects });
  // Zero, false and empty are left out to keep result_json small, except the fields whose absence must mean "not checked".
  const some = <T>(value: T) => (value === 0 || value === false || value === undefined || value === "" ? undefined : value);
  return {
    url,
    status: fetchResult.status,
    finalUrl,
    title: signals.title,
    description: signals.description,
    canonical: signals.canonical,
    robots: signals.robots,
    hreflang: signals.hreflang,
    jsonLdCount: signals.jsonLdCount,
    contentLength: fetchResult.body.length,
    isEmptyShell: isEmptyShell(fetchResult.body, signals),
    headingOutline: signals.headingOutline,
    internalLinkCount: signals.internalLinkCount,
    rawTextLength: signals.textLength,
    renderedTextLength: 0,
    renderDelta: 0,
    fetchMode: mode,
    h1Count: signals.h1Count,
    noindex: signals.metaNoindex || headerNoindex(fetchResult.headers["x-robots-tag"]),
    jsonLdTypes: signals.jsonLdTypes,
    invalidJsonLd: signals.invalidJsonLd,
    routeFamily: classifyUrlType(url),
    canonicalMismatch: signals.canonical ? !sameDocument(signals.canonical, finalUrl) : false,
    locale: classifyLanguage(url),
    ...(signals.mainText.length >= 200 ? { textHash: simhash(signals.mainText) } : {}),
    ...(isSoftNotFound(fetchResult.status, signals) ? { softNotFound: true } : {}),
    ...(signals.metaRefresh ? { metaRefresh: signals.metaRefresh } : {}),
    redirectHops: some(fetchResult.hops),
    hsts: some(Boolean(fetchResult.headers["strict-transport-security"])),
    lang: some(content.lang), imagesNoAlt: some(content.imagesNoAlt), mixedContent: some(content.mixedContent), httpLinks: some(content.httpLinks),
    externalLinks: some(content.externalLinks), h1: some(content.h1), questionHeadings: some(content.questionHeadings), statistics: some(content.statistics),
    quotes: some(content.quotes), modified: some(content.modified), snippetBlocked: some(content.snippetBlocked), headingSkips: some(content.headingSkips),
    viewport: content.viewport, words: content.words, leadWords: content.leadWords, images: content.images, landmarks: content.landmarks,
    listsOrTables: content.listsOrTables, articleLike: content.articleLike, author: content.author, entitySchema: content.entitySchema,
    ...(withLinks ? { internalLinks: signals.internalLinks.map((path) => ({ path, family: classifyUrlType(new URL(path || "/", finalUrl).toString()) })) } : {}),
  };
}

export async function auditSitemap(
  baseUrl: string,
  fetcher: Fetcher = defaultFetcher,
  options?: { maxUrls?: number; maxSitemapFiles?: number },
): Promise<{ audit: SitemapAudit; sampleUrls: string[]; urls: string[]; lastmod: Map<string, string> }> {
  const maxUrls = options?.maxUrls ?? 200;
  const origin = new URL(baseUrl).origin;
  const sitemapUrl = `${origin}/sitemap.xml`;
  const robotsUrl = `${origin}/robots.txt`;

  const errors: string[] = [];
  const indexFiles: string[] = [];
  const lastmod = new Map<string, string>();
  let urls: string[] = [];

  try {
    const robots = await fetcher(robotsUrl);
    const declared = robots.status < 400
      ? [...robots.body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((match) => match[1]!)
      : [];
    const ownSitemaps = declared.filter((entry) => isSameSite(entry, origin));
    for (const entry of declared.filter((value) => !isSameSite(value, origin))) {
      errors.push(`robots.txt declares a sitemap on another domain (${entry}); it was skipped.`);
    }
    // Fall back to the conventional location when robots.txt names no sitemap on this site.
    const entries = ownSitemaps.length ? ownSitemaps : [sitemapUrl];
    const state: SitemapCollectionState = {
      visited: new Set<string>(),
      maxFiles: options?.maxSitemapFiles ?? 500,
      lastmod,
    };
    const collected: string[] = [];
    for (const entry of entries) {
      collected.push(...await collectSitemapUrls(entry, fetcher, indexFiles, errors, 0, origin, state));
    }
    urls = [...new Set(collected)];
  } catch (err) {
    errors.push(`Sitemap audit failed: ${String(err)}`);
  }

  const sampleUrls = selectRepresentativeSample(urls, maxUrls);
  const urlTypes: Record<string, number> = {};
  const languages: Record<string, number> = {};
  const editions: Record<string, Record<string, number>> = {};
  for (const u of urls) {
    const type = classifyUrlType(u);
    urlTypes[type] = (urlTypes[type] ?? 0) + 1;
    const lang = classifyLanguage(u);
    languages[lang] = (languages[lang] ?? 0) + 1;
    const byLanguage = editions[type] ??= {};
    byLanguage[lang] = (byLanguage[lang] ?? 0) + 1;
  }
  const sections = Object.fromEntries(Object.entries(editions).map(([type, byLanguage]) => [type, {
    pages: Math.max(...Object.values(byLanguage)),
    languages: Object.keys(byLanguage).length,
  }]));

  return {
    audit: {
      totalUrls: urls.length,
      sampledUrls: sampleUrls.length,
      indexFiles,
      urlTypes,
      sections,
      languages,
      errors,
    },
    sampleUrls,
    urls,
    lastmod,
  };
}

interface SitemapCollectionState {
  visited: Set<string>;
  maxFiles: number;
  /** `<lastmod>` per page URL, for URLs whose sitemap entry declares one. */
  lastmod?: Map<string, string>;
}

/**
 * `<url>` entries of a sitemap with their `<lastmod>`. Walks the document
 * with indexOf so a malformed file (a `<url>` never closed) stays linear.
 */
export function sitemapEntries(body: string): Array<{ loc: string; lastmod?: string }> {
  const lower = body.toLowerCase();
  const entries: Array<{ loc: string; lastmod?: string }> = [];
  let from = 0;
  for (;;) {
    const start = lower.indexOf("<url", from);
    if (start < 0) break;
    if (!/[\s>]/.test(lower[start + 4] ?? "")) { from = start + 4; continue; } // <urlset>
    const end = lower.indexOf("</url>", start);
    if (end < 0) break;
    const block = body.slice(start, end);
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i.exec(block)?.[1];
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(block)?.[1];
    if (loc) entries.push(lastmod ? { loc, lastmod } : { loc });
    from = end + 6;
  }
  return entries;
}

/** Recursively collects page URLs from a sitemap or sitemap index on one origin. */
export async function collectSitemapUrls(
  sitemapUrl: string,
  fetcher: Fetcher,
  indexFiles: string[],
  errors: string[],
  depth = 0,
  origin?: string,
  state?: SitemapCollectionState,
): Promise<string[]> {
  if (depth > 3) return [];
  const collection = state ?? { visited: new Set<string>(), maxFiles: 500 };
  if (collection.visited.has(sitemapUrl)) return [];
  if (collection.visited.size >= collection.maxFiles) {
    errors.push(`Stopped after ${collection.maxFiles} sitemap files; increase the sitemap-file budget to continue.`);
    return [];
  }
  collection.visited.add(sitemapUrl);
  const allowedOrigin = origin ?? new URL(sitemapUrl).origin;
  if (!isSafePublicUrl(sitemapUrl) || !isSameSite(sitemapUrl, allowedOrigin)) {
    errors.push(`Blocked sitemap outside the connected website: ${sitemapUrl}`);
    return [];
  }
  // Sitemaps can be much larger than ordinary HTML pages. Keep the normal
  // page-response cap, while allowing a bounded 25 MB for XML sitemap files.
  const res = await fetcher(sitemapUrl, { maxBytes: 25_000_000 });
  if (res.status >= 400) {
    errors.push(`${sitemapUrl} returned ${res.status}`);
    return [];
  }
  const body = res.body;
  if (body.includes("<sitemapindex")) {
    indexFiles.push(sitemapUrl);
    const locs = [...body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) =>
      m[1].trim(),
    );
    const nested: string[] = [];
    for (const loc of locs) {
      if (collection.visited.size >= collection.maxFiles) {
        errors.push(`Stopped after ${collection.maxFiles} sitemap files; increase the sitemap-file budget to continue.`);
        break;
      }
      nested.push(
        ...(await collectSitemapUrls(loc, fetcher, indexFiles, errors, depth + 1, allowedOrigin, collection)),
      );
    }
    return nested;
  }
  const entries = sitemapEntries(body);
  const locs = entries.length ? entries.map((entry) => entry.loc) : [...body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
  if (collection.lastmod) for (const entry of entries) if (entry.lastmod) collection.lastmod.set(entry.loc, entry.lastmod);
  return locs.filter((loc) => isSafePublicUrl(loc) && isSameSite(loc, allowedOrigin));
}

export function selectRepresentativeSample(
  urls: string[],
  max: number,
): string[] {
  if (urls.length <= max) return urls;
  const buckets: Record<string, string[]> = {};
  for (const u of urls) {
    const key = `${classifyLanguage(u)}:${classifyUrlType(u)}`;
    (buckets[key] ??= []).push(u);
  }
  const sample: string[] = [];
  const keys = Object.keys(buckets);
  let i = 0;
  while (sample.length < max && keys.some((k) => buckets[k].length)) {
    const key = keys[i % keys.length];
    const next = buckets[key].shift();
    if (next) sample.push(next);
    i++;
  }
  return sample;
}

const COMMERCIAL_URL_PATTERN = /price|pricing|cost|book|buy|quote|services?|products?|plans?|compare|treatments?|clinic/i;

export function findingsFromCrawl(input: {
  siteId: string;
  analysisId: string;
  sitemap: SitemapAudit;
  pageResults: CrawlPageResult[];
}): Finding[] {
  const findings: Finding[] = [];
  const emptyPages = input.pageResults.filter((p) => p.isEmptyShell);
  const emptyRatio =
    input.pageResults.length > 0
      ? emptyPages.length / input.pageResults.length
      : 0;

  if (emptyPages.length > 0) {
    const impact = organicImpactScore({
      category: "rendering",
      pagesAffected:
        Math.round(emptyRatio * Math.max(input.sitemap.totalUrls, emptyPages.length)) ||
        emptyPages.length,
      isEmptyShellAtScale: emptyRatio >= 0.3 || emptyPages.length >= 5,
      isBlockingCrawl: emptyRatio >= 0.5,
      commercialIntent: emptyPages.some((p) => COMMERCIAL_URL_PATTERN.test(p.url)),
    });
    findings.push(finding(CHECKS["render.empty_shell"]!, {
      siteId: input.siteId,
      analysisId: input.analysisId,
      title: "Entity pages return empty or thin HTML shells to crawlers",
      summary: `${emptyPages.length}/${input.pageResults.length} sampled URLs look like empty shells in raw/Googlebot fetches (${Math.round(emptyRatio * 100)}%). Search engines and AI crawlers may not receive meaningful content.`,
      evidence: {
        emptyUrls: emptyPages.slice(0, 20).map((p) => ({
          url: p.url,
          title: p.title,
          textLength: p.rawTextLength,
          status: p.status,
        })),
        emptyRatio,
        sitemapTotal: input.sitemap.totalUrls,
      },
      impact: impact,
      recommendation:
        "Ensure server/edge-rendered HTML with real title, description, JSON-LD and primary content for entity pages — do not rely on client-only hydration for indexable URLs.",
      pagesAffected: emptyPages.map((p) => p.url),
    }));
  }

  const soft200 = input.pageResults.filter(
    (p) =>
      p.status === 200 &&
      (p.isEmptyShell || /not found|page not found|404/i.test(p.title ?? "")),
  );
  if (soft200.length >= 2) {
    const impact = organicImpactScore({
      category: "indexing",
      pagesAffected: soft200.length,
      isBlockingCrawl: true,
    });
    findings.push(finding(CHECKS["server.soft_200"]!, {
      siteId: input.siteId,
      analysisId: input.analysisId,
      title: "Soft-200 responses risk indexing junk URLs",
      summary: `${soft200.length} sampled URLs returned HTTP 200 without solid content or with not-found titles. Soft 404s waste crawl budget and dilute index quality.`,
      evidence: { urls: soft200.slice(0, 15).map((p) => p.url) },
      impact: impact,
      recommendation:
        "Return true 404/410 for unknown entity slugs and avoid self-canonicalizing empty shells.",
      pagesAffected: soft200.map((p) => p.url),
    }));
  }

  if (input.sitemap.totalUrls > 5000 && emptyRatio > 0.2) {
    const impact = organicImpactScore({
      category: "sitemap",
      pagesAffected: input.sitemap.totalUrls,
      isEmptyShellAtScale: true,
      trafficShareAffected: 0.3,
    });
    findings.push(finding(CHECKS["render.coverage_weak"]!, {
      siteId: input.siteId,
      analysisId: input.analysisId,
      title: "Large sitemap with weak render coverage",
      summary: `Sitemap declares ~${input.sitemap.totalUrls} URLs, but sampled crawl suggests a large share may not expose meaningful HTML. Indexing of the full set is unlikely until rendering is fixed.`,
      evidence: {
        sitemap: input.sitemap,
        emptyRatio,
      },
      impact: impact,
      recommendation:
        "Prioritize edge/SSR HTML for sitemap-listed entity URLs before expanding programmatic page counts.",
      pagesAffected: [],
    }));
  }

  // Detail pages (two or more path segments) are where structured data earns rich results.
  const missingJsonLd = input.pageResults.filter(
    (p) => !p.isEmptyShell && p.jsonLdCount === 0 && !["home", "page"].includes(classifyUrlType(p.url)),
  );
  if (missingJsonLd.length >= 3) {
    const impact = organicImpactScore({
      category: "structured_data",
      pagesAffected: missingJsonLd.length,
    });
    findings.push(finding(CHECKS["schema.missing"]!, {
      siteId: input.siteId,
      analysisId: input.analysisId,
      title: "Detail pages missing JSON-LD in crawler HTML",
      summary: `${missingJsonLd.length} sampled detail pages had no JSON-LD in the fetched HTML.`,
      evidence: { urls: missingJsonLd.slice(0, 10).map((p) => p.url) },
      impact: impact,
      recommendation: "Emit schema.org markup that matches each template (e.g. Product, LocalBusiness, Person, Article) in the initial HTML.",
      pagesAffected: missingJsonLd.map((p) => p.url),
    }));
  }

  return findings;
}

export * from "./tech-seo.js";
export * from "./coverage-findings.js";
export * from "./rendering.js";
export * from "./competitors.js";
export * from "./urls.js";
export * from "./html.js";
export * from "./robots.js";
export * from "./ai-readiness.js";

export * from "./content-signals.js";
export * from "./link-findings.js";
export * from "./ai-findings.js";
export * from "./probe.js";
