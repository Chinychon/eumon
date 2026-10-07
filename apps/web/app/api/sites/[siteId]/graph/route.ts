import { env } from "cloudflare:workers";
import { getLinkGraph, getSite } from "@organic-growth/db";
import { fail, json } from "../../../../../src/server";

/** How the site's page types link to each other and to Eumon's pages, and which pages nothing links to. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  return json(await getLinkGraph(env.DB, siteId));
}
