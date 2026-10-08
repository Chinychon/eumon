import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import { getSite, listSitesForResults, publishedPages } from "@organic-growth/db";
import { googleAccess } from "./results-access";
import { COVERAGE_STEP, inspectSitemapUrls, syncResults } from "./results-sync";
import { syncGeneratedPageSearch } from "./search-sync";

/** Runs daily (see cloudflare.config.ts) so page performance stays current without anyone clicking "sync". */
export class SearchSyncWorkflow extends WorkflowEntrypoint<AppEnv, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const siteIds = await step.do("list-sites", () => listSitesForResults(this.env.DB));
    const results: Record<string, string> = {};
    for (const siteId of siteIds) {
      results[siteId] = await step.do(`sync-${siteId}`, { retries: { limit: 1, delay: "1 minute" } }, async () => {
        const site = await getSite(this.env.DB, siteId);
        if (!site) return "skipped: site removed";
        const notes: string[] = [];
        if (site.gscProperty && (await publishedPages(this.env.DB, siteId)).published) {
          try {
            notes.push(`pages: ${(await syncGeneratedPageSearch(this.env, site)).queries} query rows`);
          } catch (error) {
            // One site's revoked Google access must not stop the others.
            notes.push(`pages failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try {
          notes.push(...await syncResults(this.env.DB, site, new Date(), googleAccess(this.env, siteId), { googleApiKey: this.env.GOOGLE_API_KEY, openPageRankKey: this.env.OPEN_PAGERANK_KEY }));
        } catch (error) {
          // A database error on one site must not stop the sites after it.
          notes.push(`results failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return notes.join("; ");
      });
      // Up to 8 more coverage steps (1,600 inspections), so a 23,000-URL site is checked within about two weeks under the 2,000-a-day quota.
      const site = await getSite(this.env.DB, siteId);
      if (site?.gscProperty) {
        for (let round = 1; round <= 8; round++) {
          const more = await step.do(`coverage-${siteId}-${round}`, { retries: { limit: 1, delay: "1 minute" } }, async () => {
            const { token } = await googleAccess(this.env, siteId).connect();
            const result = await inspectSitemapUrls(this.env.DB, siteId, site.gscProperty!, token, new Date().toISOString().slice(0, 10), COVERAGE_STEP);
            return result.remaining;
          });
          if (!more) break;
        }
      }
    }
    return results;
  }
}
