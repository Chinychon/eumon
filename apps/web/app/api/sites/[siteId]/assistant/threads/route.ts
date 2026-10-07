import { env } from "cloudflare:workers";
import { listAssistantThreads } from "@organic-growth/db";
import { json } from "../../../../../../src/server";

/** The site's Ask Eumon conversations, most recently active first. */
export async function GET(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  return json({ threads: await listAssistantThreads(env.DB, siteId) });
}
