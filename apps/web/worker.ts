import { memberRole } from "@organic-growth/db";
import handler from "vinext/server/fetch-handler";
import type { AppEnv } from "./cloudflare.config";
import { isRosterPath, requestedWorkspaces } from "./src/auth-paths.js";
import { authFor } from "./src/auth.js";
import { gate, isPublicPath } from "./src/gate.js";
import { APP_HEADERS, withHeaders } from "./src/headers.js";
import { fetchHtml } from "./src/fix-steps.js";
import { fixRepoFor } from "./src/fix-github.js";
import { sweepFixes } from "./src/fix-sweep.js";
import { startDailySyncs } from "./src/sync-steps.js";

export * from "vinext/server/fetch-handler";
export { SiteAnalysisWorkflow } from "./src/analysis-workflow.js";
export { ScrapeWorkflow } from "./src/scrape-workflow.js";
export { SearchSyncWorkflow } from "./src/search-sync-workflow.js";

const app = (typeof handler === "function" ? { fetch: handler } : handler) as ExportedHandler<AppEnv>;

/** Better Auth's roster endpoints only check membership; a Client must not see who else is in the workspace. */
async function isClientOfRequested(env: AppEnv, request: Request, url: URL): Promise<boolean> {
  const session = await authFor(env).api.getSession({ headers: request.headers });
  if (!session) return false;
  const { ids, slug } = requestedWorkspaces(url.searchParams, (session.session as { activeOrganizationId?: string | null }).activeOrganizationId);
  const bySlug = slug ? (await env.DB.prepare("SELECT id FROM organization WHERE slug = ?").bind(slug).first<{ id: string }>())?.id : undefined;
  for (const workspaceId of bySlug ? [...ids, bySlug] : ids) {
    if ((await memberRole(env.DB as never, workspaceId, session.user.id)) === "client") return true;
  }
  return false;
}

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
      if (isRosterPath(url.pathname) && (await isClientOfRequested(env, request, url))) {
        return withHeaders(Response.json({ error: "Your role can't see this workspace's people." }, { status: 403 }), APP_HEADERS);
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
    ctx.waitUntil(sweepFixes({ db: env.DB, opsFor: async (site) => (await fixRepoFor(env, site)).ops, fetchHtml, now: () => new Date(controller.scheduledTime) }).catch(() => 0));
  },
} satisfies ExportedHandler<AppEnv>;
