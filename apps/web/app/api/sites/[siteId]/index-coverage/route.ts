import { env } from "cloudflare:workers";
import { getSite, indexCoverage } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";

/** What Google did with the site's sitemap URLs so far (URL Inspection, a few hundred a day). */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ coverage: await indexCoverage(env.DB, siteId, new Date()), connected: Boolean(site.gscProperty) });
}
