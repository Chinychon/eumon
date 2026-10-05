import { env } from "cloudflare:workers";
import { listTemplates } from "@organic-growth/db";
import { fail, findSite, json } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await findSite(siteId))) return fail("Site not found.", 404);
  return json({ templates: await listTemplates(env.DB, siteId) });
}
