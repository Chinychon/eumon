import { env } from "cloudflare:workers";
import { listRecentEvents } from "@organic-growth/db";
import { requireSite } from "../../../../../../src/guard";

/** The latest conversion events received, so the user can check the tracker is installed. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const limit = Math.min(50, Math.max(1, Number(new URL(request.url).searchParams.get("limit")) || 20));
  return Response.json({ events: await listRecentEvents(env.DB, siteId, limit) }, { headers: { "Cache-Control": "no-store" } });
}
