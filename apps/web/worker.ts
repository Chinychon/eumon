import handler from "vinext/server/fetch-handler";
import type { AppEnv } from "./cloudflare.config";
import { startDailySyncs } from "./src/sync-steps.js";

export * from "vinext/server/fetch-handler";
export { SiteAnalysisWorkflow } from "./src/analysis-workflow.js";
export { ScrapeWorkflow } from "./src/scrape-workflow.js";
export { SearchSyncWorkflow } from "./src/search-sync-workflow.js";

const app = (typeof handler === "function" ? { fetch: handler } : handler) as ExportedHandler<AppEnv>;

export default {
  ...app,
  /** The daily Results sync (the cron trigger in cloudflare.config.ts): one workflow instance per site, named after the day, so a second firing creates none. */
  scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(startDailySyncs(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<AppEnv>;
