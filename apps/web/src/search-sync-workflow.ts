import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import { googleAccess, signalKeys } from "./results-access";
import { syncGeneratedPageSearch } from "./search-sync";
import { syncSite, workflowSteps, type SyncDeps, type SyncParams } from "./sync-steps";

/**
 * One site's Results sync: created once a day per site by the cron trigger in
 * worker.ts, or by "Sync now". The site's sources run in one step and its URL
 * inspections in steps of 40, so every step fits the Free plan's 50 subrequests.
 */
export class SearchSyncWorkflow extends WorkflowEntrypoint<AppEnv, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const deps: SyncDeps = {
      db: this.env.DB,
      google: (siteId) => googleAccess(this.env, siteId),
      keys: signalKeys(this.env),
      now: () => new Date(),
      pageSearch: (site) => syncGeneratedPageSearch(this.env, site),
    };
    const { siteId, trigger } = event.payload;
    return { [siteId]: (await syncSite(deps, workflowSteps(step), siteId, trigger)).join("; ") };
  }
}
