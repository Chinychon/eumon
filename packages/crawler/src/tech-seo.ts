import type { CrawlPageResult, Finding, SitemapAudit } from "@organic-growth/core";
import { createId, organicImpactScore, severityFromImpact } from "@organic-growth/core";
import { GOOGLEBOT_TOKEN, parseRobots } from "./robots.js";
import { classifyLanguage, isSameSite, sameDocument } from "./urls.js";

/** Crawlers that collect content for AI assistants and answer engines. */
const AI_CRAWLERS = [
  { name: "GPTBot", token: "gptbot", product: "OpenAI" },
  { name: "OAI-SearchBot", token: "oai-searchbot", product: "ChatGPT search" },
  { name: "ClaudeBot", token: "claudebot", product: "Anthropic" },
  { name: "PerplexityBot", token: "perplexitybot", product: "Perplexity" },
  { name: "Google-Extended", token: "google-extended", product: "Gemini" },
];

/**
 * Technical SEO audit rules ranked by expected organic impact.
 */
export function runTechnicalSeoAudit(input: {
  siteId: string;
  analysisId: string;
  baseUrl: string;
  sitemap: SitemapAudit;
  pages: CrawlPageResult[];
  robotsTxt?: string;
  /** Every sitemap URL was crawled; per-page checks it covers are skipped here to avoid duplicates. */
  fullCrawl?: boolean;
}): Finding[] {
  const findings: Finding[] = [];
  const { pages, sitemap, siteId, analysisId } = input;

  const canonicalMismatches = input.fullCrawl ? [] : pages.filter((p) => p.canonical && !sameDocument(p.canonical, p.finalUrl ?? p.url));
  if (canonicalMismatches.length > 0) {
    const impact = organicImpactScore({
      category: "indexing",
      pagesAffected: canonicalMismatches.length,
      isBlockingCrawl: canonicalMismatches.length > 10,
    });
    findings.push({
      id: createId("finding"),
      siteId,
      analysisId,
      category: "indexing",
      severity: severityFromImpact(impact),
      title: "Canonical mismatches detected",
      summary: `${canonicalMismatches.length} sampled pages have canonical URLs that do not match the fetched URL.`,
      evidence: {
        examples: canonicalMismatches.slice(0, 10).map((p) => ({
          url: p.url,
          canonical: p.canonical,
        })),
      },
      organicImpactScore: impact,
      recommendation: "Align canonical tags with the preferred indexable URL for each page.",
      pagesAffected: canonicalMismatches.map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
  }

  // Only meaningful when the site actually publishes locale-prefixed URLs.
  const locales = new Set(pages.map((p) => classifyLanguage(p.url)));
  const missingHreflang = locales.size > 1
    ? pages.filter((p) => p.hreflang.length === 0 && !p.isEmptyShell)
    : [];
  if (missingHreflang.length >= 3) {
    const impact = organicImpactScore({
      category: "metadata",
      pagesAffected: missingHreflang.length,
      commercialIntent: true,
    });
    findings.push({
      id: createId("finding"),
      siteId,
      analysisId,
      category: "metadata",
      severity: severityFromImpact(impact),
      title: "Multilingual pages missing hreflang in HTML",
      summary: `The site serves ${locales.size} locale variants, but ${missingHreflang.length} sampled pages lacked hreflang alternates in crawler HTML.`,
      evidence: { urls: missingHreflang.slice(0, 10).map((p) => p.url) },
      organicImpactScore: impact,
      recommendation:
        "Emit reciprocal hreflang alternates (plus x-default) in the initial HTML for every localized page.",
      pagesAffected: missingHreflang.map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
  }

  const weakTitles = input.fullCrawl ? [] : pages.filter(
    (p) =>
      !p.isEmptyShell &&
      (!p.title || p.title.length < 15 || /^https?:/i.test(p.title) || p.title === p.url),
  );
  if (weakTitles.length >= 3) {
    const impact = organicImpactScore({
      category: "metadata",
      pagesAffected: weakTitles.length,
    });
    findings.push({
      id: createId("finding"),
      siteId,
      analysisId,
      category: "metadata",
      severity: severityFromImpact(Math.min(impact, 45)),
      title: "Weak or missing titles on indexable pages",
      summary: `${weakTitles.length} pages have missing/weak titles in crawler HTML.`,
      evidence: { urls: weakTitles.slice(0, 10).map((p) => ({ url: p.url, title: p.title })) },
      organicImpactScore: Math.min(impact, 45),
      recommendation: "Generate unique, intent-matched titles server-side per entity template.",
      pagesAffected: weakTitles.map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
  }

  const googlebotRules = input.robotsTxt ? parseRobots(input.robotsTxt, GOOGLEBOT_TOKEN) : null;
  if (googlebotRules && !googlebotRules.isAllowed("/")) {
    const impact = organicImpactScore({
      category: "indexing",
      pagesAffected: sitemap.totalUrls || 1,
      isBlockingCrawl: true,
    });
    findings.push({
      id: createId("finding"),
      siteId,
      analysisId,
      category: "indexing",
      severity: "CRITICAL",
      title: "robots.txt blocks Googlebot from the entire site",
      summary: "The robots.txt rules that apply to Googlebot disallow the homepage and everything below it, so Google cannot crawl the site.",
      evidence: { robotsTxt: input.robotsTxt!.slice(0, 2000) },
      organicImpactScore: impact,
      recommendation: "Remove the sitewide Disallow from the group that applies to Googlebot (its own group, or `User-agent: *`) and keep only intentional private path blocks.",
      pagesAffected: [],
      createdAt: new Date().toISOString(),
    });
  }

  // Blocking AI crawlers is a legitimate business choice, but it removes the
  // site from AI search answers; report it without treating it as an error.
  const blockedAiCrawlers = input.robotsTxt
    ? AI_CRAWLERS.filter((crawler) => !parseRobots(input.robotsTxt!, crawler.token).isAllowed("/"))
    : [];
  if (blockedAiCrawlers.length) {
    findings.push({
      id: createId("finding"),
      siteId,
      analysisId,
      category: "indexing",
      severity: "INFORMATIONAL",
      title: "robots.txt blocks AI search crawlers",
      summary: `robots.txt disallows ${blockedAiCrawlers.map((crawler) => `${crawler.name} (${crawler.product})`).join(", ")}. These crawlers feed AI assistants and answer engines, so the site will not be cited there.`,
      evidence: { blocked: blockedAiCrawlers.map((crawler) => crawler.name) },
      organicImpactScore: 10,
      recommendation: "Keep the block if it is deliberate. To be cited in AI answers, allow the search-facing crawlers (e.g. OAI-SearchBot, PerplexityBot, Claude-SearchBot) while still blocking training crawlers if you prefer.",
      pagesAffected: [],
      createdAt: new Date().toISOString(),
    });
  }

  const declaredSitemaps = [...(input.robotsTxt ?? "").matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((match) => match[1]!);
  const foreignSitemaps = declaredSitemaps.filter((entry) => !isSameSite(entry, input.baseUrl));
  if (foreignSitemaps.length) {
    const noOwnSitemap = declaredSitemaps.length === foreignSitemaps.length;
    const impact = organicImpactScore({
      category: "sitemap",
      pagesAffected: Math.max(sitemap.totalUrls, 1),
      isBlockingCrawl: noOwnSitemap,
    });
    findings.push({
      id: createId("finding"),
      siteId,
      analysisId,
      category: "sitemap",
      severity: severityFromImpact(impact),
      title: "robots.txt points search engines to a sitemap on another domain",
      summary: `robots.txt lists ${foreignSitemaps.join(", ")}${noOwnSitemap ? " and no sitemap on this site" : ""}. Search engines discover pages through the sitemap robots.txt declares, so a foreign or stale sitemap can hide the site's real pages.`,
      evidence: { declaredSitemaps, foreignSitemaps, sitemapUrlsFound: sitemap.totalUrls },
      organicImpactScore: impact,
      recommendation: `Replace the Sitemap line in robots.txt with ${new URL(input.baseUrl).origin}/sitemap.xml and submit that sitemap in Search Console.`,
      pagesAffected: [],
      createdAt: new Date().toISOString(),
    });
  }

  // Informational: decorative issues should not outrank empty shells
  const thinDescriptions = input.fullCrawl ? [] : pages.filter(
    (p) => !p.isEmptyShell && (!p.description || p.description.length < 40),
  );
  if (thinDescriptions.length > 0) {
    const impact = organicImpactScore({
      category: "metadata",
      pagesAffected: thinDescriptions.length,
    });
    findings.push({
      id: createId("finding"),
      siteId,
      analysisId,
      category: "metadata",
      severity: severityFromImpact(Math.min(impact, 30)),
      title: "Thin meta descriptions",
      summary: `${thinDescriptions.length} pages have missing or very short meta descriptions.`,
      evidence: { count: thinDescriptions.length },
      organicImpactScore: Math.min(impact, 30),
      recommendation: "Add unique meta descriptions that match search intent for key templates.",
      pagesAffected: thinDescriptions.slice(0, 20).map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
  }

  return findings;
}
