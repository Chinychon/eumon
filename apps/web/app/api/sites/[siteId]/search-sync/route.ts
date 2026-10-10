import { env } from "cloudflare:workers";
import { syncGeneratedPageSearch } from "../../../../../src/search-sync";
import { requireSite } from "../../../../../src/guard";
import { fail, json } from "../../../../../src/server";

export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  if (!site.gscProperty) return fail("Connect Google Search Console and choose a property first.", 409);
  try {
    return json(await syncGeneratedPageSearch(env, site));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Search Console sync failed.", 502);
  }
}
