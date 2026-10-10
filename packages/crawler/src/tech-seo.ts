import type { CrawlPageResult, Finding, SitemapAudit } from "@organic-growth/core";
import { AI_ROBOTS_CHECKS, CHECKS, finding, organicImpactScore } from "@organic-growth/core";
import { GOOGLEBOT_TOKEN, parseRobots } from "./robots.js";
import { classifyLanguage, isSameSite, sameDocument } from "./urls.js";

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
  /** How the robots.txt response read (`robotsState`); without it the robots.txt notices are skipped. */
  robotsState?: "read" | "missing" | "unreadable";
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
    findings.push(finding(CHECKS["canonical.mismatch"]!, {
      siteId,
      analysisId,
      title: "Canonical mismatches detected",
      summary: `${canonicalMismatches.length} sampled pages have canonical URLs that do not match the fetched URL.`,
      evidence: {
        examples: canonicalMismatches.slice(0, 10).map((p) => ({
          url: p.url,
          canonical: p.canonical,
        })),
      },
      impact: impact,
      recommendation: "Align canonical tags with the preferred indexable URL for each page.",
      pagesAffected: canonicalMismatches.map((p) => p.url),
    }));
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
    findings.push(finding(CHECKS["hreflang.missing"]!, {
      siteId,
      analysisId,
      title: "Multilingual pages missing hreflang in HTML",
      summary: `The site serves ${locales.size} locale variants, but ${missingHreflang.length} sampled pages lacked hreflang alternates in crawler HTML.`,
      evidence: { urls: missingHreflang.slice(0, 10).map((p) => p.url) },
      impact: impact,
      recommendation:
        "Emit reciprocal hreflang alternates (plus x-default) in the initial HTML for every localized page.",
      pagesAffected: missingHreflang.map((p) => p.url),
    }));
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
    findings.push(finding(CHECKS["title.weak"]!, {
      siteId,
      analysisId,
      title: "Weak or missing titles on indexable pages",
      summary: `${weakTitles.length} pages have missing/weak titles in crawler HTML.`,
      evidence: { urls: weakTitles.slice(0, 10).map((p) => ({ url: p.url, title: p.title })) },
      impact: Math.min(impact, 45),
      recommendation: "Generate unique, intent-matched titles server-side per entity template.",
      pagesAffected: weakTitles.map((p) => p.url),
    }));
  }

  const googlebotRules = input.robotsTxt ? parseRobots(input.robotsTxt, GOOGLEBOT_TOKEN) : null;
  if (googlebotRules && !googlebotRules.isAllowed("/")) {
    const impact = organicImpactScore({
      category: "indexing",
      pagesAffected: sitemap.totalUrls || 1,
      isBlockingCrawl: true,
    });
    findings.push(finding(CHECKS["robots.googlebot_blocked"]!, {
      siteId,
      analysisId,
      severity: "CRITICAL",
      title: "robots.txt blocks Googlebot from the entire site",
      summary: "The robots.txt rules that apply to Googlebot disallow the homepage and everything below it, so Google cannot crawl the site.",
      evidence: { robotsTxt: input.robotsTxt!.slice(0, 2000) },
      impact: impact,
      recommendation: "Remove the sitewide Disallow from the group that applies to Googlebot (its own group, or `User-agent: *`) and keep only intentional private path blocks.",
      pagesAffected: [],
    }));
  }

  // Blocking AI crawlers is a legitimate business choice, but it removes the
  // site from AI search answers; report it without treating it as an error.
  // Exact tokens: a `User-agent: Applebot` group must not decide for Applebot-Extended.
  const blockedAiCrawlers = input.robotsTxt
    ? AI_ROBOTS_CHECKS.filter((crawler) => !parseRobots(input.robotsTxt!, crawler.agent.toLowerCase(), { exact: true }).isAllowed("/"))
    : [];
  if (blockedAiCrawlers.length) {
    // Each agent says whether it feeds AI answers; training and control-only tokens don't.
    const blockedSearch = blockedAiCrawlers.filter((crawler) => crawler.search);
    findings.push(finding(CHECKS["robots.ai_blocked"]!, {
      siteId,
      analysisId,
      // Its own category: not an indexing problem, and never a candidate for an automatic fix.
      severity: "INFORMATIONAL",
      title: blockedSearch.length ? "robots.txt blocks AI assistants from reading the site" : "robots.txt blocks AI training crawlers",
      summary: `robots.txt disallows ${blockedAiCrawlers.map((crawler) => `${crawler.agent} (${crawler.purpose})`).join("; ")}. ${blockedSearch.length ? "Assistants that can't read the site won't cite it in their answers." : "AI search and live answers can still read the site."}`,
      evidence: { blocked: blockedAiCrawlers.map((crawler) => crawler.agent) },
      impact: 10,
      recommendation: "Keep the block if it is deliberate. To be cited in AI answers, allow the search-facing crawlers (e.g. OAI-SearchBot, PerplexityBot, Claude-SearchBot) while still blocking training crawlers if you prefer.",
      pagesAffected: [],
    }));
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
    findings.push(finding(CHECKS["robots.foreign_sitemap"]!, {
      siteId,
      analysisId,
      title: "robots.txt points search engines to a sitemap on another domain",
      summary: `robots.txt lists ${foreignSitemaps.join(", ")}${noOwnSitemap ? " and no sitemap on this site" : ""}. Search engines discover pages through the sitemap robots.txt declares, so a foreign or stale sitemap can hide the site's real pages.`,
      evidence: { declaredSitemaps, foreignSitemaps, sitemapUrlsFound: sitemap.totalUrls },
      impact: impact,
      recommendation: `Replace the Sitemap line in robots.txt with ${new URL(input.baseUrl).origin}/sitemap.xml and submit that sitemap in Search Console.`,
      pagesAffected: [],
    }));
  }

  if (input.robotsState === "missing") {
    findings.push(finding(CHECKS["robots.missing"]!, {
      siteId, analysisId, impact: 10,
      title: "The site has no robots.txt",
      summary: "/robots.txt answers 404, so everything may be crawled. That is allowed, but robots.txt is where the sitemap is declared and where crawl traps such as internal search are kept out.",
      evidence: { robots: "missing" },
    }));
  } else if (input.robotsState === "read" && sitemap.totalUrls > 0 && declaredSitemaps.length === 0) {
    findings.push(finding(CHECKS["robots.sitemap_undeclared"]!, {
      siteId, analysisId, impact: 12,
      title: "robots.txt does not name the sitemap",
      summary: `The site has a sitemap (${sitemap.totalUrls.toLocaleString("en")} URLs) but robots.txt has no Sitemap line. Bing, and the AI search indexes built on it, find sitemaps through robots.txt.`,
      evidence: { sitemapUrls: sitemap.totalUrls },
      recommendation: `Add \`Sitemap: ${new URL(input.baseUrl).origin}/sitemap.xml\` to robots.txt.`,
    }));
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
    findings.push(finding(CHECKS["description.missing"]!, {
      siteId,
      analysisId,
      title: "Thin meta descriptions",
      summary: `${thinDescriptions.length} pages have missing or very short meta descriptions.`,
      evidence: { count: thinDescriptions.length },
      impact: Math.min(impact, 30),
      recommendation: "Add unique meta descriptions that match search intent for key templates.",
      pagesAffected: thinDescriptions.slice(0, 20).map((p) => p.url),
    }));
  }

  return findings;
}
