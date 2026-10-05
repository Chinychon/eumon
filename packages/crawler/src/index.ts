import type { CrawlPageResult, Finding, SitemapAudit } from "@organic-growth/core";
import { createId, organicImpactScore, severityFromImpact } from "@organic-growth/core";

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
}

export type Fetcher = (
  url: string,
  init?: { userAgent?: string; headers?: Record<string, string> },
) => Promise<FetchResult>;

export function isSafePublicUrl(value: string, expectedOrigin?: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
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
  const chunks: Uint8Array[] = [];
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
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export const defaultFetcher: Fetcher = async (url, init) => {
  if (!isSafePublicUrl(url)) throw new Error("Crawler only accepts public HTTP(S) website URLs.");
  const origin = new URL(url).origin;
  let target = url;
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
      if (!isSafePublicUrl(next, origin)) throw new Error("Crawler blocked a redirect outside the connected website.");
      target = next;
      continue;
    }
    const body = await boundedText(res);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { url, status: res.status, finalUrl: target, headers, body };
  }
  throw new Error("Crawler stopped after an unsafe or excessive redirect chain.");
};

export function parseHtmlSignals(html: string): {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  hreflang: Array<{ lang: string; href: string }>;
  jsonLdCount: number;
  headingOutline: string[];
  internalLinkCount: number;
  textLength: number;
  hasRootMount: boolean;
  bodyTextSample: string;
} {
  const title = matchContent(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = matchAttr(
    html,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ) ?? matchAttr(
    html,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
  );
  const canonical = matchAttr(
    html,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i,
  );
  const robots = matchAttr(
    html,
    /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i,
  );
  const hreflang: Array<{ lang: string; href: string }> = [];
  const hreflangRe =
    /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["'][^>]+href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hreflangRe.exec(html))) {
    hreflang.push({ lang: m[1], href: m[2] });
  }
  const jsonLdCount = (html.match(/application\/ld\+json/gi) ?? []).length;
  const headingOutline: string[] = [];
  const headingRe = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = headingRe.exec(html))) {
    headingOutline.push(`${m[1]}:${stripTags(m[2]).slice(0, 120)}`);
  }
  const internalLinkCount = (html.match(/<a\s+[^>]*href=["']\//gi) ?? []).length;
  const text = stripTags(html).replace(/\s+/g, " ").trim();
  const hasRootMount =
    /id=["']root["']/i.test(html) ||
    /id=["']app["']/i.test(html) ||
    /id=["']__next["']/i.test(html);
  return {
    title: title ? stripTags(title).trim() : undefined,
    description,
    canonical,
    robots,
    hreflang,
    jsonLdCount,
    headingOutline: headingOutline.slice(0, 20),
    internalLinkCount,
    textLength: text.length,
    hasRootMount,
    bodyTextSample: text.slice(0, 280),
  };
}

export function isEmptyShell(html: string, signals = parseHtmlSignals(html)): boolean {
  // SPA shell: mount point + little meaningful content, generic/missing title
  if (signals.textLength < 400 && signals.hasRootMount) return true;
  if (signals.textLength < 200) return true;
  if (
    signals.hasRootMount &&
    signals.jsonLdCount === 0 &&
    signals.headingOutline.length === 0 &&
    signals.textLength < 800
  ) {
    return true;
  }
  return false;
}

function matchContent(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m?.[1];
}

function matchAttr(html: string, re: RegExp): string | undefined {
  const m = html.match(re);
  return m?.[1];
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ");
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

function toCrawlResult(
  url: string,
  fetchResult: FetchResult,
  mode: CrawlPageResult["fetchMode"],
): CrawlPageResult {
  const signals = parseHtmlSignals(fetchResult.body);
  const empty = isEmptyShell(fetchResult.body, signals);
  return {
    url,
    status: fetchResult.status,
    finalUrl: fetchResult.finalUrl,
    title: signals.title,
    description: signals.description,
    canonical: signals.canonical,
    robots: signals.robots,
    hreflang: signals.hreflang,
    jsonLdCount: signals.jsonLdCount,
    contentLength: fetchResult.body.length,
    isEmptyShell: empty,
    headingOutline: signals.headingOutline,
    internalLinkCount: signals.internalLinkCount,
    rawTextLength: mode === "raw" ? signals.textLength : signals.textLength,
    renderedTextLength: 0,
    renderDelta: 0,
    fetchMode: mode,
  };
}

export async function auditSitemap(
  baseUrl: string,
  fetcher: Fetcher = defaultFetcher,
  options?: { maxUrls?: number },
): Promise<{ audit: SitemapAudit; sampleUrls: string[] }> {
  const maxUrls = options?.maxUrls ?? 200;
  const origin = new URL(baseUrl).origin;
  const sitemapUrl = `${origin}/sitemap.xml`;
  const robotsUrl = `${origin}/robots.txt`;

  const errors: string[] = [];
  const indexFiles: string[] = [];
  let urls: string[] = [];

  try {
    const robots = await fetcher(robotsUrl);
    const sitemapFromRobots = robots.body.match(/Sitemap:\s*(\S+)/i)?.[1];
    const entry = sitemapFromRobots ?? sitemapUrl;
    const collected = await collectSitemapUrls(entry, fetcher, indexFiles, errors, 0, origin);
    urls = collected;
  } catch (err) {
    errors.push(`Sitemap audit failed: ${String(err)}`);
  }

  const sampleUrls = selectRepresentativeSample(urls, maxUrls);
  const urlTypes: Record<string, number> = {};
  const languages: Record<string, number> = {};
  for (const u of urls) {
    const type = classifyUrlType(u);
    urlTypes[type] = (urlTypes[type] ?? 0) + 1;
    const lang = classifyLanguage(u);
    languages[lang] = (languages[lang] ?? 0) + 1;
  }

  return {
    audit: {
      totalUrls: urls.length,
      sampledUrls: sampleUrls.length,
      indexFiles,
      urlTypes,
      languages,
      errors,
    },
    sampleUrls,
  };
}

async function collectSitemapUrls(
  sitemapUrl: string,
  fetcher: Fetcher,
  indexFiles: string[],
  errors: string[],
  depth = 0,
  origin?: string,
): Promise<string[]> {
  if (depth > 3) return [];
  const allowedOrigin = origin ?? new URL(sitemapUrl).origin;
  if (!isSafePublicUrl(sitemapUrl, allowedOrigin)) {
    errors.push(`Blocked sitemap outside the connected website: ${sitemapUrl}`);
    return [];
  }
  const res = await fetcher(sitemapUrl);
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
    for (const loc of locs.slice(0, 20)) {
      nested.push(
        ...(await collectSitemapUrls(loc, fetcher, indexFiles, errors, depth + 1, allowedOrigin)),
      );
    }
    return nested;
  }
  return [...body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) => m[1].trim())
    .filter((loc) => isSafePublicUrl(loc, allowedOrigin));
}

export function classifyUrlType(url: string): string {
  const path = new URL(url).pathname;
  if (/\/doctors\//.test(path)) return "doctor";
  if (/\/hospitals\//.test(path)) return "hospital";
  if (/\/procedures\//.test(path)) return "procedure";
  if (/\/blog\//.test(path)) return "blog";
  if (/\/doctors\/[^/]+\/[^/]+/.test(path)) return "specialty_area";
  if (path === "/" || path === "/id" || path === "/zh") return "home";
  return "other";
}

export function classifyLanguage(url: string): string {
  const path = new URL(url).pathname;
  if (path === "/id" || path.startsWith("/id/")) return "id";
  if (path === "/zh" || path.startsWith("/zh/")) return "zh";
  return "en";
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
      commercialIntent: emptyPages.some((p) =>
        /procedure|hospital|ivf|fertility|cost/i.test(p.url),
      ),
    });
    findings.push({
      id: createId("finding"),
      siteId: input.siteId,
      analysisId: input.analysisId,
      category: "rendering",
      severity: severityFromImpact(impact),
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
      organicImpactScore: impact,
      recommendation:
        "Ensure server/edge-rendered HTML with real title, description, JSON-LD and primary content for entity pages — do not rely on client-only hydration for indexable URLs.",
      pagesAffected: emptyPages.map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
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
    findings.push({
      id: createId("finding"),
      siteId: input.siteId,
      analysisId: input.analysisId,
      category: "indexing",
      severity: severityFromImpact(impact),
      title: "Soft-200 responses risk indexing junk URLs",
      summary: `${soft200.length} sampled URLs returned HTTP 200 without solid content or with not-found titles. Soft 404s waste crawl budget and dilute index quality.`,
      evidence: { urls: soft200.slice(0, 15).map((p) => p.url) },
      organicImpactScore: impact,
      recommendation:
        "Return true 404/410 for unknown entity slugs and avoid self-canonicalizing empty shells.",
      pagesAffected: soft200.map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
  }

  if (input.sitemap.totalUrls > 5000 && emptyRatio > 0.2) {
    const impact = organicImpactScore({
      category: "sitemap",
      pagesAffected: input.sitemap.totalUrls,
      isEmptyShellAtScale: true,
      trafficShareAffected: 0.3,
    });
    findings.push({
      id: createId("finding"),
      siteId: input.siteId,
      analysisId: input.analysisId,
      category: "sitemap",
      severity: severityFromImpact(impact),
      title: "Large sitemap with weak render coverage",
      summary: `Sitemap declares ~${input.sitemap.totalUrls} URLs, but sampled crawl suggests a large share may not expose meaningful HTML. Indexing of the full set is unlikely until rendering is fixed.`,
      evidence: {
        sitemap: input.sitemap,
        emptyRatio,
      },
      organicImpactScore: impact,
      recommendation:
        "Prioritize edge/SSR HTML for sitemap-listed entity URLs before expanding programmatic page counts.",
      pagesAffected: [],
      createdAt: new Date().toISOString(),
    });
  }

  const missingJsonLd = input.pageResults.filter(
    (p) => !p.isEmptyShell && p.jsonLdCount === 0 && /doctor|hospital|procedure|blog/i.test(p.url),
  );
  if (missingJsonLd.length >= 3) {
    const impact = organicImpactScore({
      category: "structured_data",
      pagesAffected: missingJsonLd.length,
    });
    findings.push({
      id: createId("finding"),
      siteId: input.siteId,
      analysisId: input.analysisId,
      category: "structured_data",
      severity: severityFromImpact(impact),
      title: "Entity pages missing JSON-LD in crawler HTML",
      summary: `${missingJsonLd.length} content pages had no JSON-LD in the fetched HTML.`,
      evidence: { urls: missingJsonLd.slice(0, 10).map((p) => p.url) },
      organicImpactScore: impact,
      recommendation: "Emit Medical/Physician/Hospital/Article schema in initial HTML.",
      pagesAffected: missingJsonLd.map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
  }

  return findings;
}

export * from "./tech-seo.js";
