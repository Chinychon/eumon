import type { CrawlPageResult, Finding, SitemapAudit } from "@organic-growth/core";
import { createId, organicImpactScore, severityFromImpact } from "@organic-growth/core";

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
}): Finding[] {
  const findings: Finding[] = [];
  const { pages, sitemap, siteId, analysisId } = input;

  const canonicalMismatches = pages.filter((p) => {
    if (!p.canonical) return false;
    try {
      const canon = new URL(p.canonical, p.url);
      const page = new URL(p.finalUrl ?? p.url);
      return canon.origin + canon.pathname !== page.origin + page.pathname;
    } catch {
      return true;
    }
  });
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

  const missingHreflang = pages.filter(
    (p) =>
      /\/(id|zh)\//.test(p.url) || p.url.includes("/doctors/") || p.url.includes("/procedures/"),
  ).filter((p) => p.hreflang.length === 0 && !p.isEmptyShell);
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
      summary: `${missingHreflang.length} multilingual/entity pages lacked hreflang alternates in crawler HTML.`,
      evidence: { urls: missingHreflang.slice(0, 10).map((p) => p.url) },
      organicImpactScore: impact,
      recommendation:
        "Emit hreflang for en-MY / id / zh-CN / x-default in initial HTML for all localized entity pages.",
      pagesAffected: missingHreflang.map((p) => p.url),
      createdAt: new Date().toISOString(),
    });
  }

  const weakTitles = pages.filter(
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

  if (input.robotsTxt && /Disallow:\s*\/$/im.test(input.robotsTxt)) {
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
      title: "robots.txt blocks the entire site",
      summary: "robots.txt contains Disallow: / which blocks crawlers from the whole site.",
      evidence: { robotsTxt: input.robotsTxt.slice(0, 2000) },
      organicImpactScore: impact,
      recommendation: "Remove sitewide Disallow and keep only intentional private path blocks.",
      pagesAffected: [],
      createdAt: new Date().toISOString(),
    });
  }

  // Informational: decorative issues should not outrank empty shells
  const thinDescriptions = pages.filter(
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
