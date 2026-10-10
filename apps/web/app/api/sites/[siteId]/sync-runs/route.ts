import { env } from "cloudflare:workers";
import { listSyncRuns } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";

/** The site's latest Results syncs and what each source said. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  return Response.json({ runs: await listSyncRuns(env.DB, siteId) }, { headers: { "Cache-Control": "no-store" } });
}
