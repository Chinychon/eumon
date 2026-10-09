import handler from "vinext/server/fetch-handler";
import type { AppEnv } from "./cloudflare.config";
import { startSync } from "./src/sync-steps.js";

export * from "vinext/server/fetch-handler";
export { SiteAnalysisWorkflow } from "./src/analysis-workflow.js";
export { ScrapeWorkflow } from "./src/scrape-workflow.js";
export { SearchSyncWorkflow } from "./src/search-sync-workflow.js";

const app = (typeof handler === "function" ? { fetch: handler } : handler) as ExportedHandler<AppEnv>;

export default {
  ...app,
  /** The daily Results sync (the cron trigger in cloudflare.config.ts): one workflow instance a day for every site. */
  scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(startSync(env, { trigger: "daily" }, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<AppEnv>;
