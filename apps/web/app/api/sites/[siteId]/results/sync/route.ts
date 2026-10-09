import { env } from "cloudflare:workers";
import { getSite } from "@organic-growth/db";
import { fail, json } from "../../../../../../src/server";
import { startSync } from "../../../../../../src/sync-steps";

/**
 * "Sync now": starts the same workflow the daily run uses, for this site, and
 * answers at once. The run lands in Setup → Sync history when it finishes; the
 * dashboard waits for a run started at or after `startedAt`.
 */
export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  if (!(await getSite(env.DB, siteId))) return fail("Site not found.", 404);
  const startedAt = new Date().toISOString();
  try {
    const { id } = await startSync(env, { siteId, trigger: "manual" });
    return json({ id, startedAt }, 202);
  } catch (error) {
    return fail(`Could not start the sync: ${error instanceof Error ? error.message : String(error)}`, 503);
  }
}
