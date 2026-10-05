import puppeteer from "@cloudflare/puppeteer";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import {
  getSite,
  listSiteCompetitorDomains,
  saveAnalysisReport,
  updateAnalysisProgress,
  updateAnalysisStatus,
} from "@organic-growth/db";
import {
  runFullAnalysis,
  synthesizePlanNarrative,
} from "@organic-growth/agents";
import {
  buildRepoSnapshotFromGitHub,
  createGitHubApiClient,
  createInstallationToken,
} from "@organic-growth/repo-analyzer";
import { isSafePublicUrl } from "@organic-growth/crawler";
import { fetchSearchConsoleMetrics } from "@organic-growth/agents";
import { googleAccessToken } from "./gsc-auth";

interface AnalysisPayload {
  analysisId: string;
  siteId: string;
}

export class SiteAnalysisWorkflow extends WorkflowEntrypoint<AppEnv, AnalysisPayload> {
  async run(event: WorkflowEvent<AnalysisPayload>, step: WorkflowStep) {
    const { analysisId, siteId } = event.payload;
    const db = this.env.DB;
    try {
      await updateAnalysisStatus(db, analysisId, "running", { startedAt: new Date().toISOString() });
      const site = await step.do("load-site", async () => {
        await updateAnalysisProgress(db, analysisId, "repository", "Loading connected repository");
        const record = await getSite(db, siteId);
        if (!record?.githubInstallationId || !record.githubOwner || !record.githubRepo) {
          throw new Error("The connected site is missing its GitHub repository installation.");
        }
        return record;
      });

      const report = await step.do(
        "analyze-repository-and-crawl",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          await updateAnalysisProgress(db, analysisId, "crawl", "Inspecting repository and crawling representative pages");
          const token = await createInstallationToken(
            this.env.GITHUB_APP_ID,
            this.env.GITHUB_APP_PRIVATE_KEY,
            site.githubInstallationId!,
          );
          const repoSnapshot = await buildRepoSnapshotFromGitHub(
            createGitHubApiClient(token),
            site.githubOwner!,
            site.githubRepo!,
            site.defaultBranch ?? "main",
          );
          const competitorDomains = await listSiteCompetitorDomains(db, siteId);
          let searchMetrics;
          if (site.gscProperty) {
            const accessToken = await googleAccessToken(
              db, siteId, this.env.GOOGLE_CLIENT_ID, this.env.GOOGLE_CLIENT_SECRET,
              this.env.OAUTH_ENCRYPTION_KEY,
            );
            searchMetrics = await fetchSearchConsoleMetrics(accessToken, site.gscProperty);
          }
          const raw = await runFullAnalysis({
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
            renderPages: async (urls) => {
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
            },
          });
          const plan = await synthesizePlanNarrative(this.env.AI, raw.plan, raw.findings);
          return { ...raw, plan };
        },
      );

      await updateAnalysisProgress(db, analysisId, "saving", "Saving findings and growth plan");
      await saveAnalysisReport(db, analysisId, report, report.plan.highestImpactOpportunity);
      return { analysisId, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed unexpectedly.";
      await updateAnalysisStatus(db, analysisId, "failed", { error: message, completedAt: new Date().toISOString() });
      throw error;
    }
  }
}
