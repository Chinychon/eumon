import { env } from "cloudflare:workers";
import { checkSearchConsoleUrls } from "../../../../../../src/search-console-import";
import { requireSite } from "../../../../../../src/guard";
import { fail, json } from "../../../../../../src/server";

/** Fetches the next few imported URLs the crawl doesn't know and says how many still wait; the console calls it until none do. */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  return json(await checkSearchConsoleUrls(env.DB, site));
}
