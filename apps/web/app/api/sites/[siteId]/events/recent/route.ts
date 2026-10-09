import { env } from "cloudflare:workers";
import { getSite, listRecentEvents } from "@organic-growth/db";

/** The latest conversion events received, so the operator can check the tracker is installed. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  const limit = Math.min(50, Math.max(1, Number(new URL(request.url).searchParams.get("limit")) || 20));
  return Response.json({ events: await listRecentEvents(env.DB, siteId, limit) }, { headers: { "Cache-Control": "no-store" } });
}
