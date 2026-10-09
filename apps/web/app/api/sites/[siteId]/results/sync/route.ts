import { env } from "cloudflare:workers";
import { createId } from "@organic-growth/core";
import { getSite, recordSyncRun } from "@organic-growth/db";
import { googleAccess, signalKeys } from "../../../../../../src/results-access";
import { syncResults } from "../../../../../../src/results-sync";
import { fail, json } from "../../../../../../src/server";

/** "Sync now": the same sync the daily workflow runs, for one site, kept in the site's sync history. */
export async function POST(_request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
  const startedAt = new Date().toISOString();
  // The history is for the operator; failing to write it must not fail the sync.
  const record = (notes: string[]) => recordSyncRun(env.DB, { id: createId("sync"), siteId, trigger: "manual", startedAt, finishedAt: new Date().toISOString(), notes }).catch(() => undefined);
  let notes: string[];
  try {
    notes = await syncResults(env.DB, site, new Date(), googleAccess(env, siteId), signalKeys(env));
  } catch (error) {
    // The run that failed outright is the one the operator most needs to see in Sync history.
    const reason = error instanceof Error ? error.message : String(error);
    await record([`results failed: ${reason}`]);
    return fail(`Sync failed: ${reason}`, 500);
  }
  await record(notes);
  return json({ notes });
}
