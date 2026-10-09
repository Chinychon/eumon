import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { assembleHistory } from "../../../../../src/history";

/** The problems the analysis once reported that are gone, with what fixed them, and every action taken through Eumon. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return Response.json({ error: "Site not found." }, { status: 404 });
  return Response.json(await assembleHistory(env.DB, siteId), { headers: { "Cache-Control": "no-store" } });
}
