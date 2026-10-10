import { env } from "cloudflare:workers";
import { listTemplates } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { fail, json } from "../../../../../src/server";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  return json({ templates: await listTemplates(env.DB, siteId) });
}
