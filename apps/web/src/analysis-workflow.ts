import puppeteer from "@cloudflare/puppeteer";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import { createLlm } from "@organic-growth/ai";
import {
  enqueueAnalysisCrawlUrls,
  getCrawlCoverage,
  getSite,
  listCrawlPageResults,
  listPendingCrawlUrls,
  listSiteCompetitorDomains,
  replaceCurrentSearchMetrics,
  saveAnalysisReport,
  saveCrawlBatch,
  updateAnalysisProgress,
  updateAnalysisStatus,
  updateSiteFingerprint,
} from "@organic-growth/db";
import {
  fetchSearchConsoleMetrics,
  runFullAnalysis,
  synthesizePlanNarrative,
} from "@organic-growth/agents";
import {
  buildRepoSnapshotFromGitHub,
  createGitHubApiClient,
  createInstallationToken,
} from "@organic-growth/repo-analyzer";
import {
  GOOGLEBOT_TOKEN,
  GOOGLEBOT_UA,
  auditSitemap,
  classifyUrlType,
  crawlGooglebotBatch,
  defaultFetcher,
  isSafePublicUrl,
  parseRobots,
} from "@organic-growth/crawler";
import { googleAccessToken } from "./gsc-auth";

interface AnalysisPayload {
  analysisId: string;
  siteId: string;
}

/** Upper bound on sitemap URLs crawled per analysis (≈250 Workflow steps). */
const MAX_FULL_CRAWL_URLS = 25_000;
const CRAWL_BATCH_SIZE = 100;
const CRAWL_CONCURRENCY = 6;

export class SiteAnalysisWorkflow extends WorkflowEntrypoint<AppEnv, AnalysisPayload> {
  async run(event: WorkflowEvent<AnalysisPayload>, step: WorkflowStep) {
    const { analysisId, siteId } = event.payload;
    const db = this.env.DB;
    try {
      const site = await step.do("load-site", async () => {
        await updateAnalysisStatus(db, analysisId, "running", { startedAt: new Date().toISOString() });
        await updateAnalysisProgress(db, analysisId, "sitemap", "Reading the sitemap");
        const record = await getSite(db, siteId);
        if (!record) throw new NonRetryableError("The site no longer exists.");
        // Only plain connection fields cross the step boundary.
        return {
          name: record.name,
          baseUrl: record.baseUrl,
          githubOwner: record.githubOwner,
          githubRepo: record.githubRepo,
          githubInstallationId: record.githubInstallationId,
          defaultBranch: record.defaultBranch,
          gscProperty: record.gscProperty,
        };
      });

      // Crawl every sitemap URL (as Googlebot) in resumable batches before
      // analysis, so findings describe the whole site rather than a sample.
      // URLs robots.txt blocks for Googlebot are recorded but not fetched.
      const queued = await step.do("enqueue-full-crawl", async () => {
        const { urls } = await auditSitemap(site.baseUrl, undefined, { maxUrls: 1 });
        const capped = urls.slice(0, MAX_FULL_CRAWL_URLS);
        const robots = await defaultFetcher(new URL("/robots.txt", site.baseUrl).toString(), { userAgent: GOOGLEBOT_UA, maxBytes: 500_000 })
          .then((response) => (response.status < 400 ? parseRobots(response.body, GOOGLEBOT_TOKEN) : null))
          .catch(() => null);
        const entries = capped.map((url) => {
          const parsed = new URL(url);
          return { url, routeFamily: classifyUrlType(url), blocked: robots ? !robots.isAllowed(`${parsed.pathname}${parsed.search}`) : false };
        });
        await enqueueAnalysisCrawlUrls(db, { analysisId, siteId, urls: entries });
        const blocked = entries.filter((entry) => entry.blocked).length;
        return { queued: capped.length - blocked, declared: urls.length };
      });

      for (let batch = 0; batch * CRAWL_BATCH_SIZE < queued.queued + CRAWL_BATCH_SIZE; batch++) {
        const crawled = await step.do(`crawl-batch-${batch}`, { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } }, async () => {
          const urls = await listPendingCrawlUrls(db, analysisId, CRAWL_BATCH_SIZE);
          if (!urls.length) return 0;
          const outcomes = await crawlGooglebotBatch(urls, undefined, CRAWL_CONCURRENCY);
          await saveCrawlBatch(db, { analysisId, outcomes: outcomes.map((outcome) => ("page" in outcome ? outcome : { url: outcome.url, error: outcome.error })) });
          const done = Math.min((batch + 1) * CRAWL_BATCH_SIZE, queued.queued);
          await updateAnalysisProgress(db, analysisId, "crawl", `Crawled ${done.toLocaleString()} of ${queued.queued.toLocaleString()} sitemap URLs as Googlebot`);
          return urls.length;
        });
        if (crawled === 0) break;
      }

      // The step persists the report itself and returns only a summary: the
      // full report can exceed the Workflow step-output size limit.
      await step.do(
        "analyze-repository-and-site",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          await updateAnalysisProgress(db, analysisId, "analysis", "Checking rendering, indexing, and search data");
          const repoSnapshot = site.githubInstallationId && site.githubOwner && site.githubRepo
            ? await buildRepoSnapshotFromGitHub(
              createGitHubApiClient(await createInstallationToken(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY, site.githubInstallationId)),
              site.githubOwner,
              site.githubRepo,
              site.defaultBranch ?? "main",
            )
            : undefined;
          const competitorDomains = await listSiteCompetitorDomains(db, siteId);
          let searchMetrics;
          if (site.gscProperty) {
            const accessToken = await googleAccessToken(
              db, siteId, this.env.GOOGLE_CLIENT_ID, this.env.GOOGLE_CLIENT_SECRET,
              this.env.OAUTH_ENCRYPTION_KEY,
            );
            searchMetrics = await fetchSearchConsoleMetrics(accessToken, site.gscProperty);
            await replaceCurrentSearchMetrics(db, siteId, searchMetrics);
          }
          const [coverage, examples] = await Promise.all([
            getCrawlCoverage(db, analysisId),
            listCrawlPageResults(db, analysisId, 50),
          ]);
          const raw = await runFullAnalysis({
            analysisId,
            siteId,
            name: site.name,
            baseUrl: site.baseUrl,
            githubOwner: site.githubOwner,
            githubRepo: site.githubRepo,
            defaultBranch: site.defaultBranch,
            gscProperty: site.gscProperty,
            searchMetrics,
            competitorDomains,
            repoSnapshot,
            maxPages: 25,
            crawlCoverage: { coverage, examples },
            renderPages: (urls) => this.renderPages(urls),
          });
          let plan = raw.plan;
          try {
            plan = await synthesizePlanNarrative(createLlm(this.env), raw.plan, raw.findings);
          } catch {
            // No model configured: the deterministic plan stands on its own.
          }
          if (raw.site.fingerprint) await updateSiteFingerprint(db, siteId, raw.site.fingerprint);
          await updateAnalysisProgress(db, analysisId, "saving", "Saving findings and growth plan");
          await saveAnalysisReport(db, analysisId, { ...raw, plan, sitemapUrlsDeclared: queued.declared }, plan.highestImpactOpportunity);
          return plan.highestImpactOpportunity;
        },
      );
      return { analysisId, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed unexpectedly.";
      await updateAnalysisStatus(db, analysisId, "failed", { error: message, completedAt: new Date().toISOString() });
      throw error;
    }
  }

  /** Browser-renders a few pages so raw HTML can be compared with the rendered DOM. */
  private async renderPages(urls: string[]): Promise<Record<string, string>> {
    const browser = await puppeteer.launch(this.env.BROWSER);
    try {
      const output: Record<string, string> = {};
      for (const url of urls) {
        const page = await browser.newPage();
        try {
          await page.setRequestInterception(true);
          page.on("request", (outbound) => {
            const target = outbound.url();
            const sameSiteNavigation = !outbound.isNavigationRequest() || new URL(target).origin === new URL(url).origin;
            if (isSafePublicUrl(target) && sameSiteNavigation) {
              void outbound.continue().catch(() => undefined);
            } else {
              void outbound.abort().catch(() => undefined);
            }
          });
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
          if (new URL(page.url()).origin === new URL(url).origin) output[url] = await page.content();
        } catch {
          // Keep other representative pages when one browser navigation fails.
        } finally {
          await page.close();
        }
      }
      return output;
    } finally {
      await browser.close();
    }
  }
}
