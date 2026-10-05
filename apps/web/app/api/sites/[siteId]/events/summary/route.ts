import { env } from "cloudflare:workers";
import { getConversionSummary, getSite } from "@organic-growth/db";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  return Response.json(await getConversionSummary(env.DB, siteId), { headers: { "Cache-Control": "no-store" } });
}
