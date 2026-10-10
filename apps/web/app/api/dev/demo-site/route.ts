import { env } from "cloudflare:workers";
import { DEMO_SITE_ID, isLocalHost, seedDemoSite } from "@organic-growth/agents";
import { setSiteWorkspace } from "@organic-growth/db";
import { requireWorkspace } from "../../../../src/guard";
import { fail, json } from "../../../../src/server";

/**
 * Builds (or rebuilds) the demo site with fictional data. Offered by the
 * development server at any address, and by a built app only to requests
 * addressed to this machine, never to the deployed site.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && !isLocalHost(new URL(request.url).hostname)) return fail("Not found.", 404);
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  const result = await seedDemoSite(env.DB);
  await setSiteWorkspace(env.DB, DEMO_SITE_ID, access.viewer.workspaceId);
  return json(result);
}
