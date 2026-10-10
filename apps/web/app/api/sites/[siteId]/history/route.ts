import { env } from "cloudflare:workers";
import { assembleHistory } from "../../../../../src/history";
import { requireSite } from "../../../../../src/guard";

/** The problems the analysis once reported that are gone, with what fixed them, and every action taken through Eumon. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  return Response.json(await assembleHistory(env.DB, siteId), { headers: { "Cache-Control": "no-store" } });
}
