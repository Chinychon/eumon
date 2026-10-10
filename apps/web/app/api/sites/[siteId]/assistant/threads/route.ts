import { env } from "cloudflare:workers";
import { listAssistantThreads } from "@organic-growth/db";
import { requireSite } from "../../../../../../src/guard";
import { json } from "../../../../../../src/server";

/** The site's Ask Eumon conversations, most recently active first. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  return json({ threads: await listAssistantThreads(env.DB, siteId) });
}
