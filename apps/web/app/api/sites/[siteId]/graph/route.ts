import { env } from "cloudflare:workers";
import { getLinkFamily, getLinkGraph } from "@organic-growth/db";
import { requireSite } from "../../../../../src/guard";
import { fail, json } from "../../../../../src/server";

/**
 * How the site's page types link to each other and to Eumon's pages, and which pages nothing links to.
 * With `?family=doctors`, that one page type opened: its links in and out, and its pages by links in.
 */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const family = new URL(request.url).searchParams.get("family");
  if (family === null) return json(await getLinkGraph(env.DB, siteId));
  const opened = await getLinkFamily(env.DB, siteId, family.slice(0, 200));
  return opened ? json(opened) : fail("Run an analysis first.", 404);
}
