import { env } from "cloudflare:workers";
import { getConversionSummary } from "@organic-growth/db";
import { requireSite } from "../../../../../../src/guard";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  return Response.json(await getConversionSummary(env.DB, siteId), { headers: { "Cache-Control": "no-store" } });
}
