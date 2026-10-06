import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { syncGeneratedPageSearch } from "../../../../../src/search-sync";
import { fail, json } from "../../../../../src/server";

export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  if (!site.gscProperty) return fail("Connect Google Search Console and choose a property first.", 409);
  try {
    return json(await syncGeneratedPageSearch(env, site));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Search Console sync failed.", 502);
  }
}
