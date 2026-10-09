import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { checkSearchConsoleUrls } from "../../../../../../src/search-console-import";
import { fail, json } from "../../../../../../src/server";

/** Fetches the next few imported URLs the crawl doesn't know and says how many still wait; the console calls it until none do. */
export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json(await checkSearchConsoleUrls(env.DB, site));
}
