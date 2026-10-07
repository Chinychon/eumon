import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { loadResults } from "../../../../../src/results-data";
import { fail, json } from "../../../../../src/server";

export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ site: { name: site.name, baseUrl: site.baseUrl, gscProperty: site.gscProperty ?? null, ga4Property: site.ga4Property ?? null }, results: await loadResults(env.DB, site) });
}
