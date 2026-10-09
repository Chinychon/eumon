import { env } from "cloudflare:workers";
import { getSite, listSyncRuns } from "@organic-growth/db";

/** The site's latest Results syncs and what each source said. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  return Response.json({ runs: await listSyncRuns(env.DB, siteId) }, { headers: { "Cache-Control": "no-store" } });
}
