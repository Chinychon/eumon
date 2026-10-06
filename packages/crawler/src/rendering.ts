import type { CrawlPageResult, Finding } from "@organic-growth/core";
import { createId, organicImpactScore, severityFromImpact } from "@organic-growth/core";
import { GOOGLEBOT_UA, defaultFetcher, isEmptyShell, parseHtmlSignals, type Fetcher } from "./index.js";
import { classifyUrlType } from "./urls.js";

/** What a browser rendering of a page added to the HTML crawlers receive. */
export type RenderComparison = {
  url: string;
  family: string;
  verdict: "server_rendered" | "partially_client_rendered" | "client_rendered" | "empty_after_render";
  rawTextLength: number;
  renderedTextLength: number;
  rawTitle?: string;
  renderedTitle?: string;
  rawH1Count: number;
  renderedH1Count: number;
  rawHasDescription: boolean;
  renderedHasDescription: boolean;
  rawCanonical?: string;
  renderedCanonical?: string;
};

/** Repeated Googlebot fetches of one URL. */
export type RepeatabilityResult = {
  url: string;
  family: string;
  attempts: Array<{ status: number; emptyShell: boolean; textLength: number; ms: number; cache?: string; error?: string }>;
};

const CACHE_HEADERS = ["cf-cache-status", "x-vercel-cache", "x-nextjs-cache", "x-cache", "x-cache-status"];

/** Compares the HTML a crawler receives with the DOM after JavaScript runs. */
export function compareRendering(url: string, raw: CrawlPageResult, renderedHtml: string): RenderComparison {
  const rendered = parseHtmlSignals(renderedHtml, url);
  const renderedEmpty = isEmptyShell(renderedHtml, rendered);
  const added = rendered.textLength - raw.rawTextLength;
  const verdict: RenderComparison["verdict"] = raw.isEmptyShell
    ? renderedEmpty ? "empty_after_render" : "client_rendered"
    : added >= 500 && rendered.textLength >= raw.rawTextLength * 1.5 ? "partially_client_rendered" : "server_rendered";
  return {
    url,
    family: raw.routeFamily ?? classifyUrlType(url),
    verdict,
    rawTextLength: raw.rawTextLength,
    renderedTextLength: rendered.textLength,
    rawTitle: raw.title,
    renderedTitle: rendered.title,
    rawH1Count: raw.h1Count ?? 0,
    renderedH1Count: rendered.h1Count,
    rawHasDescription: Boolean(raw.description?.trim()),
    renderedHasDescription: Boolean(rendered.description?.trim()),
    rawCanonical: raw.canonical,
    renderedCanonical: rendered.canonical,
  };
}

/**
 * Fetches each URL several times as Googlebot. Problems that only appear on
 * some attempts (render timeouts, cache misses, flaky data sources) are
 * invisible to a single crawl but cost indexing all the same.
 */
export async function testRepeatability(
  urls: string[],
  fetcher: Fetcher = defaultFetcher,
  attempts = 3,
  concurrency = 4,
): Promise<RepeatabilityResult[]> {
  const results: RepeatabilityResult[] = urls.map((url) => ({ url, family: classifyUrlType(url), attempts: [] }));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const result = results[index];
      if (!result) return;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const started = Date.now();
        try {
          const response = await fetcher(result.url, { userAgent: GOOGLEBOT_UA });
          const signals = parseHtmlSignals(response.body, response.finalUrl);
          const cache = CACHE_HEADERS.map((name) => response.headers[name]).find(Boolean);
          result.attempts.push({
            status: response.status,
            emptyShell: response.status < 400 && isEmptyShell(response.body, signals),
            textLength: signals.textLength,
            ms: Date.now() - started,
            ...(cache ? { cache: cache.toUpperCase().slice(0, 20) } : {}),
          });
        } catch (error) {
          result.attempts.push({ status: 0, emptyShell: false, textLength: 0, ms: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 160) : "Fetch failed" });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

type Draft = Omit<Finding, "id" | "siteId" | "analysisId" | "severity" | "createdAt"> & { severity?: Finding["severity"] };

const familyLabel = (family: string) => (family === "home" ? "the homepage" : family === "page" ? "top-level pages" : `/${family}/ pages`);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};
const isBad = (attempt: RepeatabilityResult["attempts"][number]) => Boolean(attempt.error) || attempt.status >= 500 || attempt.emptyShell;

/**
 * Turns rendering comparisons into findings: content or metadata that only
 * exists after JavaScript runs, pages that stay empty even in a browser,
 * crawlers and browsers receiving different HTML, and intermittent failures.
 * `familySizes` (sitemap URLs per route family) scales impact to the template.
 */
export function findingsFromRendering(input: {
  siteId: string;
  analysisId: string;
  familySizes: Record<string, number>;
  comparisons?: RenderComparison[];
  userAgentPairs?: Array<{ url: string; browser: CrawlPageResult; googlebot: CrawlPageResult }>;
  repeatability?: RepeatabilityResult[];
}): Finding[] {
  const drafts: Draft[] = [];
  const sizeOf = (family: string) => Math.max(input.familySizes[family] ?? 1, 1);
  const comparisons = input.comparisons ?? [];

  const clientRendered = comparisons.filter((entry) => entry.verdict === "client_rendered" || entry.verdict === "partially_client_rendered");
  if (clientRendered.length) {
    const families = [...new Set(clientRendered.map((entry) => entry.family))];
    const fully = clientRendered.some((entry) => entry.verdict === "client_rendered");
    const example = [...clientRendered].sort((a, b) => (b.renderedTextLength - b.rawTextLength) - (a.renderedTextLength - a.rawTextLength))[0]!;
    drafts.push({
      category: "rendering",
      organicImpactScore: organicImpactScore({
        category: "rendering",
        pagesAffected: families.reduce((sum, family) => sum + sizeOf(family), 0),
        isEmptyShellAtScale: fully,
      }),
      title: fully ? "Page content only appears after JavaScript runs" : "Part of the page content is added by JavaScript",
      summary: `In a browser, ${example.url} shows ${example.renderedTextLength.toLocaleString("en")} characters of text; the HTML crawlers receive has ${example.rawTextLength.toLocaleString("en")}. Affected: ${families.map(familyLabel).join(", ")}. Google renders JavaScript later and less reliably than it reads HTML, and AI crawlers (GPTBot, ClaudeBot, PerplexityBot) don't run it at all.`,
      evidence: { comparisons: clientRendered },
      recommendation: "Render the main content on the server: static generation or server rendering for these routes (Next.js server components or getStaticProps, Astro, Nuxt SSR), or prerender a Vite/React SPA at build time. Keep client-side code for interaction only.",
      pagesAffected: clientRendered.map((entry) => entry.url),
    });
  }

  const emptyAfterRender = comparisons.filter((entry) => entry.verdict === "empty_after_render");
  if (emptyAfterRender.length) {
    const families = [...new Set(emptyAfterRender.map((entry) => entry.family))];
    drafts.push({
      category: "rendering",
      organicImpactScore: organicImpactScore({
        category: "rendering",
        pagesAffected: families.reduce((sum, family) => sum + sizeOf(family), 0),
        isEmptyShellAtScale: true,
      }),
      title: "Pages stay empty even after JavaScript runs",
      summary: `${emptyAfterRender.length} sampled ${emptyAfterRender.length === 1 ? "page" : "pages"} (${families.map(familyLabel).join(", ")}) had almost no content in a real browser either. That usually means a failed data request, an error boundary, or a login or consent wall in front of the content.`,
      evidence: { comparisons: emptyAfterRender },
      recommendation: "Open an affected URL with the browser console open and check failed network requests. Make sure pages render their content even when a secondary data source fails.",
      pagesAffected: emptyAfterRender.map((entry) => entry.url),
    });
  }

  // Metadata set client-side (react-helmet, useEffect document.title…) is a
  // classic of AI-built single-page apps: every URL shares index.html's title.
  const rawTitles = new Set(comparisons.map((entry) => entry.rawTitle ?? ""));
  const renderedTitles = new Set(comparisons.map((entry) => entry.renderedTitle ?? ""));
  const sharedRawTitle = comparisons.length >= 2 && rawTitles.size === 1 && renderedTitles.size > 1;
  const jsMetadata = comparisons.filter((entry) =>
    (entry.renderedTitle && entry.renderedTitle !== entry.rawTitle && (sharedRawTitle || !entry.rawTitle))
    || (!entry.rawHasDescription && entry.renderedHasDescription)
    || (!entry.rawCanonical && entry.renderedCanonical));
  if (jsMetadata.length) {
    const families = [...new Set(jsMetadata.map((entry) => entry.family))];
    const example = jsMetadata[0]!;
    drafts.push({
      category: "metadata",
      organicImpactScore: Math.min(organicImpactScore({ category: "metadata", pagesAffected: families.reduce((sum, family) => sum + sizeOf(family), 0), commercialIntent: true }) + 15, 60),
      title: "Titles and meta tags are set by JavaScript",
      summary: sharedRawTitle
        ? `Every sampled page has the same title in its HTML (“${example.rawTitle ?? ""}”); the page-specific title (e.g. “${example.renderedTitle ?? ""}”) only appears after JavaScript runs. Link previews, AI crawlers, and Google's first pass see the generic one.`
        : `On ${jsMetadata.length} sampled ${jsMetadata.length === 1 ? "page" : "pages"}, the title, description, or canonical tag only appears after JavaScript runs. Link previews, AI crawlers, and Google's first pass don't see them.`,
      evidence: { comparisons: jsMetadata.map(({ url, rawTitle, renderedTitle, rawHasDescription, renderedHasDescription, rawCanonical, renderedCanonical }) => ({ url, rawTitle, renderedTitle, rawHasDescription, renderedHasDescription, rawCanonical, renderedCanonical })) },
      recommendation: "Emit title, meta description, canonical, and Open Graph tags in the server response (framework metadata APIs, or prerendering for a single-page app) instead of setting them in the browser.",
      pagesAffected: jsMetadata.map((entry) => entry.url),
    });
  }

  const pairs = (input.userAgentPairs ?? []).filter((pair) => pair.browser.status < 400 && pair.googlebot.status < 400);
  const googlebotWorse = pairs.filter((pair) => pair.googlebot.isEmptyShell && !pair.browser.isEmptyShell);
  if (googlebotWorse.length) {
    drafts.push({
      category: "rendering",
      organicImpactScore: organicImpactScore({ category: "rendering", pagesAffected: googlebotWorse.length, isEmptyShellAtScale: true }),
      title: "Googlebot receives less content than browsers",
      summary: `${googlebotWorse.length} sampled ${googlebotWorse.length === 1 ? "page returns" : "pages return"} an empty shell to a Googlebot user agent but full HTML to a browser. Bot detection, a misconfigured prerender service, or user-agent-specific caching is serving crawlers a broken page.`,
      evidence: { pages: googlebotWorse.map((pair) => ({ url: pair.url, browserText: pair.browser.rawTextLength, googlebotText: pair.googlebot.rawTextLength })) },
      recommendation: "Serve crawlers the same HTML as browsers. Check bot-management rules, prerender or dynamic-rendering middleware, and cache keys that vary on User-Agent.",
      pagesAffected: googlebotWorse.map((pair) => pair.url),
    });
  }
  const dynamicRendering = pairs.filter((pair) => pair.browser.isEmptyShell && !pair.googlebot.isEmptyShell);
  if (dynamicRendering.length) {
    drafts.push({
      category: "rendering",
      organicImpactScore: 15,
      title: "Crawlers get pre-rendered HTML that browsers don't",
      summary: `${dynamicRendering.length} sampled ${dynamicRendering.length === 1 ? "page serves" : "pages serve"} full HTML to Googlebot and an empty shell to browsers (dynamic rendering). Google treats this as a workaround; AI crawlers and link previews that don't identify as Googlebot get the empty version.`,
      evidence: { pages: dynamicRendering.map((pair) => ({ url: pair.url, browserText: pair.browser.rawTextLength, googlebotText: pair.googlebot.rawTextLength })) },
      recommendation: "Move to server rendering or static generation so every client gets the same complete HTML.",
      pagesAffected: dynamicRendering.map((pair) => pair.url),
    });
  }

  const byFamily = new Map<string, RepeatabilityResult[]>();
  for (const result of input.repeatability ?? []) byFamily.set(result.family, [...(byFamily.get(result.family) ?? []), result]);
  for (const [family, results] of byFamily) {
    const attempts = results.flatMap((result) => result.attempts);
    const flaky = results.filter((result) => result.attempts.some(isBad) && result.attempts.some((attempt) => !isBad(attempt)));
    if (flaky.length) {
      const flakyAttempts = flaky.flatMap((result) => result.attempts);
      const bad = flakyAttempts.filter(isBad);
      const good = flakyAttempts.filter((attempt) => !isBad(attempt));
      const rate = attempts.filter(isBad).length / Math.max(attempts.length, 1);
      const causes: string[] = [];
      if (bad.some((attempt) => attempt.cache === "MISS") && good.every((attempt) => attempt.cache && attempt.cache !== "MISS")) causes.push("failures coincide with cache misses, so uncached renders are too slow or fail");
      if (bad.some((attempt) => attempt.status >= 500 || attempt.error)) causes.push("the server returned errors or timed out");
      if (bad.some((attempt) => attempt.emptyShell)) causes.push("some responses fell back to an empty client-side shell (often a render timeout or a failed data request during rendering)");
      if (median(bad.map((attempt) => attempt.ms)) > median(good.map((attempt) => attempt.ms)) * 2) causes.push("failed responses were much slower than successful ones");
      drafts.push({
        category: "rendering",
        organicImpactScore: organicImpactScore({
          category: "rendering",
          pagesAffected: Math.round(sizeOf(family) * rate),
          isEmptyShellAtScale: rate >= 0.05 && sizeOf(family) >= 50,
        }),
        title: `Intermittent empty or failed responses on ${familyLabel(family)}`,
        summary: `${attempts.filter(isBad).length} of ${attempts.length} repeated Googlebot fetches of ${familyLabel(family)} (${Math.round(rate * 100)}%) returned an empty shell or an error, while other fetches of the same URLs succeeded. A single crawl can miss this; Google sees it on every recrawl.${causes.length ? ` Likely cause: ${causes.join("; ")}.` : ""}`,
        evidence: { family, results: flaky },
        recommendation: "Make the page HTML independent of slow or optional data: cache or pre-generate it, raise render timeouts, run independent data requests in parallel, and render the main content even when a secondary request fails.",
        pagesAffected: flaky.map((result) => result.url),
      });
    }
    const latency = median(attempts.filter((attempt) => !attempt.error && attempt.status < 400).map((attempt) => attempt.ms));
    if (latency >= 3000) {
      drafts.push({
        category: "rendering",
        organicImpactScore: Math.min(organicImpactScore({ category: "rendering", pagesAffected: sizeOf(family) }), 45),
        title: `Slow responses on ${familyLabel(family)}`,
        summary: `The median Googlebot fetch of ${familyLabel(family)} took ${(latency / 1000).toFixed(1)} s. Slow responses reduce how many pages Google crawls per visit and hurt Core Web Vitals.`,
        evidence: { family, medianMs: latency, results },
        recommendation: "Cache or statically generate these pages, and look for sequential database or API requests before the HTML is sent.",
        pagesAffected: results.map((result) => result.url),
      });
    }
  }

  const createdAt = new Date().toISOString();
  return drafts.map((draft) => ({
    id: createId("finding"),
    siteId: input.siteId,
    analysisId: input.analysisId,
    ...draft,
    severity: severityFromImpact(draft.organicImpactScore),
    createdAt,
  }));
}

/** One URL per route family, most common families first: a small sample that covers every template. */
export function samplePerFamily(urls: string[], perFamily: number, limit: number): string[] {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const family = classifyUrlType(url);
    groups.set(family, [...(groups.get(family) ?? []), url]);
  }
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
  const sample: string[] = [];
  for (let round = 0; round < perFamily; round++) {
    for (const group of ordered) {
      if (sample.length >= limit) return sample;
      if (group[round]) sample.push(group[round]!);
    }
  }
  return sample;
}

