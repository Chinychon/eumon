import { env } from "cloudflare:workers";
import { requireSite } from "../../../../../../src/guard";
import { fail, json } from "../../../../../../src/server";
import { startSync } from "../../../../../../src/sync-steps";

/**
 * "Sync now": starts the same workflow the daily run uses, for this site, and
 * answers at once. Clicks within ten minutes join one run. The run lands in
 * Setup → Sync history when it finishes; the dashboard waits for a manual run
 * started at or after `startedAt`, and asks GET for the instance's status.
 */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const { site } = access;
  try {
    const result = await startSync(env, { siteId, trigger: "manual" });
    if (result.running) return fail("Today's daily sync for this site is running; its result lands in Setup → Sync history shortly.", 409);
    return json({ id: result.id, startedAt: result.startedAt, joined: !result.created }, 202);
  } catch (error) {
    return fail(`Could not start the sync: ${error instanceof Error ? error.message : String(error)}`, 503);
  }
}

/** The status of one of this site's sync instances, so the dashboard stops waiting on a run that failed. */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read");
  if (access instanceof Response) return access;
  const { site } = access;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id.startsWith(`manual-${siteId}-`) && !id.endsWith(`-${siteId}`)) return fail("Not this site's sync.", 404);
  try {
    const status = await (await env.SEARCH_SYNC_WORKFLOW.get(id)).status();
    return json({ status: status.status, error: status.error?.message ?? null });
  } catch {
    return json({ status: "unknown", error: null });
  }
}
