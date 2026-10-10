import handler from "vinext/server/fetch-handler";
import type { AppEnv } from "./cloudflare.config";
import { authFor } from "./src/auth.js";
import { gate, isPublicPath } from "./src/gate.js";
import { APP_HEADERS, withHeaders } from "./src/headers.js";
import { startDailySyncs } from "./src/sync-steps.js";

export * from "vinext/server/fetch-handler";
export { SiteAnalysisWorkflow } from "./src/analysis-workflow.js";
export { ScrapeWorkflow } from "./src/scrape-workflow.js";
export { SearchSyncWorkflow } from "./src/search-sync-workflow.js";

const app = (typeof handler === "function" ? { fetch: handler } : handler) as ExportedHandler<AppEnv>;

export default {
  ...app,
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) {
      // Attempts (sign-in, sign-up, magic link) are rate limited per address; reading the session is not.
      if (request.method !== "GET") {
        const { success } = await env.AUTH_RATE_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "local" });
        if (!success) return Response.json({ error: "Too many attempts. Wait a minute, then try again." }, { status: 429 });
      }
      return withHeaders(await authFor(env).handler(request), APP_HEADERS);
    }
    const signedIn = isPublicPath(url.pathname) ? false : Boolean(await authFor(env).api.getSession({ headers: request.headers }));
    const refused = gate(request, signedIn);
    if (refused) return withHeaders(refused, APP_HEADERS);
    const response = await app.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    // Landing pages set their own headers (they may be framed by the customer's site).
    return url.pathname.startsWith("/p/") ? response : withHeaders(response, APP_HEADERS);
  },
  /** The daily Results sync (the cron trigger in cloudflare.config.ts): one workflow instance per site, named after the day, so a second firing creates none. */
  scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(startDailySyncs(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<AppEnv>;
