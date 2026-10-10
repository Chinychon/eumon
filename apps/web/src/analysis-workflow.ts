import puppeteer from "@cloudflare/puppeteer";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import { createLlm, type JsonLlm } from "@organic-growth/ai";
import {
  datasetCoverage,
  getCrawlCoverage,
  getSite,
  listCrawlPageResults,
  listPendingCrawlUrls,
  listRecordKeys,
  listSiteMarkets,
  listSiteCompetitorDomains,
  replaceCurrentSearchMetrics,
  saveAnalysisReport,
  saveCrawlBatch,
  updateAnalysisProgress,
  updateAnalysisStatus,
  updateSiteFingerprint,
} from "@organic-growth/db";
import {
  MAX_COMPETITORS, crawlLogCoverage, fetchSearchConsoleMetrics, loadAiAnswerSignals, loadInventories, loadRankSignals, loadTrendSignals, probeTitleForCoverage, queueFullCrawl, runFullAnalysis, synthesizePlanNarrative,
} from "@organic-growth/agents";
import {
  buildRepoSnapshotFromGitHub,
  createGitHubApiClient,
  createInstallationToken,
} from "@organic-growth/repo-analyzer";
import {
  crawlGooglebotBatch,
  isSafePublicUrl,
  researchSite,
  type SiteResearch,
  probeNotFound,
} from "@organic-growth/crawler";
import { googleAccessToken } from "./gsc-auth";
import { searchConsoleReconciliation } from "@organic-growth/db";
import { connectorSignals, loadConnectorLists } from "./connectors-data";
import { loadKeywords } from "./keywords-data";

interface AnalysisPayload {
  analysisId: string;
  siteId: string;
  /** Fetch every sitemap URL again instead of reusing unchanged results from the last crawl. */
  full?: boolean;
}

/** Upper bound on sitemap URLs crawled per analysis (≈250 Workflow steps). */
const MAX_FULL_CRAWL_URLS = 25_000;
const CRAWL_BATCH_SIZE = 100;
const CRAWL_CONCURRENCY = 6;

export class SiteAnalysisWorkflow extends WorkflowEntrypoint<AppEnv, AnalysisPayload> {
  async run(event: WorkflowEvent<AnalysisPayload>, step: WorkflowStep) {
    const { analysisId, siteId, full } = event.payload;
    const db = this.env.DB;
    // Progress writes double as the cancel check: a cancelled run stops at its next update,
    // even when ending its Workflow instance didn't work.
    const progress = async (stage: string, message: string, detail?: Record<string, string | number>) => {
      if (!(await updateAnalysisProgress(db, analysisId, stage, message, detail))) throw new NonRetryableError("The analysis was cancelled.");
    };
    try {
      const site = await step.do("load-site", async () => {
        await updateAnalysisStatus(db, analysisId, "running");
        await progress("sitemap", "Reading the sitemap");
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
      // Results from the last crawl that still stand are reused unless `full`.
      const queued = await step.do("enqueue-full-crawl", async () => {
        const result = await queueFullCrawl(db, { analysisId, siteId, baseUrl: site.baseUrl, maxUrls: MAX_FULL_CRAWL_URLS, full });
        await progress("crawl", `Crawling ${result.queued.toLocaleString()} sitemap URLs as Googlebot`);
        return result;
      });

      for (let batch = 0; batch * CRAWL_BATCH_SIZE < queued.queued + CRAWL_BATCH_SIZE; batch++) {
        const crawled = await step.do(`crawl-batch-${batch}`, { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } }, async () => {
          const urls = await listPendingCrawlUrls(db, analysisId, CRAWL_BATCH_SIZE);
          if (!urls.length) return 0;
          const outcomes = await crawlGooglebotBatch(urls, undefined, CRAWL_CONCURRENCY);
          await saveCrawlBatch(db, { analysisId, outcomes: outcomes.map((outcome) => ("page" in outcome ? outcome : { url: outcome.url, error: outcome.error })) });
          const done = Math.min((batch + 1) * CRAWL_BATCH_SIZE, queued.queued);
          await progress("crawl", `Crawled ${done.toLocaleString()} of ${queued.queued.toLocaleString()} sitemap URLs as Googlebot`);
          return urls.length;
        });
        if (crawled === 0) break;
      }

      // Each competitor is researched in its own step (sitemaps and a few sample
      // pages, fetched as EumonBot), so one slow site can retry on its own.
      const competitorDomains = await step.do("list-competitors", async () => {
        await progress("competitors", "Reading competitor sitemaps and sample pages");
        return (await listSiteCompetitorDomains(db, siteId)).slice(0, MAX_COMPETITORS);
      });
      const competitorResearch: SiteResearch[] = [];
      for (const [index, domain] of competitorDomains.entries()) {
        competitorResearch.push(await step.do(`research-${domain}`, { retries: { limit: 1, delay: "10 seconds" } }, async () => {
          await progress("competitors", `Reading ${domain}`, { competitor: domain, done: index, of: competitorDomains.length });
          const research = await researchSite(domain, undefined, { maxFiles: 15, maxUrls: 50_000 });
          // Keep the step output small: the largest families are what the comparison uses.
          return { ...research, sitemap: { ...research.sitemap, families: research.sitemap.families.slice(0, 40) } };
        }));
      }

      // The client's own data, when the Data section holds any: fills by language, duplicates, thin record pages.
      // Its own step, so its queries have their own budget and a failure costs only the inventory.
      const inventory = await step.do("inventory", () => loadInventories(db, siteId, { analysisId }).catch(() => []));

      // The step persists the report itself and returns only a summary: the
      // full report can exceed the Workflow step-output size limit.
      await step.do(
        "analyze-repository-and-site",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          await progress("analysis", "Checking rendering, indexing, and search data");
          const repoSnapshot = site.githubInstallationId && site.githubOwner && site.githubRepo
            ? await buildRepoSnapshotFromGitHub(
              createGitHubApiClient(await createInstallationToken(this.env.GITHUB_APP_ID, this.env.GITHUB_APP_PRIVATE_KEY, site.githubInstallationId)),
              site.githubOwner,
              site.githubRepo,
              site.defaultBranch ?? "main",
            )
            : undefined;
          let llm: JsonLlm | undefined;
          try {
            llm = createLlm(this.env);
          } catch {
            // No model configured: content types are matched by name and the plan is deterministic.
          }
          let searchMetrics;
          if (site.gscProperty) {
            const accessToken = await googleAccessToken(
              db, siteId, this.env.GOOGLE_CLIENT_ID, this.env.GOOGLE_CLIENT_SECRET,
              this.env.OAUTH_ENCRYPTION_KEY,
            );
            searchMetrics = await fetchSearchConsoleMetrics(accessToken, site.gscProperty);
            await replaceCurrentSearchMetrics(db, siteId, searchMetrics);
          }
          // One fetch of a URL that cannot exist: a site that answers 200 for it is a soft-404 site, and pages carrying that title are soft 404s.
          const notFoundProbe = await probeNotFound(site.baseUrl, analysisId).catch(() => undefined);
          const [coverage, examples, datasets, targetMarkets, entityKeys, competitors] = await Promise.all([
            getCrawlCoverage(db, analysisId, { notFoundTitle: probeTitleForCoverage(notFoundProbe) }),
            listCrawlPageResults(db, analysisId, 50),
            datasetCoverage(db, siteId),
            listSiteMarkets(db, siteId),
            listRecordKeys(db, siteId),
            listSiteCompetitorDomains(db, siteId),
          ]);
          // Keyword lists from the Performance sync give opportunities real volume and difficulty, and the biggest gaps.
          // An enrichment only: an analysis never fails for want of them (for example before migration 0016 has run).
          const keywords = await loadKeywords(db, { id: siteId, baseUrl: site.baseUrl, gscProperty: site.gscProperty }, { markets: targetMarkets, competitors }).catch(() => undefined);
          // Search results, links and the crawl log, likewise an enrichment only.
          const connectors = await Promise.all([
            loadConnectorLists(db, { id: siteId, baseUrl: site.baseUrl }, { markets: targetMarkets, competitors }),
            crawlLogCoverage(db, siteId, analysisId),
            searchConsoleReconciliation(db, siteId, analysisId).catch(() => null),
          ]).then(async ([lists, coverage, searchConsole]) => connectorSignals(lists, coverage, searchConsole, await loadTrendSignals(db, siteId, lists.crawlLog).catch(() => null), inventory, ...await Promise.all([loadRankSignals(db, siteId).catch(() => null), loadAiAnswerSignals(db, siteId).catch(() => null)]))).catch(() => connectorSignals({ serp: { lists: [], suggestions: [] }, links: undefined } as never, null, null, null, inventory, null));
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
            competitorResearch,
            datasets,
            targetMarkets,
            entityKeys,
            keywords,
            connectors,
            notFoundProbe,
            llm,
            repoSnapshot,
            maxPages: 25,
            crawlCoverage: { coverage, examples },
            renderPages: (urls) => this.renderPages(urls),
          });
          const plan = llm ? await synthesizePlanNarrative(llm, raw.plan, raw.findings) : raw.plan;
          if (raw.site.fingerprint) await updateSiteFingerprint(db, siteId, raw.site.fingerprint);
          await progress("saving", "Saving findings and growth plan");
          await saveAnalysisReport(db, analysisId, {
            ...raw, plan, sitemapUrlsDeclared: queued.declared,
            ...(queued.reused ? { crawlReuse: { urls: queued.reused, from: queued.reusedFrom } } : {}),
          }, plan.highestImpactOpportunity);
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

  /** Browser-renders one page per template so raw HTML can be compared with the rendered DOM. */
  private async renderPages(urls: string[]): Promise<Record<string, string>> {
    const browser = await puppeteer.launch(this.env.BROWSER);
    try {
      const output: Record<string, string> = {};
      for (const url of urls) {
        const page = await browser.newPage();
        try {
          await page.setRequestInterception(true);
          // Request interception never sees WebSockets; block them so page scripts can't open sockets to anything.
          // Best-effort: if this browser build lacks CDP sessions, render anyway rather than drop the page.
          try {
            const cdp = await page.createCDPSession();
            await cdp.send("Network.enable");
            await cdp.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
          } catch { /* socket block unavailable */ }
          page.on("request", (outbound) => {
            const target = outbound.url();
            const sameSiteNavigation = !outbound.isNavigationRequest() || new URL(target).origin === new URL(url).origin;
            if (isSafePublicUrl(target) && sameSiteNavigation) {
              void outbound.continue().catch(() => undefined);
            } else {
              void outbound.abort().catch(() => undefined);
            }
          });
          // Wait for client-side data requests to settle (as Google's renderer does);
          // on a timeout, use whatever has rendered so far.
          const loaded = await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 }).catch(() => null);
          if (!loaded) await page.waitForSelector("body", { timeout: 5000 });
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
