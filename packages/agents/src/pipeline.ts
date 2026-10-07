import {
  createId,
  rankSeverityByOrganicImpact,
  type CrawlCoverage,
  type CrawlPageResult,
  type SiteRecord,
} from "@organic-growth/core";
import {
  GOOGLEBOT_TOKEN,
  GOOGLEBOT_UA,
  auditSitemap,
  classifyUrlType,
  compareRendering,
  defaultFetcher,
  fetchPageAudit,
  fetchRobots,
  findingsFromCrawl,
  findingsFromCrawlCoverage,
  findingsFromRendering,
  inspectPage,
  scriptTrackers,
  researchSite,
  runTechnicalSeoAudit,
  samplePerFamily,
  testRepeatability,
  type Fetcher,
  type PageInspection,
  type RenderComparison,
  type SiteResearch,
} from "@organic-growth/crawler";
import type { JsonLlm } from "@organic-growth/ai";
import { enqueueAnalysisCrawlUrls, getPreviousCompletedAnalysis, listCrawlStates, reuseCrawlResults, type D1Like } from "@organic-growth/db";
import {
  analyzeRepository,
  type RepoSnapshot,
} from "@organic-growth/repo-analyzer";
import { analyzeSearch, findingsFromSearch } from "./search.js";
import {
  analyzeSearchTraffic,
  buildOpportunities,
  synthesizeGrowthPlan,
  type AnalysisBundle,
} from "./index.js";
import { findingsFromCode } from "./code-findings.js";
import { auditConversion, findingsFromConversion } from "./conversion.js";
import {
  compareCompetition,
  competitorProfiles,
  contentTypeEntries,
  labelContentTypes,
  type CompetitionReport,
  type OwnContent,
} from "./competition.js";

const DAY = 86_400_000;

/**
 * Whether an earlier crawl result still stands for a re-run. Only successful
 * fetches carry over. With a sitemap `lastmod`, a page changed on or after
 * the day it was crawled is fetched again, and results older than 30 days
 * are refreshed anyway; without one, results older than 7 days are.
 */
export function shouldReuse(previous: { state: string; crawledAt: string | null } | undefined, lastmod: string | undefined, now: number): boolean {
  if (previous?.state !== "complete" || !previous.crawledAt) return false;
  const crawledAt = Date.parse(previous.crawledAt);
  if (!Number.isFinite(crawledAt)) return false;
  const changed = lastmod ? Date.parse(lastmod) : Number.NaN;
  if (!Number.isFinite(changed)) return now - crawledAt < 7 * DAY;
  const crawledDay = Date.parse(previous.crawledAt.slice(0, 10));
  return changed < crawledDay && now - crawledAt < 30 * DAY;
}

/**
 * Queues every sitemap URL (up to `maxUrls`) for the Googlebot crawl. URLs
 * robots.txt blocks for Googlebot are recorded but will not be fetched. Unless
 * `full`, results from the site's last finished crawl that still stand
 * (`shouldReuse`) are copied over instead of being fetched again.
 */
export async function queueFullCrawl(
  db: D1Like,
  input: { analysisId: string; siteId: string; baseUrl: string; maxUrls: number; full?: boolean; fetcher?: Fetcher; now?: number },
): Promise<{ declared: number; queued: number; reused: number; reusedFrom?: string }> {
  const fetcher = input.fetcher ?? defaultFetcher;
  const { urls, lastmod } = await auditSitemap(input.baseUrl, fetcher, { maxUrls: 1 });
  const robots = await fetchRobots(input.baseUrl, GOOGLEBOT_TOKEN, GOOGLEBOT_UA, fetcher).catch(() => null);
  const previous = input.full ? null : await getPreviousCompletedAnalysis(db, input.siteId, input.analysisId);
  const prior = previous ? await listCrawlStates(db, previous.id) : new Map<string, { state: string; crawledAt: string | null }>();
  const now = input.now ?? Date.now();
  const reuse: string[] = [];
  const toFetch: Array<{ url: string; routeFamily: string; blocked: boolean }> = [];
  for (const url of urls.slice(0, input.maxUrls)) {
    const { pathname, search } = new URL(url);
    const blocked = robots ? !robots.isAllowed(`${pathname}${search}`) : false;
    if (!blocked && shouldReuse(prior.get(url), lastmod.get(url), now)) reuse.push(url);
    else toFetch.push({ url, routeFamily: classifyUrlType(url), blocked });
  }
  if (previous && reuse.length) await reuseCrawlResults(db, { analysisId: input.analysisId, previousAnalysisId: previous.id, urls: reuse });
  await enqueueAnalysisCrawlUrls(db, { analysisId: input.analysisId, siteId: input.siteId, urls: toFetch });
  return {
    declared: urls.length,
    queued: toFetch.filter((entry) => !entry.blocked).length,
    reused: reuse.length,
    ...(previous && reuse.length ? { reusedFrom: previous.completedAt } : {}),
  };
}

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
  /** Competitor research done beforehand (e.g. one Workflow step per competitor); otherwise `competitorDomains` are researched here. */
  competitorResearch?: SiteResearch[];
  /** The site's collected datasets, so content gaps can be matched to data it already holds. */
  datasets?: OwnContent["datasets"];
  /** Language model for matching content types across sites; names are compared without it. */
  llm?: JsonLlm;
  /** Countries the business sells to (Search Console alpha-3 codes). */
  targetMarkets?: string[];
  /** Record keys of collected datasets, to recognize searches that name one entity. */
  entityKeys?: Array<{ key: string; entityType: string }>;
}

/** Competitors researched per analysis; each costs a sitemap profile and a handful of page fetches. */
export const MAX_COMPETITORS = 5;

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
  // One page per template is inspected for conversion paths and structured data (compared with competitors).
  const inspectUrls = new Set(samplePerFamily(seedUrls.slice(0, input.maxPages ?? 24), 1, 6));
  const ownInspections: PageInspection[] = [];
  const inspectedHtml = new Map<string, string>();
  for (const url of seedUrls.slice(0, input.maxPages ?? 24)) {
    try {
      const audited = await fetchPageAudit(url, fetcher);
      pageResults.push(audited.googlebot);
      userAgentPairs.push({ url, browser: audited.raw, googlebot: audited.googlebot });
      if (inspectUrls.has(url)) {
        ownInspections.push(inspectPage(url, { status: audited.googlebot.status, body: audited.googlebotHtml }));
        inspectedHtml.set(url, audited.googlebotHtml);
      }
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

  // Analytics SDKs bundled into the site's JavaScript never appear in its HTML.
  const scriptCache = new Map<string, Promise<string[]>>();
  await Promise.all(ownInspections.map(async (inspection) => {
    const bundled = await scriptTrackers(inspectedHtml.get(inspection.url) ?? "", inspection.url, fetcher, scriptCache);
    inspection.tracking = [...new Set([...inspection.tracking, ...bundled])];
  }));
  const conversion = auditConversion(ownInspections);
  findings.push(...findingsFromConversion(conversion, { siteId: input.siteId, analysisId, familySizes: sitemap.urlTypes, repoAnalytics: repo?.fingerprint.analytics }));

  if (repo) {
    findings.push(...findingsFromCode({
      siteId: input.siteId,
      analysisId,
      repo,
      coverage: input.crawlCoverage?.coverage,
      comparisons,
      repeatability: summarizeRepeatability(repeatability),
      familySizes: sitemap.urlTypes,
    }));
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
  const brandTerms = [
    input.name,
    input.githubRepo,
    new URL(input.baseUrl).hostname.replace(/^www\./, "").split(".")[0],
  ].filter((term): term is string => Boolean(term));
  const search = analyzeSearch(searchMetrics, { brandTerms, targetMarkets: input.targetMarkets, entityKeys: input.entityKeys });
  if (searchMetrics.length) findings.push(...findingsFromSearch(search, input.siteId, analysisId));

  // Competitors: sitemaps and sample pages, compared with this site's content and data.
  const research = input.competitorResearch
    ?? await Promise.all((input.competitorDomains ?? []).slice(0, MAX_COMPETITORS).map((domain) => researchSite(domain, fetcher)));
  let competition: CompetitionReport | undefined;
  if (research.length) {
    const own: OwnContent = {
      domain: new URL(input.baseUrl).hostname.replace(/^www\./, ""),
      families: sitemap.urlTypes,
      sections: sitemap.sections,
      pages: ownInspections,
      datasets: input.datasets,
    };
    let labels = new Map<string, string>();
    if (input.llm) {
      try {
        labels = await labelContentTypes(input.llm, contentTypeEntries(own, research));
      } catch {
        // Without labels, families are matched by name.
      }
    }
    competition = compareCompetition(own, research, labels);
  }
  const competitors = competition ? competitorProfiles(competition, input.siteId) : [];

  const rankedFindings = rankSeverityByOrganicImpact(findings);

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
    competition,
    datasets: input.datasets,
    search,
  };

  const opportunities = buildOpportunities(bundle);
  const plan = synthesizeGrowthPlan(bundle);
  const searchNarrative = analyzeSearchTraffic(searchMetrics, brandTerms, search);

  return {
    site,
    analysisId,
    // Content-heavy repositories can declare thousands of routes; the inspected ones carry the detail.
    repo: repo ? { ...repo, routes: repo.routes.slice(0, 300), sensitivePaths: repo.sensitivePaths.slice(0, 50) } : undefined,
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
    competition: competition ?? null,
    conversion,
    search: searchMetrics.length ? search : null,
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
