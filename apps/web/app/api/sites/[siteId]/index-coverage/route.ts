import { env } from "cloudflare:workers";
import { indexCoverage } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { fail, json } from "../../../../../src/server";

/** What Google did with the site's sitemap URLs so far (URL Inspection, a few hundred a day). */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const { site } = access;
  return json({ coverage: await indexCoverage(env.DB, siteId, new Date()), connected: Boolean(site.gscProperty) });
}
