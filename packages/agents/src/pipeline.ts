import {
  createId,
  rankSeverityByOrganicImpact,
  type CrawlCoverage,
  type CrawlPageResult,
  type SiteRecord,
} from "@organic-growth/core";
import {
  auditSitemap,
  compareRendering,
  defaultFetcher,
  fetchPageAudit,
  findingsFromCrawl,
  findingsFromCrawlCoverage,
  findingsFromRendering,
  runTechnicalSeoAudit,
  samplePerFamily,
  testRepeatability,
  type Fetcher,
  type RenderComparison,
} from "@organic-growth/crawler";
import {
  analyzeRepository,
  type RepoSnapshot,
} from "@organic-growth/repo-analyzer";
import {
  analyzeSearchTraffic,
  buildOpportunities,
  discoverCompetitors,
  synthesizeGrowthPlan,
  type AnalysisBundle,
} from "./index.js";

export interface RunAnalysisInput {
  /** The persisted analysis this run belongs to, so findings link back to it. */
  analysisId: string;
  siteId: string;
  name: string;
  baseUrl: string;
  repoSnapshot?: RepoSnapshot;
  githubOwner?: string;
  githubRepo?: string;
  searchMetrics?: import("@organic-growth/core").SearchMetricRow[];
  fetcher?: Fetcher;
  maxPages?: number;
  defaultBranch?: string;
  gscProperty?: string;
  competitorDomains?: string[];
  renderPages?: (urls: string[]) => Promise<Record<string, string>>;
  /** Results of crawling every sitemap URL, when a full crawl ran first. */
  crawlCoverage?: { coverage: CrawlCoverage; examples: CrawlPageResult[] };
  /** Re-fetch a sample several times to catch intermittent failures (default true). */
  repeatability?: boolean;
}

export async function runFullAnalysis(input: RunAnalysisInput) {
  const { analysisId } = input;
  const fetcher = input.fetcher ?? defaultFetcher;
  const now = new Date().toISOString();

  const site: SiteRecord = {
    id: input.siteId,
    name: input.name,
    baseUrl: input.baseUrl,
    githubOwner: input.githubOwner,
    githubRepo: input.githubRepo,
    defaultBranch: input.defaultBranch ?? "main",
    fingerprint: undefined,
    gscProperty: input.gscProperty,
    createdAt: now,
    updatedAt: now,
  };

  let repo;
  if (input.repoSnapshot) {
    repo = analyzeRepository(input.repoSnapshot);
    site.fingerprint = repo.fingerprint;
  }

  const { audit: sitemap, sampleUrls } = await auditSitemap(
    input.baseUrl,
    fetcher,
    { maxUrls: input.maxPages ?? 24 },
  );

  const seedUrls = ensureSeedUrls(input.baseUrl, sampleUrls);

  const pageResults: CrawlPageResult[] = [];
  const userAgentPairs: Array<{ url: string; browser: CrawlPageResult; googlebot: CrawlPageResult }> = [];
  const findings = [];
  for (const url of seedUrls.slice(0, input.maxPages ?? 24)) {
    try {
      const audited = await fetchPageAudit(url, fetcher);
      pageResults.push(audited.googlebot);
      userAgentPairs.push({ url, browser: audited.raw, googlebot: audited.googlebot });
    } catch (err) {
      findings.push({
        id: createId("finding"),
        siteId: input.siteId,
        analysisId,
        category: "rendering" as const,
        severity: "MEDIUM" as const,
        title: `Failed to fetch ${url}`,
        summary: String(err),
        evidence: { url, error: String(err) },
        organicImpactScore: 30,
        createdAt: now,
      });
    }
  }

  // Source vs render: one page per template, rendered in a real browser.
  const comparisons: RenderComparison[] = [];
  const servedPages = pageResults.filter((page) => page.status < 400);
  if (input.renderPages && servedPages.length) {
    const sample = samplePerFamily(servedPages.map((page) => page.url), 1, 6);
    try {
      const rendered = await input.renderPages(sample);
      for (const page of servedPages) {
        const html = rendered[page.url];
        if (!html) continue;
        const comparison = compareRendering(page.url, page, html);
        comparisons.push(comparison);
        page.renderedTextLength = comparison.renderedTextLength;
        page.renderDelta = comparison.renderedTextLength - page.rawTextLength;
      }
    } catch {
      // Browser failures do not discard the raw crawl; report coverage remains explicit.
    }
  }

  // Repeatability: the same URLs fetched several times catch intermittent failures.
  const repeatability = input.repeatability === false || !servedPages.length
    ? []
    : await testRepeatability(samplePerFamily(servedPages.map((page) => page.url), 2, 10), fetcher, 3);

  const sampleFindings = findingsFromCrawl({
    siteId: input.siteId,
    analysisId,
    sitemap,
    pageResults,
  });
  const fullCrawl = Boolean(input.crawlCoverage?.coverage.completedUrls);
  // Per-issue counts exist for crawls made since those checks were added.
  const fullCrawlChecks = Boolean(fullCrawl && input.crawlCoverage?.coverage.issues);
  if (fullCrawl && input.crawlCoverage) {
    // Evidence from every sitemap URL supersedes extrapolation from the sample.
    const covered = new Set(["rendering", "sitemap", ...(fullCrawlChecks ? ["structured_data"] : [])]);
    findings.push(...sampleFindings.filter((finding) => !covered.has(finding.category)));
    findings.push(...findingsFromCrawlCoverage({
      siteId: input.siteId,
      analysisId,
      coverage: input.crawlCoverage.coverage,
      examples: input.crawlCoverage.examples,
    }));
  } else {
    findings.push(...sampleFindings);
  }

  findings.push(...findingsFromRendering({
    siteId: input.siteId,
    analysisId,
    familySizes: sitemap.urlTypes,
    comparisons,
    userAgentPairs,
    repeatability,
  }));

  let robotsTxt: string | undefined;
  try {
    const robots = await fetcher(new URL("/robots.txt", input.baseUrl).toString());
    robotsTxt = robots.body;
  } catch {
    robotsTxt = undefined;
  }

  findings.push(
    ...runTechnicalSeoAudit({
      siteId: input.siteId,
      analysisId,
      baseUrl: input.baseUrl,
      sitemap,
      pages: pageResults,
      robotsTxt,
      fullCrawl: fullCrawlChecks,
    }),
  );

  const searchMetrics = input.searchMetrics ?? [];

  const competitorObservations = await Promise.all((input.competitorDomains ?? []).slice(0, 10).map(async (domain) => {
    try {
      const page = await fetchPageAudit(`https://${domain}/`, fetcher);
      return { domain, status: page.googlebot.status, title: page.googlebot.title, pageCount: 1 };
    } catch {
      return { domain, pageCount: 0 };
    }
  }));
  const competitors = discoverCompetitors({
    siteId: input.siteId,
    baseUrl: input.baseUrl,
    searchMetrics,
    competitorDomains: competitorObservations,
  });

  const rankedFindings = rankSeverityByOrganicImpact(findings);

  const brandTerms = [
    input.name,
    input.githubRepo,
    new URL(input.baseUrl).hostname.replace(/^www\./, "").split(".")[0],
  ].filter((term): term is string => Boolean(term));

  const bundle: AnalysisBundle = {
    brandTerms,
    siteId: input.siteId,
    analysisId,
    baseUrl: input.baseUrl,
    repo,
    fingerprint: site.fingerprint,
    sitemap,
    pages: pageResults,
    findings: rankedFindings,
    searchMetrics,
    competitors,
  };

  const opportunities = buildOpportunities(bundle);
  const plan = synthesizeGrowthPlan(bundle);
  const searchNarrative = analyzeSearchTraffic(searchMetrics, brandTerms);

  return {
    site,
    analysisId,
    repo,
    sitemap,
    coverage: input.crawlCoverage?.coverage ?? null,
    pages: pageResults,
    findings: rankedFindings,
    competitors,
    opportunities,
    plan,
    rendering: {
      comparisons,
      repeatability: summarizeRepeatability(repeatability),
    },
    // Raw Search Console rows are persisted separately; the report keeps the
    // synthesis so it stays well under Workflow step and D1 row limits.
    searchNarrative: {
      totalClicks: searchNarrative.totalClicks,
      totalImpressions: searchNarrative.totalImpressions,
      countryShare: searchNarrative.countryShare,
      brandedShare: searchNarrative.brandedShare,
      commercialGapQueries: searchNarrative.commercialGapQueries.slice(0, 10),
      narrative: searchNarrative.narrative,
    },
  };
}

function ensureSeedUrls(baseUrl: string, sample: string[]): string[] {
  const origin = new URL(baseUrl).origin;
  return [...new Set(sample.length ? sample : [`${origin}/`])];
}

/** Per-template totals of the repeated fetches, for the report. */
function summarizeRepeatability(results: Awaited<ReturnType<typeof testRepeatability>>) {
  const families = new Map<string, { family: string; urls: number; attempts: number; failed: number; medianMs: number; times: number[] }>();
  for (const result of results) {
    const entry = families.get(result.family) ?? { family: result.family, urls: 0, attempts: 0, failed: 0, medianMs: 0, times: [] };
    entry.urls++;
    for (const attempt of result.attempts) {
      entry.attempts++;
      if (attempt.error || attempt.status >= 500 || attempt.emptyShell) entry.failed++;
      else entry.times.push(attempt.ms);
    }
    families.set(result.family, entry);
  }
  return [...families.values()].map(({ times, ...entry }) => ({
    ...entry,
    medianMs: times.length ? [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]! : 0,
  }));
}
