import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AppEnv } from "../cloudflare.config";
import { googleAccess, signalKeys } from "./results-access";
import { syncSites, type StepLike, type SyncParams } from "./sync-steps";

/**
 * The Results sync: every site once a day (the cron trigger in worker.ts) or one
 * site from "Sync now". Each site's sources run in one step and its URL
 * inspections in steps of 40, so every step fits the Free plan's 50 subrequests.
 */
export class SearchSyncWorkflow extends WorkflowEntrypoint<AppEnv, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    // Step results here are strings, numbers and plain objects, which Workflows serialise; the cast only bridges its generic constraint.
    const steps: StepLike = {
      do: <T>(name: string, fn: () => Promise<T>, options?: { retries: { limit: number; delay: number } }) => (options
        ? step.do(name, { retries: { limit: options.retries.limit, delay: options.retries.delay, backoff: "constant" } }, fn as never)
        : step.do(name, fn as never)) as unknown as Promise<T>,
    };
    const deps = { db: this.env.DB, google: (siteId: string) => googleAccess(this.env, siteId), keys: signalKeys(this.env), now: () => new Date() };
    return syncSites(deps, steps, event.payload ?? { trigger: "daily" });
  }
}
