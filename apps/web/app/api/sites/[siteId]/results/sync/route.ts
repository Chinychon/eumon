import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { googleAccess, signalKeys } from "../../../../../../src/results-access";
import { syncResults } from "../../../../../../src/results-sync";
import { fail, json } from "../../../../../../src/server";

/** "Sync now": the same sync the daily workflow runs, for one site. */
export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  return json({ notes: await syncResults(env.DB, site, new Date(), googleAccess(env, siteId), signalKeys(env)) });
}
