import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import { getSite, listSitesWithLivePages } from "@organic-growth/db";
import { syncGeneratedPageSearch } from "./search-sync";

/** Runs daily (see cloudflare.config.ts) so page performance stays current without anyone clicking "sync". */
export class SearchSyncWorkflow extends WorkflowEntrypoint<AppEnv, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const siteIds = await step.do("list-sites", () => listSitesWithLivePages(this.env.DB));
    const results: Record<string, string> = {};
    for (const siteId of siteIds) {
      results[siteId] = await step.do(`sync-${siteId}`, { retries: { limit: 2, delay: "1 minute", backoff: "exponential" } }, async () => {
        const site = await getSite(this.env.DB, siteId);
        if (!site) return "skipped: site removed";
        try {
          const synced = await syncGeneratedPageSearch(this.env, site);
          return `synced ${synced.queries} query rows`;
        } catch (error) {
          // One site's revoked Google access must not stop the others.
          return `failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      });
    }
    return results;
  }
}
